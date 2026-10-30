"""Prune published releases so a daily refresh never pushes the R2 bill past the free tier.

The operator's constraint is the whole design: *stay inside Cloudflare's free
tiers*. So the arithmetic comes first, measured on release `2026-10-30.5`
(2026-10-30):

    14,239 objects / 331.4 MB per release
      funds/       8,983 objects  298.8 MB   one document per fund
      companies/   5,225 objects   28.6 MB   reverse-X-Ray shards
      index/          26 objects    1.1 MB   per-letter hash shards
      root             5 objects    2.8 MB   manifest, catalogue, tickers, aliases, descriptor

R2 Standard storage is $0.015/GB-month with 10 GB free, and the release is still
growing (13,482 → 13,764 → 14,239 objects in three days). Thirty daily copies is
9.9 GB: the entire free tier, with no margin, before the next release goes over it.

Three rules, applied to every listing:

* **Keep in full** the live release (`latest/release.json`), its parent — the
  rollback target, because rolling back is a pointer write only while the older
  bytes are still there — and the staged candidate (`staging/latest/release.json`).
* **Keep as a stub** the newest release of each of the four most recent completed
  quarters. A stub keeps the *proof* and drops the *bytes*: `manifest.json`,
  `release.json`, `catalogue.json`, `tickers.json`, `aliases.json` and `index/`
  stay; `funds/` and `companies/` go. A `ARCHIVED.json` is written into the prefix
  recording what was removed and why it is recoverable.
* **Delete everything else** under `releases/`.

Why a stub and not a copy: the fund documents are *derived* data. The N-PORT
filings they were built from are immutable at the SEC, `manifest.json` lists every
published file with its sha256, and the parser that produced them is versioned by
`pipeline_git_sha`. So the manifest is the release's proof, and `funds/` is only
its current rendering: dropping the rendering costs nothing that cannot be rebuilt
byte for byte, and keeping four renderings of the past year costs 1.3 GB.

Steady state: 3 × 331.4 MB + 4 × ~4 MB ≈ 1.0 GB, i.e. ~10% of the free tier instead
of 100%.

`plan` is the safe command — it lists, reads the two pointers, prints a table of
one decision per release and mutates nothing. `apply` performs that plan and needs
`--yes`; without it the plan is printed and the process exits 2. Both commands
refuse (exit 2, no changes) when the live pointer is missing or unreadable, when a
decision would touch the live, staged or rollback release, when a release prefix
has no `release.json`, or when one run would delete more than 60% of the bucket
unless `--force` — that last guard is for a listing bug, not for the policy.

`--ignore-prefix` (both commands, repeatable) is the operator's explicit exception
to the `release.json` guard: a prefix named there is left out of the plan
entirely — not kept, not stubbed, not deleted, and not counted toward the totals or
the 60% guard — and printed as `ignored` with its object count so a reader can see
why it was skipped. Without it, one legacy prefix that was never a release (the
real bucket has a 73-byte `releases/2026-10-28/smoke.json`) would make every
nightly run refuse, and the prune would never happen. Ignoring the live release is
itself refused: the pointer's target has to stay visible to the plan.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Iterable, Mapping, Sequence

from . import release
from .artifact import canonical_bytes, utc_now_iso
from .r2 import IMMUTABLE, ObjectEntry, R2Client, R2Error

RELEASES_PREFIX = "releases/"

#: Both pointer paths come from the publish step, so a pointer rename cannot leave
#: retention looking at a path nothing writes.
LIVE_POINTER = release.LIVE_POINTER
STAGED_POINTER = f"{release.DEFAULT_POINTER_PREFIX}/{release.DEFAULT_POINTER_NAME}"

#: The small objects a stub keeps. Everything else under `funds/` and `companies/`
#: is re-derivable, these are what make the release auditable.
ARCHIVE_OBJECT = "ARCHIVED.json"
STUB_FILES = frozenset({"manifest.json", "release.json", "catalogue.json", "tickers.json", "aliases.json"})
STUB_PREFIXES = ("index/",)

DEFAULT_QUARTERS = 4

#: A guard against a listing bug, not a policy: losing 60% of the bucket in one run
#: means the listing did not see the live or staged releases, not that the policy
#: decided to delete them. `--force` is the operator saying "I read the plan".
MASS_DELETE_FRACTION = 0.60

#: One DeleteObjects request takes at most this many keys.
DELETE_BATCH = 1000

GB = 1_000_000_000
FREE_TIER_BYTES = 10 * GB

KEEP = "keep"
STUB = "stub"
DELETE = "delete"
ACTIONS = (KEEP, STUB, DELETE)

#: `2026-10-30.5` — an `as_of` date and the counter for a second release that day.
#: The id is also the published directory name, and the only thing that says where
#: a release sorts and which quarter it belongs to.
RELEASE_ID = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?$")


class RetentionError(RuntimeError):
    """A prune that must not run as it stands."""


# -- release ids, quarters, formatting ---------------------------------------
def release_order(release_id: str) -> tuple[date, int]:
    """Sort key for a release id: `(as_of date, same-day counter)`.

    Sorting the *ids* rather than the listing matters: a bucket listing is
    lexicographic by key, so it puts `2026-10-30.10` before `2026-10-30.9`.
    """
    match = RELEASE_ID.match(release_id)
    if match is None:
        raise RetentionError(f"{release_id!r} is not a release id (YYYY-MM-DD[.N]); refusing to guess how it sorts")
    year, month, day, counter = match.groups()
    try:
        stamp = date(int(year), int(month), int(day))
    except ValueError as error:
        raise RetentionError(f"{release_id!r} is not a real date: {error}") from error
    return stamp, int(counter or 0)


def quarter_of(stamp: date) -> tuple[int, int]:
    """`(year, quarter)` for a date — the calendar quarter, as `refresh.py` uses it."""
    return stamp.year, (stamp.month - 1) // 3 + 1


def quarter_label(quarter: tuple[int, int]) -> str:
    return f"{quarter[0]}Q{quarter[1]}"


def completed_quarters(today: date, quarters: int = DEFAULT_QUARTERS) -> list[tuple[int, int]]:
    """The `quarters` most recent *completed* quarters, newest first.

    A quarter that contains `today` is not completed, so its releases are never
    turned into stubs: the newest of them is usually the live release, and the rest
    are still being superseded.
    """
    year, quarter = quarter_of(today)
    out: list[tuple[int, int]] = []
    for _ in range(max(0, quarters)):
        quarter -= 1
        if quarter == 0:
            year, quarter = year - 1, 4
        out.append((year, quarter))
    return out


def utc_today() -> date:
    return datetime.now(UTC).date()


def format_bytes(count: int) -> str:
    for unit, scale in (("GB", GB), ("MB", 1_000_000), ("kB", 1_000)):
        if count >= scale:
            return f"{count / scale:,.1f} {unit}"
    return f"{count} B"


# -- reading the listing ------------------------------------------------------
def release_groups(listing: Iterable[ObjectEntry]) -> dict[str, list[ObjectEntry]]:
    """Group a bucket listing by release id, ignoring everything outside `releases/`.

    Objects under `latest/`, `staging/` and the bucket root are the live pointers
    and health checks; retention never lists them for deletion, and the grouping is
    what keeps them out of reach.
    """
    groups: dict[str, list[ObjectEntry]] = {}
    for entry in listing:
        if not entry.key.startswith(RELEASES_PREFIX):
            continue
        release_id, separator, _relative = entry.key[len(RELEASES_PREFIX) :].partition("/")
        if not release_id:
            continue
        groups.setdefault(release_id, []).append(entry)
    return groups


def relative_key(release_id: str, key: str) -> str:
    """An object's path inside its release prefix: `funds/VOO.json`, `index/A.json`."""
    prefix = f"{RELEASES_PREFIX}{release_id}/"
    return key[len(prefix) :] if key.startswith(prefix) else key


