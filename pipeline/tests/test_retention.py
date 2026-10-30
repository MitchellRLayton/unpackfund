"""Retention: the decision is arithmetic, so the tests are arithmetic.

`plan_releases` is a pure function over a bucket listing — no network, no clock
unless a test pins one — because a policy that deletes data can only be trusted if
its keep/stub/delete choice is checkable without a bucket. The apply path runs
against a fake bucket that records every batch, so "objects before the prefix,
1,000 keys per request" is an assertion rather than a hope.

The two client verbs this command added (a paginated listing and a batched delete)
are pinned here as well: nothing else in the suite calls them, and the listing one
carries a signing subtlety — `sigv4.canonical_query` takes the query *decoded*, so
signing the wire URL double-encodes `prefix` and `continuation-token` into a 403.
"""

from __future__ import annotations

import hashlib
import io
import json
import urllib.error
from datetime import date

import pytest

from pipeline import release, retention, r2
from pipeline.r2 import ObjectEntry, R2Error

#: 2026Q4, so the four most recent completed quarters are 2026Q3, Q2, Q1, 2025Q4.
TODAY = date(2026, 10, 30)

#: The five root objects + one index shard + companies/index.json + per-fund and
#: per-company shards: 11 objects for the default sizes below.
SMALL = ("release.json", "manifest.json", "catalogue.json", "tickers.json", "aliases.json")


def stored(release_id: str, *, funds: int = 2, companies: int = 2, archived: bool = False) -> dict[str, bytes]:
    """One release as the bucket holds it: real pointer/manifest JSON, filler elsewhere."""
    prefix = f"releases/{release_id}/"
    objects = {
        f"{prefix}release.json": json.dumps({"kind": "release", "as_of": release_id}).encode(),
        f"{prefix}manifest.json": json.dumps(
            {"as_of": release_id, "pipeline_git_sha": "abc123", "fund_count": funds, "company_count": companies}
        ).encode(),
        f"{prefix}catalogue.json": b"c" * 900,
        f"{prefix}tickers.json": b"t" * 100,
        f"{prefix}aliases.json": b"a" * 200,
        f"{prefix}index/A.json": b"i" * 300,
        f"{prefix}companies/index.json": b"ci" * 350,
    }
    for index in range(companies):
        objects[f"{prefix}companies/c_{index:010d}.json"] = b"k" * 1400
    for index in range(funds):
        objects[f"{prefix}funds/T{index}.json"] = b"f" * 4000
    if archived:
        objects[f"{prefix}ARCHIVED.json"] = b'{"kind": "archive-stub"}'
    return objects


def listing(*release_ids: str, **kwargs) -> list[ObjectEntry]:
    """A bucket listing for these releases, as `list_objects` would return it."""
    entries: list[ObjectEntry] = []
    for release_id in release_ids:
        entries += [ObjectEntry(key, len(body)) for key, body in stored(release_id, **kwargs).items()]
    return entries


class FakeBucket:
    """A bucket in a dict: listing, pointers, batched deletes, and what it wrote."""

    def __init__(self, objects: dict[str, bytes]):
        self.objects = dict(objects)
        self.batches: list[list[str]] = []
        self.prefix_deletes: list[str] = []
        self.puts: list[tuple[str, str]] = []

    def list_objects(self, prefix: str = "") -> list[ObjectEntry]:
        return [ObjectEntry(key, len(body)) for key, body in sorted(self.objects.items()) if key.startswith(prefix)]

    def get(self, key: str) -> bytes:
        if key not in self.objects:
            raise R2Error("GET", 404, "NoSuchKey", key)
        return self.objects[key]

    def delete_objects(self, keys) -> int:
        batch = list(keys)
        assert len(batch) <= r2.DELETE_BATCH_LIMIT, f"batch of {len(batch)} exceeds the S3 limit"
        self.batches.append(batch)
        for key in batch:
            self.objects.pop(key, None)
        return len(batch)

    def delete_object(self, key: str) -> None:
        self.prefix_deletes.append(key)
        self.objects.pop(key, None)

    def put(self, key: str, body: bytes, *, content_type: str = "", cache_control: str = "") -> str:
        self.objects[key] = body
        self.puts.append((key, cache_control))
        return "etag"


def bucket(release_ids, *, live: str | None = None, staged: str | None = None, **kwargs) -> FakeBucket:
    objects: dict[str, bytes] = {}
    for release_id in release_ids:
        objects.update(stored(release_id, **kwargs))
    if live is not None:
        objects[release.LIVE_POINTER] = json.dumps({"kind": "release", "as_of": live}).encode()
    if staged is not None:
        objects[retention.STAGED_POINTER] = json.dumps({"kind": "release", "as_of": staged}).encode()
    return FakeBucket(objects)


