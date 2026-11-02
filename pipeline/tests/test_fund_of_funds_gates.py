"""The gates that guard a flattened fund, tested by seeding the errors they must catch.

A validator test that only feeds it a valid document proves nothing (lookthrough-math-
and-qa §8). Each case below breaks exactly one invariant of the composition and asserts
the *named* check fires — so a gate that silently stops working fails here rather than
in a release where a composed weight is indistinguishable from a filed one.
"""

from __future__ import annotations

import copy

import pytest

from pipeline import artifact
from pipeline.fund_lookthrough import MAX_DEPTH, MIN_UNRESOLVED_WARNING_BP
from pipeline.validate import (
    MAX_TOTAL_BP,
    Report,
    _check_categories,
    _check_fund_of_funds,
    _check_fund_of_funds_release,
    _total_ceiling,
)


def document(**overrides) -> dict:
    """A flattened fund whose every number agrees with every other number."""
    base = {
        "ticker": "PARENT",
        "coverage_pct": 60.0,
        "holdings": [
            {"company_id": "c_1", "name": "Mapped Corp", "ticker": "MAPPED",
             "asset_cat": "equity", "weight_bp": 6_000},
            {"company_id": None, "name": "Residual Fund", "ticker": None,
             "asset_cat": "fund", "weight_bp": 4_000},
        ],
        "metrics": {"hhi": 0.36, "hhi_pct2": 3_600.0, "effective_n": 2.7778,
                    "top10_pct": 60.0},
        "components": [
            {"ticker": "CHILD", "name": "Child Fund", "weight_bp": 10_000,
             "coverage_pct": 60.0, "asset_cat": "equity", "resolved_by": "series_lei"},
        ],
        "lookthrough": {
            "depth": 1,
            "fund_bp": 10_000,
            "resolved_fund_bp": 10_000,
            "unresolved_fund_bp": 4_000,
            "as_of_skew_days": 0,
            "holdings_bp": 10_000,
            "refused": {"unresolved": 1},
        },
        "warnings": ["fund_of_funds", "fund_of_funds_unresolved", "partial_coverage"],
    }
    base.update(overrides)
    return base


def failures(doc: dict, check=_check_fund_of_funds) -> list[str]:
    """Run one per-fund gate and return the names of the checks that failed."""
    report = Report()
    printed: list[str] = []
    original_fail = report.fail

    def capture(name: str, detail: str = "") -> None:
        printed.append(name)
        original_fail(name, detail)

    report.fail = capture  # type: ignore[method-assign]
    check(doc, report)
    return printed


def test_a_consistent_flattened_fund_passes():
    assert failures(document()) == []


def test_a_document_that_is_not_a_fund_of_funds_is_untouched():
    plain = {"ticker": "PLAIN", "holdings": [], "coverage_pct": 99.0, "warnings": []}
    assert failures(plain) == []


def test_holdings_bp_must_be_the_sum_of_the_published_vector():
    """The provenance describes the vector; if the sum moved, it describes another one."""
    doc = document()
    doc["holdings"][0]["weight_bp"] = 5_000  # Σ now 9,000, holdings_bp still 10,000
    assert "PARENT.lookthrough.holdings_bp" in failures(doc)


def test_coverage_is_recomputed_from_the_vector_not_trusted():
    doc = document(coverage_pct=99.9)  # 6,000 of 10,000 is 60.0
    assert "PARENT.lookthrough.coverage" in failures(doc)


def test_a_flattened_fund_must_carry_the_fund_of_funds_label():
    doc = document(warnings=["partial_coverage", "fund_of_funds_unresolved"])
    assert "PARENT.warnings" in failures(doc)


def test_a_material_residual_must_be_labelled():
    doc = document(warnings=["fund_of_funds", "partial_coverage"])
    assert "PARENT.warnings" in failures(doc)


