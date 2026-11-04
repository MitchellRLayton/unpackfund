"""Identification: the second coverage level, and the one rule that defines it.

``coverage_pct`` is **attribution** — a company was named for the row. ``identified_pct``
is **identification** — a company, *or* a security the identifier layer resolves to a
FIGI. Identification is a superset of attribution by construction, and publishing both
is the whole point: the gap between them is weight whose *issuer* we cannot name but
whose *security* we can.

These tests pin the rule where it lives (``weights.identified_row``), the arithmetic
that turns it into the published numbers (``weights.identified_split``), and the two
properties the validator will hold the release to: identification never falls below
attribution, and the parts (per class) sum to the whole (the fund).
"""

from __future__ import annotations

import pytest

from pipeline import classify, fixtures, identifiers, weights
from pipeline.nport import Holding


def _figi(body: str) -> str:
    """A FIGI with its real check digit, so a test identifier behaves like a FIGI."""
    assert len(body) == identifiers.FIGI_LENGTH - 1
    return body + str(identifiers.figi_check_digit(body))


#: Three distinct securities, spelled the way the identifier layer spells them.
FIGI_APPLE = _figi("BBG000B9XRY")
FIGI_NORTHWIND = _figi("BBG000BLNNH")
FIGI_UNRELATED = _figi("BBG000C3J3C")


def _security_map(
    by_key: dict[str, str] | None = None,
    *,
    figis: tuple[str, ...] = (FIGI_APPLE, FIGI_NORTHWIND, FIGI_UNRELATED),
) -> identifiers.SecurityMap:
    """The real ``SecurityMap`` over a hand-written lookup — the object, not a mock.

    The pipeline only ever calls ``figi_of``, and a duck-typed stand-in would let the
    two drift: a test that passes a class the production code cannot construct proves
    nothing about production.
    """
    return identifiers.SecurityMap(
        release="test-layer",
        figi_by_key=dict(by_key or {}),
        figis=frozenset(figis),
        sources={},
    )


def _holding(name: str, value: float, **overrides) -> Holding:
    """One filed row, in the shape ``nport.parse`` produces (``test_weights`` style)."""
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


def _vector(holdings: list[Holding], security_map=None, net_assets: float = 1_000.0):
    return weights.build_vector(
        holdings,
        fixtures.sample_index(),
        net_assets,
        lag_days=59,
        security_map=security_map,
    )


def _row(vector, prefix: str):
    return next(row for row in vector.holdings if row.name.startswith(prefix))


# --- the rule, in the one place it lives ------------------------------------


@pytest.mark.parametrize(
    ("label", "company_id", "overrides", "mapped", "expected"),
    [
        ("a company names the row", "c_0000320193", {}, True, True),
        ("an ISIN the layer knows names the security", None, {"isin": "US0378331005"}, True, True),
        ("a FIGI filed in its own right names it", None, {"other_ids": (FIGI_APPLE,)}, True, True),
        ("an identifier the layer does not know names nothing", None, {"isin": "US0000000001"}, True, False),
        ("a value that is not a FIGI names nothing", None, {"other_ids": ("NOTAFIGI1234",)}, True, False),
        ("no identifier at all names nothing", None, {}, True, False),
        ("without the layer only a company identifies", None, {"isin": "US0378331005"}, False, False),
    ],
)
def test_the_rule_has_one_definition(label, company_id, overrides, mapped, expected):
    """``identified_row``: a company, or a security the layer resolves.

    The last case is the determinism control: with no security map there is nothing to
    consult, so identification *is* attribution — which is why a release built without
    the layer reproduces the numbers it published before this column existed.
    """
    security_map = _security_map({"US0378331005": FIGI_APPLE}) if mapped else None
    holding = _holding("Northwind Private Co", 100.0, **overrides)
    assert weights.identified_row(company_id, holding, security_map) is expected


def test_a_row_is_identified_iff_a_company_or_the_flag(vector):
    """The published row carries its answer; ``row_identified`` never re-derives it."""
    for row in vector.holdings:
        assert weights.row_identified(row) == (row.company_id is not None or row.identified)


# --- what the release publishes ---------------------------------------------


def test_company_row_counts_in_both_levels():
    vector = _vector([_holding("Apple Inc.", 600.0, ticker="AAPL"), _holding("Northwind Private Co", 400.0)])
    assert vector.coverage_pct == 60.0
    assert vector.identified_pct == 60.0
    assert vector.identified_bp == 6_000
    assert _row(vector, "Apple").identified is True
    assert _row(vector, "Northwind").identified is False