def actions(decisions) -> dict[str, str]:
    return {decision.release: decision.action for decision in decisions}


# -- selection ----------------------------------------------------------------
def test_keeps_live_staged_and_rollback_parent_and_deletes_the_rest():
    """Twelve daily releases: three are live/staged/parent, one is the quarter stub."""
    release_ids = [
        "2026-07-01", "2026-07-15", "2026-08-01", "2026-08-15", "2026-09-01", "2026-09-15",
        "2026-10-01", "2026-10-15", "2026-10-20", "2026-10-25", "2026-10-29", "2026-10-30",
    ]
    decisions = retention.plan_releases(
        listing(*release_ids), "2026-10-29", "2026-10-30", parent="2026-10-25", today=TODAY
    )

    assert actions(decisions) == {
        # The three that must never be touched: the pointer target, today's staged
        # candidate, and yesterday's live release (the rollback target).
        "2026-10-29": retention.KEEP,
        "2026-10-30": retention.KEEP,
        "2026-10-25": retention.KEEP,
        # One snapshot of the last completed quarter…
        "2026-09-15": retention.STUB,
        # …and everything else goes.
        "2026-07-01": retention.DELETE,
        "2026-07-15": retention.DELETE,
        "2026-08-01": retention.DELETE,
        "2026-08-15": retention.DELETE,
        "2026-09-01": retention.DELETE,
        "2026-10-01": retention.DELETE,
        "2026-10-15": retention.DELETE,
        "2026-10-20": retention.DELETE,
    }
    reasons = {decision.release: decision.reason for decision in decisions}
    assert "live pointer" in reasons["2026-10-29"]
    assert "staged candidate" in reasons["2026-10-30"]
    assert "rollback parent" in reasons["2026-10-25"]
    assert "2026Q3" in reasons["2026-09-15"] and "stub" in reasons["2026-09-15"]
    assert "superseded by 2026-09-15" in reasons["2026-09-01"]
    assert "2026Q4 is not a completed quarter" in reasons["2026-10-20"]


def test_quarterly_stub_is_the_newest_of_each_of_four_completed_quarters():
    """Q3 2026, Q2, Q1 and Q4 2025 each keep exactly their newest release."""
    release_ids = [
        "2025-10-01", "2025-11-15",          # 2025Q4 → 2025-11-15 is the stub
        "2026-03-15", "2026-02-01",          # 2026Q1 → 2026-03-15
        "2026-04-01", "2026-06-30",          # 2026Q2 → 2026-06-30
        "2026-07-01", "2026-09-30",          # 2026Q3 → 2026-09-30
        "2026-10-01", "2026-10-30",          # 2026Q4 → live/staged only
    ]
    decisions = retention.plan_releases(listing(*release_ids), "2026-10-30", "2026-10-01", today=TODAY)
    stubs = [decision.release for decision in decisions if decision.action == retention.STUB]

    assert sorted(stubs) == ["2025-11-15", "2026-03-15", "2026-06-30", "2026-09-30"]


def test_a_quarter_outside_the_window_is_deleted_not_stubbed():
    """Only four stubs exist; an older quarter's newest release still goes."""
    release_ids = [
        "2025-04-01", "2025-06-30",   # 2025Q2, outside the window
        "2025-11-15",                 # 2025Q4, inside it
        "2026-03-15", "2026-06-30", "2026-09-30",
        "2026-10-29", "2026-10-30",
    ]
    decisions = retention.plan_releases(
        listing(*release_ids), "2026-10-29", "2026-10-30", parent="2026-10-25", today=TODAY
    )
    by_action = actions(decisions)

    assert by_action["2025-11-15"] == retention.STUB
    assert by_action["2025-06-30"] == retention.DELETE
    assert by_action["2025-04-01"] == retention.DELETE
    assert "outside the 4 most recent completed quarters" in next(
        decision.reason for decision in decisions if decision.release == "2025-06-30"
    )


def test_rollback_parent_is_kept_even_when_it_is_not_the_newest():
    """After a rollback the live pointer names an older release; keep its predecessor.

    The newer releases in the bucket then have no protection at all — they are the
    failed candidate and its rebuild, and the whole point of the rollback is that the
    site does not read them.
    """
    release_ids = ["2026-10-01", "2026-10-15", "2026-10-20", "2026-10-25"]
    groups = retention.release_groups(listing(*release_ids))
    parent = retention.resolve_parent(groups, "2026-10-15")
    assert parent == "2026-10-01"

    decisions = retention.plan_releases(
        listing(*release_ids), "2026-10-15", None, parent=parent, today=TODAY
    )
    by_action = actions(decisions)
    assert by_action["2026-10-15"] == retention.KEEP
    assert by_action["2026-10-01"] == retention.KEEP
    assert by_action["2026-10-20"] == retention.DELETE
    assert by_action["2026-10-25"] == retention.DELETE


