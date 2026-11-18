"""The free-tier ceilings, in one place, and the gate a release has to pass before it spends.

The product runs on $0 plans: Cloudflare R2 (10 GB-month, 1M Class A ops, 10M Class B),
Cloudflare Workers (20,000 static-asset files per version, 3,000 Builds minutes), GitHub
Actions (free for standard runners in a *public* repository, 500 MB of Actions storage on
the Free plan). Crossing one of them is not a slowdown, it is an invoice, so the numbers
live here as constants with their source and as-of date, and the code that uploads a
release refuses to cross them. The policy that binds a person or an agent is
`docs/04-decisions/ADR-0028-free-tier-cost-ceilings.md` in the workspace above this repo.

**Two things this module deliberately does not do.**

1. It does not guess a number it cannot read. Whether the account has a card, whether the
   plan is Free, and how many Workers Builds minutes are used are dashboard-only through
   the current token (403 on 2026-11-10); those are named in ADR-0028 as operator checks,
   not invented here.
2. It does not pass silently when it cannot measure. On 2026-11-10 the bucket reached
   16.33 GB against a 10 GB allowance while a prune step with `continue-on-error: true`
   printed a refusal nobody read and the job stayed green. A gate that cannot run must be
   a red run, not a green one.

Why the per-release ceiling is what it is: the prune policy keeps the live release and the
staged candidate in full, plus four quarterly archive stubs (ADR-0011 §4). `MAX_RESIDENT_RELEASES`
is 3, one more than the policy can hold, so a release that passes this gate leaves headroom
even if a rollback parent is kept by hand. The byte ceiling is therefore
`(R2_STORAGE_BUDGET - STUB_ALLOWANCE) / MAX_RESIDENT_RELEASES` (75 % of the allowance, minus room
for the archive stubs, split three ways); the object
ceiling is a month's Class A budget divided by 30, which is the one-release-a-day cadence the
arithmetic in ADR-0028 assumes.

**What this gate cannot see, stated here so no reader assumes otherwise.** It judges one
release at a time from the bytes it is about to publish; it does not read the bucket. A bucket
already over the line — the 2026-11-10 incident — would accept a normal release, because the
cause was a prune that deferred for ten days. That state is `assess_bucket`'s question, asked by
`pipeline.retention apply` after it re-lists the bucket: a prune that leaves it over the budget
exits 2, so the workflow run is red rather than green-with-a-warning. The two halves are the
enforcement — this module stops the growth, retention makes a backlog visible in the one channel
a workflow reads. For the same reason the 33,333 figure is a
30-day division: a 31-day month at one release a day is 1,033,323 objects, so the object line
leaves the pointer puts, `next-id`'s listings and re-tries no room in a long month — see
ADR-0028 §Residual gaps.

Run from the repository root, so every path resolves as written:

    pnpm check:budget                                    # the ceilings, as encoded
    pnpm check:budget --release artifacts/releases/2026-11-10.1
    pnpm check:budget --site web/out
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

GB = 1_000_000_000
MB = 1_000_000

# --- Cloudflare R2, Free plan -------------------------------------------------------
# Source: https://developers.cloudflare.com/r2/pricing/ (fetched 2026-11-10).
# Billing rounds *up* to the next unit, so 1,000,001 Class A ops bill as 2,000,000.
R2_FREE_BYTES = 10 * GB
R2_FREE_CLASS_A_OPS = 1_000_000
R2_FREE_CLASS_B_OPS = 10_000_000

# --- Cloudflare Workers, Free plan --------------------------------------------------
# Source: https://developers.cloudflare.com/workers/platform/limits/ (fetched 2026-11-10).
# The asset limit is a hard deploy failure, not a bill: the deploy is rejected above it.
WORKERS_FREE_ASSET_FILES = 20_000
# Source: https://developers.cloudflare.com/workers/ci-cd/builds/ (Free plan allowance).
WORKERS_FREE_BUILDS_MINUTES = 3_000

# --- GitHub Actions, GitHub Free ----------------------------------------------------
# Source: https://docs.github.com/en/actions/concepts/billing-and-usage (fetched 2026-11-18).
# Standard GitHub-hosted runners are free in a *public* repository, so Actions minutes cost
# nothing while `MitchellRLayton/unpackfund` is public. Changing that visibility is a spend
# decision, not a settings toggle: the repo becomes metered against the $12/month included
# compute allowance the moment it is private.
GITHUB_ACTIONS_FREE_ON_PUBLIC_REPO = True
# Source: https://docs.github.com/en/billing/reference/product-usage-included (fetched
# 2026-11-18): GitHub Free includes 500 MB of GitHub Actions storage and $12/month of
# included compute usage. Whether the public-repository carve-out covers artifact storage
# as well as runners is [open] in ADR-0028, so 500 MB is treated as the ceiling.
GITHUB_FREE_ACTIONS_STORAGE_MB = 500

HEADROOM = 0.75

#: Every full release the prune policy can leave resident (live + staged + one rollback
#: parent kept by hand). ADR-0011 §4 keeps two; this is the conservative bound.
MAX_RESIDENT_RELEASES = 3

#: The storage line this gate refuses above. Not the 10 GB allowance itself: sitting on
#: the allowance leaves no room for a release that arrives while a prune is deferred, so
#: the operating ceiling is HEADROOM of it.
R2_STORAGE_BUDGET = int(R2_FREE_BYTES * HEADROOM)

#: Class A objects one release may write, at one release a day: 1M ops a month / 30 days.
MAX_RELEASE_OBJECTS = R2_FREE_CLASS_A_OPS // 30

#: The trailing-30-day operating line for release uploads. **Not** `HEADROOM`: storage and
#: operation shortages fail differently. At 75 % the guard would refuse the nightly release
#: around the 20th of a busy month and freeze the site's data for a week to save cents; at
#: 95 % a nightly loop still fits (30 x 22,357 = 670,710), and the 5 % left over covers what
#: the ledger does not count — the ~24 k of listings and any remediation copies.
#:
#: A rolling window, not a calendar month: the allowance resets on the billing period, and the
#: 2026-11-17 charge was the period's million counted from 2026-10-28.
R2_WINDOW_BUDGET = int(R2_FREE_CLASS_A_OPS * 0.95)

#: How many releases one date may publish: the plan, a hotfix, and one retry. 2026-11-02
#: published eight (176,181 objects) because every re-run allocated a new id. The ceiling is
#: `MAX_DAILY_RELEASES x this release's own size`, not a fixed object count: a fixed count
#: derived from `MAX_RELEASE_OBJECTS` would allow four real releases (4 x 22,357 < 3 x 33,333),
#: and a release that died at 98 % must still leave room for its retry. This is a **rate**
#: guard, not the monthly budget (30 days at it is 2M); the real average is set by the
#: one-a-day plan and by skipping an unchanged same-date re-run.
MAX_DAILY_RELEASES = 3

#: Room for the four quarterly archive stubs the prune keeps (measured at ~4 MB each) so that
#: `MAX_RESIDENT_RELEASES` maximum-size releases *plus* the stubs still fit the budget — without
#: it, three releases at the limit exactly consumed the budget and the stubs had nothing.
STUB_ALLOWANCE = 64 * MB

#: Per-release bytes, so `MAX_RESIDENT_RELEASES` of them plus the stubs fit inside `R2_STORAGE_BUDGET`.
MAX_RELEASE_BYTES = (R2_STORAGE_BUDGET - STUB_ALLOWANCE) // MAX_RESIDENT_RELEASES


class CostCeilingError(RuntimeError):
    """A release would cross a free-tier ceiling. Refused before the first PutObject."""


@dataclass(frozen=True)
class Ceiling:
    """One measured quantity against its allowance."""

    resource: str
    measured: int
    limit: int
    unit: str

    @property
    def fraction(self) -> float:
        return self.measured / self.limit if self.limit else 0.0

    @property
    def over(self) -> bool:
        return self.measured > self.limit

    @property
    def near(self) -> bool:
        return not self.over and self.fraction >= HEADROOM

    @property
    def verdict(self) -> str:
        return "OVER" if self.over else ("near" if self.near else "ok")

    def line(self) -> str:
        return (
            f"  {self.verdict:<4} {self.resource:<34} "
            f"{self.measured:>12,} / {self.limit:>12,} {self.unit:<10} "
            f"({self.fraction:5.1%})"
        )


def _human_bytes(n: int) -> str:
    return f"{n / GB:.3f} GB" if n >= GB else f"{n / MB:.1f} MB"


def assess_release(*, objects: int, bytes: int) -> list[Ceiling]:
    """A single release against the Class A operation budget and the storage steady state.

    Both inputs are the bytes that are about to be published, not an estimate from the
    directory tree: `release.read_release` already holds every object in memory.
    """
    return [
        Ceiling(
            "R2 Class A ops for one release",
            objects,
            MAX_RELEASE_OBJECTS,
            "objects",
        ),
        Ceiling(
            f"R2 storage, {MAX_RESIDENT_RELEASES} releases + archive stubs",
            bytes * MAX_RESIDENT_RELEASES + STUB_ALLOWANCE,
            R2_STORAGE_BUDGET,
            "bytes",
        ),
    ]


def assess_site(*, files: int) -> list[Ceiling]:
    """A built site against the Workers static-asset file cap."""
    return [Ceiling("Workers static-asset files", files, WORKERS_FREE_ASSET_FILES, "files")]


def assess_day(*, objects: int, already: int) -> list[Ceiling]:
    """Today's uploads plus this release, against the daily rate guard."""
    return [
        Ceiling(
            "R2 Class A ops today (release uploads)",
            already + objects,
            MAX_DAILY_RELEASES * objects,
            "objects",
        )
    ]