def test_a_labelled_residual_must_actually_be_material():
    doc = document(
        lookthrough={**document()["lookthrough"],
                     "unresolved_fund_bp": MIN_UNRESOLVED_WARNING_BP - 1},
        holdings=[{"company_id": "c_1", "name": "Mapped Corp", "ticker": "MAPPED",
                   "asset_cat": "equity", "weight_bp": 6_001},
                  {"company_id": None, "name": "Residual Fund", "ticker": None,
                   "asset_cat": "fund", "weight_bp": 3_999}],
        coverage_pct=60.0,
    )
    doc["lookthrough"]["holdings_bp"] = 10_000
    assert "PARENT.warnings" in failures(doc)


def test_depth_beyond_the_cap_fails():
    doc = document()
    doc["lookthrough"]["depth"] = MAX_DEPTH + 1
    assert "PARENT.lookthrough.depth" in failures(doc)


def test_depth_zero_fails_because_a_flatten_used_at_least_one_hop():
    doc = document()
    doc["lookthrough"]["depth"] = 0
    assert "PARENT.lookthrough.depth" in failures(doc)


def test_resolved_weight_cannot_exceed_the_fund_weight():
    doc = document()
    doc["lookthrough"]["resolved_fund_bp"] = 10_001
    assert "PARENT.lookthrough.resolved_fund_bp" in failures(doc)


def test_a_component_sum_that_disagrees_with_fund_bp_fails():
    """The sleeve list *is* the fund's fund weight: if they disagree, one was filtered."""
    doc = document()
    doc["lookthrough"]["fund_bp"] = 9_000
    assert "PARENT.lookthrough.fund_bp" in failures(doc)


def test_a_short_sleeve_is_allowed_in_components():
    """A negative sleeve is a real position, not a defect — the sum is what must hold."""
    doc = document()
    doc["components"] = [
        {"ticker": "LONG", "name": "Long Fund", "weight_bp": 1_400,
         "coverage_pct": 90.0, "asset_cat": "equity", "resolved_by": "series_lei"},
        {"ticker": "SHORT", "name": "Short Fund", "weight_bp": -400,
         "coverage_pct": 90.0, "asset_cat": "equity", "resolved_by": "series_lei"},
    ]
    doc["lookthrough"]["fund_bp"] = 1_000
    doc["lookthrough"]["resolved_fund_bp"] = 1_000
    assert failures(doc) == []


def test_a_composed_vector_may_inherit_its_sleeves_over_sum():
    """10,587 bp is SSAJX: eleven sleeves averaging 10,380 bp, weighted by a 10,200 bp parent.

    An as-filed vector may not exceed 10,500 — that band is what catches a fund whose
    weights were scaled — but a composition multiplies the sleeves' own over-sum by the
    parent's, so the ceiling has to be derived rather than borrowed.
    """
    assert _total_ceiling(document()) > 10_587
    assert _total_ceiling({"ticker": "PLAIN"}) == MAX_TOTAL_BP
    assert _total_ceiling(document()) < 100_000, "a factor of ten is still a failure"


def test_components_must_be_sorted():
    doc = document()
    doc["components"] = [
        {"ticker": "SMALL", "name": "Small Fund", "weight_bp": 2_000,
         "coverage_pct": 90.0, "asset_cat": "equity", "resolved_by": "series_lei"},
        {"ticker": "BIG", "name": "Big Fund", "weight_bp": 8_000,
         "coverage_pct": 90.0, "asset_cat": "equity", "resolved_by": "series_lei"},
    ]
    assert "PARENT.components.order" in failures(doc)


def test_a_duplicate_sleeve_is_a_failure():
    doc = document()
    doc["components"] = [
        {"ticker": "CHILD", "name": "Child Fund", "weight_bp": 5_000,
         "coverage_pct": 90.0, "asset_cat": "equity", "resolved_by": "series_lei"},
        {"ticker": "CHILD", "name": "Child Fund Again", "weight_bp": 5_000,
         "coverage_pct": 90.0, "asset_cat": "equity", "resolved_by": "series_lei"},
    ]
    assert "PARENT.components.duplicate" in failures(doc)


def test_a_component_that_claims_resolution_must_name_a_ticker():
    doc = document()
    doc["components"][0]["ticker"] = None
    assert "PARENT.components.resolved_by" in failures(doc)


def test_a_lookthrough_without_components_is_refused():
    doc = document()
    del doc["components"]
    assert "PARENT.components" in failures(doc)


