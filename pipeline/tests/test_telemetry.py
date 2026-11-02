"""Telemetry ledger tests: append semantics, parsing, and the shape of one line.

The ledger is the only durable answer to "how have the nightly runs been going?", so the
two failure modes that matter are covered first: a line must never be lost on the way in,
and a torn or hand-edited line must not take the rest of the file with it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline import r2, telemetry

VERIFY_LIVE_TEXT = """\
verify-live  site=https://unpackfund.com  data=https://data.unpackfund.com  repo=MitchellRLayton/unpackfund

ok   pointer        live release 2026-11-02.7 (generated 2026-11-02T20:53:36Z), 9,112 funds, 15,287 companies
ok   catalogue      sha256 c8b128eea19859eb… matches the pointer; as_of 2026-11-02.7
ok   pages          /f/VTI/ 99.3% mapped = catalogue 99.3%
ok   handoff        promotion 41532647157 (2026-11-02T21:54:01Z) -> deploy-site run 41533232600, success
ok   routes         / 200, /x/ 200, /funds/ 200
"""


class FakeStore:
    """The two R2 calls a ledger uses, in memory."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.puts: list[tuple[str, dict]] = []

    def get(self, key: str) -> bytes:
        if key not in self.objects:
            raise r2.R2Error("GetObject", 404, "NoSuchKey", key)
        return self.objects[key]

    def put(self, key: str, body: bytes, **kwargs) -> str:
        self.objects[key] = body
        self.puts.append((key, kwargs))
        return "etag"


def write_artifacts(root: Path, release: str = "2026-11-02.7") -> Path:
    """A run's artifacts directory, as `upload-artifact` receives it."""
    (root / "releases" / release).mkdir(parents=True)
    (root / "triage").mkdir()
    (root / "releases" / release / "upload-report.json").write_text(
        json.dumps(
            {
                "release": release,
                "objects": [{"key": f"releases/{release}/funds/AAPL.json"}] * 3,
                "total_bytes": 558168069,
                "failures": [],
                "live_pointer_release": "2026-11-02.6",
                "started_at": "2026-11-02T20:53:36+00:00",
                "finished_at": "2026-11-02T21:19:34+00:00",
            }
        )
    )
    (root / "releases" / release / "build-summary.json").write_text(
        json.dumps({"fund_count": 9112, "company_count": 15287, "elapsed_seconds": 1626.2})
    )
    (root / "triage" / "index.json").write_text(
        json.dumps({"release": release, "total": 3259, "by_kind": {"nav_mismatch": 1077, "no_filing": 1793}})
    )
    return root


def test_append_creates_the_ledger_then_adds_one_line_at_a_time():
    store = FakeStore()
    first = telemetry.append(store, "nightly", {"ts": "2026-11-01T00:00:00Z", "release": "2026-11-01.1"})
    second = telemetry.append(store, "nightly", {"ts": "2026-11-02T00:00:00Z", "release": "2026-11-02.7"})

    assert [record["release"] for record in first] == ["2026-11-01.1"]
    assert [record["release"] for record in second] == ["2026-11-01.1", "2026-11-02.7"]
    assert len(store.objects[telemetry.LEDGERS["nightly"]].decode().splitlines()) == 2
    # A ledger changes every run: it cannot be served immutable from the edge.
    assert store.puts[-1][1]["cache_control"] == r2.NO_CACHE
    assert store.puts[-1][1]["content_type"] == telemetry.LEDGER_CONTENT_TYPE


def test_append_keeps_only_the_last_records():
    store = FakeStore()
    for day in range(5):
        telemetry.append(store, "nightly", {"ts": f"2026-11-0{day + 1}T00:00:00Z"}, max_records=2)
    kept = [record["ts"] for record in telemetry.load(store, "nightly")]
    assert kept == ["2026-11-04T00:00:00Z", "2026-11-05T00:00:00Z"]


def test_a_torn_line_does_not_lose_the_rest():
    assert telemetry.loads('{"a": 1}\n{"b": \n\n{"c": 3}\n') == [{"a": 1}, {"c": 3}]


