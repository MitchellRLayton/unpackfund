"""The identification contract: the row flag, the two document fields, the manifest block.

``coverage_pct`` counts the weight that resolved to a *company*. Measured on the wide
release, 88.6 % of gross is *identified* — a company, a named security, a fund share —
against 62.5 % covered, so the site understated what it knows by 26 points. This test
file is the hand-calculated fixture for the field that publishes the difference, and for
the four gates that hold it:

- the row flag itself: a row that resolved to a company is identified, and a row can be
  identified *without* being attributed — that is the whole point of the field;
- the document's ``identified_pct`` / ``identified_by_cat``, recomputed from the rows and
  refused when it disagrees with them;
- **``identified_pct`` below ``coverage_pct`` fails the release** — identification is a
  superset of attribution, so an inversion is a mis-wired identifier map, and the site
  would print two numbers that contradict each other;
- the manifest's release-wide block, which is derived from the published documents and
  compared back to them (the ``etf_count`` rule).

The fixture vector: 6,000 bp of equity attributed to a company, 3,000 bp of debt that is
named but unattributed, 1,000 bp of cash that is neither. Gross 10,000 bp, so
``coverage_pct`` is 60.0 and ``identified_pct`` is 90.0 — a 30-point gap, which is what
the field exists to publish.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline import artifact, fixtures, validate
from pipeline.classify import CATEGORY_ORDER


def row(
    *,
    company_id: str | None,
    name: str,
    asset_cat: str,
    weight_bp: int,
    identified: bool | None = None,
    ticker: str | None = None,
) -> dict:
    return artifact.holding_row(
        company_id=company_id,
        name=name,
        ticker=ticker,
        asset_cat=asset_cat,
        weight_bp=weight_bp,
        identified=identified,
    )


def metrics_for(holdings: list[dict]) -> dict[str, float | None]:
    """The four metrics the validator recomputes, from the rows it recomputes them on.

    Hand arithmetic, not an import: ``_check_fund`` is the implementation under test, so
    a fixture that called it would agree with itself.
    """
    covered = sorted(
        (
            item["weight_bp"] / 10_000
            for item in holdings
            if item["company_id"]
            and item["asset_cat"] in ("equity", "debt", "fund")
            and item["weight_bp"] > 0
        ),
        reverse=True,
    )
    if not covered:
        return {"hhi": None, "hhi_pct2": None, "effective_n": None, "top10_pct": None}
    hhi = sum(weight * weight for weight in covered)
    return {
        "hhi": hhi,
        "hhi_pct2": round(hhi * 10_000, 4),
        "effective_n": round(1 / hhi, 6),
        "top10_pct": round(sum(covered[:10]) * 100, 4),
    }


def document(
    holdings: list[dict],
    *,
    ticker: str = "TEST",
    coverage_pct: float | None = None,
    identified_pct: float | None = None,
    identified_by_cat: dict[str, float | None] | None = None,
) -> dict:
    published = artifact.build_fund_artifact(
        ticker=ticker,
        fund_id="CIK0000000001",
        name="Sample Identification Fund",
        issuer="Sample Trust",
        as_of="2026-09-30",
        filed_at="2026-10-30",
        source_url="https://www.sec.gov/Archives/edgar/data/1/000000000026000001/primary_doc.xml",
        coverage_pct=(
            coverage_pct
            if coverage_pct is not None
            else round(
                100
                * sum(
                    abs(item["weight_bp"])
                    for item in holdings
                    if item["company_id"]
                )
                / sum(abs(item["weight_bp"]) for item in holdings),
                1,
            )
        ),
        etf=True,
        holdings=holdings,
        metrics=metrics_for(holdings),
        warnings=[],
        identified_pct=identified_pct,
        identified_by_cat=identified_by_cat,
    )
    published["net_assets"] = 1_000_000_000
    return published


@pytest.fixture
def three_class_rows() -> list[dict]:
    return [
        row(company_id="c_0000320193", name="ATTRIBUTED EQUITY", asset_cat="equity", weight_bp=6_000),
        row(company_id=None, name="NAMED TREASURY", asset_cat="debt", weight_bp=3_000, identified=True),
        row(company_id=None, name="CASH SWEEP", asset_cat="cash", weight_bp=1_000, identified=False),
    ]


@pytest.fixture
def published(three_class_rows) -> dict:
    return document(three_class_rows)


def failures_of(release_dir: Path, capsys) -> tuple[int, str]:
    code = validate.validate(release_dir)
    return code, capsys.readouterr().out


# --------------------------------------------------------------------------- the row


def test_a_company_row_is_identified_without_being_told(three_class_rows):
    """Attribution implies identification, so the default derives rather than lies."""
    assert three_class_rows[0]["identified"] is True
    assert three_class_rows[1]["identified"] is True
    assert three_class_rows[2]["identified"] is False


def test_a_row_can_be_identified_and_unattributed(three_class_rows):
    """The field's reason to exist: a named security with no company behind it."""
    treasury = three_class_rows[1]
    assert treasury["company_id"] is None
    assert treasury["identified"] is True


