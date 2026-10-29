"""End-to-end on fixtures: artifact → release → validator, offline and repeatable."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from pipeline import artifact, build as build_mod, paths, validate

from .conftest import corrupt_release, fund_document, write_release

#: Pinned hash of the fixture fund artifact. If a field, its order, or a weight
#: changes, this fails — which is the point: a schema change is a release event,
#: and the number below is what a consumer's cache and the manifest will see.
# Re-pinned 2026-10-29 when coverage_pct moved from a net-weight denominator to a
# gross one: the old formula reported 111.2% coverage for funds holding shorts, so
# the fixture's own number was impossible. The hash still pins every other byte.
# 2026-10-30: + the additive ``etf`` label (was absent, so every catalogue row
# read "not an ETF"). The hash changed because the document gained a field, not
# because a number moved — the fixture's weights, metrics and order are the same.
GOLDEN_SHA256 = "11305e2c632a2e4b3c51af9f0ccb0d2547505b27adc5ba5c91509ad27cd0aba8"


def test_artifact_shape(document):
    assert list(document) == [
        "schema_version",
        "ticker",
        "fund_id",
        "name",
        "issuer",
        "etf",
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
    # The label is a bool rather than a truthy string, so ``if document["etf"]``
    # cannot mean "unknown"; the fixture is named "… Fund", so the name rule
    # says no — which is the rule's whole documented limitation, not a bug here.
    assert document["etf"] is False


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


def test_validator_rejects_a_catalogue_that_lies_about_the_etf_flag(tmp_path, document):
    """The exact defect: the flag is published, so it has to match the fund.

    ``catalogue.json`` said "not an ETF" for all 8,531 funds while the manifest
    counted 3,172, because the writer read a field the document did not have. A
    label nobody compares is a label nobody can trust, so the comparison is a test.
    """
    release_dir = write_release(tmp_path, [document])
    path = release_dir / "catalogue.json"
    payload = json.loads(path.read_text())
    ticker = document["ticker"]
    payload["funds"][ticker][2] = 1 if not document["etf"] else 0
    body = json.dumps(payload, indent=2, sort_keys=False).encode() + b"\n"
    path.write_bytes(body)
    release = json.loads((release_dir / "release.json").read_text())
    entry = release["objects"]["catalogue"]
    entry["bytes"] = len(body)
    entry["sha256"] = hashlib.sha256(body).hexdigest()
    (release_dir / "release.json").write_bytes(
        json.dumps(release, indent=2, sort_keys=False).encode() + b"\n"
    )
    assert validate.validate(release_dir) == 1


def test_validator_rejects_an_alias_to_an_unpublished_ticker(tmp_path, document):
    """An alias is a redirect; pointing one at a missing page is a 404 with a story."""
    release_dir = write_release(tmp_path, [document])
    path = release_dir / "aliases.json"
    payload = json.loads(path.read_text())
    payload["targets"]["VTSAX"] = "NOPE"
    body = json.dumps(payload, indent=2, sort_keys=False).encode() + b"\n"
    path.write_bytes(body)
    release = json.loads((release_dir / "release.json").read_text())
    entry = release["objects"]["aliases"]["object"]
    entry["bytes"] = len(body)
    entry["sha256"] = hashlib.sha256(body).hexdigest()
    (release_dir / "release.json").write_bytes(
        json.dumps(release, indent=2, sort_keys=False).encode() + b"\n"
    )
    assert validate.validate(release_dir) == 1


def test_validator_rejects_an_alias_that_shadows_a_published_fund(tmp_path, document):
    release_dir = write_release(tmp_path, [document])
    path = release_dir / "aliases.json"
    payload = json.loads(path.read_text())
    payload["targets"][document["ticker"]] = document["ticker"]
    body = json.dumps(payload, indent=2, sort_keys=False).encode() + b"\n"
    path.write_bytes(body)
    release = json.loads((release_dir / "release.json").read_text())
    entry = release["objects"]["aliases"]["object"]
    entry["bytes"] = len(body)
    entry["sha256"] = hashlib.sha256(body).hexdigest()
    (release_dir / "release.json").write_bytes(
        json.dumps(release, indent=2, sort_keys=False).encode() + b"\n"
    )
    assert validate.validate(release_dir) == 1


def test_alias_map_publishes_classes_and_skips_collisions(document):
    """Only aliases that reach a published page, and never over a published ticker."""

    def build(ticker: str, symbols: tuple[str, ...]):
        return build_mod.FundBuild(
            ticker=ticker, document={"ticker": ticker}, payload=b"", ref_symbols=symbols
        )

    builds = [
        build("VOO", ("VFIAX", "VFINX", "VOO")),
        build("VTI", ("VTI", "VTSAX")),
        # A class symbol that another published fund uses as its own ticker is a
        # collision the release cannot express, so it is skipped rather than
        # silently renaming a fund.
        build("VFIAX", ("VFIAX",)),
    ]
    assert build_mod._alias_map(builds) == {"VFINX": "VOO", "VTSAX": "VTI"}


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
    assert manifest_document["etf_count"] == 0
    assert manifest_document["etf_classifier"] == "name_rule_v1"
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


def test_validator_resolves_a_bare_release_id(tmp_path, capsys):
    """`pnpm data:validate --release 2026-10-28.1` must not depend on the cwd."""
    assert paths.release_dir("2026-10-28.1") == paths.RELEASES / "2026-10-28.1"
    assert paths.release_dir(Path("artifacts/releases/x")) is None
    assert paths.release_dir(tmp_path) == tmp_path


@pytest.mark.parametrize("field", ["ticker", "holdings", "metrics", "warnings"])
def test_missing_field_is_reported(tmp_path, document, field):
    def mutate(doc):
        del doc[field]

    assert validate.validate(corrupt_release(tmp_path, document, mutate)) == 1
