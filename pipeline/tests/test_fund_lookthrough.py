"""Fund-of-funds look-through: the join, the sum, and every way it refuses.

The expected numbers here are arithmetic a human can check in their head, written out
in the comment above each assertion (lookthrough-math-and-qa §8: a fixture whose
expected value was captured from a run locks in whatever the run did). Every refusal
case is a test, because a flatten that merges the wrong fund produces a completely
plausible ledger and no coverage number reveals it.
"""

from __future__ import annotations

import json
import zlib

import pytest

from pipeline import classify, fund_lookthrough as fol, weights
from pipeline.fund_lookthrough import (
    BP_PER_UNIT,
    MAX_DEPTH,
    MIN_LOOKTHROUGH_BP,
    Composer,
    EdgeIndex,
    FundEdge,
    FundInput,
    RUNG_LEI,
    RUNG_NONE,
    RUNG_SYMBOL,
)

VOO_LEI = "549300F1U7C6RG7BQE89"
VTV_LEI = "549300DIIN0FEK4WZC47"


def holding(
    name: str,
    weight_bp: int,
    *,
    company_id: str | None = None,
    ticker: str | None = None,
    asset_cat: str = classify.EQUITY,
    lei: str | None = None,
    isin: str | None = None,
) -> weights.FundHolding:
    return weights.FundHolding(
        company_id=company_id,
        name=name,
        ticker=ticker,
        asset_cat=asset_cat,
        weight_bp=weight_bp,
        is_company_exposure=asset_cat in classify.COMPANY_CATEGORIES,
        lei=lei,
        isin=isin,
    )


def company(name: str, weight_bp: int, company_id: str | None = None) -> weights.FundHolding:
    return holding(
        name,
        weight_bp,
        # crc32, not hash(): Python randomises string hashing per process, and two
        # companies that merge in one run and not in another is an intermittent test.
        company_id=company_id or f"c_{zlib.crc32(name.encode()):010d}",
        asset_cat=classify.EQUITY,
    )


def fund(rows: list[weights.FundHolding], *, ticker: str, as_of: str = "2026-08-31",
         series_lei: str | None = None, name: str = "") -> FundInput:
    return FundInput(
        ticker=ticker,
        as_of=as_of,
        holdings=tuple(rows),
        series_lei=series_lei,
        name=name or f"{ticker} Fund",
    )


def fund_row(name: str, weight_bp: int, *, lei: str | None = None,
             ticker: str | None = None, isin: str | None = None) -> weights.FundHolding:
    """A parent's position in another fund: category `fund`, carrying identifiers."""
    return holding(
        name,
        weight_bp,
        asset_cat=classify.FUND,
        lei=lei,
        ticker=ticker,
        isin=isin,
    )


def compose(parent: FundInput, children: list[FundInput], aliases=None) -> fol.Composed:
    funds = {parent.ticker: parent, **{child.ticker: child for child in children}}
    composer = Composer(funds, EdgeIndex.build(funds, aliases))
    return composer.compose(parent.ticker)


def by_name(composed: fol.Composed) -> dict[str, int]:
    return {row["name"]: row["weight_bp"] for row in composed.holdings}


# --- the sum ----------------------------------------------------------------


def test_two_sleeves_compose_to_a_hand_calculated_weight():
    """X = 0.6·0.5 + 0.4·0.2 = 0.38; Y = 0.4·0.3 = 0.12; parent cash 100 bp."""
    parent = fund(
        [fund_row("Alpha ETF", 6_000, lei="AAA"), fund_row("Beta ETF", 4_000, lei="BBB"),
         holding("Cash", 100, asset_cat=classify.CASH)],
        ticker="PARENT",
        series_lei="PARENT-LEI",
    )
    alpha = fund([company("X Corp", 5_000), holding("Bond", 5_000, asset_cat=classify.DEBT)],
                 ticker="ALPHA", series_lei="AAA")
    beta = fund([company("X Corp", 2_000), company("Y Corp", 3_000),
                 holding("Cash", 5_000, asset_cat=classify.CASH)],
                ticker="BETA", series_lei="BBB")
    composed = compose(parent, [alpha, beta])
    weights_bp = by_name(composed)

    assert weights_bp["X Corp"] == 3_800  # 0.6·5,000 + 0.4·2,000
    assert weights_bp["Y Corp"] == 1_200  # 0.4·3,000
    assert weights_bp["Bond"] == 3_000  # 0.6·5,000
    assert weights_bp["Cash"] == 100 + 2_000  # parent's 100 bp + 0.4·5,000
    assert composed.depth == 1
    assert composed.unresolved_fund_bp == 0
    # Closure: nothing invented and nothing lost.
    assert composed.total_bp == 10_100