def is_stub_kept(relative: str) -> bool:
    """Does a stub keep this object? The five small root objects, `index/`, and the record."""
    return relative in STUB_FILES or relative == ARCHIVE_OBJECT or relative.startswith(STUB_PREFIXES)


def matches_prefix(key: str, prefix: str) -> bool:
    """Is this key the prefix itself or something under it? `releases/x` never matches `releases/xy`."""
    return key == prefix or key.startswith(prefix + "/")


@dataclass(frozen=True)
class IgnoredPrefix:
    """A prefix the operator excluded on purpose, and what is inside it."""

    prefix: str
    objects: int
    bytes: int

    def to_json(self) -> dict:
        return {"prefix": self.prefix, "objects": self.objects, "bytes": self.bytes}


def split_ignored(
    listing: Iterable[ObjectEntry], prefixes: Sequence[str]
) -> tuple[list[ObjectEntry], list[IgnoredPrefix]]:
    """Split a listing into what the plan considers and what the operator excluded.

    Ignored objects are not merely protected from deletion: they leave the plan's
    arithmetic altogether, so they cannot make a plan look safer (by swelling the
    denominator) or more destructive (by being counted as deletions). Every
    requested prefix is reported even when it matches nothing, because a prefix that
    silently matches nothing is a typo the operator has to see.
    """
    normalized: list[str] = []
    for raw in prefixes:
        prefix = raw.strip().strip("/")
        if not prefix:
            raise RetentionError("--ignore-prefix needs a prefix such as releases/2026-10-28")
        if prefix not in normalized:
            normalized.append(prefix)

    counts = {prefix: [0, 0] for prefix in normalized}
    considered: list[ObjectEntry] = []
    for entry in listing:
        match = next((prefix for prefix in normalized if matches_prefix(entry.key, prefix)), None)
        if match is None:
            considered.append(entry)
        else:
            counts[match][0] += 1
            counts[match][1] += entry.size
    return considered, [
        IgnoredPrefix(prefix, counts[prefix][0], counts[prefix][1]) for prefix in normalized
    ]


