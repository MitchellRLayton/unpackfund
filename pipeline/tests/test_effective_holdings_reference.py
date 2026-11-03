"""Acceptance tests for the independent Effective-holdings reference.

What is under test is ``pipeline/scripts/verify_effective_holdings.py``, the
second implementation of ``Core = 1/HHI`` and ``Broad = exp(Shannon entropy)``
that exists to disagree with the production module (``web/lib/effective-holdings.ts``)
when the production module is wrong. These tests hold it to three oracles it did
not invent:

* **The ten fixtures in the task brief, to nine decimals.** The numbers are pasted
  into this file from the brief, not read out of the reference, so a reference that
  drifted fails here instead of agreeing with itself.
* **Closed-form rationals for the concentration side.** ``Σ sᵢ²`` on integer basis
  points is a rational, so ``Core`` is compared for *equality*, not within a
  tolerance.
* **``decimal.Decimal.ln``/``exp`` at 60 digits.** A second arithmetic path for the
  transcendental side; it shares nothing with the reference's 50-digit atanh and
  Taylor series.

The real-release tests (the five redesign portfolios and the three real funds) need
the mirrored release, which lives outside the repository and is not present in CI.
They skip with the reason named rather than failing, and every number they check is
also recorded here, so a reader can see what the release said on 2026-11-03.1
without having it.
"""

from __future__ import annotations

import ast
import importlib.util
import os
import random
import sys
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify_effective_holdings.py"


def _load_reference():
    """Import the reference by path.

    The module is registered in ``sys.modules`` before execution because
    ``dataclasses`` resolves each class's module through it; without the entry the
    import fails with ``NoneType has no attribute __dict__``.
    """
    spec = importlib.util.spec_from_file_location("verify_effective_holdings", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


reference = _load_reference()
F = Fraction
#: The script's own release override, so a run can be pointed at another mirror with
#: the same variable the CLI uses (``UNPACKFUND_MIRROR``). CI leaves it unset and the
#: release-dependent tests below skip.
MIRROR = Path(os.environ.get("UNPACKFUND_MIRROR") or reference.DEFAULT_MIRROR)
MIRROR_REASON = f"mirrored release not present at {MIRROR}"


def _close(actual: Fraction, expected: str, tolerance: str, label: str = "") -> None:
    """Assert ``actual`` is within ``tolerance`` of the decimal string ``expected``."""
    gap = abs(actual - F(expected))
    assert gap <= F(tolerance), f"{label}: {actual} vs {expected} (gap {gap})"


# ---------------------------------------------------------------------------
# The brief's table: the acceptance oracle, pasted from the task, nine decimals.
# ---------------------------------------------------------------------------

FIXTURES = {
    1: {"core": "1", "broad": "1"},
    2: {"core": "4", "broad": "4"},
    3: {"core": "1.6", "broad": "1.754765351"},
    4: {"core": "2.631578947", "broad": "2.800094073"},
    5: {
        "core": "1.470588235",
        "broad": "1.649384888",
        "disjoint_core": "2.631578947",
        "disjoint_broad": "2.800094073",
    },
    6: {
        "core": "2",
        "broad": "2",
        "disjoint_core": "4",
        "disjoint_broad": "4",
    },
    7: {"core": "1.923076923", "broad": "1.960131704"},
    8: {
        "core": "1.882352941",
        "broad": "1.937819241",
        "coverage_pct": "80",
        "range_core_single": "2.631578947",
        "range_broad_single": "2.800094073",
        "range_core_split": "2.857142857",
        "range_broad_split": "3.694746280",
    },
    9: {
        "core": "3.636363636",
        "broad": "6.324555320",
        "top10_core_share": "0.990909091",
        "top10_breadth_share": "0.918790182",
    },
    10: {"core": "3.992015968", "broad": "44.721359550"},
}

#: Closed-form rationals: exact equality, no tolerance at all.
CLOSED_FORM = {
    "1.core": F(1),
    "2.core": F(4),
    "3.core": F(8, 5),
    "4.core": F(50, 19),
    "5.core": F(25, 17),
    "5.disjoint_core": F(50, 19),
    "6.core": F(2),
    "6.disjoint_core": F(4),
    "7.core": F(25, 13),
    "8.core": F(32, 17),
    "8.range_core_single": F(50, 19),
    "8.range_core_split": F(20, 7),
    "9.core": F(40, 11),
    "10.core": F(2000, 501),
}


# ---------------------------------------------------------------------------
# 1. Independence: the reference imports nothing from the project.
# ---------------------------------------------------------------------------


def test_reference_imports_only_the_standard_library() -> None:
    """The reference must not share code with production.

    ``web/lib/effective-holdings.ts`` is TypeScript, so a Python import cannot reach
    it; what this holds is the same rule inside Python — no ``pipeline.*`` module, no
    ``web`` helper, and nothing from ``scripts``. Parsing the file rather than
    importing it also catches a lazy import inside a function.
    """
    tree = ast.parse(SCRIPT.read_text())
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level:
            imported.add("<relative import>")
    outside = {name for name in imported if name not in sys.stdlib_module_names}
    assert outside == set(), f"imports outside the standard library: {sorted(outside)}"
    assert "__future__" in imported


# ---------------------------------------------------------------------------
# 2. The ten fixtures at 1e-9.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("number", "field"),
    [
        (number, field)
        for number, fields in FIXTURES.items()
        for field in fields
    ],
)
def test_fixture_field_against_the_brief(number: int, field: str) -> None:
    values = reference.fixture_values(number)
    key = f"{number}.{field}"
    assert key in values, f"fixture {number} does not compute {field}"
    _close(values[key], FIXTURES[number][field], "1e-9", f"fixture {key}")


