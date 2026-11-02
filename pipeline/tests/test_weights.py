"""Weights: integer basis points that keep the filed residual and never drift."""

from __future__ import annotations

import pytest

from pipeline import companies, gleif, weights
from pipeline.companies import company_id
from pipeline.nport import Holding


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


# --- allocation -------------------------------------------------------------


def test_allocation_sums_to_round_of_exact_total():
    """Three equal thirds cannot be integers; the total still has to be exact."""
    bp = weights.allocate_bp([1 / 3, 1 / 3, 1 / 3])
    assert sum(bp) == 10_000
    assert bp == [3334, 3333, 3333]


def test_allocation_keeps_the_filed_residual():
    """A filing summing to 100.09% of NAV stays at 10,009 bp — never rescaled."""
    assert sum(weights.allocate_bp([0.5, 0.5009])) == 10_009


def test_allocation_is_deterministic_under_ties():
    first = weights.allocate_bp([0.125] * 8)
    second = weights.allocate_bp([0.125] * 8)
    assert first == second
    assert sum(first) == 10_000


def test_allocation_handles_negative_residual():
    bp = weights.allocate_bp([-0.004, 0.5])
    assert sum(bp) == 4_960


# --- vector -----------------------------------------------------------------


def test_vector_totals_the_filing(vector):
    assert vector.total_bp == 10_000


def test_share_classes_merge_to_one_company(vector):
    """Alphabet A and C are two rows and one company; the ledger must say so."""
    alphabet = [row for row in vector.holdings if row.name.startswith("Alphabet")]
    assert len(alphabet) == 1
    merged = alphabet[0]
    assert merged.weight_bp == 2_380
    assert merged.merged_rows == 2
    assert "duplicate_company" in vector.warnings


def test_fund_row_is_labelled_and_kept_separate(vector):
    vw = next(row for row in vector.holdings if row.name.startswith("Vanguard Total"))
    assert vw.asset_cat == "fund"
    assert vw.company_id is None
    assert "fund_of_funds" in vector.warnings


def test_cash_and_derivatives_are_labelled(vector):
    categories = {row.asset_cat for row in vector.holdings}
    assert {"equity", "fund", "cash", "derivative"} <= categories
    assert "cash_or_derivative" in vector.warnings


def test_unmapped_rows_do_not_collapse_into_one(vector):
    unmapped = [row for row in vector.holdings if row.company_id is None]
    assert len(unmapped) >= 2
    assert "unmapped_holding" in vector.warnings


def test_coverage_is_weight_based_not_count_based(vector):
    """5 of 7 rows resolve, but coverage is a share of gross weight, not of rows."""
    assert vector.coverage_pct == pytest.approx(83.7)


def test_short_positions_cannot_push_coverage_above_100(index):
    """A 100% long / 50% short fund is fully attributed, not 200% attributed.

    Net-weight coverage reported 111.2% for AUEIX and 102.6% for ASPCX on the widened
    universe: dividing positive mapped weight by a net total that shorts had reduced.
    Both sides of a short are real exposure, so both sides are counted.
    """
    rows = [
        _holding("Apple Inc", 100.0),
        _holding("Microsoft Corp", 50.0, val_usd=-50.0, payoff_profile="Short"),
    ]
    vector = weights.build_vector(rows, index, 100.0, lag_days=0)
    assert vector.coverage_pct <= 100.0
    assert vector.coverage_pct == pytest.approx(66.7)


def test_empty_filing_is_an_error(index):
    with pytest.raises(weights.WeightError):
        weights.build_vector([], index, 1_000.0, lag_days=0)


def test_rows_without_value_are_dropped_not_zeroed(index):
    rows = [_holding("Apple Inc", 100.0), _holding("Ghost Inc", None, pct_val=None)]
    vector = weights.build_vector(rows, index, 1_000.0, lag_days=0)
    assert [row.name for row in vector.holdings] == ["Apple Inc"]


def test_stale_filing_warning(index):
    rows = [_holding("Apple Inc", 1_000.0)]
    stale = weights.build_vector(rows, index, 1_000.0, lag_days=weights.STALE_LAG_DAYS + 1)
    fresh = weights.build_vector(rows, index, 1_000.0, lag_days=59)
    assert "stale_filing" in stale.warnings
    assert "stale_filing" not in fresh.warnings


# --- identity: a weak name cannot outvote an identifier ---------------------

#: The live defect's row: an Italian issuer whose N-PORT symbol ``DAN`` also belongs
#: to a US company, and whose LEI is the filing's own statement about who it is.
DANIELI_LEI = "815600B4B8C6A353E566"
DANIELI_ID = gleif.issuer_id(DANIELI_LEI)
DANA_CIK = 26780
DANA_ID = company_id(DANA_CIK)
DANA_LEI = "5493001KJTIIGC8Y1R12"
APPLE = company_id(320193)