def test_figi_names_a_security_the_company_ladder_could_not():
    """The case this split exists for: an issuer we cannot name, a security we can."""
    vector = _vector(
        [
            _holding("Northwind Private Co", 600.0, isin="US0378331005"),
            _holding("Unnameable Holdings", 400.0),
        ],
        _security_map({"US0378331005": FIGI_NORTHWIND}),
    )
    assert vector.coverage_pct == 0.0
    assert vector.identified_pct == 60.0
    assert vector.identified_bp == 6_000
    assert vector.identified_by_cat[classify.EQUITY] == 60.0
    # Attribution inside the class is still zero: the two numbers answer two questions.
    assert vector.coverage_by_cat[classify.EQUITY] == 0.0
    assert _row(vector, "Northwind").identified is True


def test_figi_in_the_other_block_identifies_without_an_isin():
    """``identifiers/other`` is a join key like ISIN/CUSIP — a filed FIGI counts."""
    vector = _vector(
        [_holding("Northwind Private Co", 1_000.0, other_ids=("EXCHANGEVAL", FIGI_NORTHWIND))],
        _security_map(),
    )
    assert vector.coverage_pct == 0.0
    assert vector.identified_pct == 100.0


def test_cash_is_in_both_denominators_and_neither_numerator():
    """A sweep has weight but no security, so it dilutes both levels equally."""
    vector = _vector(
        [
            _holding("Apple Inc.", 500.0, ticker="AAPL"),
            _holding("Money Market Sweep", 500.0, asset_cat="STIV", issuer_cat="MMF"),
        ],
        _security_map(),
    )
    assert vector.categories[classify.CASH] == 5_000
    assert vector.coverage_pct == 50.0
    assert vector.identified_pct == 50.0
    # A class with weight but no identified weight is 0%, not None.
    assert vector.identified_by_cat[classify.CASH] == 0.0


def test_missing_security_map_reproduces_attribution():
    """The determinism control: no map ⇒ the two levels are the same vector."""
    holdings = [
        _holding("Apple Inc.", 600.0, ticker="AAPL"),
        _holding("Northwind Private Co", 300.0, isin="US0378331005"),
        _holding("Unnameable Holdings", 100.0, other_ids=("EXCHANGEVAL",)),
    ]
    with_map = _vector(holdings, _security_map({"US0378331005": FIGI_NORTHWIND}))
    without = _vector(holdings, None)

    assert with_map.identified_pct == 90.0
    assert without.identified_pct == without.coverage_pct == 60.0
    assert without.identified_bp == 6_000
    assert without.identified_by_cat == without.coverage_by_cat
    assert all(row.identified is False for row in without.holdings if not row.company_id)


def test_split_carries_all_six_classes_and_sums_to_the_whole():
    """Same contract as ``coverage_by_cat``: six keys in order, ``None`` for no weight."""
    vector = _vector(
        [
            _holding("Apple Inc.", 600.0, ticker="AAPL"),
            _holding("Northwind Private Co", 400.0, isin="US0378331005"),
        ],
        _security_map({"US0378331005": FIGI_NORTHWIND}),
    )
    assert tuple(vector.identified_by_cat) == classify.CATEGORY_ORDER
    assert tuple(vector.identified_cat_bp) == classify.CATEGORY_ORDER
    assert vector.identified_by_cat[classify.CASH] is None
    assert vector.identified_by_cat[classify.EQUITY] == 100.0
    assert sum(vector.identified_cat_bp.values()) == vector.identified_bp


def test_identification_never_falls_below_attribution():
    """The invariant the validator gates: the second level is a superset of the first."""
    vector = _vector(
        [
            _holding("Apple Inc.", 250.0, ticker="AAPL"),
            _holding("Northwind Private Co", 250.0, isin="US0378331005"),
            _holding("Unnameable Holdings", 499.5),
            _holding("Money Market Sweep", 0.5, asset_cat="STIV", issuer_cat="MMF"),
        ],
        _security_map({"US0378331005": FIGI_NORTHWIND}),
    )
    assert vector.identified_pct >= vector.coverage_pct
    assert vector.coverage_pct == 25.0
    assert vector.identified_pct == 50.0
    assert vector.identified_bp <= sum(abs(row.weight_bp) for row in vector.holdings)


def test_the_largest_row_speaks_for_a_merged_group():
    """Two unnamed rows of one name are one published line; it answers as its largest row.

    The same rule the label, the ticker and the country already follow: the row that
    carries the most weight describes the merged line, so two runs on one filing cannot
    disagree about it.
    """
    small_first = _vector(
        [
            _holding("Northwind Private Co", 100.0, isin="US0378331005"),
            _holding("Northwind Private Co", 900.0),
        ],
        _security_map({"US0378331005": FIGI_NORTHWIND}),
    )
    merged = _row(small_first, "Northwind")
    assert merged.merged_rows == 2
    assert merged.identified is False
    assert small_first.identified_pct == 0.0

    large_first = _vector(
        [
            _holding("Northwind Private Co", 900.0, isin="US0378331005"),
            _holding("Northwind Private Co", 100.0),
        ],
        _security_map({"US0378331005": FIGI_NORTHWIND}),
    )
    assert _row(large_first, "Northwind").identified is True
    assert large_first.identified_pct == 100.0