@pytest.mark.parametrize(("key", "expected"), sorted(CLOSED_FORM.items()))
def test_fixture_concentration_is_exact(key: str, expected: Fraction) -> None:
    number = int(key.split(".")[0])
    actual = reference.fixture_values(number)[key]
    assert actual == expected, f"{key}: {actual} != {expected}"


def test_the_equalities_between_fixtures() -> None:
    """Two independent statements of the same distribution must agree exactly.

    Fixture 5's disjoint set is {0.3, 0.2, 0.5} and fixture 4 is {0.5, 0.3, 0.2}, so
    the two share a Core and a Broad. Fixture 6's disjoint set is four equal weights,
    which is fixture 2. Fixture 1 is the degenerate case.
    """
    four = reference.fixture_values(4)
    five = reference.fixture_values(5)
    two = reference.fixture_values(2)
    six = reference.fixture_values(6)
    assert five["5.disjoint_core"] == four["4.core"]
    # Exactly equal, not merely close: both sums run over the same sorted weights, so
    # equal distributions must give bit-identical 50-digit answers.
    assert five["5.disjoint_broad"] == four["4.broad"]
    assert six["6.disjoint_core"] == two["2.core"]
    assert six["6.disjoint_broad"] == two["2.broad"]
    eight = reference.fixture_values(8)
    assert eight["8.range_core_single"] == five["5.disjoint_core"]
    assert eight["8.range_broad_single"] == five["5.disjoint_broad"]
    one = reference.fixture_values(1)
    assert one["1.core"] == 1 and one["1.broad"] == 1