def test_one_company_through_two_sleeves_is_summed_once():
    """3,000 + 2,000 in two sleeves at 50% each = 2,500 bp, one row."""
    parent = fund([fund_row("Alpha ETF", 5_000, lei="AAA"), fund_row("Beta ETF", 5_000, lei="BBB")],
                  ticker="PARENT")
    alpha = fund([company("Same Corp", 6_000, company_id="c_1")], ticker="ALPHA", series_lei="AAA")
    beta = fund([company("Same Corp", 4_000, company_id="c_1")], ticker="BETA", series_lei="BBB")
    composed = compose(parent, [alpha, beta])

    rows = [row for row in composed.holdings if row["company_id"] == "c_1"]
    assert len(rows) == 1, "the same company must not appear twice"
    assert rows[0]["weight_bp"] == 0.5 * 6_000 + 0.5 * 4_000  # 5,000
    assert composed.metrics["hhi"] == pytest.approx(0.25)  # 0.5²
    assert composed.metrics["effective_n"] == pytest.approx(4.0)  # 1 / 0.25


def test_coverage_recurses_and_is_never_renormalised():
    """A sleeve at 50% coverage leaves the parent at 50%, not at 100%."""
    parent = fund([fund_row("Half ETF", 10_000, lei="AAA")], ticker="PARENT")
    half = fund(
        [company("Mapped Corp", 5_000),
         holding("Mystery Holding", 5_000, asset_cat=classify.EQUITY)],
        ticker="HALF",
        series_lei="AAA",
    )
    composed = compose(parent, [half])

    assert composed.coverage_pct == 50.0
    # The unmapped sleeve row is still there, at its composed weight.
    assert by_name(composed)["Mystery Holding"] == 5_000


def test_nested_wrapper_is_flattened_through_the_parent():
    """PARENT → MID (100%) → LEAF (100%) → Apple: depth 2, Apple at 8,000 bp."""
    parent = fund([fund_row("Mid ETF", 10_000, lei="MID")], ticker="PARENT")
    mid = fund([fund_row("Leaf ETF", 8_000, lei="LEAF"), company("Mid Corp", 2_000)],
               ticker="MID", series_lei="MID")
    leaf = fund([company("Apple Inc", 10_000, company_id="c_apple")],
                ticker="LEAF", series_lei="LEAF")
    composed = compose(parent, [mid, leaf])

    assert composed.depth == 2
    assert by_name(composed)["Apple Inc"] == 8_000  # 1.0 · 0.8 · 10,000
    assert by_name(composed)["Mid Corp"] == 2_000


# --- the key ----------------------------------------------------------------


def test_series_lei_resolves_an_edge_whose_name_and_ticker_do_not():
    """The real AVGV case: filed name "Avantis US Large Cap Value", we say "U.S."."""
    parent = fund([fund_row("Avantis US Large Cap Value ETF", 10_000, lei=VOO_LEI,
                            ticker="NOTAPUBLISHEDSYMBOL")], ticker="PARENT")
    child = fund([company("Microsoft Corp", 10_000)], ticker="AVLV", series_lei=VOO_LEI,
                 name="Avantis U.S. Large Cap Value ETF")
    composed = compose(parent, [child])

    assert composed.unresolved_fund_bp == 0
    assert by_name(composed)["Microsoft Corp"] == 10_000
    assert composed.components[0]["resolved_by"] == RUNG_LEI


def test_share_class_symbol_resolves_through_the_alias_map():
    parent = fund([fund_row("Vanguard Total Stock Mkt", 10_000, ticker="VTSAX")], ticker="PARENT")
    child = fund([company("Apple Inc", 10_000)], ticker="VTI")
    composed = compose(parent, [child], aliases={"VTSAX": "VTI"})

    assert by_name(composed)["Apple Inc"] == 10_000
    assert composed.components[0]["resolved_by"] == RUNG_SYMBOL


def test_a_name_alone_never_resolves_an_edge():
    """A trust name is not identity: same name, no LEI, no symbol → residual."""
    parent = fund([fund_row("iShares Trust", 10_000)], ticker="PARENT")
    child = fund([company("Apple Inc", 10_000)], ticker="IVV", name="iShares Trust")
    composed = compose(parent, [child])

    assert composed.unresolved_fund_bp == 10_000
    assert composed.coverage_pct == 0.0
    assert composed.components[0]["ticker"] is None
    assert composed.components[0]["resolved_by"] is None
    assert by_name(composed)["iShares Trust"] == 10_000  # labelled, never dropped