def test_a_release_fails_a_sleeve_it_does_not_publish():
    funds = [document(), {"ticker": "OTHER", "holdings": [], "coverage_pct": 1.0,
                          "warnings": []}]
    report = Report()
    printed: list[str] = []
    report.fail = lambda check, detail="": printed.append(check)  # type: ignore[method-assign]
    _check_fund_of_funds_release(funds, report)
    assert "PARENT.components" in printed, "CHILD is not in the release"


def test_a_release_with_sleeves_and_no_flatten_warns():
    plain = {"ticker": "CHILD", "holdings": [], "coverage_pct": 99.0, "warnings": []}
    sleeves_only = document()
    del sleeves_only["lookthrough"]
    sleeves_only["holdings"] = [{"company_id": None, "name": "Child Fund",
                                 "ticker": None, "asset_cat": "fund", "weight_bp": 10_000}]
    report = Report()
    warned: list[str] = []
    report.warn = lambda check, detail="": warned.append(check)  # type: ignore[method-assign]
    _check_fund_of_funds_release([plain, sleeves_only], report)
    assert "fund_of_funds" in warned


# --- the document builder ---------------------------------------------------


def test_attach_keeps_the_contract_key_order_and_omits_what_is_absent():
    original = {
        "schema_version": 1, "ticker": "T", "fund_id": "S1", "name": "N",
        "issuer": "I", "etf": False, "as_of": "2026-08-31", "filed_at": "2026-10-30",
        "lag_days": 60, "source": "SEC N-PORT", "source_url": "https://www.sec.gov/x",
        "coverage_pct": 0.0, "holdings": [{"company_id": None, "name": "A",
                                          "ticker": None, "asset_cat": "fund",
                                          "weight_bp": 10_000}],
        "metrics": {"hhi": None, "hhi_pct2": None, "effective_n": None, "top10_pct": None},
        "warnings": ["fund_of_funds"],
    }
    plain = artifact.attach_fund_of_funds(
        original,
        holdings=original["holdings"],
        coverage_pct=0.0,
        metrics=original["metrics"],
        components=[{"ticker": "C", "name": "C", "weight_bp": 10_000,
                     "coverage_pct": 99.0, "asset_cat": "equity", "resolved_by": "series_lei"}],
    )
    assert "lookthrough" not in plain
    assert plain["components"][0]["ticker"] == "C"
    # ``categories`` and ``coverage_by_cat`` are re-derived from whatever vector the
    # rebuilt document publishes (ADR-0016), so they sit right after ``coverage_pct``
    # and are never copied from the parent's filed vector.
    assert list(plain) == [
        *list(original)[:12], "categories", "coverage_by_cat",
        "holdings", "metrics", "components", "warnings",
    ]

    flattened = artifact.attach_fund_of_funds(
        original,
        holdings=[{"company_id": "c_1", "name": "X", "ticker": "X",
                   "asset_cat": "equity", "weight_bp": 9_000}],
        coverage_pct=90.0,
        metrics={"hhi": 0.81, "hhi_pct2": 8_100.0, "effective_n": 1.2346,
                 "top10_pct": 90.0},
        components=plain["components"],
        lookthrough={"depth": 1, "fund_bp": 10_000, "resolved_fund_bp": 10_000,
                     "unresolved_fund_bp": 0, "as_of_skew_days": 0,
                     "holdings_bp": 9_000, "refused": {}},
        warnings=["fund_of_funds"],
    )
    assert list(flattened) == [
        *list(original)[:12], "categories", "coverage_by_cat",
        "holdings", "metrics", "components", "lookthrough", "warnings",
    ]
    assert flattened["categories"]["equity"] == 9_000
    assert flattened["categories"]["fund"] == 0, "the composed vector has no fund rows left"
    assert flattened["holdings"][0]["weight_bp"] == 9_000
    assert original["coverage_pct"] == 0.0, "the builder must not mutate its input"


# --- ADR-0016 §5: the split, the labels, and the fund-row tripwire -----------