def test_staged_candidate_is_kept_even_when_its_quarter_is_old():
    """A rehearsal that sat for a quarter is still the staged candidate, not a stub."""
    release_ids = ["2026-08-01", "2026-09-15", "2026-10-29", "2026-10-30"]
    decisions = retention.plan_releases(listing(*release_ids), "2026-10-29", "2026-08-01", today=TODAY)
    by_action = actions(decisions)

    assert by_action["2026-08-01"] == retention.KEEP
    assert "staged candidate" in next(d.reason for d in decisions if d.release == "2026-08-01")
    # The quarter still gets a snapshot: the newest release that is not a keeper.
    assert by_action["2026-09-15"] == retention.STUB


def test_live_and_staged_can_be_the_same_release():
    decisions = retention.plan_releases(
        listing("2026-10-29", "2026-10-30"), "2026-10-30", "2026-10-30", parent="2026-10-29", today=TODAY
    )
    live = next(decision for decision in decisions if decision.release == "2026-10-30")

    assert live.action == retention.KEEP
    assert "live pointer" in live.reason and "staged candidate" in live.reason
    assert next(decision for decision in decisions if decision.release == "2026-10-29").action == retention.KEEP


def test_resolve_parent_prefers_a_declared_value_and_falls_back_to_the_listing():
    groups = retention.release_groups(listing("2026-10-01", "2026-10-15", "2026-10-25"))

    assert retention.resolve_parent(groups, "2026-10-25") == "2026-10-15"
    assert retention.resolve_parent(groups, "2026-10-25", declared="2026-10-01") == "2026-10-01"
    # A declared parent the bucket no longer holds is not trusted.
    assert retention.resolve_parent(groups, "2026-10-25", declared="2026-09-01") == "2026-10-15"
    assert retention.resolve_parent(groups, "2026-10-01") is None


# -- the stub's keep-list -----------------------------------------------------
def test_stub_keeps_exactly_the_small_objects():
    """A stub keeps the proof and the index, and drops funds/ and companies/."""
    decisions = retention.plan_releases(listing("2026-09-15", "2026-10-29"), "2026-10-29", None, today=TODAY)
    stub = next(decision for decision in decisions if decision.action == retention.STUB)

    kept = sorted(retention.relative_key(stub.release, entry.key) for entry in stub.kept)
    removed = sorted(retention.relative_key(stub.release, entry.key) for entry in stub.delete)

    assert kept == ["aliases.json", "catalogue.json", "index/A.json", "manifest.json", "release.json", "tickers.json"]
    assert removed == [
        "companies/c_0000000000.json",
        "companies/c_0000000001.json",
        "companies/index.json",
        "funds/T0.json",
        "funds/T1.json",
    ]
    assert stub.objects == 11
    assert stub.objects - stub.remove_objects == len(kept)
    assert stub.bytes - stub.remove_bytes == sum(entry.size for entry in stub.kept)
    assert stub.remove_bytes > stub.kept_bytes  # the bytes are the point


def test_stub_keeps_the_archive_record_it_already_wrote():
    decisions = retention.plan_releases(
        listing("2026-09-15", "2026-10-29", archived=True), "2026-10-29", None, today=TODAY
    )
    stub = next(decision for decision in decisions if decision.release == "2026-09-15")

    assert stub.action == retention.KEEP
    assert "already archived" in stub.reason
    assert stub.remove_objects == 0


# -- refusals -----------------------------------------------------------------
def test_plan_refuses_without_a_live_pointer():
    fake = bucket(["2026-10-29", "2026-10-30"], live=None)

    with pytest.raises(retention.RetentionError, match="missing"):
        retention.build_plan(fake, today=TODAY)


def test_plan_refuses_an_unreadable_live_pointer():
    class Broken(FakeBucket):
        def get(self, key):
            raise R2Error("GET", 500, "InternalError", key)

    with pytest.raises(retention.RetentionError, match="unreadable"):
        retention.build_plan(Broken(bucket(["2026-10-29"], live="2026-10-29").objects), today=TODAY)


def test_plan_refuses_a_pointer_that_names_no_release():
    fake = bucket(["2026-10-29"], live="2026-10-29")
    fake.objects[release.LIVE_POINTER] = json.dumps({"kind": "release"}).encode()

    with pytest.raises(retention.RetentionError, match="names no release"):
        retention.build_plan(fake, today=TODAY)