def test_an_unresolved_sleeve_keeps_its_weight_and_its_name():
    parent = fund([fund_row("Some Other ETF", 4_000), company("Direct Corp", 6_000)],
                  ticker="PARENT")
    composed = compose(parent, [])

    assert by_name(composed)["Some Other ETF"] == 4_000
    assert by_name(composed)["Direct Corp"] == 6_000
    assert composed.total_bp == 10_000
    assert composed.unresolved_fund_bp == 4_000
    assert composed.refusals == {"unresolved": 1}


# --- the refusals -----------------------------------------------------------


def test_depth_cap_stops_the_walk_and_labels_the_sleeve():
    """A 4-hop chain stops at 3: the fourth fund stays a fund row, by name."""
    chain = [
        fund(
            [fund_row(f"Fund {index + 1}", 10_000, lei=f"L{index + 1}")],
            ticker=f"F{index}",
            series_lei=f"L{index}",
        )
        for index in range(MAX_DEPTH + 1)
    ]
    chain.append(
        fund(
            [company("Deep Corp", 10_000)],
            ticker=f"F{MAX_DEPTH + 1}",
            series_lei=f"L{MAX_DEPTH + 1}",
        )
    )
    composed = compose(chain[0], chain[1:])

    assert composed.depth == MAX_DEPTH
    assert composed.unresolved_fund_bp == 10_000
    names = by_name(composed)
    assert "Deep Corp" not in names, "a company beyond the cap must not be counted"
    # The sleeve we stopped at was *resolved*, so it ships under the published fund's
    # name and ticker: "we stopped here, and here is what it is" beats an as-filed
    # label the reader cannot look up.
    assert names[f"F{MAX_DEPTH + 1} Fund"] == 10_000
    stopped = composed.holdings[0]
    assert stopped["ticker"] == f"F{MAX_DEPTH + 1}"
    assert stopped["company_id"] is None


def test_a_cycle_terminates_and_is_labelled():
    """A holds B, B holds A: finite, and the loop is a residual, not a doubled weight."""
    parent = fund([fund_row("Beta ETF", 10_000, lei="BBB")], ticker="ALPHA", series_lei="AAA")
    beta = fund([fund_row("Alpha ETF", 10_000, lei="AAA")], ticker="BETA", series_lei="BBB")
    composed = compose(parent, [parent, beta])

    assert composed.depth == 1
    assert composed.total_bp == 10_000  # closure holds; no exponential blow-up
    assert composed.unresolved_fund_bp == 10_000
    assert composed.coverage_pct == 0.0


def test_a_fund_holding_itself_is_a_residual():
    parent = fund(
        [fund_row("Alpha ETF", 2_000, lei="AAA"), company("Real Corp", 8_000)],
        ticker="ALPHA",
        series_lei="AAA",
    )
    composed = compose(parent, [parent])

    assert composed.depth == 0
    assert by_name(composed)["Real Corp"] == 8_000
    assert composed.unresolved_fund_bp == 2_000
    assert composed.refusals == {"self": 1}


def test_a_company_that_is_also_a_fund_row_is_not_treated_as_an_edge():
    """Only category `fund` is an edge; the classifier decides, not the name."""
    parent = fund(
        [holding("Vanguard 500 Index Fund", 3_000, asset_cat=classify.EQUITY,
                 company_id="c_vanguard_mutual")],
        ticker="PARENT",
    )
    composed = compose(parent, [])
    assert composed.depth == 0
    assert composed.unresolved_fund_bp == 0


# --- packaging --------------------------------------------------------------


def test_components_carry_the_sleeve_view_and_stay_sorted():
    parent = fund(
        [fund_row("Big ETF", 7_000, lei="L1"), fund_row("Small ETF", 2_000, lei="L2"),
         fund_row("Tiny ETF", 500, lei="L3")],
        ticker="PARENT",
    )
    children = [
        fund([company("A Corp", 10_000)], ticker="BIG", series_lei="L1"),
        fund([company("B Corp", 10_000)], ticker="SMALL", series_lei="L2"),
        fund([company("C Corp", 10_000)], ticker="TINY", series_lei="L3"),
    ]
    composed = compose(parent, children)

    assert [row["ticker"] for row in composed.components] == ["BIG", "SMALL", "TINY"]
    assert composed.components[0]["coverage_pct"] == 100.0
    assert composed.fund_bp == 9_500
    assert composed.resolved_fund_bp == 9_500