@pytest.mark.parametrize("number", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
def test_the_inequalities_hold_on_every_fixture(number: int) -> None:
    values = reference.fixture_values(number)
    core = values[f"{number}.core"]
    broad = values[f"{number}.broad"]
    n = values[f"{number}.n"]
    assert core >= 1
    assert core <= broad + F(1, 10**40)
    assert broad <= n + F(1, 10**40)
    assert core <= values[f"{number}.disjoint_core"] + F(1, 10**40)
    assert broad <= values[f"{number}.disjoint_broad"] + F(1, 10**40)


def test_fixture_five_is_the_merge_test() -> None:
    """Squaring each source's weight before merging must fail, loudly.

    Fixture 5 is 50% in a fund holding X 60% / Y 40% plus 50% directly in X. Merging
    first gives X = 0.8, Y = 0.2. The wrong answer squares 0.3 and 0.5 separately,
    which is fixture 5's *disjoint* value — 2.631578947 instead of 1.470588235, a 79%
    error on Core. If a future implementation returns the disjoint number, this is
    the test that says so.
    """
    values = reference.fixture_values(5)
    assert values["5.core"] == F(25, 17)  # 1 / 0.68, merged
    assert values["5.disjoint_core"] == F(50, 19)  # 1 / 0.38, unmerged
    assert values["5.core"] < values["5.disjoint_core"]
    wrong = values["5.disjoint_core"]
    assert abs(wrong - values["5.core"]) / values["5.core"] > F(7, 10)


def test_fixture_seven_shows_cash_is_outside_every_denominator() -> None:
    """Removing the 20% cash changes neither number, and cash is never a company."""
    with_cash = reference.measure(reference.FIXTURES[7][1])
    without_cash = reference.measure(
        reference.Portfolio(
            sources=(
                reference.Source(
                    "A",
                    (
                        reference.Position("X", F(3, 5), "X"),
                        reference.Position("Y", F(2, 5), "Y"),
                    ),
                    F(4, 5),
                ),
            )
        )
    )
    assert with_cash.core == without_cash.core
    assert with_cash.broad == without_cash.broad
    assert with_cash.merged.cash == F(1, 5)
    assert with_cash.merged.unmatched == 0
    assert with_cash.merged.unmatched_count == 0
    assert with_cash.merged.investable == F(4, 5)


def test_fixture_eight_reports_coverage_and_both_ranges() -> None:
    measurements = reference.measure(reference.FIXTURES[8][1])
    assert measurements.coverage_pct == 80
    assert measurements.merged.unmatched == F(1, 5)
    assert measurements.merged.unmatched_count == 4
    assert measurements.range_core_single == F(50, 19)
    assert measurements.range_core_split == F(20, 7)
    # One holding is always at least as concentrated as M equal holdings.
    assert measurements.range_core_single < measurements.range_core_split
    assert measurements.band.key == "full"


def test_fixture_nine_top_ten_shares() -> None:
    values = reference.fixture_values(9)
    assert values["9.top10_core_share"] == F(109, 110)  # 0.2725 / 0.275, exact
    _close(values["9.top10_breadth_share"], "0.918790182", "1e-9", "fixture 9 breadth")
    # The top ten are nine tenths of the count but hold almost all the concentration.
    assert values["9.top10_core_share"] > values["9.top10_breadth_share"]


@pytest.mark.parametrize("number", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
def test_the_fifty_digit_printing_is_not_noise(number: int) -> None:
    """The printed 50-digit string parses back to the value within 10⁻⁴⁰."""
    values = reference.fixture_values(number)
    for field in ("core", "broad"):
        printed = reference.fmt(values[f"{number}.{field}"], reference.DPS)
        assert Decimal(printed) != 0
        exact = reference.decimal_of(values[f"{number}.{field}"], 50)
        assert abs(Decimal(printed) - exact) < Decimal("1e-40")


def test_check_mode_passes() -> None:
    """``--check`` is the same oracle without pytest; it must exit zero."""
    assert reference.run_check() == 0


# ---------------------------------------------------------------------------
# 3. Inequalities on random portfolios.
# ---------------------------------------------------------------------------


def _random_portfolio(rng: random.Random) -> "reference.Portfolio":
    sources = []
    for source_index in range(rng.randint(2, 6)):
        sizes = [rng.randint(1, 900) for _ in range(rng.randint(1, 12))]
        divisor = sum(sizes) + rng.choice([0, 0, 0, rng.randint(1, 500)])
        positions = [
            reference.Position(
                f"C{index}", F(size, divisor), f"C{rng.randint(0, 60)}"
            )
            for index, size in enumerate(sizes)
        ]
        unmatched = rng.choice([0, 0, rng.randint(1, 200)])
        if unmatched:
            positions.append(reference.Position("unknown", F(unmatched, divisor), None))
        sources.append(reference.Source(f"S{source_index}", tuple(positions), F(1)))
    return reference.Portfolio(tuple(sources))


@pytest.mark.parametrize("seed", [11, 23, 47, 101, 2026])
def test_invariants_on_random_portfolios(seed: int) -> None:
    """``1 ≤ Core ≤ Broad ≤ N`` and the two disjoint inequalities, every time."""
    rng = random.Random(seed)
    checked = 0
    for _round in range(30):
        portfolio = _random_portfolio(rng)
        try:
            measurements = reference.measure(portfolio)
        except ValueError:  # a draw with no matched company has nothing to measure
            continue
        checked += 1
        core, broad = measurements.core, measurements.broad
        n = F(measurements.n)
        assert core >= 1
        assert core <= broad + F(1, 10**30)
        assert broad <= n + F(1, 10**30)
        assert core <= measurements.disjoint_core + F(1, 10**30)
        assert broad <= measurements.disjoint_broad + F(1, 10**30)
        # The disjoint measure has one entry per (source, company) contribution, so its
        # own count is not ``N`` — it is at most the number of contributions.
        contributions = reference._disjoint_weights(portfolio)
        assert 0 < len(contributions)
        assert measurements.disjoint_core <= F(len(contributions)) + F(1, 10**30)
        assert measurements.disjoint_broad <= F(len(contributions)) + F(1, 10**30)
        # The two numbers are equal only when the weights are.
        shares = sorted((weight / measurements.total for _c, weight in measurements.merged.rows))
        if shares[0] == shares[-1]:
            assert core == n
            assert abs(broad - n) <= F(1, 10**40)
        else:
            assert core < broad
    assert checked >= 25


def test_merging_never_increases_either_number() -> None:
    """Sharing a company between two sources must pull both numbers down.

    This is the property the whole look-through exists for, and the one a second,
    subtly different merge implementation would break on an overlap-heavy portfolio.
    """
    merged_into = reference.measure(
        reference.Portfolio(
            (
                reference.Source("A", (reference.Position("X", F(1, 2), "X"),), F(1, 2)),
                reference.Source("B", (reference.Position("X", F(1, 2), "X"),), F(1, 2)),
            )
        )
    )
    separate = reference.measure(
        reference.Portfolio(
            (
                reference.Source("A", (reference.Position("X", F(1), "A"),), F(1, 2)),
                reference.Source("B", (reference.Position("X", F(1), "B"),), F(1, 2)),
            )
        )
    )
    assert merged_into.n == 1 and separate.n == 2
    assert merged_into.core == 1 and separate.core == 2


# ---------------------------------------------------------------------------
# 4. Coverage banding (item E).
# ---------------------------------------------------------------------------


def _covered_portfolio(covered: Fraction, total: Fraction = F(1)) -> "reference.Portfolio":
    """One fund whose NAV splits into one named company plus unmatched weight."""
    unmatched = total - covered
    positions = [reference.Position("X", covered, "X")]
    if unmatched > 0:
        positions.append(reference.Position("unknown", unmatched, None))
    return reference.Portfolio((reference.Source("A", tuple(positions)),))


@pytest.mark.parametrize(
    ("coverage", "key", "shows", "ranked"),
    [
        (F(599, 10), "none", False, False),
        (F(60), "partial", True, False),
        (F(65), "partial", True, False),
        (F(699, 10), "partial", True, False),
        (F(70), "full", True, True),
        (F(701, 10), "full", True, True),
    ],
)
def test_coverage_band_boundaries(
    coverage: Fraction, key: str, shows: bool, ranked: bool
) -> None:
    band = reference.coverage_band(coverage)
    assert (band.key, band.shows_numbers, band.ranked) == (key, shows, ranked)


def test_band_withholds_both_numbers_at_59_9_percent() -> None:
    """59.9% coverage: neither number is shown, and they are None, not zero."""
    measurements = reference.measure(_covered_portfolio(F(599, 1000)))
    assert measurements.coverage_pct == F(599, 10)
    assert measurements.band.key == "none"
    assert measurements.core_display is None
    assert measurements.broad_display is None
    # The arithmetic still happened; only the display is withheld. One matched
    # company is the floor: Core = 1 by definition (a single company is one
    # equal-sized holding), and Broad too, so assert the floor rather than 1 > 1.
    assert measurements.core == 1
    assert measurements.broad == 1
    assert measurements.n == 1


def test_band_is_labelled_partial_at_65_percent() -> None:
    measurements = reference.measure(_covered_portfolio(F(65, 100)))
    assert measurements.coverage_pct == 65
    assert measurements.band.key == "partial"
    assert measurements.band.shows_numbers is True
    assert measurements.band.ranked is False
    assert measurements.band.label.startswith("Partial (65.0%")
    assert measurements.core_display == measurements.core
    assert measurements.broad_display == measurements.broad


def test_band_shows_normally_at_70_percent() -> None:
    measurements = reference.measure(_covered_portfolio(F(70, 100)))
    assert measurements.coverage_pct == 70
    assert measurements.band.key == "full"
    assert measurements.band.label == ""
    assert measurements.band.ranked is True
    assert measurements.core_display == measurements.core
    assert measurements.broad_display == measurements.broad


def test_band_labels_never_carry_a_verdict() -> None:
    """The copy rule: no advice, no "risk", no "safe", no "diversified enough".

    Band labels appear next to the two numbers in the answer strip, so they are
    checked here rather than left to review.
    """
    forbidden = ("risk", "safe", "diversif", "should", "consider", "recommend")
    for coverage in (F(599, 10), F(65), F(70), None):
        label = reference.coverage_band(coverage).label.lower()
        for word in forbidden:
            assert word not in label, f"band label for {coverage} contains {word!r}"


# ---------------------------------------------------------------------------
# 5. The five redesign portfolios.
# ---------------------------------------------------------------------------

#: What the reference must reproduce for the five portfolios in
#: ``web/lib/fixtures/portfolios.ts``, on release ``2026-11-03.1``. Recorded from the
#: Decimal hand path (``Decimal.ln``/``exp`` at 60 digits over the merged weight
#: vector), independently of the reference's own 50-digit Fraction series.
REDESIGN = {
    "three-fund": {
        "total": "0.90814",
        "core": "129.8745596693224720060143802142764681075",
        "broad": "672.6795674812565950678448305919415167321",
        "coverage_pct": "91.34655038876650874598911654948348873935",
    },
    "single-fund": {
        "total": "0.9976",
        "core": "61.09507374707326086929830700342430013027",
        "broad": "237.7698057229222895552326415771216670501",
        "coverage_pct": "99.98997694697804951388192843540142327353",
    },
    "stock-and-cash": {
        "total": "0.7488",
        "core": "6.901164610076892955236148273854789013773",
        "broad": "63.82341563340703182671926521151785748035",
        "coverage_pct": "99.99332309541296654870801896240902717500",
    },
    "dollar-mode": {
        "total": "0.96562",
        "core": "230.1670227703971704440914180926367346004",
        "broad": "969.6029803773936147674085042458827866270",
        "coverage_pct": "97.27600588318255999032901496987891120827",
    },
    "overlap-heavy": {
        "total": "0.9975",
        "core": "53.49061715957467968998215736249369002839",
        "broad": "189.6988249320014585352780300724124811357",
        "coverage_pct": "99.99498771991378878251716705929527341988",
    },
}

#: The fragments decode to these (kind, key, fraction-of-portfolio) entries. Kept
#: beside the numbers so the fixture wiring is checked without a release.
DECODED = {
    "three-fund": [("f", "BND", F(1, 10)), ("f", "VTI", F(6, 10)), ("f", "VXUS", F(3, 10))],
    "single-fund": [("f", "VTI", F(1))],
    "stock-and-cash": [
        ("f", "VTI", F(1, 2)),
        ("s", "AAPL", F(1, 4)),
        ("c", "CASH", F(1, 4)),
    ],
    "dollar-mode": [("f", "VTI", F(2, 5)), ("f", "VXUS", F(3, 5))],
    "overlap-heavy": [("f", "VOO", F(1, 2)), ("f", "VTI", F(1, 2))],
}


@pytest.mark.parametrize("name", sorted(DECODED))
def test_redesign_fragments_decode_to_their_documented_weights(name: str) -> None:
    _label, fragment = reference.REDESIGN_FRAGMENTS[name]
    assert reference.decode_fragment(fragment) == DECODED[name]


def test_recorded_expectations_match_the_reference_module() -> None:
    """The two records of the same numbers must not drift apart."""
    assert reference.REDESIGN_EXPECTED == REDESIGN
    assert reference.REDESIGN_RELEASE == "2026-11-03.1"


@pytest.mark.skipif(not (MIRROR / "funds").is_dir(), reason=MIRROR_REASON)
@pytest.mark.parametrize("name", sorted(REDESIGN))
def test_redesign_portfolio_against_the_release(name: str) -> None:
    needed = sorted(
        {
            key
            for _label, fragment in reference.REDESIGN_FRAGMENTS.values()
            for kind, key, _allocation in reference.decode_fragment(fragment)
            if kind == "f"
        }
    )
    funds = {ticker: reference.load_fund(MIRROR, ticker) for ticker in needed}
    portfolio, _label = reference.redesign_portfolio(name, MIRROR, funds)
    measurements = reference.measure(portfolio)
    expected = REDESIGN[name]
    assert measurements.total == F(expected["total"]), name
    _close(measurements.core, expected["core"], "1e-12", f"{name}.core")
    _close(measurements.broad, expected["broad"], "1e-12", f"{name}.broad")
    _close(
        measurements.coverage_pct, expected["coverage_pct"], "1e-12", f"{name}.coverage"
    )
    assert measurements.band.key == "full"
    assert measurements.disjoint_core >= measurements.core
    assert measurements.disjoint_broad >= measurements.broad


@pytest.mark.skipif(not (MIRROR / "funds").is_dir(), reason=MIRROR_REASON)
def test_stock_and_cash_merges_the_direct_holding_into_the_fund_line() -> None:
    """AAPL held directly must add to VTI's Apple line, not create a second company.

    Nothing else in the suite proves the direct-holding merge on real data: the
    portfolio's company count has to equal the fund's, and the Apple line has to
    carry 0.25 on top of half of VTI's weight in it.
    """
    funds = {"VTI": reference.load_fund(MIRROR, "VTI")}
    portfolio, _label = reference.redesign_portfolio("stock-and-cash", MIRROR, funds)
    measurements = reference.measure(portfolio)
    vti = reference.load_fund(MIRROR, "VTI")
    fund_only = reference.measure(reference.fund_portfolio(reference.fund_vector(vti)))
    assert measurements.n == fund_only.n
    apple = next(
        weight
        for company, weight in measurements.merged.rows
        if company == "c_0000320193"
    )
    apple_in_vti = next(
        weight for company, weight in fund_only.merged.rows if company == "c_0000320193"
    )
    assert apple == F(1, 4) + apple_in_vti / 2


# ---------------------------------------------------------------------------
# 6. The three real funds and the T² relationship (item D).
# ---------------------------------------------------------------------------

#: ``(T, Σwᵢ², Core, Broad, page effective_n)`` for the three funds, on release
#: ``2026-11-03.1``. ``Σwᵢ²`` is the fund page's own ``hhi``; ``Core`` is
#: ``1/Σ(wᵢ/T)²``; the page publishes ``1/Σwᵢ²``, so ``Core = T² × page``.
REAL_FUNDS = {
    "VTI": {
        "total": "0.9976",
        "sum_w_squared": "0.01628946",
        "core": "61.09507374707326086930",
        "broad": "237.76980572292228955523",
        "page_effective_n": "61.389389",
        "difference_pct": "-0.479424",
        "published_coverage_pct": "99.3",
    },
    "VXUS": {
        "total": "0.9443",
        "sum_w_squared": "0.00400775",
        "core": "222.49453933004803193812",
        "broad": "826.32595132590425421650",
        "page_effective_n": "249.516561",
        "difference_pct": "-10.829751",
        "published_coverage_pct": "93.2",
    },
    "AKRE": {
        "total": "0.9933",
        "sum_w_squared": "0.07866905",
        "core": "12.54171608783886420390",
        "broad": "14.33732199880420688425",
        "page_effective_n": "12.711479",
        "difference_pct": "-1.335509",
        "published_coverage_pct": "99.3",
    },
}


@pytest.mark.skipif(not (MIRROR / "funds").is_dir(), reason=MIRROR_REASON)
@pytest.mark.parametrize("ticker", sorted(REAL_FUNDS))
def test_real_fund_recomputed_from_raw_positions(ticker: str) -> None:
    """Recompute from the raw positions, then hold the hand check to the reference."""
    expected = REAL_FUNDS[ticker]
    fund = reference.load_fund(MIRROR, ticker)
    vector = reference.fund_vector(fund)
    check = reference.hand_check(fund, vector)

    assert vector.negative_weight == 0 or ticker != "VTI"
    assert check.total == Decimal(expected["total"]), f"{ticker} T"
    assert check.sum_w_squared == Decimal(expected["sum_w_squared"]), f"{ticker} Σw²"
    # The fund page's published hhi *is* Σwᵢ² over these rows, no renormalisation.
    assert abs(check.page_hhi - check.sum_w_squared) <= Decimal("1e-12")
    # Core and Broad: the Decimal path against the recorded values, at 1e-20, and
    # against the reference's independent Fraction path at 1e-12 (the brief's bar).
    assert abs(check.core - Decimal(expected["core"])) <= Decimal("1e-18")
    assert abs(check.broad - Decimal(expected["broad"])) <= Decimal("1e-18")
    measurements = reference.measure(reference.fund_portfolio(vector))
    _close(measurements.core, expected["core"], "1e-12", f"{ticker} reference Core")
    _close(measurements.broad, expected["broad"], "1e-12", f"{ticker} reference Broad")
    # The page's number, the T² relation, and the percentage difference.
    page = Decimal(expected["page_effective_n"])
    t_squared = check.total * check.total
    assert abs(check.core_over_t_squared - page) <= max(
        Decimal("1e-6"), page * Decimal("1e-6")
    )
    assert abs(check.core - t_squared * page) <= max(
        Decimal("1e-6"), check.core * Decimal("1e-6")
    )
    assert abs(check.difference_pct - Decimal(expected["difference_pct"])) <= Decimal(
        "1e-6"
    )
    assert len(vector.matched) == len({company for company, _weight in vector.matched})
    assert fund.coverage_pct == float(expected["published_coverage_pct"])
    assert measurements.band.key == "full"


@pytest.mark.skipif(not (MIRROR / "funds").is_dir(), reason=MIRROR_REASON)
def test_the_concentrated_fund_was_chosen_from_the_release() -> None:
    """AKRE: 17 companies, top-ten share 80.88% of its own weight, 99.3% covered.

    The brief asked for a concentrated fund found *in* the release, not picked by
    name. These are the two quantities the screen used.
    """
    fund = reference.load_fund(MIRROR, "AKRE")
    vector = reference.fund_vector(fund)
    assert len(vector.matched) == 17
    top_ten = sum((weight for _company, weight in vector.matched[:10]), F(0))
    assert top_ten / vector.total > F(80, 100)
    assert fund.page_top10_pct == 80.88
    assert fund.coverage_pct == 99.3