def test_plan_refuses_a_release_prefix_without_release_json():
    """The real bucket has one: `releases/2026-10-28/smoke.json`, a smoke test."""
    fake = bucket(["2026-10-29", "2026-10-30"], live="2026-10-29")
    fake.objects["releases/2026-10-27/smoke.json"] = b"{}"

    with pytest.raises(retention.RetentionError, match="no release.json"):
        retention.build_plan(fake, today=TODAY)


def test_plan_refuses_a_release_id_it_cannot_place():
    fake = bucket(["2026-10-29"], live="2026-10-29")
    fake.objects["releases/latest-ish/manifest.json"] = b"{}"

    with pytest.raises(retention.RetentionError, match="not a release id"):
        retention.build_plan(fake, today=TODAY)


def test_check_plan_refuses_to_delete_the_live_release():
    fake = bucket(["2026-10-29", "2026-10-30"], live="2026-10-29")
    live_id = "2026-10-29"
    tampered = retention.Decision(live_id, retention.DELETE, "a listing bug did this", tuple(fake.list_objects(f"releases/{live_id}/")))

    with pytest.raises(retention.RetentionError, match="live release"):
        retention.check_plan([tampered], fake.list_objects(""), live=live_id)


def test_check_plan_refuses_to_stub_the_staged_release():
    fake = bucket(["2026-10-29", "2026-10-30"], live="2026-10-29")
    staged_id = "2026-10-30"
    tampered = retention.Decision(staged_id, retention.STUB, "a policy edit did this", tuple(fake.list_objects(f"releases/{staged_id}/")))

    with pytest.raises(retention.RetentionError, match="staged release"):
        retention.check_plan([tampered], fake.list_objects(""), live="2026-10-29", staged=staged_id)


def test_check_plan_refuses_to_delete_the_rollback_parent():
    fake = bucket(["2026-10-25", "2026-10-29"], live="2026-10-29")
    parent_id = "2026-10-25"
    tampered = retention.Decision(parent_id, retention.DELETE, "a policy edit did this", tuple(fake.list_objects(f"releases/{parent_id}/")))

    with pytest.raises(retention.RetentionError, match="rollback parent"):
        retention.check_plan([tampered], fake.list_objects(""), live="2026-10-29", parent=parent_id)


def test_check_plan_refuses_a_delete_outside_its_own_release_prefix():
    entries = (ObjectEntry("latest/release.json", 10),)
    decisions = [retention.Decision("2026-08-01", retention.DELETE, "a listing bug did this", entries)]

    with pytest.raises(retention.RetentionError, match="not under releases/2026-08-01/"):
        retention.check_plan(decisions, listing("2026-08-01", "2026-10-29"), live="2026-10-29")


def test_mass_delete_guard_refuses_above_sixty_percent_unless_forced():
    """The first real cleanup removes 70% of the bucket: read it, then --force."""
    release_ids = [
        "2026-07-01", "2026-07-15", "2026-08-01", "2026-08-15", "2026-09-01", "2026-09-15",
        "2026-10-01", "2026-10-15", "2026-10-20", "2026-10-25", "2026-10-29", "2026-10-30",
    ]
    entries = listing(*release_ids)
    decisions = retention.plan_releases(entries, "2026-10-29", "2026-10-30", parent="2026-10-25", today=TODAY)
    removed = sum(decision.remove_objects for decision in decisions)

    assert removed / len(entries) > retention.MASS_DELETE_FRACTION
    with pytest.raises(retention.RetentionError, match="guard"):
        retention.check_plan(decisions, entries, live="2026-10-29", staged="2026-10-30", parent="2026-10-25")
    # --force is the operator saying "I read the plan", not a way to skip the check.
    retention.check_plan(
        decisions, entries, live="2026-10-29", staged="2026-10-30", parent="2026-10-25", force=True
    )