# -- the decision -------------------------------------------------------------
@dataclass(frozen=True)
class Decision:
    """What happens to one release, and every object it owns.

    The whole group travels with the decision so `apply` cannot act on a listing the
    plan did not see: what is deleted is derived from `entries` by the same rule the
    plan used, not from a second read of the bucket.
    """

    release: str
    action: str
    reason: str
    entries: tuple[ObjectEntry, ...] = ()

    @property
    def objects(self) -> int:
        return len(self.entries)

    @property
    def bytes(self) -> int:
        return sum(entry.size for entry in self.entries)

    @property
    def delete(self) -> tuple[ObjectEntry, ...]:
        """The objects this decision removes: all of them, or all but the stub keep-list."""
        if self.action == DELETE:
            return self.entries
        if self.action == STUB:
            return tuple(
                entry for entry in self.entries if not is_stub_kept(relative_key(self.release, entry.key))
            )
        return ()

    @property
    def kept(self) -> tuple[ObjectEntry, ...]:
        removed = {entry.key for entry in self.delete}
        return tuple(entry for entry in self.entries if entry.key not in removed)

    @property
    def remove_objects(self) -> int:
        return len(self.delete)

    @property
    def remove_bytes(self) -> int:
        return sum(entry.size for entry in self.delete)

    @property
    def kept_objects(self) -> int:
        return self.objects - self.remove_objects

    @property
    def kept_bytes(self) -> int:
        return self.bytes - self.remove_bytes

    def to_json(self) -> dict:
        return {
            "release": self.release,
            "action": self.action,
            "objects": self.objects,
            "bytes": self.bytes,
            "remove_objects": self.remove_objects,
            "remove_bytes": self.remove_bytes,
            "kept_objects": self.kept_objects,
            "kept_bytes": self.kept_bytes,
            "reason": self.reason,
        }


def resolve_parent(
    groups: Mapping[str, Sequence[ObjectEntry]], live: str, declared: str | None = None
) -> str | None:
    """The rollback target: the release the live pointer pointed at before `live`.

    The pointer descriptor carries no `parent` field today (checked against the live
    pointer on 2026-10-30), so the previous live release is read off the bucket: the
    release that sorts immediately before `live`. If the descriptor ever grows one,
    the declared value wins and this derivation stops being used.
    """
    if declared and declared in groups:
        return declared
    live_order = release_order(live)
    older = [release_id for release_id in groups if release_order(release_id) < live_order]
    return max(older, key=release_order) if older else None


