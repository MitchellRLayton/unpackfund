"""Corroborated identity: cross-fund evidence, under a rule that refuses to guess.

Every test here is about the *refusal*, not the recovery. The pass exists because
28,695 ISINs and 5,127 LEIs resolve to a company in other funds' rows; it is safe
only because a key with two candidate companies maps to neither.
"""

from __future__ import annotations

from pipeline import companies, weights
from pipeline.companies import (
    IDENTITY_MIN_OCCURRENCES,
    IdentityEvidence,
    IdentityTable,
    company_id,
)
from pipeline.nport import Holding

APPLE = company_id(320193)
MICROSOFT = company_id(789019)


def _holding(name: str, value: float, **overrides) -> Holding:
    defaults = dict(
        name=name,
        title="COMMON STOCK",
        cusip=None,
        isin=None,
        ticker=None,
        lei=None,
        balance=1.0,
        units="NS",
        cur_cd="USD",
        val_usd=value,
        pct_val=None,
        asset_cat="EC",
        issuer_cat="CORP",
        inv_country="US",
        payoff_profile="Long",
        is_derivative=False,
    )
    defaults.update(overrides)
    return Holding(**defaults)


def _evidence(pairs) -> IdentityEvidence:
    """Build evidence from ``(isin, lei, company_id)`` sightings, one row each."""
    evidence = IdentityEvidence()
    for isin, lei, cid in pairs:
        evidence.observe(isin, lei, cid)
    return evidence


# --- the rule ---------------------------------------------------------------


def test_unanimous_and_corroborated_key_maps():
    table = _evidence([("US1", None, APPLE), ("US1", None, APPLE)]).table()
    assert table.resolve("US1", None) == (APPLE, "isin_corroborated")


def test_a_single_sighting_is_not_an_identity():
    """One fund naming a security is a coincidence until a second one agrees."""
    table = _evidence([("US1", None, APPLE)]).table()
    assert table.resolve("US1", None) == (None, "unmapped")
    assert table.thin["isin"] == 1


def test_two_disagreeing_candidates_stay_unmapped():
    """The whole discipline in one assertion: a tie leaves the row unmapped."""
    evidence = _evidence([("US1", None, APPLE), ("US1", None, APPLE)])
    evidence.observe("US1", None, MICROSOFT)
    table = evidence.table()
    assert "US1" not in table.by_isin
    assert table.contested["isin"] == 1
    assert table.resolve("US1", None) == (None, "unmapped")


def test_majority_is_not_used_to_break_a_tie():
    """Three sightings of one company against one of another is still a conflict."""
    evidence = _evidence([("US1", None, APPLE)] * 3)
    evidence.observe("US1", None, MICROSOFT)
    assert evidence.table().resolve("US1", None) == (None, "unmapped")


def test_isin_and_lei_that_disagree_stay_unmapped():
    """Each identifier is corroborated on its own, and they name different companies."""
    evidence = _evidence(
        [("US1", None, APPLE), ("US1", None, APPLE), ("US2", "L2", MICROSOFT), ("US3", "L2", MICROSOFT)]
    )
    table = evidence.table()
    assert table.by_isin["US1"] == APPLE
    assert table.by_lei["L2"] == MICROSOFT
    # A row carrying the ISIN of one identity and the LEI of another gets neither:
    # there is nothing in the row that says which of the two is the issuer.
    assert table.resolve("US1", "L2") == (None, "unmapped")
    # Each on its own still resolves, so the refusal is about the pair, not the keys.
    assert table.resolve("US1", None) == (APPLE, "isin_corroborated")
    assert table.resolve(None, "L2") == (MICROSOFT, "lei_corroborated")


def test_lei_rung_is_named_separately():
    table = _evidence([(None, "L1", APPLE), (None, "L1", APPLE)]).table()
    assert table.resolve(None, "L1") == (APPLE, "lei_corroborated")


def test_minimum_occurrences_is_documented_by_its_constant():
    assert IDENTITY_MIN_OCCURRENCES == 2


# --- where the evidence comes from ------------------------------------------


def test_evidence_is_recorded_only_for_rows_the_ladder_resolved(index):
    """An unmapped row contributes nothing — that is what makes this evidence."""
    holdings = [
        _holding("APPLE INC", 100.0, isin="US1", lei="L1", ticker="AAPL"),
        _holding("SOMETHING ELSE", 100.0, isin="US1", lei="L1"),
    ]
    evidence = IdentityEvidence()
    weights.build_vector(
        holdings, index, 200.0, lag_days=10, evidence=evidence
    )
    assert dict(evidence.isin["US1"]) == {APPLE: 1}


def test_identity_rows_never_feed_the_evidence_table(index):
    """Pass 2 must not learn from its own answers, or the rule would drift."""
    holdings = [_holding("SOMETHING ELSE", 100.0, isin="US1", lei="L1")]
    table = _evidence([("US1", None, APPLE), ("US1", None, APPLE)]).table()
    evidence = IdentityEvidence()
    vector = weights.build_vector(
        holdings, index, 100.0, lag_days=10, identity=table, evidence=evidence
    )
    assert vector.holdings[0].company_id == APPLE
    assert not evidence.isin


def test_qualified_identity_does_not_override_the_ladder(index):
    """The ladder's own answer wins, even when the table disagrees with it."""
    holdings = [_holding("APPLE INC", 100.0, isin="US9", ticker="AAPL")]
    table = _evidence([("US9", None, MICROSOFT), ("US9", None, MICROSOFT)]).table()
    vector = weights.build_vector(
        holdings, index, 100.0, lag_days=10, identity=table
    )
    assert vector.holdings[0].company_id == APPLE
    assert vector.rung_counts["ticker"] == 1
    assert vector.rung_counts["isin_corroborated"] == 0


# --- the counts a reviewer reads --------------------------------------------


def test_rung_counts_name_every_identity_rung():
    counts = companies.rung_counts(
        __import__("collections").Counter(
            {"ticker": 1, "name_exact": 2, "isin_corroborated": 3, "lei_corroborated": 4, "unmapped": 5}
        )
    )
    assert counts == {
        "ticker": 1,
        "name_exact": 2,
        "isin_corroborated": 3,
        "lei_corroborated": 4,
        "unmapped": 5,
    }


def test_identity_rung_is_counted_on_the_vector(index):
    holdings = [_holding("SOMETHING ELSE", 100.0, isin="US1")]
    table = _evidence([("US1", None, APPLE), ("US1", None, APPLE)]).table()
    vector = weights.build_vector(
        holdings, index, 100.0, lag_days=10, identity=table
    )
    assert vector.rung_counts["isin_corroborated"] == 1
    assert vector.coverage_pct == 100.0


def test_no_table_leaves_previous_behaviour_untouched(index):
    holdings = [_holding("SOMETHING ELSE", 100.0, isin="US1", lei="L1")]
    vector = weights.build_vector(holdings, index, 100.0, lag_days=10)
    assert vector.holdings[0].company_id is None
    assert vector.rung_counts["unmapped"] == 1
    assert vector.coverage_pct == 0.0