def test_parse_verify_live_reads_the_printed_report():
    record = telemetry.parse_verify_live(VERIFY_LIVE_TEXT, run_id="41523584117")
    assert record["ok"] is True
    assert record["release"] == "2026-11-02.7"
    assert record["funds"] == 9112
    assert record["companies"] == 15287
    assert record["site"] == "https://unpackfund.com"
    assert [check["check"] for check in record["checks"]] == [
        "pointer",
        "catalogue",
        "pages",
        "handoff",
        "routes",
    ]


def test_parse_verify_live_marks_a_failed_check():
    text = VERIFY_LIVE_TEXT.replace(
        "ok   catalogue      sha256", "FAIL catalogue      sha256"
    )
    record = telemetry.parse_verify_live(text)
    assert record["ok"] is False
    assert [c["check"] for c in record["checks"] if c["status"] == "fail"] == ["catalogue"]


def test_nightly_record_distils_the_artifacts(tmp_path):
    record = telemetry.nightly_record(write_artifacts(tmp_path), run_id="41518452777")
    assert record["release"] == "2026-11-02.7"
    assert record["objects"] == 3
    assert record["bytes"] == 558168069
    assert record["funds"] == 9112
    assert record["triage"] == {"total": 3259, "by_kind": {"nav_mismatch": 1077, "no_filing": 1793}}
    assert record["failures"] == []
    assert record["status"] == "ok"
    assert record["publish_seconds"] == pytest.approx(1558.0)


def test_a_failed_night_still_produces_a_line(tmp_path):
    root = write_artifacts(tmp_path)
    report = json.loads((root / "releases" / "2026-11-02.7" / "upload-report.json").read_text())
    report["failures"] = ["releases/2026-11-02.7/funds/BNDC.json public GET returned 520"]
    (root / "releases" / "2026-11-02.7" / "upload-report.json").write_text(json.dumps(report))

    record = telemetry.nightly_record(root, kind="build", status="failure")
    assert record["status"] == "failure"
    assert record["failures"] == ["releases/2026-11-02.7/funds/BNDC.json public GET returned 520"]


def test_a_run_that_wrote_no_artifact_still_produces_a_line(tmp_path):
    record = telemetry.nightly_record(tmp_path, kind="idle", status="ok", run_id="1")
    assert record["release"] is None
    assert record["objects"] is None
    assert record["triage"] is None
    assert record["kind"] == "idle"
    assert record["status"] == "ok"


def test_a_promotion_line_carries_the_release_it_promoted(tmp_path):
    """`promote` writes no artifacts, so the release comes from the pointer it moved."""
    record = telemetry.nightly_record(
        tmp_path, kind="promote", status="ok", release="2026-11-02.7", run_id="41532647157"
    )
    assert record["kind"] == "promote"
    assert record["release"] == "2026-11-02.7"
    assert record["status"] == "ok"
    assert record["objects"] is None


def test_an_explicit_release_wins_over_a_stale_artifact(tmp_path):
    """A promote runs days after the build; the artifacts it can see are the old night's."""
    root = write_artifacts(tmp_path)
    record = telemetry.nightly_record(root, kind="promote", release="2026-11-02.7")
    assert record["release"] == "2026-11-02.7"
    assert telemetry.nightly_record(root)["release"] == "2026-11-02.7"


def test_the_cli_accepts_a_promote_line(tmp_path, monkeypatch, capsys):
    store = FakeStore()
    monkeypatch.setattr(telemetry, "client_from_env", lambda: store)
    code = telemetry.main(
        [
            "append", "--ledger", "nightly", "--kind", "promote", "--status", "ok",
            "--release", "2026-11-02.7", "--artifacts", str(tmp_path), "--run-id", "41532647157",
        ]
    )
    assert code == 0
    written = telemetry.load(store, "nightly")
    assert len(written) == 1
    assert written[0]["kind"] == "promote"
    assert written[0]["release"] == "2026-11-02.7"
    assert written[0]["run_id"] == "41532647157"


def test_render_calls_out_failures():
    table = telemetry.render(
        [
            {
                "ts": "2026-11-02T16:26:00Z",
                "kind": "build",
                "release": "2026-11-02.3",
                "objects": 21958,
                "bytes": 558168069,
                "triage": {"total": 3259},
                "failures": ["releases/2026-11-02.3/funds/BNDC.json public GET returned 520"],
            }
        ],
        ledger="nightly",
    )
    assert "2026-11-02.3" in table
    assert "**Failures**" in table
    assert "BNDC.json public GET returned 520" in table