def plan_releases(
    listing: Iterable[ObjectEntry],
    live: str,
    staged: str | None = None,
    quarters: int = DEFAULT_QUARTERS,
    *,
    parent: str | None = None,
    today: date | None = None,
) -> list[Decision]:
    """Decide keep/stub/delete for every release in the listing.

    Pure by construction — no network and no clock unless `today` is left out — so
    the policy is testable as arithmetic. The order of the returned list is newest
    release first, which is the order an operator reads a plan in.
    """
    groups = release_groups(listing)
    ordered = sorted(groups, key=release_order, reverse=True)
    moment = today or utc_today()

    roles: dict[str, list[str]] = {}
    for release_id, label in (
        (live, f"live pointer ({LIVE_POINTER})"),
        (parent, "rollback parent of live"),
        (staged, f"staged candidate ({STAGED_POINTER})"),
    ):
        if release_id:
            roles.setdefault(release_id, []).append(label)

    # One stub per completed quarter: the newest release that is not already kept in
    # full. If the newest *is* the live release, that release is better than a stub
    # and the next newest becomes the quarter's snapshot.
    stubs: dict[str, tuple[int, int]] = {}
    for quarter in completed_quarters(moment, quarters):
        candidates = [
            release_id
            for release_id in ordered
            if release_id not in roles and quarter_of(release_order(release_id)[0]) == quarter
        ]
        if candidates:
            stubs[candidates[0]] = quarter

    current = quarter_of(moment)
    window = set(completed_quarters(moment, quarters))
    decisions: list[Decision] = []

    for release_id in ordered:
        entries = tuple(groups[release_id])
        if release_id in roles:
            decisions.append(Decision(release_id, KEEP, "; ".join(roles[release_id]), entries))
            continue

        if release_id in stubs:
            quarter = quarter_label(stubs[release_id])
            if any(relative_key(release_id, entry.key) == ARCHIVE_OBJECT for entry in entries):
                # A stub is written once. Rewriting it would rewrite a historical
                # record's timestamp on every nightly run and buy nothing.
                decisions.append(
                    Decision(release_id, KEEP, f"already archived as the {quarter} stub ({ARCHIVE_OBJECT} present)", entries)
                )
            else:
                decisions.append(
                    Decision(
                        release_id,
                        STUB,
                        f"newest release of {quarter}, kept as a stub: {ARCHIVE_OBJECT}, the manifest and index/ stay",
                        entries,
                    )
                )
            continue

        stamp = release_order(release_id)[0]
        quarter = quarter_of(stamp)
        if quarter in window:
            stub = next(
                (release_id for release_id in stubs if quarter_of(release_order(release_id)[0]) == quarter), None
            )
            reason = (
                f"superseded by {stub} as the {quarter_label(quarter)} stub"
                if stub
                else "not the live, rollback or staged release"
            )
        elif quarter >= current:
            reason = f"not the live, rollback or staged release; {quarter_label(quarter)} is not a completed quarter"
        else:
            reason = f"{quarter_label(quarter)} is outside the {quarters} most recent completed quarters"
        decisions.append(Decision(release_id, DELETE, reason, entries))

    return decisions


# -- the refusals -------------------------------------------------------------
def check_plan(
    decisions: Sequence[Decision],
    listing: Sequence[ObjectEntry],
    *,
    live: str,
    staged: str | None = None,
    parent: str | None = None,
    force: bool = False,
) -> None:
    """Raise `RetentionError` for every case where pruning would be a guess.

    Applied by both commands, so `plan` refuses the same states `apply` does — a
    plan you are allowed to look at but not run is not a plan.
    """
    groups = release_groups(listing)
    if not live:
        raise RetentionError(f"{LIVE_POINTER} names no live release; refusing to prune without knowing what is live")
    if live not in groups:
        raise RetentionError(
            f"the live release {live} has no objects under {RELEASES_PREFIX} — the site is already broken, "
            "and pruning must not make it worse"
        )

    for release_id in sorted(groups, key=release_order):
        if not any(relative_key(release_id, entry.key) == "release.json" for entry in groups[release_id]):
            raise RetentionError(
                f"{RELEASES_PREFIX}{release_id}/ has {len(groups[release_id])} object(s) but no release.json; "
                "refusing to treat it as a release — inspect that prefix by hand once, then re-run"
            )

    by_release = {decision.release: decision for decision in decisions}
    for role, release_id in (("live", live), ("staged", staged), ("rollback parent", parent)):
        if not release_id:
            continue
        decision = by_release.get(release_id)
        if decision is not None and decision.action != KEEP:
            raise RetentionError(
                f"the plan would {decision.action} {release_id}, which is the {role} release; keeping it is not optional"
            )

    for decision in decisions:
        prefix = f"{RELEASES_PREFIX}{decision.release}/"
        for entry in decision.delete:
            if not entry.key.startswith(prefix):
                raise RetentionError(f"the plan would delete {entry.key}, which is not under {prefix}")

    removed = sum(decision.remove_objects for decision in decisions)
    total = len(listing)
    if total and removed / total > MASS_DELETE_FRACTION and not force:
        raise RetentionError(
            f"the plan removes {removed:,} of {total:,} objects ({removed / total:.1%}) in one run, more than the "
            f"{MASS_DELETE_FRACTION:.0%} guard — that guard exists so a truncated listing cannot delete the bucket. "
            "Read the plan, then re-run with --force if it is right"
        )