# -- the plan document --------------------------------------------------------
def test_plan_json_shape_and_totals(tmp_path):
    fake = bucket(
        ["2026-10-01", "2026-10-15", "2026-10-20", "2026-10-29", "2026-10-30"],
        live="2026-10-29",
        staged="2026-10-30",
    )
    plan = retention.build_plan(fake, force=True, today=TODAY)
    document = plan.to_json()

    assert set(document) == {
        "generated_utc", "live", "parent", "staged", "quarters", "forced", "bucket", "ignored",
        "considered", "decisions", "totals"
    }
    assert document["ignored"] == []
    assert document["live"] == "2026-10-29"
    assert document["parent"] == "2026-10-20"
    assert document["staged"] == "2026-10-30"
    assert len(document["decisions"]) == 5
    assert set(document["decisions"][0]) == {
        "release", "action", "objects", "bytes", "remove_objects", "remove_bytes", "kept_objects", "kept_bytes", "reason"
    }

    totals = document["totals"]
    assert totals["keep"] == 3 and totals["stub"] == 0 and totals["delete"] == 2
    assert totals["remove_objects"] == sum(decision.remove_objects for decision in plan.decisions)
    assert totals["deleted_bytes"] == plan.remove_bytes
    assert totals["kept_bytes"] == document["bucket"]["bytes"] - plan.remove_bytes
    assert totals["after_objects"] == document["bucket"]["objects"] - totals["remove_objects"]
    assert totals["estimated_gb_after"] == round(plan.after_gb, 3)


def test_help_renders_for_both_subcommands(capsys):
    """argparse does `help % params`, so an unescaped `%` in a help string raises TypeError."""
    for command in ("plan", "apply"):
        with pytest.raises(SystemExit) as exit_info:
            retention.main([command, "--help"])
        assert exit_info.value.code == 0
        printed = capsys.readouterr().out
        assert "--ignore-prefix" in printed and "60% of the bucket" in printed


