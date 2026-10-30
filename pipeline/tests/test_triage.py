"""The triage log, tested offline: rules, record shape, merge, index, exit codes.

The messages in `REAL` are copied verbatim from the 2026-10-30.5 release's
``build-summary.json``, because a classifier tested only on invented strings
would pass while the real distribution is misread. The numbers in them (funds,
dollars, line numbers) are what the rules have to ignore.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from pipeline import triage

REAL = {
    "no_filing": (
        "NoFilingError: AAAD: series 'S000104986' has no N-PORT filing in the newest "
        "282 filings of CIK 0001727074 — closed fund or money-market fund (MMFs report "
        "on N-MFP, never on N-PORT)"
    ),
    "leverage": (
        "GateError: AAAIX: schedule reconciles to total assets (785,930,514 of "
        "789,085,717) but not to net assets (735,098,853); liabilities are 53,986,864 "
        "and no single cash row matches them, so this is leverage, not a truncated filing"
    ),
    "nav_mismatch": (
        "GateError: AAA: holdings sum to 41,410,793 vs netAssets 44,906,491 (7.78%) "
        "— over the 5% band"
    ),
    "size": (
        "GateError: BIGFUND: artifact is 2,044,119 bytes, over the 2,000,000-byte budget"
    ),
    "parse": "NportParseError: malformed XML: no element found: line 3459, column 0",
    "no_holdings": "WeightError: filing reports no holdings",
    "series": (
        "LookupError: ZZZZ: not in company_tickers_mf.json and no override row — add "
        "pipeline/overrides/tickers.csv (cik, series_id, registrant) rather than guessing"
    ),
    "other": "RuntimeError: a failure mode nobody has seen before",
}

REQUIRED_KINDS = {
    "no_filing",
    "leverage",
    "nav_mismatch",
    "size",
    "parse",
    "series",
    "other",
}


def summary_document(failures: list[dict], release: str) -> dict:
    return {
        "attempted": 5,
        "fund_count": 1,
        "release": release,
        "failed": failures,
        "funds": 1,
        "generated_at": "2026-10-30T03:02:03Z",
    }


def make_release(
    root: Path, failures: list[dict], *, release: str = "2026-10-30.5"
) -> Path:
    """A release directory with only the file this module reads."""
    release_dir = root / "releases" / release
    release_dir.mkdir(parents=True)
    (release_dir / triage.SUMMARY_NAME).write_text(
        json.dumps(summary_document(failures, release)), encoding="utf-8"
    )
    return release_dir


def failure(ticker: str, kind: str, *, cik: str = "0000000001") -> dict:
    return {"ticker": ticker, "cik": cik, "error": REAL[kind]}


def read_lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


DAY = date(2026, 10, 30)
T1 = datetime(2026, 10, 30, 3, 2, 3, tzinfo=UTC)
T2 = datetime(2026, 10, 30, 7, 45, 0, tzinfo=UTC)


# -- classification ----------------------------------------------------------
@pytest.mark.parametrize("expected,message", sorted(REAL.items()))
def test_each_real_message_classifies_to_its_kind(expected, message):
    assert triage.classify(message) == expected


def test_rule_table_is_ordered_data_ending_with_other():
    kinds = [kind for kind, _ in triage.RULES]
    assert isinstance(triage.RULES, list)  # data a reviewer can read and tune in place
    assert kinds[-1] == "other"
    assert len(kinds) == len(set(kinds))
    assert REQUIRED_KINDS <= set(kinds)
    assert triage.KINDS == tuple(kinds)
    assert all(isinstance(pattern, re.Pattern) for _, pattern in triage.RULES)


def test_a_message_naming_a_series_is_a_filing_problem_not_a_series_problem():
    # The real no-filing message contains "series"; `no_filing` must win, or 1,818
    # money-market funds would be triaged as series-resolution bugs.
    assert "series" in REAL["no_filing"]
    assert triage.classify(REAL["no_filing"]) == "no_filing"


def test_other_is_total_including_multiline_messages():
    assert triage.classify("RuntimeError: boom\nline two") == "other"
    assert triage.classify("") == "other"


# -- record shape ------------------------------------------------------------
def test_jsonl_record_has_the_contract_keys_in_order(tmp_path):
    release_dir = make_release(tmp_path, [failure("AAA", "no_filing"), failure("BBB", "parse")])
    result = triage.log_release(release_dir, day=DAY, out_dir=tmp_path / "artifacts", now=T1)

    records = read_lines(result.day_path)
    assert [list(record) for record in records] == [list(triage.RECORD_KEYS)] * 2
    first = records[0]
    assert first["release"] == "2026-10-30.5"
    assert first["ticker"] == "AAA"
    assert first["cik"] == "0000000001"
    assert first["kind"] == "no_filing"
    assert first["error"] == REAL["no_filing"]
    assert first["state"] == "open"
    assert first["seen"] == 1
    assert first["logged_utc"] == first["first_seen"] == first["last_seen"]
    assert first["logged_utc"].startswith("2026-10-30T03:02:03")
    assert result.total == 2
    assert result.entries == 2


def test_day_file_and_index_paths_default_to_out_triage(tmp_path):
    release_dir = make_release(tmp_path, [failure("AAA", "nav_mismatch")])
    result = triage.log_release(release_dir, day=DAY, out_dir=tmp_path / "artifacts", now=T1)
    assert result.day_path == tmp_path / "artifacts" / "triage" / "2026-10-30.jsonl"
    assert result.index_path == tmp_path / "artifacts" / "triage" / "index.json"


# -- merge -------------------------------------------------------------------
def test_running_twice_merges_instead_of_duplicating(tmp_path):
    release_dir = make_release(tmp_path, [failure("AAA", "leverage"), failure("BBB", "size")])
    out = tmp_path / "artifacts"
    first = triage.log_release(release_dir, day=DAY, out_dir=out, now=T1)
    original = read_lines(first.day_path)
    second = triage.log_release(release_dir, day=DAY, out_dir=out, now=T2)
    merged = read_lines(second.day_path)

    assert len(merged) == len(original) == 2
    by_ticker = {record["ticker"]: record for record in merged}
    for before, after in zip(original, merged):
        assert after["first_seen"] == before["first_seen"]  # the original sighting survives
        assert after["seen"] == before["seen"] + 1
        assert after["last_seen"] == T2.isoformat(timespec="seconds")
        assert after["last_seen"] > before["last_seen"]
    assert by_ticker["AAA"]["kind"] == "leverage"
    assert second.total == 2


def test_first_seen_is_carried_across_days_and_seen_keeps_counting(tmp_path):
    release_dir = make_release(tmp_path, [failure("AAA", "no_filing")])
    out = tmp_path / "artifacts"
    day_one = triage.log_release(release_dir, day=DAY, out_dir=out, now=T1)
    day_two = triage.log_release(
        release_dir, day=DAY + timedelta(days=1), out_dir=out, now=T1 + timedelta(days=1)
    )

    [yesterday] = read_lines(day_one.day_path)
    [today] = read_lines(day_two.day_path)
    assert today["first_seen"] == yesterday["first_seen"] == T1.isoformat(timespec="seconds")
    assert today["seen"] == 2
    assert today["last_seen"] == (T1 + timedelta(days=1)).isoformat(timespec="seconds")


def test_a_failure_that_stops_being_reported_keeps_its_line(tmp_path):
    # Append-only: the second run has nothing to log, and yesterday's line is
    # still there when the same day is re-read.
    release_dir = make_release(tmp_path, [failure("AAA", "parse")])
    out = tmp_path / "artifacts"
    emptiness = make_release(tmp_path / "second", [], release="2026-10-30.5")
    first = triage.log_release(release_dir, day=DAY, out_dir=out, now=T1)
    triage.log_release(emptiness, day=DAY, out_dir=out, now=T2)
    assert len(read_lines(first.day_path)) == 1


def test_two_releases_on_one_day_do_not_merge_into_each_other(tmp_path):
    older = make_release(
        tmp_path / "a", [failure("AAA", "no_filing"), failure("BBB", "size")], release="2026-10-30.4"
    )
    newer = make_release(tmp_path / "b", [failure("AAA", "leverage")], release="2026-10-30.5")
    out = tmp_path / "artifacts"
    first = triage.log_release(older, day=DAY, out_dir=out, now=T1)
    before = {record["ticker"]: record for record in read_lines(first.day_path)}
    second = triage.log_release(newer, day=DAY, out_dir=out, now=T2)
    after = read_lines(second.day_path)

    assert len(after) == 3
    unchanged = [record for record in after if record["release"] == "2026-10-30.4"]
    assert {record["ticker"]: record for record in unchanged} == before
    assert second.total == 1
    assert second.by_kind["leverage"] == 1


def test_merge_keeps_extra_keys_an_operator_added(tmp_path):
    release_dir = make_release(tmp_path, [failure("AAA", "no_filing")])
    out = tmp_path / "artifacts"
    first = triage.log_release(release_dir, day=DAY, out_dir=out, now=T1)
    record = read_lines(first.day_path)[0]
    record["note"] = "asked the issuer; MMF by design"
    first.day_path.write_text(json.dumps(record) + "\n", encoding="utf-8")

    triage.log_release(release_dir, day=DAY, out_dir=out, now=T2)
    [merged] = read_lines(first.day_path)
    assert merged["note"] == "asked the issuer; MMF by design"
    assert merged["seen"] == 2


def test_a_corrupt_historical_day_file_is_skipped_with_a_warning(tmp_path, capsys):
    release_dir = make_release(tmp_path, [failure("AAA", "no_filing")])
    out = tmp_path / "artifacts"
    day_dir = out / "triage"
    day_dir.mkdir(parents=True)
    yesterday = day_dir / "2026-10-29.jsonl"
    yesterday.write_text("{broken\n", encoding="utf-8")

    result = triage.log_release(release_dir, day=DAY, out_dir=out, now=T1)
    assert "WARN skipping unreadable day file 2026-10-29.jsonl" in capsys.readouterr().out
    assert yesterday.read_text() == "{broken\n"  # untouched
    assert result.total == 1
    assert [entry["date"] for entry in json.loads(result.index_path.read_text())["days"]] == [
        "2026-10-30"
    ]


def test_a_corrupt_day_file_for_today_is_refused_instead_of_overwritten(tmp_path):
    release_dir = make_release(tmp_path, [failure("AAA", "no_filing")])
    out = tmp_path / "artifacts"
    day_dir = out / "triage"
    day_dir.mkdir(parents=True)
    today = day_dir / "2026-10-30.jsonl"
    today.write_text("{broken\n", encoding="utf-8")

    with pytest.raises(triage.TriageError) as error:
        triage.log_release(release_dir, day=DAY, out_dir=out, now=T1)
    assert "refusing to merge over it" in str(error.value)
    assert today.read_text() == "{broken\n"  # nothing was silently dropped


# -- index -------------------------------------------------------------------
def test_index_totals_and_days(tmp_path):
    release_dir = make_release(
        tmp_path,
        [
            failure("AAA", "no_filing"),
            failure("BBB", "no_filing"),
            failure("CCC", "nav_mismatch"),
        ],
    )
    out = tmp_path / "artifacts"
    first = triage.log_release(release_dir, day=DAY, out_dir=out, now=T1)
    second = triage.log_release(
        release_dir, day=DAY + timedelta(days=1), out_dir=out, now=T2 + timedelta(days=1)
    )

    index = json.loads(second.index_path.read_text())
    assert index["release"] == "2026-10-30.5"
    assert index["total"] == 3
    assert index["by_kind"]["no_filing"] == 2
    assert index["by_kind"]["nav_mismatch"] == 1
    assert set(index["by_kind"]) == set(triage.KINDS)  # zeros included, stable columns
    assert [entry["date"] for entry in index["days"]] == ["2026-10-30", "2026-10-31"]
    assert [entry["total"] for entry in index["days"]] == [3, 3]
    assert index["days"][1]["by_kind"]["no_filing"] == 2
    assert index["generated_utc"].startswith("2026-10-31T07:45:00")
    assert json.loads(first.index_path.read_text())["total"] == 3


def test_custom_index_path_is_used_and_uploaded_by_name(tmp_path):
    release_dir = make_release(tmp_path, [failure("AAA", "size")])
    out = tmp_path / "artifacts"
    index_path = tmp_path / "elsewhere" / "history.json"
    result = triage.log_release(
        release_dir, day=DAY, out_dir=out, index_path=index_path, now=T1
    )
    assert result.index_path == index_path
    assert json.loads(index_path.read_text())["total"] == 1
    assert result.day_path == out / "triage" / "2026-10-30.jsonl"


def test_a_clean_release_writes_an_empty_day_file_and_a_zero_index(tmp_path):
    release_dir = make_release(tmp_path, [])
    out = tmp_path / "artifacts"
    result = triage.log_release(release_dir, day=DAY, out_dir=out, now=T1)
    assert result.total == 0
    assert result.day_path.read_text() == ""
    assert json.loads(result.index_path.read_text())["total"] == 0


# -- CLI exit codes ----------------------------------------------------------
def test_cli_writes_the_log_and_exits_zero_even_with_failures(tmp_path, capsys):
    release_dir = make_release(tmp_path, [failure("AAA", "no_filing"), failure("BBB", "leverage")])
    out = tmp_path / "artifacts"
    code = triage.main(["--release", str(release_dir), "--out", str(out), "--date", "2026-10-30"])
    captured = capsys.readouterr().out
    assert code == 0
    assert "2 failure(s)" in captured
    assert "no_filing" in captured and "leverage" in captured
    assert (out / "triage" / "2026-10-30.jsonl").is_file()


def test_cli_missing_release_directory_exits_two(tmp_path, capsys):
    code = triage.main(
        ["--release", str(tmp_path / "nope"), "--out", str(tmp_path / "artifacts")]
    )
    assert code == 2
    assert "not a directory" in capsys.readouterr().out


def test_cli_release_without_build_summary_exits_two(tmp_path, capsys):
    release_dir = tmp_path / "2026-10-30.5"
    release_dir.mkdir()
    code = triage.main(["--release", str(release_dir), "--out", str(tmp_path / "artifacts")])
    assert code == 2
    assert triage.SUMMARY_NAME in capsys.readouterr().out


def test_cli_unreadable_summary_exits_two(tmp_path, capsys):
    release_dir = tmp_path / "2026-10-30.5"
    release_dir.mkdir()
    (release_dir / triage.SUMMARY_NAME).write_text("{not json")
    code = triage.main(["--release", str(release_dir), "--out", str(tmp_path / "artifacts")])
    assert code == 2
    assert "not readable JSON" in capsys.readouterr().out


def test_cli_bad_date_is_a_usage_error(tmp_path):
    release_dir = make_release(tmp_path, [])
    with pytest.raises(SystemExit) as error:
        triage.main(["--release", str(release_dir), "--date", "30-10-2026"])
    assert error.value.code == 2


# -- upload ------------------------------------------------------------------
class FakeClient:
    """Records puts the way `R2Client` would have made them."""

    def __init__(self):
        self.puts: list[tuple[str, bytes, str, str]] = []

    def put(self, key, body, *, content_type="", cache_control="") -> str:
        self.puts.append((key, body, content_type, cache_control))
        return "etag"


@pytest.fixture
def no_env(monkeypatch):
    """No credentials, and no workspace `.env` to refill them from."""
    for name in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(triage, "load_env", lambda *args, **kwargs: [])
    return monkeypatch


@pytest.fixture
def r2_env(no_env):
    no_env.setenv("R2_ENDPOINT", "https://account.r2.example")
    no_env.setenv("R2_ACCESS_KEY_ID", "key-id")
    no_env.setenv("R2_SECRET_ACCESS_KEY", "secret-not-printed")
    return no_env


def test_upload_without_credentials_exits_two_and_writes_nothing(tmp_path, no_env, capsys):
    release_dir = make_release(tmp_path, [failure("AAA", "no_filing")])
    out = tmp_path / "artifacts"
    code = triage.main(
        ["--release", str(release_dir), "--out", str(out), "--upload", "--date", "2026-10-30"]
    )
    assert code == 2
    captured = capsys.readouterr().out
    assert "R2_ENDPOINT" in captured and "missing credential" in captured
    assert not (out / "triage").exists()  # a true no-op, nothing half-written


def test_upload_publishes_day_file_and_index_under_triage(tmp_path, r2_env, monkeypatch, capsys):
    release_dir = make_release(tmp_path, [failure("AAA", "nav_mismatch"), failure("BBB", "series")])
    out = tmp_path / "artifacts"
    client = FakeClient()
    monkeypatch.setattr(triage, "R2Client", lambda endpoint, bucket, credentials: client)

    code = triage.main(
        [
            "--release",
            str(release_dir),
            "--out",
            str(out),
            "--upload",
            "--date",
            "2026-10-30",
        ]
    )
    captured = capsys.readouterr().out
    assert code == 0, captured
    keys = [key for key, *_ in client.puts]
    assert keys == ["triage/2026-10-30.jsonl", "triage/index.json"]
    cache_controls = {cache_control for *_, cache_control in client.puts}
    assert cache_controls == {triage.NO_CACHE}
    day_body = client.puts[0][1].decode()
    assert json.loads(day_body.splitlines()[0])["ticker"] == "AAA"
    index_body = json.loads(client.puts[1][1])
    assert index_body["total"] == 2 and index_body["by_kind"]["series"] == 1
    assert "triage/2026-10-30.jsonl" in captured


def test_upload_failure_exits_two(tmp_path, r2_env, monkeypatch, capsys):
    release_dir = make_release(tmp_path, [failure("AAA", "no_filing")])

    class Exploding(FakeClient):
        def put(self, key, body, **kwargs):
            raise triage.R2Error("PUT", 403, "AccessDenied", key)

    monkeypatch.setattr(triage, "R2Client", lambda *args: Exploding())
    code = triage.main(
        [
            "--release",
            str(release_dir),
            "--out",
            str(tmp_path / "artifacts"),
            "--upload",
            "--date",
            "2026-10-30",
        ]
    )
    assert code == 2
    assert "upload failed" in capsys.readouterr().out


# -- the log against a real-shaped summary -----------------------------------
def test_a_summary_shaped_like_the_real_one_logs_every_row(tmp_path):
    # 200 rows, 7 kinds, the way the 2026-10-30.5 build-summary looks: the point is
    # that nothing is dropped and the counts sum to the row count.
    kinds = ["no_filing", "nav_mismatch", "leverage", "parse", "size", "series", "other"]
    rows = [
        {"ticker": f"T{index:03d}", "cik": f"{index:010d}", "error": REAL[kinds[index % 7]]}
        for index in range(200)
    ]
    release_dir = make_release(tmp_path, rows)
    result = triage.log_release(
        release_dir, day=DAY, out_dir=tmp_path / "artifacts", now=T1
    )
    assert result.entries == 200
    assert result.total == 200
    assert sum(result.by_kind.values()) == 200
    assert len(read_lines(result.day_path)) == 200
    index = json.loads(result.index_path.read_text())
    assert index["total"] == 200
    assert sum(index["by_kind"].values()) == 200