# -- the plan -----------------------------------------------------------------
@dataclass
class Plan:
    live: str
    parent: str | None
    staged: str | None
    decisions: list[Decision]
    bucket_objects: int
    bucket_bytes: int
    quarters: int = DEFAULT_QUARTERS
    forced: bool = False
    generated_utc: str = ""
    ignored: list[IgnoredPrefix] = field(default_factory=list)

    def count(self, action: str) -> int:
        return sum(1 for decision in self.decisions if decision.action == action)

    @property
    def ignored_objects(self) -> int:
        return sum(row.objects for row in self.ignored)

    @property
    def ignored_bytes(self) -> int:
        return sum(row.bytes for row in self.ignored)

    @property
    def considered_objects(self) -> int:
        """Objects the plan looked at: the bucket minus what `--ignore-prefix` excluded."""
        return self.bucket_objects - self.ignored_objects

    @property
    def considered_bytes(self) -> int:
        return self.bucket_bytes - self.ignored_bytes

    @property
    def remove_objects(self) -> int:
        return sum(decision.remove_objects for decision in self.decisions)

    @property
    def remove_bytes(self) -> int:
        return sum(decision.remove_bytes for decision in self.decisions)

    @property
    def after_objects(self) -> int:
        return self.bucket_objects - self.remove_objects

    @property
    def after_bytes(self) -> int:
        """What stays in the bucket: ignored objects are untouched, so they still cost."""
        return self.bucket_bytes - self.remove_bytes

    @property
    def after_gb(self) -> float:
        """Storage after the plan, in the GB R2 bills in (10^9 bytes, not GiB)."""
        return self.after_bytes / GB

    @property
    def removal_fraction(self) -> float:
        """Deleted objects over *considered* objects — the 60% guard's ratio."""
        return self.remove_objects / self.considered_objects if self.considered_objects else 0.0

    def to_json(self) -> dict:
        return {
            "generated_utc": self.generated_utc,
            "live": self.live,
            "parent": self.parent,
            "staged": self.staged,
            "quarters": self.quarters,
            "forced": self.forced,
            "bucket": {"objects": self.bucket_objects, "bytes": self.bucket_bytes},
            "ignored": [row.to_json() for row in self.ignored],
            "considered": {"objects": self.considered_objects, "bytes": self.considered_bytes},
            "decisions": [decision.to_json() for decision in self.decisions],
            "totals": {
                "keep": self.count(KEEP),
                "stub": self.count(STUB),
                "delete": self.count(DELETE),
                "remove_objects": self.remove_objects,
                "deleted_bytes": self.remove_bytes,
                "kept_bytes": self.after_bytes,
                "after_objects": self.after_objects,
                "estimated_gb_after": round(self.after_gb, 3),
                "removal_fraction": round(self.removal_fraction, 4),
            },
        }


def read_pointer(client: R2Client, key: str, *, required: bool) -> dict | None:
    """Read a pointer object, or refuse if it exists but does not name a release."""
    try:
        body = client.get(key)
    except R2Error as error:
        if error.status == 404 and not required:
            return None
        if error.status == 404:
            raise RetentionError(
                f"{key} is missing (HTTP 404): the pointer is how the bucket says which release the site reads, "
                "so pruning without it could delete what is live"
            ) from error
        raise RetentionError(f"{key} is unreadable: {error}") from error
    try:
        document = json.loads(body)
    except json.JSONDecodeError as error:
        raise RetentionError(f"{key} is not JSON: {error}") from error
    if not isinstance(document, dict) or not isinstance(document.get("as_of"), str):
        raise RetentionError(f"{key} names no release (no string `as_of`); refusing to prune without knowing what is live")
    return document