def _with_categories(**overrides) -> dict:
    """A document whose split agrees with its vector, plus a label on its sleeve."""
    doc = document(**overrides)
    doc["categories"] = {"equity": 6_000, "debt": 0, "cash": 0, "derivative": 0,
                         "fund": 4_000, "other": 0}
    doc["coverage_by_cat"] = {"equity": 100.0, "debt": None, "cash": None,
                              "derivative": None, "fund": 0.0, "other": None}
    return doc


def test_a_split_that_disagrees_with_the_vector_fails():
    doc = _with_categories()
    doc["categories"]["equity"] = 5_000
    assert "PARENT.categories" in failures(doc, _check_categories)


def test_a_missing_split_fails():
    """Absence is not "unknown"; ADR-0016 makes both objects required."""
    doc = document()
    assert "PARENT.categories" in failures(doc, _check_categories)


def test_a_class_with_no_weight_cannot_claim_a_percentage():
    doc = _with_categories()
    doc["coverage_by_cat"]["cash"] = 0.0
    assert "PARENT.coverage_by_cat.cash" in failures(doc, _check_categories)


def test_a_coverage_by_cat_that_disagrees_with_the_vector_fails():
    doc = _with_categories()
    doc["coverage_by_cat"]["fund"] = 50.0
    assert "PARENT.coverage_by_cat.fund" in failures(doc, _check_categories)


def test_a_split_missing_a_category_key_fails():
    doc = _with_categories()
    del doc["categories"]["other"]
    assert "PARENT.categories.keys" in failures(doc, _check_categories)


def test_five_percent_in_funds_without_sleeves_fails():
    """The state ADR-0013 was written to end: a composition nobody can read."""
    doc = _with_categories()
    del doc["components"]
    doc["holdings"] = doc["holdings"]
    assert "PARENT.components" in failures(doc, _check_categories)


def test_a_sleeve_label_outside_the_enum_fails():
    doc = document()
    doc["components"][0]["asset_cat"] = "growth"
    assert "PARENT.components.asset_cat" in failures(doc)


def test_a_resolved_sleeve_without_a_label_fails():
    doc = document()
    del doc["components"][0]["asset_cat"]
    assert "PARENT.components.asset_cat" in failures(doc)


def test_an_unresolved_sleeve_may_carry_no_label():
    doc = document()
    doc["components"][0].update({"ticker": None, "resolved_by": None, "asset_cat": None})
    assert failures(doc) == []


def test_a_fund_published_as_a_company_is_caught_by_name():
    """The Vanguard defect, as the release-level tripwire sees it.

    Sixty Target Retirement share classes filed their sleeves as ``EC``/``CORP`` and
    published 99.5% "coverage" that was entirely fund positions. No arithmetic gate can
    see that; the release's own name list can.
    """
    child = {"ticker": "CHILD", "name": "Vanguard Total Stock Market Index Fund",
             "holdings": [], "coverage_pct": 99.0, "warnings": []}
    parent = {
        "ticker": "PARENT",
        "name": "Vanguard Target Retirement 2050 Fund",
        "holdings": [
            {"company_id": "c_x", "name": "Vanguard Total Stock Market Index Fund",
             "ticker": None, "asset_cat": "equity", "weight_bp": 5_369},
        ],
        "coverage_pct": 99.5,
        "warnings": [],
    }
    report = Report()
    printed: list[str] = []
    report.fail = lambda name, detail="": printed.append(name)  # type: ignore[method-assign]
    _check_fund_of_funds_release([parent, child], report)
    assert "PARENT.fund_row" in printed


def test_a_row_below_the_materiality_floor_is_not_a_tripwire_hit():
    """A 0.5% name collision is noise; the gate fires on material rows only."""
    child = {"ticker": "CHILD", "name": "Some Other Fund", "holdings": [],
             "coverage_pct": 99.0, "warnings": []}
    parent = {
        "ticker": "PARENT", "name": "Parent Fund",
        "holdings": [{"company_id": "c_x", "name": "Some Other Fund", "ticker": None,
                      "asset_cat": "equity", "weight_bp": 40}],
        "coverage_pct": 99.0, "warnings": [],
    }
    report = Report()
    printed: list[str] = []
    report.fail = lambda name, detail="": printed.append(name)  # type: ignore[method-assign]
    _check_fund_of_funds_release([parent, child], report)
    assert printed == []