def test_a_short_sleeve_is_a_component_and_the_sum_still_closes():
    """BRMSX is long 1,398 bp of funds and short 688 bp of SPY; the short is a sleeve.

    The first implementation dropped every row under 10 bp, which is every negative
    row, so the sleeve list summed to 1,385 against a ``fund_bp`` of 710 — a
    provenance that describes a different fund than the one published.
    """
    parent = fund(
        [fund_row("Long ETF", 13_980, lei="LONG"), fund_row("Short ETF", -6_880, lei="SHORT")],
        ticker="PARENT",
    )
    long_fund = fund([company("Alpha Corp", 10_000)], ticker="LONG", series_lei="LONG")
    short_fund = fund([company("Beta Corp", 10_000)], ticker="SHORT", series_lei="SHORT")
    composed = compose(parent, [long_fund, short_fund])

    assert [row["weight_bp"] for row in composed.components] == [13_980, -6_880]
    assert sum(row["weight_bp"] for row in composed.components) == composed.fund_bp == 7_100


def test_two_share_classes_of_one_sleeve_are_one_component():
    """A fund holding VOO and VFIAX holds one fund; the vector merges them, so must the list."""
    parent = fund(
        [fund_row("Vanguard S&P 500 ETF", 6_000, lei="AAA"),
         fund_row("Vanguard 500 Index Admiral", 4_000, ticker="VFIAX")],
        ticker="PARENT",
    )
    target = fund([company("X Corp", 10_000)], ticker="VOO", series_lei="AAA")
    composed = compose(parent, [target], aliases={"VFIAX": "VOO"})

    assert [row["ticker"] for row in composed.components] == ["VOO"]
    assert composed.components[0]["weight_bp"] == 10_000
    assert sum(row["weight_bp"] for row in composed.components) == composed.fund_bp


def test_published_rows_are_sorted_and_carry_no_identifiers():
    parent = fund([fund_row("Alpha ETF", 5_000, lei="AAA", isin="US1234567890")], ticker="PARENT")
    alpha = fund(
        [company("Zeta Corp", 6_000), company("Alpha Corp", 4_000)],
        ticker="ALPHA",
        series_lei="AAA",
    )
    composed = compose(parent, [alpha])

    assert [row["name"] for row in composed.holdings] == ["Zeta Corp", "Alpha Corp"]
    text = json.dumps(composed.as_lookthrough()) + json.dumps(composed.holdings)
    for token in ("AAA", "US1234567890", VOO_LEI):
        assert token not in text
    assert all("lei" not in row and "isin" not in row for row in composed.holdings)


def test_composition_is_deterministic():
    parent = fund(
        [fund_row("Alpha ETF", 5_000, lei="AAA"), fund_row("Beta ETF", 5_000, lei="BBB")],
        ticker="PARENT",
    )
    alpha = fund([company("X Corp", 5_000), company("Y Corp", 5_000)], ticker="ALPHA",
                 series_lei="AAA")
    beta = fund([company("X Corp", 5_000), company("Z Corp", 5_000)], ticker="BETA",
                series_lei="BBB")
    first = compose(parent, [alpha, beta])
    second = compose(parent, [alpha, beta])
    assert first.holdings == second.holdings
    assert first.as_lookthrough() == second.as_lookthrough()


def test_zero_weight_composed_rows_are_dropped():
    parent = fund([fund_row("Alpha ETF", 10_000, lei="AAA")], ticker="PARENT")
    alpha = fund([company("Big Corp", 9_999), company("Dot Corp", 1)], ticker="ALPHA",
                 series_lei="AAA")
    composed = compose(parent, [alpha])
    assert all(row["weight_bp"] > 0 for row in composed.holdings)


def test_a_vector_over_the_row_budget_is_not_published():
    """6,001 composed rows is over MAX_LOOKTHROUGH_ROWS: sleeves only, never truncated.

    The rule matters more than the number. Truncating would publish a vector whose
    weights no longer sum to NAV, which is the one thing a reader must be able to trust;
    dropping the flatten instead leaves the filed vector intact and the sleeves named.
    """
    parent = fund([fund_row("Alpha ETF", 10_000, lei="AAA")], ticker="PARENT")
    rows = [
        company(f"Company {index:05d}", 1)
        for index in range(fol.MAX_LOOKTHROUGH_ROWS + 1)
    ]
    alpha = fund(rows, ticker="ALPHA", series_lei="AAA")
    funds = {item.ticker: item for item in (parent, alpha)}
    composer = Composer(funds, EdgeIndex.build(funds))
    composed = composer.compose("PARENT")

    assert len(composed.holdings) == fol.MAX_LOOKTHROUGH_ROWS + 1
    assert composer.skip_reason(composed) == "too_large"
    assert composer.wants_lookthrough(composed) is False
    assert composed.components[0]["ticker"] == "ALPHA", "the sleeve view survives"