def build_plan(
    client: R2Client,
    *,
    live: str | None = None,
    staged: str | None = None,
    quarters: int = DEFAULT_QUARTERS,
    force: bool = False,
    today: date | None = None,
    ignore_prefixes: Sequence[str] = (),
) -> Plan:
    """List the bucket, read the two pointers, decide, and refuse if anything is off.

    `live`/`staged` exist for tests and for a manual rehearsal: they skip the pointer
    read, which is the only reason a normal run needs the bucket's live state.
    `ignore_prefixes` are the operator's explicit exceptions, dropped before the
    decisions — and before every count that feeds a guard.
    """
    full = client.list_objects("")
    listing, ignored = split_ignored(full, ignore_prefixes)

    declared_parent: str | None = None
    if live:
        live_id = live
    else:
        document = read_pointer(client, LIVE_POINTER, required=True)
        assert document is not None  # required=True raises instead of returning None
        live_id = document["as_of"]
        if isinstance(document.get("parent"), str):
            declared_parent = document["parent"]

    hidden = [row.prefix for row in ignored if matches_prefix(f"{RELEASES_PREFIX}{live_id}/release.json", row.prefix)]
    if hidden:
        raise RetentionError(
            f"--ignore-prefix {hidden[0]} hides the live release {live_id}; the pointer's target has to stay "
            "visible, so this plan cannot be built"
        )

    if staged is not None:
        staged_id = staged or None
    else:
        document = read_pointer(client, STAGED_POINTER, required=False)
        staged_id = document["as_of"] if document else None

    parent = resolve_parent(release_groups(listing), live_id, declared_parent)
    decisions = plan_releases(listing, live_id, staged_id, quarters, parent=parent, today=today)
    # The refusals see the considered listing: an ignored prefix is not a release
    # missing its release.json, and it is not part of the mass-delete denominator.
    check_plan(decisions, listing, live=live_id, staged=staged_id, parent=parent, force=force)
    return Plan(
        live=live_id,
        parent=parent,
        staged=staged_id,
        decisions=decisions,
        bucket_objects=len(full),
        bucket_bytes=sum(entry.size for entry in full),
        quarters=quarters,
        forced=force,
        generated_utc=utc_now_iso(),
        ignored=ignored,
    )


# -- applying it --------------------------------------------------------------
@dataclass
class ApplyReport:
    deleted_objects: int = 0
    deleted_bytes: int = 0
    confirmed_objects: int = 0
    archived: list[str] = field(default_factory=list)
    after_objects: int | None = None
    after_bytes: int | None = None


def read_manifest(client: R2Client, release_id: str) -> dict:
    """The manifest is the proof a stub rests on, so it is read before anything is deleted."""
    key = f"{RELEASES_PREFIX}{release_id}/manifest.json"
    try:
        body = client.get(key)
    except R2Error as error:
        raise RetentionError(
            f"{key} is unreadable ({error}); a stub without the manifest has no proof of what it removed, "
            "so nothing was deleted"
        ) from error
    try:
        document = json.loads(body)
    except json.JSONDecodeError as error:
        raise RetentionError(f"{key} is not JSON: {error}") from error
    if document.get("as_of") != release_id:
        raise RetentionError(
            f"{key} says as_of {document.get('as_of')!r}, not {release_id!r}; the published path is derived from "
            "as_of, so the manifest does not describe this release — nothing was deleted"
        )
    return document