def test_cli_plan_writes_json_and_prints_the_table(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(
        ["2026-10-01", "2026-10-15", "2026-10-20", "2026-10-29", "2026-10-30"],
        live="2026-10-29",
        staged="2026-10-30",
    )
    target = tmp_path / "retention-plan.json"

    assert retention.main(["plan", "--json", str(target)], client=fake) == 0

    printed = capsys.readouterr().out
    assert "live: 2026-10-29" in printed
    assert "plan: 3 keep, 0 stub, 2 delete" in printed
    document = json.loads(target.read_text())
    assert document["totals"]["delete"] == 2


def test_cli_plan_dry_run_count_prints_only_the_totals(capsys, monkeypatch):
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-10-01", "2026-10-15", "2026-10-20", "2026-10-29"], live="2026-10-29")

    assert retention.main(["plan", "--dry-run-count"], client=fake) == 0

    printed = capsys.readouterr().out
    assert "plan: 2 keep, 0 stub, 2 delete" in printed
    assert "release            action" not in printed  # the per-release table is what it skips


def test_cli_plan_exits_two_on_a_refusal(capsys, monkeypatch):
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-10-29"], live=None)

    assert retention.main(["plan"], client=fake) == 2
    assert "REFUSED" in capsys.readouterr().out


def test_cli_missing_credentials_exit_two(capsys, monkeypatch):
    def missing():
        raise release.ReleaseError("missing credential(s): R2_ENDPOINT")

    monkeypatch.setattr(retention, "connect", missing)
    assert retention.main(["plan"]) == 2
    assert "REFUSED" in capsys.readouterr().out


# -- --ignore-prefix: the operator's explicit exception -------------------------
def test_ignored_prefix_is_absent_from_the_plan_and_reported_with_its_count(monkeypatch):
    """A 73-byte smoke test that was never a release must not stop the nightly prune."""
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-10-01", "2026-10-29"], live="2026-10-29")
    fake.objects["releases/2026-10-28/smoke.json"] = b"{}"
    with pytest.raises(retention.RetentionError, match="no release.json"):
        retention.build_plan(fake, today=TODAY)

    plan = retention.build_plan(fake, ignore_prefixes=["releases/2026-10-28"], today=TODAY)

    assert "2026-10-28" not in [decision.release for decision in plan.decisions]
    assert [row.to_json() for row in plan.ignored] == [
        {"prefix": "releases/2026-10-28", "objects": 1, "bytes": 2}
    ]
    document = plan.to_json()
    assert document["ignored"] == [{"prefix": "releases/2026-10-28", "objects": 1, "bytes": 2}]
    assert document["bucket"]["objects"] == 24  # ignored objects are still in the bucket, with the pointer
    assert document["considered"]["objects"] == 23
    # A trailing slash, a leading slash and a repeat all name the same prefix once.
    again = retention.build_plan(fake, ignore_prefixes=["/releases/2026-10-28/", "releases/2026-10-28"], today=TODAY)
    assert len(again.ignored) == 1


def test_ignored_bytes_are_not_counted_in_the_deleted_totals(monkeypatch):
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-10-01", "2026-10-29"], live="2026-10-29")
    fake.objects.update(stored("2026-09-20"))          # a real-looking release we want excluded
    fake.objects["releases/2026-09-20/funds/BIG.json"] = b"x" * 10_000
    ignored_bytes = sum(entry.size for entry in fake.list_objects("releases/2026-09-20/"))

    without = retention.build_plan(fake, today=TODAY)
    stub = next(decision for decision in without.decisions if decision.release == "2026-09-20")
    assert stub.action == retention.STUB and stub.remove_bytes > 0

    plan = retention.build_plan(fake, ignore_prefixes=["releases/2026-09-20"], today=TODAY)
    assert "2026-09-20" not in [decision.release for decision in plan.decisions]
    assert plan.ignored_bytes == ignored_bytes
    # Its bytes are gone from the deleted total, not moved into another release's row.
    assert plan.remove_bytes == without.remove_bytes - stub.remove_bytes
    assert plan.considered_bytes == plan.bucket_bytes - ignored_bytes
    # Storage after the plan still includes the ignored prefix: it costs, it is just not ours to prune.
    assert plan.after_bytes == plan.bucket_bytes
    assert plan.to_json()["totals"]["deleted_bytes"] == 0


def test_ignored_prefix_does_not_count_toward_the_mass_delete_guard(monkeypatch):
    """The 70% is only reached by counting the ignored prefix as deletions."""
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(
        ["2026-10-01", "2026-10-15", "2026-10-29"],
        live="2026-10-29",
    )
    fake.objects.update(stored("2026-10-02", funds=40, companies=20))  # 60 extra objects to delete

    unignored = retention.build_plan(fake, today=TODAY, force=True)
    assert unignored.removal_fraction > retention.MASS_DELETE_FRACTION
    with pytest.raises(retention.RetentionError, match="guard"):
        retention.check_plan(
            unignored.decisions, fake.list_objects(""), live="2026-10-29"
        )

    plan = retention.build_plan(fake, ignore_prefixes=["releases/2026-10-02"], today=TODAY)
    assert plan.removal_fraction <= retention.MASS_DELETE_FRACTION
    assert plan.remove_objects == 11  # only 2026-10-01 is deleted; the ignored prefix is not
    assert plan.considered_objects == 34


def test_ignoring_the_live_release_is_refused():
    fake = bucket(["2026-10-01", "2026-10-29"], live="2026-10-29")
    with pytest.raises(retention.RetentionError, match="hides the live release"):
        retention.build_plan(fake, ignore_prefixes=["releases/2026-10-29"], today=TODAY)


def test_cli_ignore_prefix_is_repeatable_and_printed_as_ignored(capsys, monkeypatch):
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-10-01", "2026-10-15", "2026-10-29"], live="2026-10-29")
    fake.objects["releases/2026-10-28/smoke.json"] = b"{}"
    fake.objects["releases/2026-10-27/smoke.json"] = b"{}"

    assert retention.main(
        ["plan", "--ignore-prefix", "releases/2026-10-28", "--ignore-prefix", "releases/2026-10-27"],
        client=fake,
    ) == 0

    printed = capsys.readouterr().out
    assert "ignored: releases/2026-10-28 (1 object(s) / 2 B)" in printed
    assert "ignored: releases/2026-10-27 (1 object(s) / 2 B)" in printed
    assert "plan: 2 keep, 0 stub, 1 delete" in printed


def test_cli_apply_accepts_ignore_prefix_and_leaves_it_alone(capsys, monkeypatch):
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-10-01", "2026-10-15", "2026-10-29"], live="2026-10-29")
    fake.objects["releases/2026-10-28/smoke.json"] = b"{}"

    assert retention.main(
        ["apply", "--ignore-prefix", "releases/2026-10-28", "--yes"], client=fake
    ) == 0

    assert fake.objects["releases/2026-10-28/smoke.json"] == b"{}"
    assert not any(key.startswith("releases/2026-10-01/") for key in fake.objects)
    assert "ignored: releases/2026-10-28" in capsys.readouterr().out


# -- apply --------------------------------------------------------------------
def test_apply_refuses_without_yes_and_changes_nothing(capsys, monkeypatch):
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-10-01", "2026-10-29"], live="2026-10-29")
    before = dict(fake.objects)

    assert retention.main(["apply"], client=fake) == 2

    assert "refusing to delete anything" in capsys.readouterr().out
    assert fake.objects == before and fake.batches == []


def test_apply_deletes_in_batches_objects_before_the_prefix(monkeypatch):
    """2,500 fund documents are three requests, then the prefix marker goes."""
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(
        ["2026-10-20", "2026-10-25", "2026-10-29"], live="2026-10-29", funds=2500
    )
    plan = retention.build_plan(fake, force=True, today=TODAY)

    report = retention.apply_plan(plan, fake, yes=True)

    assert [len(batch) for batch in fake.batches] == [1000, 1000, 509]
    assert all(key.startswith("releases/2026-10-20/") for batch in fake.batches for key in batch)
    assert fake.prefix_deletes == ["releases/2026-10-20/"]
    assert not any(key.startswith("releases/2026-10-20/") for key in fake.objects)
    assert report.deleted_objects == len(fake.batches[0]) + len(fake.batches[1]) + len(fake.batches[2])
    assert report.confirmed_objects == report.deleted_objects
    assert report.after_objects == len(fake.list_objects(""))
    assert report.after_bytes == sum(entry.size for entry in fake.list_objects(""))


def test_apply_stub_removes_the_bytes_and_writes_the_archive_record(monkeypatch):
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-09-15", "2026-10-25", "2026-10-29"], live="2026-10-29")
    plan = retention.build_plan(fake, today=TODAY)
    stub = next(decision for decision in plan.decisions if decision.action == retention.STUB)
    removed_objects, removed_bytes = stub.remove_objects, stub.remove_bytes

    report = retention.apply_plan(plan, fake, yes=True)

    archive_key = "releases/2026-09-15/ARCHIVED.json"
    assert report.archived == ["2026-09-15"]
    assert fake.puts == [(archive_key, r2.IMMUTABLE)]
    assert not any(key.startswith(("releases/2026-09-15/funds/", "releases/2026-09-15/companies/")) for key in fake.objects)
    for kept in ("manifest.json", "release.json", "catalogue.json", "tickers.json", "aliases.json", "index/A.json"):
        assert f"releases/2026-09-15/{kept}" in fake.objects
    assert fake.prefix_deletes == []  # a stub keeps its prefix

    document = json.loads(fake.objects[archive_key])
    assert document["kind"] == "archive-stub"
    assert document["release"] == "2026-09-15"
    assert document["quarter"] == "2026Q3"
    assert document["objects_removed"] == removed_objects
    assert document["bytes_removed"] == removed_bytes
    assert document["objects_kept"] == stub.kept_objects
    assert document["removed_prefixes"] == ["funds/", "companies/"]
    assert document["recovery"]["re_derivable"] is True
    assert document["recovery"]["pipeline_git_sha"] == "abc123"
    assert "immutable at the SEC" in document["recovery"]["statement"]
    assert "manifest.json" in document["kept"] and "index/A.json" in document["kept"]


def test_apply_is_idempotent(monkeypatch):
    """A second run re-plans to nothing: the stub is archived, the deletes are gone."""
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-07-01", "2026-09-15", "2026-10-25", "2026-10-29"], live="2026-10-29")
    first = retention.build_plan(fake, force=True, today=TODAY)
    retention.apply_plan(first, fake, yes=True)

    second = retention.build_plan(fake, today=TODAY)
    assert all(decision.action == retention.KEEP for decision in second.decisions)
    assert second.remove_objects == 0

    report = retention.apply_plan(second, fake, yes=True)
    assert report.deleted_objects == 0 and report.archived == []


def test_apply_refuses_when_a_stub_manifest_is_unreadable(monkeypatch):
    """A stub without its manifest has no proof, so nothing is deleted at all."""
    monkeypatch.setattr(retention, "utc_today", lambda: TODAY)
    fake = bucket(["2026-09-15", "2026-10-25", "2026-10-29"], live="2026-10-29")
    fake.objects["releases/2026-09-15/manifest.json"] = b"{not json"
    plan = retention.build_plan(fake, today=TODAY)
    before = dict(fake.objects)

    with pytest.raises(retention.RetentionError, match="not JSON"):
        retention.apply_plan(plan, fake, yes=True)
    assert fake.objects == before and fake.batches == []


# -- the r2 verbs this command needed ----------------------------------------
class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200, headers: dict | None = None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def client_with(pages: list[bytes], captured: list) -> r2.R2Client:
    queue = list(pages)

    def opener(request, timeout=None):
        captured.append(request)
        return FakeResponse(queue.pop(0) if queue else b"")

    return r2.R2Client("https://acct.r2.cloudflarestorage.com", "unpackfund-artifacts", r2.Credentials("AKID", "secret"), opener=opener)


def list_page(keys: list[tuple[str, int]], token: str | None = None, truncated: bool = False) -> bytes:
    contents = "".join(f"<Contents><Key>{key}</Key><Size>{size}</Size></Contents>" for key, size in keys)
    body = f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">{contents}'
    if truncated:
        body += f"<IsTruncated>true</IsTruncated><NextContinuationToken>{token}</NextContinuationToken>"
    else:
        body += "<IsTruncated>false</IsTruncated>"
    return (body + "</ListBucketResult>").encode()


def test_list_objects_follows_continuation_tokens_and_reads_sizes():
    captured: list = []
    client = client_with(
        [
            list_page([("releases/a/manifest.json", 12)], token="abc/def==", truncated=True),
            list_page([("releases/a/funds/VOO.json", 34)]),
        ],
        captured,
    )

    entries = client.list_objects("releases/")

    assert entries == [ObjectEntry("releases/a/manifest.json", 12), ObjectEntry("releases/a/funds/VOO.json", 34)]
    assert len(captured) == 2
    assert "continuation-token=abc%2Fdef%3D%3D" in captured[1].full_url


def test_list_objects_signs_the_decoded_query(monkeypatch):
    """`sigv4` canonicalises a *decoded* query; signing the wire URL double-encodes it.

    Measured against the real bucket: the double-encoded form is a 403
    `SignatureDoesNotMatch` on any listing with a `prefix` or a continuation token.
    """
    signed: list[str] = []
    real_sign = r2.sign

    def spy(method, url, **kwargs):
        signed.append(url)
        return real_sign(method, url, **kwargs)

    monkeypatch.setattr(r2, "sign", spy)
    captured: list = []
    client = client_with([list_page([("releases/a/manifest.json", 12)], token="abc/def==", truncated=True)], captured)
    client._list_page("releases/", "abc/def==", 1000)

    # The wire URL is percent-encoded…
    assert "prefix=releases%2F" in captured[0].full_url
    assert "continuation-token=abc%2Fdef%3D%3D" in captured[0].full_url
    # …and the signature is computed over the values themselves.
    assert signed[0].endswith(
        "?list-type=2&max-keys=1000&prefix=releases/&continuation-token=abc/def=="
    )


def test_list_objects_refuses_a_truncated_page_with_no_token():
    body = b"<ListBucketResult><Contents><Key>a</Key></Contents><IsTruncated>true</IsTruncated></ListBucketResult>"
    client = client_with([body], [])

    with pytest.raises(R2Error, match="no continuation token"):
        client.list_objects("releases/")


def delete_result(deleted: list[str], errors: list[tuple[str, str]] | None = None) -> bytes:
    body = "".join(f"<Deleted><Key>{key}</Key></Deleted>" for key in deleted)
    for key, code in errors or []:
        body += f"<Error><Key>{key}</Key><Code>{code}</Code></Error>"
    return f'<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">{body}</DeleteResult>'.encode()


def test_delete_objects_sends_one_batch_request_with_the_keys_and_a_content_md5():
    captured: list = []
    client = client_with([delete_result(["releases/a/funds/VOO.json"])], captured)

    assert client.delete_objects(["releases/a/funds/VOO.json"]) == 1

    request = captured[0]
    headers = {name.lower(): value for name, value in request.header_items()}
    assert request.get_method() == "POST"
    assert request.full_url.endswith("/unpackfund-artifacts?delete")
    assert b"<Key>releases/a/funds/VOO.json</Key>" in request.data
    assert headers["content-type"] == r2.XML_CONTENT_TYPE
    import base64

    assert headers["content-md5"] == base64.b64encode(hashlib.md5(request.data).digest()).decode()
    assert "content-md5" in headers["authorization"]


def test_delete_objects_counts_a_missing_key_as_deleted_and_raises_on_a_hard_error():
    client = client_with([delete_result([], errors=[("releases/a/x.json", "NoSuchKey")])], [])
    assert client.delete_objects(["releases/a/x.json"]) == 1

    client = client_with([delete_result([], errors=[("releases/a/x.json", "AccessDenied")])], [])
    with pytest.raises(R2Error, match="AccessDenied"):
        client.delete_objects(["releases/a/x.json"])


def test_delete_objects_rejects_more_than_one_batch():
    client = client_with([], [])
    with pytest.raises(ValueError, match="at most 1000"):
        client.delete_objects([f"releases/a/funds/{index}.json" for index in range(r2.DELETE_BATCH_LIMIT + 1)])


def test_delete_object_swallows_404():
    def missing(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b""))

    absent = r2.R2Client("https://e", "b", r2.Credentials("AKID", "secret"), opener=missing)
    absent.delete_object("releases/a/funds/gone.json")  # idempotent: not an error

    def forbidden(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, io.BytesIO(b"<Error/>"))

    with pytest.raises(R2Error):
        r2.R2Client("https://e", "b", r2.Credentials("AKID", "secret"), opener=forbidden).delete_object("releases/a/x.json")