#: R2 bills the *next whole million* once the allowance is crossed ("1,000,001 operations bills
#: as 2,000,000"), so the marginal cost of an operation inside an already-billed band is zero,
#: and the next charge starts only at the boundary. The guard therefore stops at 95 % of the
#: band it is in: 950,000 while free, then 1,950,000 in the second band, and so on. The margin
#: covers what the ledger does not count — listings, retries, one remediation copy (the 2026-11-18
#: quarantine was 30,815) and a hand-rolled upload.
BAND_MARGIN = 100_000


def window_ceiling(used: int) -> int:
    """The line this window must not cross, given what it has already spent.

    Below the allowance that is `R2_WINDOW_BUDGET`. Once the window is inside a billable band
    the next million is already paid for, so refusing would buy nothing: the line becomes the
    top of that band.
    """
    # `<=`, not `<`: at exactly 1,000,000 the allowance is consumed and nothing is billable,
    # so the band has NOT advanced — allowing another 22k there would start the first charge.
    if used <= R2_FREE_CLASS_A_OPS:
        return R2_WINDOW_BUDGET
    band = (used // R2_FREE_CLASS_A_OPS) + 1
    return band * R2_FREE_CLASS_A_OPS - BAND_MARGIN


def assess_window(*, used: int, adding: int) -> list[Ceiling]:
    """What the trailing 30 days have spent, plus this release, against the band it is in."""
    return [Ceiling("R2 Class A, this billing period", used + adding, window_ceiling(used), "objects")]


def assess_bucket(*, bytes: int) -> list[Ceiling]:
    """The bucket as it stands after a prune, against the storage budget.

    This is the other half of the pair: `guard_release` stops one release from crossing
    the line, and this refuses a prune that reports success while the bucket is still
    over it — the shape of the 2026-11-10 failure, where a step printed a refusal into a
    green job for ten days.
    """
    return [Ceiling("R2 storage, bucket after prune", bytes, R2_STORAGE_BUDGET, "bytes")]


def over_budget(ceilings: list[Ceiling]) -> list[Ceiling]:
    return [ceiling for ceiling in ceilings if ceiling.over]


def format_report(ceilings: list[Ceiling], *, heading: str = "free-tier ceiling") -> str:
    lines = [f"{heading}  (headroom policy {HEADROOM:.0%})"]
    lines.extend(ceiling.line() for ceiling in ceilings)
    return "\n".join(lines)


def guard_release(*, objects: int, bytes: int, release_id: str = "") -> list[Ceiling]:
    """Raise before the first `PutObject` when a release would cross a ceiling.

    Called from `release.upload_release` — the only place a *release* becomes Class A
    operations. The repository has other writers (`promote_release`'s pointer put, retention's
    batched deletes, triage, telemetry); they are not releases and are not this gate's
    business, which is why the claim is narrow on purpose. It refuses rather than warns for the
    same reason the 60% mass-delete guard refuses: a warning inside a green job is how the
    bucket reached 16.33 GB.
    """
    ceilings = assess_release(objects=objects, bytes=bytes)
    over = over_budget(ceilings)
    if over:
        label = f"release {release_id}" if release_id else "this release"
        detail = "\n".join(ceiling.line() for ceiling in over)
        raise CostCeilingError(
            f"REFUSED: {label} would cross a free-tier ceiling\n"
            f"{detail}\n"
            f"  this release: {objects:,} objects, {_human_bytes(bytes)}\n"
            f"  see docs/04-decisions/ADR-0028-free-tier-cost-ceilings.md (workspace) for the "
            f"policy; only the operator may approve an upload past it"
        )
    return ceilings


def guard_day(*, objects: int, already: int, release_id: str = "") -> list[Ceiling]:
    """Refuse a second-today release that would take the date past its rate guard."""
    ceilings = assess_day(objects=objects, already=already)
    over = over_budget(ceilings)
    if over:
        label = f"release {release_id}" if release_id else "this release"
        detail = "\n".join(ceiling.line() for ceiling in over)
        raise CostCeilingError(
            f"REFUSED: {label} would take today past the upload rate guard\n"
            f"{detail}\n"
            f"  already published today: {already:,} object(s); this release adds {objects:,}\n"
            f"  one release a day is the plan, and this date is already at three releases' "
            f"worth (ADR-0028). A same-day re-run of unchanged data is skipped before the "
            f"first write, so this is a fourth distinct release today"
        )
    return ceilings


def guard_window(*, used: int, adding: int, release_id: str = "") -> list[Ceiling]:
    """Refuse a release that would take the trailing 30 days past their operating line.

    This is the budget the November charge showed was missing: the per-release and per-date
    guards each passed, and the period still crossed the allowance because nothing counted it.
    `used` comes from the usage ledger (`release.read_usage`), which counts operations
    performed — the bucket's own size is the wrong number, because retention deletes old
    releases and their operations were still billed.
    """
    ceilings = assess_window(used=used, adding=adding)
    over = over_budget(ceilings)
    if over:
        label = f"release {release_id}" if release_id else "this release"
        detail = "\n".join(ceiling.line() for ceiling in over)
        raise CostCeilingError(
            f"REFUSED: {label} would take this billing period past its Class A budget\n"
            f"{detail}\n"
            f"  {used:,} already spent in the window (usage ledger), and this release adds {adding:,}\n"
            f"  the line is {window_ceiling(used):,} for the band this window is in; it reserves "
            f"{BAND_MARGIN:,} for the listings and copies the ledger does not count, because R2 bills "
            f"the next whole million and crossing it starts a new $4.50 charge (ADR-0028). Publishing "
            f"less, or packing the release smaller, is the fix; raising the line is an ADR amendment"
        )
    return ceilings


def _tree_measurement(directory: Path) -> tuple[int, int]:
    """Files and bytes a directory tree publishes (symlinks and directories excluded)."""
    files = 0
    total = 0
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        files += 1
        total += path.stat().st_size
    return files, total


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.cost_ceilings", description=__doc__)
    parser.add_argument("--release", type=Path, help="a release directory (as uploaded to R2)")
    parser.add_argument("--site", type=Path, help="a built site directory (web/out)")
    args = parser.parse_args(argv)

    if args.release is None and args.site is None:
        print("free-tier ceilings, as encoded in pipeline/pipeline/cost_ceilings.py")
        print(f"  R2 storage              {_human_bytes(R2_FREE_BYTES)} per month")
        print(f"  R2 Class A ops          {R2_FREE_CLASS_A_OPS:,} per month "
              f"(one release: {MAX_RELEASE_OBJECTS:,} objects; one date: {MAX_DAILY_RELEASES} releases)")
        print(f"  R2 Class B ops          {R2_FREE_CLASS_B_OPS:,} per month")
        print(f"  Workers asset files     {WORKERS_FREE_ASSET_FILES:,} per version")
        print(f"  Workers Builds          {WORKERS_FREE_BUILDS_MINUTES:,} minutes per month")
        print(f"  Actions storage         {GITHUB_FREE_ACTIONS_STORAGE_MB:,} MB "
              f"(GitHub Free); runner minutes free while the repo is public")
        print(f"  R2 Class A period       {R2_WINDOW_BUDGET:,} while free; else the top of the band, "
              f"minus {BAND_MARGIN:,}")
        print(f"  headroom policy         {HEADROOM:.0%} — refuse above the ceiling, warn above headroom")
        print("  a measured gate: --release <dir> or --site <dir>")
        return 0

    ceilings: list[Ceiling] = []
    if args.release is not None:
        if not args.release.is_dir():
            print(f"FAIL: {args.release} is not a directory", file=sys.stderr)
            return 1
        files, total = _tree_measurement(args.release)
        if not files:
            print(f"FAIL: {args.release} publishes no files", file=sys.stderr)
            return 1
        ceilings += assess_release(objects=files, bytes=total)
        print(f"  measured {args.release}: {files:,} files, {_human_bytes(total)}")
    if args.site is not None:
        if not args.site.is_dir():
            print(f"FAIL: {args.site} is not a directory", file=sys.stderr)
            return 1
        files, total = _tree_measurement(args.site)
        if not files:
            print(f"FAIL: {args.site} publishes no files", file=sys.stderr)
            return 1
        ceilings += assess_site(files=files)
        print(f"  measured {args.site}: {files:,} files, {_human_bytes(total)}")

    print(format_report(ceilings))
    over = over_budget(ceilings)
    if over:
        print(f"FAIL: {len(over)} ceiling(s) would be crossed", file=sys.stderr)
        return 1
    print("ok: inside every measured free-tier ceiling")
    return 0


if __name__ == "__main__":
    sys.exit(main())