def archive_document(
    decision: Decision, manifest: dict, *, archived_utc: str | None = None
) -> dict:
    """The record a stub leaves behind: what went, and why it can be rebuilt."""
    return {
        "schema_version": 1,
        "kind": "archive-stub",
        "release": decision.release,
        "as_of": manifest.get("as_of"),
        "archived_utc": archived_utc or utc_now_iso(),
        "quarter": quarter_label(quarter_of(release_order(decision.release)[0])),
        "reason": decision.reason,
        "objects_removed": decision.remove_objects,
        "bytes_removed": decision.remove_bytes,
        "objects_kept": decision.kept_objects,
        "bytes_kept": decision.kept_bytes,
        "removed_prefixes": ["funds/", "companies/"],
        "kept": sorted(relative_key(decision.release, entry.key) for entry in decision.kept),
        "recovery": {
            "re_derivable": True,
            "manifest": "manifest.json",
            "pipeline_git_sha": manifest.get("pipeline_git_sha"),
            "fund_count": manifest.get("fund_count"),
            "company_count": manifest.get("company_count"),
            "statement": (
                "funds/ and companies/ were removed to stay inside the Cloudflare R2 free tier. They are derived "
                "data: the N-PORT filings they were built from are immutable at the SEC, manifest.json lists every "
                "published file with its sha256, and the parser that produced them is versioned by pipeline_git_sha "
                "— so the documents are re-derivable byte for byte from the release this file describes. Nothing "
                "in this release is lost; it is a deterministic rebuild, not a backup."
            ),
        },
    }


def apply_plan(plan: Plan, client: R2Client, *, yes: bool = False) -> ApplyReport:
    """Delete what the plan says to delete, batched, objects before the prefix.

    Safe to re-run: a delete of a missing key is not an error, and the next plan is
    computed from a fresh listing, so an interrupted run simply continues.
    """
    if not yes:
        raise RetentionError("apply deletes objects; it needs --yes once you have read the plan")

    # Read every stub's manifest first: a stub whose proof is unreadable must not
    # lose its bytes, and finding that out after the first deletion is too late.
    manifests = {
        decision.release: read_manifest(client, decision.release)
        for decision in plan.decisions
        if decision.action == STUB and decision.delete
    }

    report = ApplyReport()
    for decision in plan.decisions:
        removals = decision.delete
        if not removals:
            continue
        confirmed = 0
        for start in range(0, len(removals), DELETE_BATCH):
            chunk = [entry.key for entry in removals[start : start + DELETE_BATCH]]
            confirmed += client.delete_objects(chunk)
        removed_bytes = sum(entry.size for entry in removals)
        report.deleted_objects += len(removals)
        report.deleted_bytes += removed_bytes
        report.confirmed_objects += confirmed
        print(
            f"  {decision.action:<6} {decision.release:<16} {len(removals):>7,} object(s) / "
            f"{format_bytes(removed_bytes):>10}  {decision.reason}"
        )
        if decision.action == DELETE:
            # Objects first, then the prefix marker: an empty prefix is a leftover of
            # a tool that made one, and deleting it is a no-op when it never existed.
            client.delete_object(f"{RELEASES_PREFIX}{decision.release}/")
        elif decision.action == STUB:
            body = canonical_bytes(archive_document(decision, manifests[decision.release]))
            client.put(f"{RELEASES_PREFIX}{decision.release}/{ARCHIVE_OBJECT}", body, cache_control=IMMUTABLE)
            report.archived.append(decision.release)

    after = client.list_objects("")
    report.after_objects = len(after)
    report.after_bytes = sum(entry.size for entry in after)
    return report


# -- printing -----------------------------------------------------------------
def print_plan(plan: Plan, *, counts_only: bool = False) -> None:
    if not counts_only:
        print(
            f"  bucket: {plan.bucket_objects:,} objects / {format_bytes(plan.bucket_bytes)}"
            f"    live: {plan.live}    parent: {plan.parent or '—'}    staged: {plan.staged or '—'}"
        )
        print(f"  {'release':<16}{'action':<8}{'objects':>9}{'now':>12}{'after':>12}  reason")
        for decision in plan.decisions:
            print(
                f"  {decision.release:<16}{decision.action:<8}{decision.objects:>9,}"
                f"{format_bytes(decision.bytes):>12}{format_bytes(decision.kept_bytes):>12}  {decision.reason}"
            )
    for row in plan.ignored:
        print(
            f"  ignored: {row.prefix} ({row.objects:,} object(s) / {format_bytes(row.bytes)})"
            " — left out of the decisions, the totals and the guard"
        )
    print(
        f"  plan: {plan.count(KEEP)} keep, {plan.count(STUB)} stub, {plan.count(DELETE)} delete — removes "
        f"{plan.remove_objects:,} object(s) / {format_bytes(plan.remove_bytes)} "
        f"({plan.removal_fraction:.1%} of the {plan.considered_objects:,} considered objects); after ≈ "
        f"{plan.after_gb:.3f} GB of the {FREE_TIER_BYTES // GB} GB free tier "
        f"({plan.after_gb * GB / FREE_TIER_BYTES:.1%})"
    )
    if plan.after_bytes > FREE_TIER_BYTES:
        print("  warning: that is over the free tier — the policy cannot keep up with the release size; check the listing")