def test_a_vector_under_the_row_budget_is_published():
    parent = fund([fund_row("Alpha ETF", 10_000, lei="AAA")], ticker="PARENT")
    alpha = fund([company("Company A", 6_000), company("Company B", 4_000)],
                 ticker="ALPHA", series_lei="AAA")
    funds = {item.ticker: item for item in (parent, alpha)}
    composer = Composer(funds, EdgeIndex.build(funds))
    composed = composer.compose("PARENT")
    assert composer.skip_reason(composed) is None


def test_an_immaterial_fund_edge_is_reported_as_such():
    small = fund([fund_row("Alpha ETF", MIN_LOOKTHROUGH_BP - 1, lei="AAA")], ticker="PARENT")
    alpha = fund([company("X Corp", 10_000)], ticker="ALPHA", series_lei="AAA")
    funds = {item.ticker: item for item in (small, alpha)}
    composer = Composer(funds, EdgeIndex.build(funds))
    assert composer.skip_reason(composer.compose("PARENT")) == "immaterial"


def test_threshold_decides_whether_the_vector_is_flattened():
    small = fund([fund_row("Alpha ETF", MIN_LOOKTHROUGH_BP - 1, lei="AAA")], ticker="PARENT")
    large = fund([fund_row("Alpha ETF", MIN_LOOKTHROUGH_BP, lei="AAA")], ticker="OTHER")
    alpha = fund([company("X Corp", 10_000)], ticker="ALPHA", series_lei="AAA")
    funds = {item.ticker: item for item in (small, large, alpha)}
    composer = Composer(funds, EdgeIndex.build(funds))

    assert composer.wants_lookthrough(composer.compose("PARENT")) is False
    assert composer.wants_lookthrough(composer.compose("OTHER")) is True


# --- the edge index ---------------------------------------------------------


def test_edge_index_prefers_lei_over_a_symbol_that_names_something_else():
    index = EdgeIndex(
        by_lei={"L1": "RIGHT"},
        by_symbol={"WRONG": "OTHER", "L2": "SYMBOLTARGET"},
    )
    assert index.resolve(FundEdge(1_000, "x", ticker="WRONG", lei="L1")) == ("RIGHT", RUNG_LEI)
    assert index.resolve(FundEdge(1_000, "x", ticker="WRONG")) == ("OTHER", RUNG_SYMBOL)
    assert index.resolve(FundEdge(1_000, "x")) == (None, RUNG_NONE)


def test_edge_index_falls_through_an_unknown_lei_to_the_symbol():
    """An LEI the release does not publish is not evidence; the symbol still is."""
    index = EdgeIndex(by_lei={"L1": "RIGHT"}, by_symbol={"SYM": "OTHER"})
    assert index.resolve(FundEdge(1_000, "x", lei="L9", ticker="SYM")) == ("OTHER", RUNG_SYMBOL)
    assert index.resolve(FundEdge(1_000, "x", lei="L9")) == (None, RUNG_NONE)


# --- classifier -------------------------------------------------------------


@pytest.mark.parametrize(
    "asset_cat,issuer_cat,expected",
    [
        ("EC", "RF", classify.FUND),  # the AVGV case: equity category, registered fund
        (None, "RF", classify.FUND),  # the iShares AOA case: no assetCat at all
        ("", "RF", classify.FUND),
        ("DBT", "RF", classify.FUND),
        ("EC", "CORP", classify.EQUITY),  # ordinary equity is untouched
        ("EC", "RF", classify.FUND),
    ],
)
def test_the_classifier_promotes_every_registered_fund_row(asset_cat, issuer_cat, expected):
    outcome = classify.classify(asset_cat, issuer_cat, is_derivative=False)
    assert outcome.category == expected


def test_cash_and_derivatives_are_never_fund_edges_even_when_registered():
    """A money-market sweep files issuerCat RF and must stay cash (§3 of the math skill)."""
    money_market = classify.classify("STIV", "RF", is_derivative=False)
    assert money_market.category == classify.CASH
