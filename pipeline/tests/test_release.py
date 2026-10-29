"""End-to-end on fixtures: artifact → release → validator, offline and repeatable."""

from __future__ import annotations

import hashlib
import json

import pytest

from pipeline import artifact, validate

from .conftest import corrupt_release, fund_document, write_release

#: Pinned hash of the fixture fund artifact. If a field, its order, or a weight
#: changes, this fails — which is the point: a schema change is a release event,
#: and the number below is what a consumer's cache and the manifest will see.
GOLDEN_SHA256 = "0ea757f7ab7308aa3189e9ec1975c594485085d0d57150a6930ae68529a201dd"


def test_artifact_shape(document):
    assert list(document) == [
        "schema_version",
        "ticker",
        "fund_id",
        "name",
        "issuer",
        "as_of",
        "filed_at",
        "lag_days",
        "source",
        "source_url",
        "coverage_pct",
        "holdings",
        "metrics",
        "warnings",
    ]
    assert document["as_of"] == "2026-06-30"
    assert document["filed_at"] == "2026-08-28"
    assert document["lag_days"] == 59
    assert document["source"] == "SEC N-PORT"


def test_holdings_publish_no_licensed_identifiers(document):
    text = json.dumps(document)
    assert "cusip" not in text.lower()
    assert "isin" not in text.lower()
    assert "037833100" not in text  # Apple's CUSIP, present in the filing


def test_holdings_are_sorted_by_weight(document):
    keys = [(-row["weight_bp"], row["name"].upper()) for row in document["holdings"]]
    assert keys == sorted(keys)


def test_weights_sum_to_the_filing(document):
    assert sum(row["weight_bp"] for row in document["holdings"]) == 10_000


def test_serialisation_is_byte_stable(document):
    first = artifact.canonical_bytes(document)
    second = artifact.canonical_bytes(json.loads(first))
    assert first == second
    assert first.endswith(b"\n")


def test_golden_hash(document):
    digest = hashlib.sha256(artifact.canonical_bytes(document)).hexdigest()
    assert digest == GOLDEN_SHA256, f"artifact hash changed: {digest}"


def test_generated_at_is_reproducible(monkeypatch):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1793318400")
    assert artifact.utc_now_iso() == "2026-10-30T00:00:00Z"


def test_release_passes_its_own_validator(tmp_path, document):
    release_dir = write_release(tmp_path, [document])
    assert validate.validate(release_dir) == 0


def test_validator_rejects_tampered_weight(tmp_path, document):
    def mutate(doc):
        doc["holdings"][0]["weight_bp"] += 1

    assert validate.validate(corrupt_release(tmp_path, document, mutate)) == 1


def test_validator_rejects_hash_mismatch(tmp_path, document):
    release_dir = write_release(tmp_path, [document])
    path = release_dir / "funds" / "TEST.json"
    path.write_bytes(path.read_bytes().replace(b'"lag_days": 59', b'"lag_days": 58'))
    assert validate.validate(release_dir) == 1


def test_validator_rejects_cusip_in_output(tmp_path, document):
    def mutate(doc):
        doc["holdings"][0]["name"] = "Apple Inc 037833100"

    assert validate.validate(corrupt_release(tmp_path, document, mutate)) == 1


def test_validator_rejects_unknown_warning(tmp_path, document):
    def mutate(doc):
        doc["warnings"] = [*doc["warnings"], "trust_me"]

    assert validate.validate(corrupt_release(tmp_path, document, mutate)) == 1


def test_validator_rejects_metric_drift(tmp_path, document):
    def mutate(doc):
        doc["metrics"]["hhi"] = 0.5

    assert validate.validate(corrupt_release(tmp_path, document, mutate)) == 1


def test_validator_rejects_unsorted_holdings(tmp_path, document):
    def mutate(doc):
        doc["holdings"].reverse()

    assert validate.validate(corrupt_release(tmp_path, document, mutate)) == 1


def test_manifest_counts_agree_with_files(tmp_path, document):
    release_dir = write_release(tmp_path, [document])
    manifest_document = json.loads((release_dir / "manifest.json").read_text())
    assert manifest_document["fund_count"] == 1
    assert manifest_document["company_count"] == 3
    assert manifest_document["etf_count"] is None
    assert manifest_document["etf_classifier"] == "pending_adr_0007_c3"
    assert sum(manifest_document["coverage_histogram"].values()) == 1
    assert manifest_document["files"][0]["bytes"] == len(
        (release_dir / "funds" / "TEST.json").read_bytes()
    )


def test_two_builds_of_the_same_filing_are_identical(filing, index):
    """The determinism gate: same input, same bytes, no ordering luck."""
    first = fund_document(filing, index)
    second = fund_document(filing, index)
    assert artifact.canonical_bytes(first) == artifact.canonical_bytes(second)


def test_validator_cli_returns_failure_for_missing_release(tmp_path, capsys):
    assert validate.main(["--release", str(tmp_path / "nope")]) == 1


@pytest.mark.parametrize("field", ["ticker", "holdings", "metrics", "warnings"])
def test_missing_field_is_reported(tmp_path, document, field):
    def mutate(doc):
        del doc[field]

    assert validate.validate(corrupt_release(tmp_path, document, mutate)) == 1