def print_apply_report(report: ApplyReport) -> None:
    archived = f", {len(report.archived)} archived ({', '.join(report.archived)})" if report.archived else ""
    print(
        f"\n  applied: removed {report.deleted_objects:,} object(s) / {format_bytes(report.deleted_bytes)}"
        f" ({report.confirmed_objects:,} confirmed by R2){archived}"
    )
    if report.after_objects is not None:
        after_bytes = report.after_bytes or 0
        print(
            f"  bucket after: {report.after_objects:,} objects / {format_bytes(after_bytes)} = "
            f"{after_bytes / GB:.3f} GB of the {FREE_TIER_BYTES // GB} GB free tier "
            f"({after_bytes / FREE_TIER_BYTES:.1%})"
        )


# -- CLI ----------------------------------------------------------------------
def connect() -> R2Client:
    """Build a client from the workspace `.env` / CI secrets; never prints a value."""
    release.load_env()
    credentials, endpoint, bucket = release.credentials_from_env()
    return R2Client(endpoint, bucket, credentials)


def _add_state_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--live", default=None, help="release id that is live (default: read latest/release.json)")
    parser.add_argument("--staged", default=None, help="staged candidate id; '' means there is none")
    parser.add_argument(
        "--force", action="store_true", help="allow a plan that removes more than 60%% of the bucket"
    )
    parser.add_argument(
        "--ignore-prefix",
        action="append",
        default=None,
        metavar="PREFIX",
        help="leave this prefix out of the plan entirely (repeatable); it is printed as `ignored`, "
        "counted nowhere, and is the operator's exception to the release.json guard",
    )


def main(argv: list[str] | None = None, *, client: R2Client | None = None) -> int:
    """`plan` prints and exits 0; a refusal exits 2; `apply` needs `--yes`."""
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.retention",
        description="Prune published releases to the live/staged pair, their rollback parent, and four quarterly stubs.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    plan_parser = commands.add_parser("plan", help="show what would be kept, stubbed and deleted; changes nothing")
    _add_state_arguments(plan_parser)
    plan_parser.add_argument("--dry-run-count", action="store_true", help="print the totals only, not the table")
    plan_parser.add_argument("--json", type=Path, default=None, help="write the plan as JSON")

    apply_parser = commands.add_parser("apply", help="perform the plan; refuses without --yes")
    _add_state_arguments(apply_parser)
    apply_parser.add_argument("--yes", action="store_true", help="required: actually delete objects")

    args = parser.parse_args(argv)

    try:
        connection = client or connect()
        plan = build_plan(
            connection,
            live=args.live or None,
            staged=args.staged,
            force=args.force,
            ignore_prefixes=args.ignore_prefix or (),
        )
    except (RetentionError, release.ReleaseError) as error:
        print(f"REFUSED: {error}")
        return 2

    if args.command == "plan":
        print_plan(plan, counts_only=args.dry_run_count)
        if args.json is not None:
            args.json.parent.mkdir(parents=True, exist_ok=True)
            args.json.write_text(json.dumps(plan.to_json(), indent=2) + "\n", encoding="utf-8")
            print(f"  json: {args.json}")
        return 0

    print_plan(plan)
    if not args.yes:
        print("\n  refusing to delete anything: re-run with --yes once this plan is what you want")
        return 2
    try:
        report = apply_plan(plan, connection, yes=True)
    except RetentionError as error:
        print(f"REFUSED: {error}")
        return 2
    except R2Error as error:
        print(f"FAIL: {error}")
        print("  a partial run is safe to repeat: the next plan is computed from a fresh listing")
        return 1
    print_apply_report(report)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
