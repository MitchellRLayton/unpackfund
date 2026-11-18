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
`R2_STORAGE_BUDGET / MAX_RESIDENT_RELEASES` (75 % of the allowance, split three ways); the object
ceiling is a month's Class A budget divided by 30, which is the one-release-a-day cadence the
arithmetic in ADR-0028 assumes.

**What this gate cannot see, stated here so no reader assumes otherwise.** It judges one
release at a time from the bytes it is about to publish; it does not read the bucket. A bucket
already over the line — the 2026-11-10 incident — would accept a normal release, because the
cause was a prune that deferred for ten days. Bucket state is guarded where it is known: the
prune workflow (`prune.yml`, whose refusal is now a red run) and `pipeline.retention`'s plan,
which prints and warns on the post-plan total. The two together are the enforcement; this
module is the half that stops the growth. For the same reason the 33,333 figure is a
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

#: Per-release bytes, so `MAX_RESIDENT_RELEASES` of them fit inside `R2_STORAGE_BUDGET`.
MAX_RELEASE_BYTES = R2_STORAGE_BUDGET // MAX_RESIDENT_RELEASES


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
            f"R2 storage, {MAX_RESIDENT_RELEASES} releases resident",
            bytes * MAX_RESIDENT_RELEASES,
            R2_STORAGE_BUDGET,
            "bytes",
        ),
    ]


def assess_site(*, files: int) -> list[Ceiling]:
    """A built site against the Workers static-asset file cap."""
    return [Ceiling("Workers static-asset files", files, WORKERS_FREE_ASSET_FILES, "files")]


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
              f"(one release: {MAX_RELEASE_OBJECTS:,} objects)")
        print(f"  R2 Class B ops          {R2_FREE_CLASS_B_OPS:,} per month")
        print(f"  Workers asset files     {WORKERS_FREE_ASSET_FILES:,} per version")
        print(f"  Workers Builds          {WORKERS_FREE_BUILDS_MINUTES:,} minutes per month")
        print(f"  Actions storage         {GITHUB_FREE_ACTIONS_STORAGE_MB:,} MB "
              f"(GitHub Free); runner minutes free while the repo is public")
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
