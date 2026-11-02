"""The compact benchmark object: the rollup rule, its bytes, and the release gate.

The object exists for one reason — the ledger's comparison column needs 2,374
numbers and the fund document behind them is 1.58 MB — so these tests pin the two
things that make it safe to replace a filing with a derived file:

* the rollup is *the same rule the consumer uses* (unmapped rows and rows filed at
  0 bp are dropped, everything else is summed per company), and
* the validator recomputes it from the fund document, so a release cannot publish a
  compact file that disagrees with the filing it claims to summarise.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from pipeline import benchmarks, validate
from pipeline import fixtures
from pipeline.artifact import canonical_bytes

from .conftest import write_release


def _document(ticker: str = "TEST", rows: list[dict] | None = None) -> dict:
    return {
        "schema_version": 1,
        "ticker": ticker,
        "fund_id": "S000000001",
        "name": "Test Index Fund",
        "issuer": "Test Issuer",
        "etf": False,
        "as_of": "2026-06-30",
        "filed_at": "2026-08-28",
        "lag_days": 59,
        "source": "SEC N-PORT",
        "source_url": "https://www.sec.gov/Archives/edgar/data/1/x/primary_doc.xml",
        "coverage_pct": 97.8,
        "holdings": rows
        if rows is not None
        else [
            {"company_id": "c_2", "name": "Second", "ticker": "B", "asset_cat": "equity", "weight_bp": 300},
            {"company_id": "c_1", "name": "First", "ticker": "A", "asset_cat": "equity", "weight_bp": 500},
            {"company_id": None, "name": "Untraced line", "ticker": None, "asset_cat": "equity", "weight_bp": 100},
            {"company_id": "c_3", "name": "Rounds to nothing", "ticker": "C", "asset_cat": "equity", "weight_bp": 0},
            {"company_id": "c_1", "name": "First, second class", "ticker": "A2", "asset_cat": "equity", "weight_bp": 200},
        ],
        "metrics": {"hhi": 0.1, "hhi_pct2": 1000.0, "effective_n": 10.0, "top10_pct": 80.0},
        "warnings": [],
    }


def test_rollup_drops_unmapped_and_zero_rows_and_sums_by_company():
    weights = benchmarks.rollup(_document())
    # c_1 appears twice and is summed; the unmapped row and the 0 bp row are gone.
    assert weights == {"c_1": 700, "c_2": 300}
    # Sorted by company id, so the serialised bytes cannot depend on filing order.
    assert list(weights) == sorted(weights)


def test_rollup_keeps_integer_basis_points():
    for value in benchmarks.rollup(_document()).values():
        assert isinstance(value, int)


def test_object_copies_its_provenance_from_the_fund_document():
    document = _document()
    compact = benchmarks.build_benchmark_object(document)
    for field in ("fund_id", "name", "as_of", "filed_at", "lag_days", "coverage_pct", "source_url"):
        assert compact[field] == document[field]
    assert compact["kind"] == "benchmark"
    assert compact["ticker"] == "TEST"
    # The issuer and the metrics are not part of the comparison, so they are not
    # copied: an object with two jobs would stop being small.
    assert "issuer" not in compact
    assert "metrics" not in compact


def test_an_empty_rollup_is_an_error_not_an_empty_object():
    with pytest.raises(ValueError):
        benchmarks.build_benchmark_object(
            _document(rows=[{"company_id": None, "name": "x", "ticker": None, "asset_cat": "equity", "weight_bp": 5}])
        )


def test_serialisation_is_compact_and_byte_stable():
    body = benchmarks.canonical_bytes(benchmarks.build_benchmark_object(_document()))
    assert body.endswith(b"\n")
    assert b"\n  " not in body, "the object must be one line: indenting it would 2.4x its bytes"
    assert benchmarks.canonical_bytes(json.loads(body)) == body


def test_the_compact_object_is_far_smaller_than_the_document_it_replaces():
    # A VT-shaped filing: 9,770 rows, 2,374 companies at >= 1 bp, the rest rounding
    # to nothing. The measured live object is 43 kB against 1.58 MB.
    rows = [
        {"company_id": f"c_{index:010d}", "name": f"Company {index}", "ticker": None, "asset_cat": "equity", "weight_bp": 4}
        for index in range(2_374)
    ] + [
        {"company_id": f"c_{index:010d}", "name": f"Tiny {index}", "ticker": None, "asset_cat": "equity", "weight_bp": 0}
        for index in range(2_374, 9_770)
    ]
    document = _document(rows=rows)
    compact = benchmarks.canonical_bytes(benchmarks.build_benchmark_object(document))
    full = canonical_bytes(document)
    assert benchmarks.size_ok(compact)
    assert len(compact) * 10 < len(full), f"{len(compact):,} B vs {len(full):,} B"


def test_only_configured_tickers_are_pre_rolled():
    documents = [_document("TEST"), _document("OTHER")]
    built = benchmarks.build_benchmark_documents(documents, ("TEST",))
    assert set(built) == {"TEST"}
    # A release that does not publish the ticker publishes no object, and the app
    # falls back to the fund document it can always fetch.
    assert benchmarks.build_benchmark_documents([_document("OTHER")], ("TEST",)) == {}


def test_production_ticker_is_configured():
    assert "VT" in benchmarks.BENCHMARK_TICKERS


def test_the_fixture_release_publishes_a_valid_benchmark(tmp_path):
    release_dir = write_release(tmp_path, [fixtures.sample_document()], benchmarks=("TEST",))
    assert validate.validate(release_dir) == 0
    compact = json.loads((release_dir / "benchmarks/TEST.json").read_text())
    # Byte for byte what the builder's rule says it should be — not a hand-typed map.
    assert compact["weights"] == benchmarks.rollup(fixtures.sample_document())
    assert len(compact["weights"]) == 3
    descriptor = json.loads((release_dir / "release.json").read_text())
    entry = descriptor["objects"]["benchmarks"]["files"]["TEST"]
    assert entry["path"] == "benchmarks/TEST.json"
    assert entry["bytes"] == (release_dir / "benchmarks/TEST.json").stat().st_size


def _repair_descriptor(release_dir, ticker: str, payload: bytes) -> None:
    """Re-hash one benchmark entry so a test can isolate the rollup check."""
    release_path = release_dir / "release.json"
    descriptor = json.loads(release_path.read_text())
    entry = descriptor["objects"]["benchmarks"]["files"][ticker]
    entry["bytes"] = len(payload)
    entry["sha256"] = hashlib.sha256(payload).hexdigest()
    release_path.write_bytes(canonical_bytes(descriptor))


def test_validator_rejects_a_rollup_that_disagrees_with_the_fund(tmp_path):
    release_dir = write_release(tmp_path, [fixtures.sample_document()], benchmarks=("TEST",))
    path = release_dir / "benchmarks/TEST.json"
    compact = json.loads(path.read_text())
    first = sorted(compact["weights"])[0]
    compact["weights"][first] += 1
    payload = benchmarks.canonical_bytes(compact)
    path.write_bytes(payload)
    _repair_descriptor(release_dir, "TEST", payload)
    assert validate.validate(release_dir) == 1


def test_validator_rejects_provenance_that_drifted_from_the_filing(tmp_path):
    release_dir = write_release(tmp_path, [fixtures.sample_document()], benchmarks=("TEST",))
    path = release_dir / "benchmarks/TEST.json"
    compact = json.loads(path.read_text())
    compact["coverage_pct"] = 100.0
    payload = benchmarks.canonical_bytes(compact)
    path.write_bytes(payload)
    _repair_descriptor(release_dir, "TEST", payload)
    assert validate.validate(release_dir) == 1


def test_validator_rejects_an_object_the_descriptor_omits(tmp_path):
    release_dir = write_release(tmp_path, [fixtures.sample_document()], benchmarks=("TEST",))
    release_path = release_dir / "release.json"
    descriptor = json.loads(release_path.read_text())
    descriptor["objects"].pop("benchmarks")
    release_path.write_bytes(canonical_bytes(descriptor))
    assert validate.validate(release_dir) == 1


def test_validator_rejects_an_object_missing_from_disk(tmp_path):
    release_dir = write_release(tmp_path, [fixtures.sample_document()], benchmarks=("TEST",))
    (release_dir / "benchmarks/TEST.json").unlink()
    assert validate.validate(release_dir) == 1


def test_a_failed_benchmark_load_is_not_a_release_failure(tmp_path):
    """No benchmark at all is a valid release: the app falls back to the fund."""
    release_dir = write_release(tmp_path, [fixtures.sample_document()])
    assert not (release_dir / "benchmarks").exists()
    assert validate.validate(release_dir) == 0


def test_sample_fixture_release_carries_the_object():
    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "pipeline" / "artifacts"
    release_dir = fixtures.write_sample_release(root / "fixtures")
    compact = json.loads((release_dir / "benchmarks/TEST.json").read_text())
    assert compact["ticker"] == "TEST"
    assert compact["weights"]