def test_the_row_flag_is_the_last_key(three_class_rows):
    """Key order is the contract: the row object is fixed, and this is the fixed tail."""
    assert list(three_class_rows[0]) == [
        "company_id",
        "name",
        "ticker",
        "asset_cat",
        "weight_bp",
        "identified",
    ]


# ---------------------------------------------------------------------- the document


def test_the_document_publishes_the_split_beside_the_coverage(published):
    assert published["identified_pct"] == 90.0
    assert published["coverage_pct"] == 60.0
    assert published["identified_by_cat"] == {
        "equity": 100.0,
        "debt": 100.0,
        "cash": 0.0,
        "derivative": None,
        "fund": None,
        "other": None,
    }
    keys = list(published)
    assert keys.index("identified_pct") == keys.index("coverage_by_cat") + 1
    assert keys.index("identified_by_cat") == keys.index("coverage_by_cat") + 2
    assert keys.index("holdings") == keys.index("coverage_by_cat") + 3


def test_a_class_with_no_weight_is_null_not_zero(published):
    """A percentage of nothing is undefined; publishing 0.0 would read as "none named"."""
    assert published["identified_by_cat"]["derivative"] is None


def test_a_caller_may_publish_its_own_measurement(three_class_rows):
    """The two kwargs the builder passes are accepted by name, and kept in contract order."""
    measured = {name: 1.0 for name in reversed(CATEGORY_ORDER)}
    built = document(
        three_class_rows,
        identified_pct=77.7,
        identified_by_cat=measured,
    )
    assert built["identified_pct"] == 77.7
    assert list(built["identified_by_cat"]) == list(CATEGORY_ORDER)
    assert set(built["identified_by_cat"].values()) == {1.0}


def test_a_flattened_document_recomputes_its_split(published):
    """A flattened vector is a different list of rows, so the old ratio does not carry."""
    flattened = [
        row(company_id="c_0000320193", name="ATTRIBUTED EQUITY", asset_cat="equity", weight_bp=6_000),
        row(company_id=None, name="NAMED TREASURY", asset_cat="debt", weight_bp=3_000, identified=True),
        row(company_id=None, name="CASH SWEEP", asset_cat="cash", weight_bp=1_000),
    ]
    rebuilt = artifact.attach_fund_of_funds(
        published,
        holdings=flattened,
        coverage_pct=60.0,
        metrics=published["metrics"],
    )
    assert rebuilt["identified_pct"] == 90.0
    assert list(rebuilt).index("identified_pct") == list(rebuilt).index("coverage_by_cat") + 1


def test_a_composed_row_gains_the_flag_it_never_had(published):
    """The flattener builds plain dictionaries; the document layer owns the row shape."""
    composed = [
        {"company_id": "c_0000320193", "name": "ATTRIBUTED EQUITY", "ticker": None,
         "asset_cat": "equity", "weight_bp": 6_000},
        {"company_id": None, "name": "NAMED TREASURY", "ticker": None,
         "asset_cat": "debt", "weight_bp": 4_000},
    ]
    rebuilt = artifact.attach_fund_of_funds(
        published, holdings=composed, coverage_pct=60.0, metrics=published["metrics"]
    )
    assert [list(item) for item in rebuilt["holdings"]] == [
        ["company_id", "name", "ticker", "asset_cat", "weight_bp", "identified"],
    ] * 2
    assert rebuilt["holdings"][0]["identified"] is True
    # Absent at the child level, so it reads unidentified here: understating is the only
    # safe direction for a number the validator recomputes.
    assert rebuilt["holdings"][1]["identified"] is False
    assert rebuilt["identified_pct"] == 60.0


def test_a_row_that_already_carries_the_flag_is_untouched():
    row_with_flag = {
        "company_id": None, "name": "NAMED TREASURY", "ticker": None,
        "asset_cat": "debt", "weight_bp": 1_000, "identified": True,
    }
    assert artifact.published_row(row_with_flag) is row_with_flag


# -------------------------------------------------------------------- the manifest


def test_the_manifest_states_the_release_identification(tmp_path, published):
    release_dir = fixtures.write_release(tmp_path, [published])
    manifest = json.loads((release_dir / "manifest.json").read_text())

    assert manifest["identified_pct"] == 90.0
    assert manifest["identified_bp"] == 9_000
    assert manifest["total_bp"] == 10_000
    assert manifest["identified_by_cat"] == published["identified_by_cat"]