def _dana_index() -> companies.CompanyIndex:
    return companies.CompanyIndex.from_document(
        {"0": {"cik_str": DANA_CIK, "ticker": "DAN", "title": "DANA INC"}}
    )


def _entity(lei: str, name: str, category: str = "CORP") -> gleif.Entity:
    return gleif.Entity(
        lei=lei, name=name, status="ACTIVE", jurisdiction="IT", category=category
    )


def _issuers(entities, isin_to_lei=None) -> gleif.IssuerIndex:
    return gleif.IssuerIndex(
        {entity.lei: entity for entity in entities},
        isin_to_lei or {},
        cache_date="2026-10-30",
        source="test",
    )


def _table(pairs) -> companies.IdentityTable:
    evidence = companies.IdentityEvidence()
    for isin, lei, cid in pairs:
        evidence.observe(isin, lei, cid)
    return evidence.table()


def test_a_weak_name_match_yields_to_the_row_s_lei():
    """A filing that writes the bare symbol as the name: three letters are not identity.

    This is the row shape parts 1-2 cannot see — ``DAN``/``DANA INC`` is a *weak* yes,
    not a refusal — and the LEI is the only thing in the row that names the issuer.
    """
    holdings = [_holding("DAN", 100.0, ticker="DAN", lei=DANIELI_LEI)]
    issuers = _issuers([_entity(DANIELI_LEI, "DANIELI & C. OFFICINE MECCANICHE S.P.A.")])
    vector = weights.build_vector(
        holdings, _dana_index(), 100.0, lag_days=10, issuers=issuers
    )
    row = vector.holdings[0]
    assert row.company_id == DANIELI_ID
    assert vector.rung_counts["lei_issuer"] == 1
    assert vector.rung_counts["ticker"] == 0
    # An issuer-namespace row publishes no local listing code: ``DAN`` is Rome's.
    assert row.ticker is None
    assert vector.coverage_pct == 100.0


def test_an_identifier_that_agrees_leaves_the_ladder_answer_alone():
    """The LEI is GLEIF's and the entity it names is DANA INC itself: nothing moves."""
    holdings = [_holding("DAN", 100.0, ticker="DAN", lei=DANA_LEI)]
    issuers = _issuers([_entity(DANA_LEI, "DANA INCORPORATED")])
    vector = weights.build_vector(
        holdings, _dana_index(), 100.0, lag_days=10, issuers=issuers
    )
    assert vector.holdings[0].company_id == DANA_ID
    assert vector.rung_counts["ticker"] == 1
    assert vector.rung_counts["lei_issuer"] == 0


def test_a_strong_name_match_is_not_overruled_by_a_conflicting_lei():
    """The filed name is the US company's own, so the ladder is right *about the name*.

    The row carries the Italian LEI, but ``DANA INC`` corroborates ``DANA INC``
    exactly; a distinctive/exact match is left exactly as it was.
    """
    holdings = [_holding("DANA INC", 100.0, ticker="DAN", lei=DANIELI_LEI)]
    issuers = _issuers([_entity(DANIELI_LEI, "DANIELI & C. OFFICINE MECCANICHE S.P.A.")])
    vector = weights.build_vector(
        holdings, _dana_index(), 100.0, lag_days=10, issuers=issuers
    )
    assert vector.holdings[0].company_id == DANA_ID
    assert vector.rung_counts["ticker"] == 1


def test_identifiers_that_contradict_each_other_are_refused():
    """One row, an LEI and an ISIN that GLEIF maps to two issuers: no tie-break."""
    holdings = [
        _holding("DAN", 100.0, ticker="DAN", lei=DANIELI_LEI, isin="IT0000076502")
    ]
    issuers = _issuers(
        [_entity(DANIELI_LEI, "DANIELI & C. OFFICINE MECCANICHE S.P.A.")],
        {"IT0000076502": DANA_LEI},
    )
    vector = weights.build_vector(
        holdings, _dana_index(), 100.0, lag_days=10, issuers=issuers
    )
    assert vector.holdings[0].company_id is None
    assert vector.rung_counts["unmapped"] == 1


def test_a_weak_match_with_no_identifier_keeps_the_row():
    """Nothing better is on offer, and dropping a real holding is not an improvement."""
    holdings = [_holding("DAN", 100.0, ticker="DAN")]
    vector = weights.build_vector(holdings, _dana_index(), 100.0, lag_days=10)
    assert vector.holdings[0].company_id == DANA_ID
    assert vector.rung_counts["ticker"] == 1


def test_the_identity_table_can_also_overrule_a_weak_match():
    """No LEI, but two other funds agreed this security belongs to Apple."""
    holdings = [_holding("DAN", 100.0, ticker="DAN", isin="US9")]
    table = _table([("US9", None, APPLE), ("US9", None, APPLE)])
    vector = weights.build_vector(
        holdings, _dana_index(), 100.0, lag_days=10, identity=table
    )
    assert vector.holdings[0].company_id == APPLE
    assert vector.rung_counts["isin_corroborated"] == 1