def test_the_manifest_is_derived_from_the_documents(tmp_path, three_class_rows):
    """Never a parameter: two funds' rows are the only input, and the block sums them."""
    first = document(three_class_rows, ticker="TESTA")
    second = document(
        [
            row(company_id="c_0001652044", name="OTHER EQUITY", asset_cat="equity", weight_bp=5_000),
            row(company_id=None, name="UNNAMED LINE", asset_cat="debt", weight_bp=5_000),
        ],
        ticker="TESTB",
    )
    release_dir = fixtures.write_release(tmp_path, [first, second])
    manifest = json.loads((release_dir / "manifest.json").read_text())

    # 9,000 + 5,000 of 10,000 + 10,000.
    assert manifest["identified_pct"] == 70.0
    assert manifest["identified_bp"] == 14_000
    assert manifest["total_bp"] == 20_000
    assert manifest["identified_by_cat"]["equity"] == 100.0
    # Debt: 8,000 bp across the two funds, 3,000 of it identified (the second fund's
    # unnamed line is not), so 37.5 — the per-class split is not the release's ratio.
    assert manifest["identified_by_cat"]["debt"] == 37.5
    assert manifest["identified_by_cat"]["cash"] == 0.0


# ----------------------------------------------------------------------- the gates


def test_a_release_that_publishes_its_split_validates(tmp_path, published, capsys):
    release_dir = fixtures.write_release(tmp_path, [published])
    code, out = failures_of(release_dir, capsys)

    assert code == 0
    assert "ok   identified: 90.0% of gross identified (9,000 of 10,000 bp)" in out


def test_identification_below_attribution_fails_the_release(tmp_path, capsys):
    """The headline gate: an inversion is a mis-wired map, and it names both numbers."""
    inverted = document(
        [
            row(company_id="c_0000320193", name="ATTRIBUTED EQUITY", asset_cat="equity", weight_bp=5_500),
            row(company_id=None, name="CASH SWEEP", asset_cat="cash", weight_bp=4_500),
        ],
        coverage_pct=60.0,
    )
    assert inverted["identified_pct"] == 55.0
    release_dir = fixtures.write_release(tmp_path, [inverted])
    code, out = failures_of(release_dir, capsys)

    assert code == 1
    assert "FAIL TEST.identified_pct: 55.0 < coverage_pct 60.0" in out
    assert "superset of attribution" in out


def test_a_company_row_that_is_not_identified_fails_the_release(tmp_path, capsys):
    """The flag must agree with attribution: a company row is identified by existing."""
    contradicting = artifact.holding_row(
        company_id="c_0000320193",
        name="ATTRIBUTED EQUITY",
        ticker=None,
        asset_cat="equity",
        weight_bp=9_000,
        identified=False,
    )
    cash = row(company_id=None, name="CASH SWEEP", asset_cat="cash", weight_bp=1_000)
    release_dir = fixtures.write_release(tmp_path, [document([contradicting, cash])])
    code, out = failures_of(release_dir, capsys)

    assert code == 1
    assert "FAIL TEST.holdings.identified" in out
    assert "carries company_id c_0000320193 with identified: false" in out


def test_a_class_split_that_does_not_match_the_rows_fails(tmp_path, published, capsys):
    tampered = dict(published)
    tampered["identified_by_cat"] = dict(published["identified_by_cat"], debt=50.0)
    release_dir = fixtures.write_release(tmp_path, [tampered])
    code, out = failures_of(release_dir, capsys)

    assert code == 1
    assert "FAIL TEST.identified_by_cat.debt: 50.0 != 100.0000 recomputed" in out


def test_the_manifest_must_equal_the_funds_it_hashes(tmp_path, published, capsys):
    release_dir = fixtures.write_release(tmp_path, [published])
    manifest_path = release_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["identified_bp"] = 8_000
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    code, out = failures_of(release_dir, capsys)

    assert code == 1
    assert "FAIL manifest.identified_bp: 8,000 != 9,000 recomputed from the funds" in out


def test_a_document_built_before_the_field_still_validates(published, capsys):
    """Additive to schema 1: absent is valid, and the release says so exactly once.

    Checked at the checker rather than through a release directory, because the release's
    pointers hash the manifest — a hand-edited old release would fail the *hash* gate and
    prove nothing about this one.
    """
    stored = json.loads(json.dumps(published))
    for field in ("identified_pct", "identified_by_cat"):
        stored.pop(field)
    for item in stored["holdings"]:
        item.pop("identified")

    report = validate.Report()
    validate._check_identified(stored, report)
    validate._check_identified_release({}, [stored], report)

    assert report.failures == 0
    assert "absent (release predates the field)" in capsys.readouterr().out


def test_a_half_wired_release_fails(published):
    """Funds that publish the split into a manifest that states none of it."""
    report = validate.Report()
    validate._check_identified_release({}, [published], report)

    assert report.failures == 1