def test_a_weak_match_is_not_credited_as_identity_evidence():
    """The wrong ``c_`` id spread through the evidence table; a weak match never feeds it."""
    holdings = [_holding("DAN", 100.0, ticker="DAN", lei=DANIELI_LEI)]
    issuers = _issuers([_entity(DANIELI_LEI, "DANIELI & C. OFFICINE MECCANICHE S.P.A.")])
    evidence = companies.IdentityEvidence()
    weights.build_vector(
        holdings,
        _dana_index(),
        100.0,
        lag_days=10,
        issuers=issuers,
        evidence=evidence,
    )
    assert not evidence.lei
    assert not evidence.isin


def test_a_well_corroborated_match_is_still_evidence():
    """The other side of that rule: a strong ladder answer feeds the table as it did."""
    holdings = [_holding("DANA INC", 100.0, ticker="DAN", isin="US1", lei=DANA_LEI)]
    evidence = companies.IdentityEvidence()
    weights.build_vector(
        holdings, _dana_index(), 100.0, lag_days=10, evidence=evidence
    )
    assert dict(evidence.lei[DANA_LEI]) == {DANA_ID: 1}
    assert dict(evidence.isin["US1"]) == {DANA_ID: 1}


def test_the_live_defect_resolves_by_lei_end_to_end():
    """Both Danieli share classes, as filed: one legal entity, and not DANA INC.

    The live artifact carried ``c_0000026780`` for one class and split the other; the
    fund's own LEI says both are the same Italian issuer, so the merge is the point.
    """
    holdings = [
        _holding("Danieli & C Officine Meccaniche SpA", 100.0, ticker="DAN", lei=DANIELI_LEI),
        _holding("Danieli & C Officine Meccaniche SpA", 50.0, ticker="DANR", lei=DANIELI_LEI),
    ]
    issuers = _issuers([_entity(DANIELI_LEI, "DANIELI & C. OFFICINE MECCANICHE S.P.A.")])
    vector = weights.build_vector(
        holdings, _dana_index(), 200.0, lag_days=10, issuers=issuers
    )
    danieli = [row for row in vector.holdings if row.name.startswith("Danieli")]
    assert len(danieli) == 1
    assert danieli[0].company_id == DANIELI_ID
    assert danieli[0].weight_bp == 7_500
    assert vector.rung_counts["lei_issuer"] == 2
    assert "duplicate_company" in vector.warnings


def test_a_cusip_in_the_ticker_field_is_not_published():
    """FXED's American Financial Group row files the CUSIP as its ticker.

    ``<ticker value="025932872"/>`` is the row's CUSIP, and the release gate refuses to
    publish a CUSIP at all. The row keeps its identity in ``company_id``; the symbol
    field is dropped rather than passed through.
    """
    holdings = [_holding("American Financial Group Inc/OH", 100.0, ticker="025932872")]
    vector = weights.build_vector(
        holdings, _dana_index(), 200.0, lag_days=10
    )
    row = vector.holdings[0]
    assert row.ticker is None, "a CUSIP-shaped ticker must not reach the artifact"
    # Resolution is unaffected: the index answers "which company" before publication
    # asks "which string". The live FXED row resolves by name and publishes no symbol.
    assert vector.rung_counts.get("cusip", 0) == 0


# --- metrics ----------------------------------------------------------------


def test_hhi_matches_definition(vector):
    """HHI is Σw² over company weight with NAV as the denominator, from bp alone."""
    company = [
        row.weight_bp / 10_000
        for row in vector.holdings
        if row.company_id and row.asset_cat in weights.METRIC_CATEGORIES and row.weight_bp > 0
    ]
    result = weights.metrics(vector.holdings)
    assert result["hhi"] == pytest.approx(sum(weight**2 for weight in company))
    assert result["hhi_pct2"] == pytest.approx(result["hhi"] * 10_000, abs=1e-4)
    assert result["effective_n"] == pytest.approx(1 / result["hhi"], abs=1e-6)


def test_metrics_ignore_cash_and_derivatives(vector):
    without = [
        row
        for row in vector.holdings
        if row.asset_cat not in {"cash", "derivative"}
    ]
    assert weights.metrics(vector.holdings) == weights.metrics(without)


def test_cash_only_fund_has_null_metrics(index):
    rows = [
        _holding("Vanguard Market Liquidity Fund", 1_000.0, asset_cat="STIV", issuer_cat="RF")
    ]
    vector = weights.build_vector(rows, index, 1_000.0, lag_days=0)
    assert weights.metrics(vector.holdings) == {
        "hhi": None,
        "hhi_pct2": None,
        "effective_n": None,
        "top10_pct": None,
    }


def test_top10_caps_at_available_rows(index):
    rows = [_holding("Apple Inc", 1_000.0), _holding("Alphabet Inc", 1_000.0)]
    result = weights.metrics(weights.build_vector(rows, index, 2_000.0, lag_days=0).holdings)
    assert result["top10_pct"] == pytest.approx(100.0)
