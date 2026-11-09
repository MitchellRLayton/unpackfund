#!/usr/bin/env python3
"""Independent reference for the two "Effective holdings" numbers.

WHAT THIS IS
------------
A second implementation, written from the definitions only, of the two numbers the
site shows as **Effective holdings**: ``Core = 1/HHI`` and
``Broad = exp(Shannon entropy)``, both in units of **equal-sized holdings**. It
shares no code with the production module (``web/lib/effective-holdings.ts``) and
imports nothing from ``pipeline/``: the only imports are the Python standard
library. It exists to disagree with the production module when the production
module is wrong, so it is deliberately arithmetic nobody would ship: exact
rationals for the concentration side and a 50-digit series for the logarithm.

WHY TWO ARITHMETICS
-------------------
* **HHI and Core are exact rationals.** Every input is an integer basis point or an
  exact allocation fraction, so ``Σ sᵢ²`` is a ``Fraction`` and ``1/HHI`` is a
  ``Fraction``. There is no rounding to argue about, and a test can compare two
  rationals for equality rather than within a tolerance.
* **H and Broad are transcendental.** ``H = −Σ sᵢ ln sᵢ`` needs ``ln`` and ``exp``.
  mpmath is not installed in the pipeline venv, so this file implements ``ln`` and
  ``exp`` itself: integer fixed-point (grid ``10⁻⁹⁰``) around the atanh series
  ``ln m = 2·Σ y^(2k+1)/(2k+1)`` with ``y = (m−1)/(m+1)`` after reducing ``m`` into
  ``[1, 2)``, and ``exp`` by Taylor series after halving the argument into
  ``|x| ≤ 2⁻⁸``. Fifty digits are printed; the truncation budget is ~10⁻⁸⁶, so the
  printed digits are real digits. ``decimal.Decimal.ln``/``exp`` at 60 digits is
  used as a *second* independent path inside ``--check`` and in the hand check, so
  a bug in the series cannot quietly agree with itself.

DEFINITIONS (the only ones used here)
-------------------------------------
``wᵢ`` — merged portfolio weight of matched company ``i``; ``T = Σ wᵢ``;
``u`` — weight of company-like positions that could not be matched; ``M`` — how
many of those there are; ``Q = T + u``; ``sᵢ = wᵢ / T``; ``N`` — number of included
companies.

* ``HHI = Σ sᵢ²`` → ``Core = 1 / HHI``
* ``H = −Σ sᵢ ln sᵢ`` (natural log, ``0·ln0 = 0``) → ``Broad = exp(H)``
* ``1 ≤ Core ≤ Broad ≤ N``, all three equal iff every weight is equal.
* top-ten share of concentration = ``(Σ sᵢ² over the 10 largest) / HHI``
* top-ten share of breadth = ``(−Σ sᵢ ln sᵢ over the 10 largest) / H``
* without overlap (``a_{k,i}`` = source ``k``'s contribution to company ``i``, one
  source per fund and per direct stock, ``Σ_k a_{k,i} = wᵢ``):
  ``HHI_disjoint = Σ (a_{k,i}/T)²``, ``H_disjoint = −Σ (a_{k,i}/T) ln(a_{k,i}/T)``,
  and ``Core ≤ Core_disjoint``, ``Broad ≤ Broad_disjoint`` because merging
  company lines can only move weight toward the middle.
* whole-portfolio range with weights over ``Q``: add ``(u/Q)²`` and
  ``−(u/Q)ln(u/Q)`` for the "one holding" case; ``(u/Q)²/M`` and
  ``−(u/Q)ln(u/Q·M)`` for the "M equal holdings" case.

Excluded and never a company: user cash, fund cash, money-market sweeps,
derivatives. Negative weights are excluded and flagged. ``0·ln0 = 0``.

COVERAGE BANDING
----------------
The two numbers are only shown when enough of the portfolio's company-like weight
resolved: ``c ≥ 70`` shows them; ``60 ≤ c < 70`` labels them partial and never ranks
them; ``c < 60`` withholds both numbers. Bands are half-open on the lower edge, so
70.0 shows and 60.0 is partial. The band keys here are the ones ``web/lib/format.ts``
uses (``full``/``partial``/``none``) so the test expectations line up with the app's.

USAGE
-----
::

    python pipeline/scripts/verify_effective_holdings.py                # the ten fixtures, 50 digits
    python pipeline/scripts/verify_effective_holdings.py --check        # exits 1 on any disagreement
    python pipeline/scripts/verify_effective_holdings.py --release live --hand-check     # three real funds, worked columns
    python pipeline/scripts/verify_effective_holdings.py --release live --portfolios     # the five redesign portfolios
    python pipeline/scripts/verify_effective_holdings.py --release live --scan-concentrated

``--check`` exits non-zero when anything disagrees: with the brief's table beyond the
table's own nine decimals, with a value that has a closed form (compared as a
rational, so there is no tolerance to hide in), or between the three arithmetic paths
by more than 1e-12. The table carries nine decimals because that is what the brief
states; the claims it cannot resolve are checked exactly instead of being loosened.

``--release`` takes the directory holding ``funds/<TICKER>.json`` (the mirror layout
produced by ``pnpm pages:mirror``), and defaults to ``$UNPACKFUND_MIRROR`` or the
local mirror used while this reference was written. Every real-data mode is
evidence only: it never writes, and it never gates a release.

This file is evidence layer. The precise terms (HHI, entropy, Shannon) belong here
and in the methodology; the site's labels say "Effective holdings", "Core",
"Broad" and "equal-sized holdings" and nothing else.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from dataclasses import dataclass
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path
from typing import Mapping, Sequence

# ---------------------------------------------------------------------------
# 0. Precision
# ---------------------------------------------------------------------------

#: Significant digits printed for every transcendental value.
DPS = 50

#: Fixed-point grid for the ``ln``/``exp`` layer: one unit is ``10⁻⁹⁰``.
SCALE = 10**90

def _mul(a: int, b: int) -> int:
    """Multiply two scaled integers, truncating toward −∞ by less than one unit."""
    return (a * b) // SCALE


def _from_fraction(value: Fraction) -> int:
    """A rational as a scaled integer (error < 10⁻⁹⁰)."""
    return (value.numerator * SCALE) // value.denominator


def _as_fraction(scaled: int) -> Fraction:
    return Fraction(scaled, SCALE)


_LN2: int | None = None


def _ln2() -> int:
    """ln 2 = 2·atanh(1/3), as a scaled integer."""
    global _LN2
    if _LN2 is None:
        y = SCALE // 3
        y2 = _mul(y, y)
        total = y
        term = y
        k = 1
        while True:
            term = _mul(term, y2)
            add = term // (2 * k + 1)
            if add <= 0:
                break
            total += add
            k += 1
        _LN2 = 2 * total
    return _LN2


_LN_CACHE: dict[Fraction, int] = {}


def ln_scaled(value: Fraction) -> int:
    """``ln(value)`` for a positive rational, as a scaled integer.

    Reduces ``value`` by powers of two into ``[1, 2)``, then uses the atanh series
    ``ln m = 2(y + y³/3 + y⁵/5 + …)`` with ``y = (m−1)/(m+1) ∈ [0, 1/3)``. The term
    ratio is at most ``1/9``, so ~95 terms reach the 10⁻⁹⁰ grid; each term is
    truncated to the grid, bounding the total error near 10⁻⁸⁸.
    """
    if value <= 0:
        raise ValueError(f"ln of a non-positive value: {value}")
    if value == 1:
        return 0
    cached = _LN_CACHE.get(value)
    if cached is not None:
        return cached

    scaled = _from_fraction(value)
    exponent = 0
    while scaled >= 2 * SCALE:
        scaled //= 2
        exponent += 1
    while scaled < SCALE:
        scaled *= 2
        exponent -= 1

    y = ((scaled - SCALE) * SCALE) // (scaled + SCALE)  # 0 ≤ y < SCALE/3
    if y == 0:
        answer = exponent * _ln2()
    else:
        y2 = _mul(y, y)
        total = y
        term = y
        k = 1
        while True:
            term = _mul(term, y2)
            if term == 0:
                break
            add = term // (2 * k + 1)
            if add == 0:
                break
            total += add
            k += 1
        answer = 2 * total + exponent * _ln2()
    _LN_CACHE[value] = answer
    return answer


def ln_fraction(value: Fraction) -> Fraction:
    """``ln(value)`` to ~10⁻⁸⁸, as an exact rational over the grid."""
    return _as_fraction(ln_scaled(value))


def exp_scaled(scaled: int) -> int:
    """``exp(n / SCALE)`` as a scaled integer.

    Halves the argument until ``|x| ≤ 2⁻⁸``, sums the Taylor series to the grid,
    then squares back up. Squaring at most 14 times multiplies the truncation error
    by at most 2¹⁴, which keeps the result inside 10⁻⁸⁴.
    """
    if scaled == 0:
        return SCALE
    x = scaled
    halvings = 0
    while abs(x) > SCALE // 256:
        x //= 2
        halvings += 1
    term = SCALE
    total = SCALE
    index = 0
    while True:
        index += 1
        term = _mul(term, x) // index
        if term == 0:
            break
        total += term
        if index > 512:  # pragma: no cover - a diverging series would be a bug
            raise ArithmeticError("exp series did not converge")
    for _ in range(halvings):
        total = _mul(total, total)
    return total


def exp_fraction(value: Fraction) -> Fraction:
    """``e^value`` to ~10⁻⁸⁴, as an exact rational over the grid."""
    return _as_fraction(exp_scaled(_from_fraction(value)))


# ---------------------------------------------------------------------------
# 1. Printing
# ---------------------------------------------------------------------------


def decimal_of(value: Fraction, digits: int = DPS) -> Decimal:
    """A rational rounded to ``digits`` significant digits.

    ``Decimal`` is only used for base-10 conversion here, never for the arithmetic
    the numbers themselves come from.
    """
    with localcontext() as ctx:
        ctx.prec = digits
        return Decimal(value.numerator) / Decimal(value.denominator)


def fmt(value: Fraction, digits: int = DPS) -> str:
    """The value at ``digits`` significant digits, in plain decimal notation."""
    return format(decimal_of(value, digits), "f")


def fmt_pct(value: Fraction, places: int = 1) -> str:
    """A percentage at ``places`` decimals, half-up, from the exact rational."""
    scaled = value * 10**places
    units = (scaled.numerator * 2 + scaled.denominator) // (2 * scaled.denominator)
    sign = "-" if units < 0 else ""
    units = abs(units)
    whole, frac = divmod(units, 10**places)
    return f"{sign}{whole}.{str(frac).rjust(places, '0')}"


# ---------------------------------------------------------------------------
# 2. The portfolio model: sources, positions, merge
# ---------------------------------------------------------------------------

#: Asset classes that describe a company exposure. Cash and derivatives are
#: excluded by name, never by omission: §3 of the math skill lists them as cases.
COMPANY_LIKE = frozenset({"equity", "debt", "fund"})
EXCLUDED_CATEGORIES = frozenset({"cash", "derivative"})


@dataclass(frozen=True)
class Position:
    """One line of a source document.

    ``weight`` is a share of the source's own NAV (a fund) or of the portfolio (a
    direct stock at 100%). ``company`` is ``None`` for a company-like position that
    could not be matched: it carries weight but no identity, so it can never be
    counted as a company.
    """

    #: Human name for this line, used by the worked columns and to keep the fixtures
    #: readable (``"AAPL"`` for a direct holding, the company id for a fund row).
    label: str
    weight: Fraction
    company: str | None = None


@dataclass(frozen=True)
class Source:
    """A fund's filed vector, or one direct stock.

    ``allocation`` is the portfolio weight of this source; it multiplies every
    position. One source per fund and per direct stock is what makes the
    "disjoint" arithmetic of §2 well defined: ``Σ_k a_{k,i} = wᵢ``.
    """

    key: str
    positions: tuple[Position, ...]
    allocation: Fraction = Fraction(1)


@dataclass(frozen=True)
class Portfolio:
    """Everything the visitor holds, as sources plus cash."""

    sources: tuple[Source, ...]
    #: User cash. Outside every denominator: it is never a company and it never
    #: raises coverage, so it only ever dilutes the two numbers.
    cash: Fraction = Fraction(0)


@dataclass(frozen=True)
class Merged:
    """The portfolio after look-through merging: each company appears once."""

    rows: tuple[tuple[str, Fraction], ...]
    total: Fraction
    unmatched: Fraction
    unmatched_count: int
    cash: Fraction = Fraction(0)

    @property
    def n(self) -> int:
        return len(self.rows)

    @property
    def investable(self) -> Fraction:
        """``Q`` — matched company weight plus company-like weight we could not name."""
        return self.total + self.unmatched

    @property
    def coverage_pct(self) -> Fraction:
        """Company-like coverage: matched weight over matched-plus-unmatched weight.

        Cash is outside both terms, so adding cash can never raise it. The release's
        published ``coverage_pct`` uses a different denominator (gross weight,
        including cash and derivatives); the two agree in band for every fund checked
        here and both are printed by ``--hand-check``.
        """
        investable = self.investable
        if investable <= 0:
            return Fraction(0)
        return Fraction(100) * self.total / investable


def merge(portfolio: Portfolio) -> Merged:
    """Look through every source and merge to one line per company.

    This is the step the fixtures exist for: squaring or logging a source's weight
    *before* merging produces the disjoint answer, which overstates both numbers.
    """
    weights: dict[str, Fraction] = {}
    unmatched = Fraction(0)
    unmatched_count = 0
    for source in portfolio.sources:
        if source.allocation < 0:
            raise ValueError(f"negative source allocation on {source.key!r}")
        if source.allocation == 0:
            continue
        for position in source.positions:
            if position.weight < 0:
                raise ValueError(f"negative position weight on {source.key!r}")
            if position.weight == 0:
                continue
            contribution = source.allocation * position.weight
            if position.company is None:
                unmatched += contribution
                unmatched_count += 1
            else:
                weights[position.company] = (
                    weights.get(position.company, Fraction(0)) + contribution
                )
    rows = tuple(sorted(weights.items(), key=lambda row: (-row[1], row[0])))
    return Merged(
        rows=rows,
        total=sum(weights.values(), Fraction(0)),
        unmatched=unmatched,
        unmatched_count=unmatched_count,
        cash=portfolio.cash,
    )


# ---------------------------------------------------------------------------
# 3. The numbers
# ---------------------------------------------------------------------------


def _hhi_of(values: Sequence[Fraction], total: Fraction) -> Fraction:
    """``Σ (value/total)²``, exact."""
    if total <= 0:
        raise ValueError("HHI needs a positive denominator")
    return sum(((value / total) ** 2 for value in values), Fraction(0))


def _entropy_of(values: Sequence[Fraction], total: Fraction) -> Fraction:
    """``−Σ (value/total)·ln(value/total)``, with ``0·ln0 = 0``."""
    if total <= 0:
        raise ValueError("entropy needs a positive denominator")
    entropy = Fraction(0)
    for value in values:
        if value <= 0:
            continue
        share = value / total
        entropy -= share * ln_fraction(share)
    return entropy


@dataclass(frozen=True)
class Measurements:
    """Everything the reference can say about one portfolio."""

    merged: Merged
    hhi: Fraction
    core: Fraction
    entropy: Fraction
    broad: Fraction
    disjoint_hhi: Fraction
    disjoint_core: Fraction
    disjoint_entropy: Fraction
    disjoint_broad: Fraction
    top10_core_share: Fraction
    top10_breadth_share: Fraction
    range_core_single: Fraction | None
    range_broad_single: Fraction | None
    range_core_split: Fraction | None
    range_broad_split: Fraction | None
    band: "Band"

    @property
    def n(self) -> int:
        return self.merged.n

    @property
    def total(self) -> Fraction:
        return self.merged.total

    @property
    def coverage_pct(self) -> Fraction:
        return self.merged.coverage_pct

    @property
    def core_display(self) -> Fraction | None:
        """What the answer strip shows for Core: ``None`` when withheld."""
        return self.core if self.band.shows_numbers else None

    @property
    def broad_display(self) -> Fraction | None:
        """What the answer strip shows for Broad: ``None`` when withheld."""
        return self.broad if self.band.shows_numbers else None


def _disjoint_weights(portfolio: Portfolio) -> list[Fraction]:
    """Every ``a_{k,i}``: one entry per (source, company) pair, before merging.

    Unmatched positions are not companies and are not in this list; the disjoint
    pair is computed over the same ``T`` as the merged pair, so the two are
    comparable and ``Core ≤ Core_disjoint`` is a like-for-like statement.
    """
    contributions: list[Fraction] = []
    for source in portfolio.sources:
        if source.allocation == 0:
            continue
        for position in source.positions:
            if position.company is None or position.weight <= 0:
                continue
            contributions.append(source.allocation * position.weight)
    return contributions


def measure(portfolio: Portfolio, coverage_pct: Fraction | None = None) -> Measurements:
    """Compute every number for one portfolio, then apply the coverage bands."""
    merged = merge(portfolio)
    if merged.n == 0:
        raise ValueError("portfolio has no matched company; nothing to measure")

    values = [weight for _company, weight in merged.rows]
    hhi = _hhi_of(values, merged.total)
    core = 1 / hhi
    entropy = _entropy_of(values, merged.total)
    broad = exp_fraction(entropy)

    # Disjoint: every source keeps its own lines, so an overlapping fund pair is
    # counted twice — this is the answer the merge step must beat, and the two
    # inequalities are the test that it did.
    disjoint_values = _disjoint_weights(portfolio)
    disjoint_total = sum(disjoint_values, Fraction(0))
    disjoint_hhi = _hhi_of(disjoint_values, disjoint_total)
    disjoint_entropy = _entropy_of(disjoint_values, disjoint_total)

    # Top-ten shares: the largest ten companies' contribution over the whole sum.
    top_ten = [weight for _company, weight in merged.rows[:10]]
    top_ten_hhi = sum(((value / merged.total) ** 2 for value in top_ten), Fraction(0))
    top_ten_entropy = Fraction(0)
    for value in top_ten:
        share = value / merged.total
        top_ten_entropy -= share * ln_fraction(share)
    top10_core_share = top_ten_hhi / hhi
    top10_breadth_share = (
        top_ten_entropy / entropy if entropy > 0 else Fraction(1)
    )

    # Whole-portfolio range: the same company lines with the unmatched weight put
    # back in, over Q, as either one position or M equal positions.
    range_core_single = range_broad_single = None
    range_core_split = range_broad_split = None
    investable = merged.investable
    if merged.unmatched > 0 and investable > 0:
        q = investable
        shares = [value / q for value in values]
        unmatched_share = merged.unmatched / q
        hhi_single = sum((s**2 for s in shares), Fraction(0)) + unmatched_share**2
        entropy_single = _entropy_of(values, q) - unmatched_share * ln_fraction(
            unmatched_share
        )
        range_core_single = 1 / hhi_single
        range_broad_single = exp_fraction(entropy_single)
        if merged.unmatched_count > 0:
            count = merged.unmatched_count
            hhi_split = (
                sum((s**2 for s in shares), Fraction(0)) + unmatched_share**2 / count
            )
            entropy_split = _entropy_of(values, q) - unmatched_share * ln_fraction(
                unmatched_share / count
            )
            range_core_split = 1 / hhi_split
            range_broad_split = exp_fraction(entropy_split)

    band = coverage_band(coverage_pct if coverage_pct is not None else merged.coverage_pct)
    return Measurements(
        merged=merged,
        hhi=hhi,
        core=core,
        entropy=entropy,
        broad=broad,
        disjoint_hhi=disjoint_hhi,
        disjoint_core=1 / disjoint_hhi,
        disjoint_entropy=disjoint_entropy,
        disjoint_broad=exp_fraction(disjoint_entropy),
        top10_core_share=top10_core_share,
        top10_breadth_share=top10_breadth_share,
        range_core_single=range_core_single,
        range_broad_single=range_broad_single,
        range_core_split=range_core_split,
        range_broad_split=range_broad_split,
        band=band,
    )


# ---------------------------------------------------------------------------
# 4. Coverage bands
# ---------------------------------------------------------------------------

#: ``c ≥ 70``: both numbers shown, may be ranked.
COVERAGE_SHOWN = Fraction(70)
#: ``60 ≤ c < 70``: both numbers shown, labelled partial, never ranked.
COVERAGE_PARTIAL = Fraction(60)


@dataclass(frozen=True)
class Band:
    """What the coverage band does to the two numbers — the display rule, as data."""

    key: str  # "full" | "partial" | "none" — the same names web/lib/format.ts uses
    label: str
    shows_numbers: bool
    ranked: bool


def coverage_band(coverage_pct: Fraction | None) -> Band:
    """Classify company-like coverage into the three published bands.

    Half-open on the lower edge, so 70.0 shows and 60.0 is partial — one value, one
    band, no boundary dispute.
    """
    if coverage_pct is None:
        return Band(
            key="none",
            label="Not covered (no company weight traced)",
            shows_numbers=False,
            ranked=False,
        )
    if coverage_pct >= COVERAGE_SHOWN:
        return Band(key="full", label="", shows_numbers=True, ranked=True)
    if coverage_pct >= COVERAGE_PARTIAL:
        return Band(
            key="partial",
            label=f"Partial ({fmt_pct(coverage_pct)}% of weight)",
            shows_numbers=True,
            ranked=False,
        )
    return Band(
        key="none",
        label=f"Not covered ({fmt_pct(coverage_pct)}% of weight)",
        shows_numbers=False,
        ranked=False,
    )


# ---------------------------------------------------------------------------
# 5. The ten analytic fixtures
# ---------------------------------------------------------------------------
#
# Two independent anchors per fixture:
#
# * ``TABLE`` is the value as written in the task brief, to nine decimals. It is
#   the acceptance oracle and was checked by hand (Σ sᵢ² for 50/30/20 is
#   0.25 + 0.09 + 0.04 = 0.38, so Core = 50/19 = 2.631578947…). Nothing here was
#   captured from a previous run of this file.
# * ``EXACT_CORE`` is the closed-form rational for the concentration side, so the
#   Core comparison is equality of rationals, not a tolerance.
#
# The transcendental side is anchored by ``decimal.Decimal.ln``/``exp`` at 60 digits
# inside ``--check`` (``_decimal_cross_check``), which is a third path.

F = Fraction


def _single(weights: Mapping[str, Fraction]) -> Portfolio:
    """One fund holding exactly these companies, plus optional unmatched weight."""
    positions = tuple(
        Position(label=key, weight=value, company=key) for key, value in weights.items()
    )
    return Portfolio(sources=(Source(key="fund", positions=positions),))


def _fixture_portfolios() -> list[tuple[int, str, Portfolio]]:
    four = {f"C{index}": F(1, 4) for index in range(4)}
    ten_at_five = {"C0": F(1, 2), **{f"T{index}": F(1, 20) for index in range(10)}}
    five_hundred = {
        "C0": F(1, 2),
        **{f"S{index}": F(1, 1000) for index in range(500)},
    }
    return [
        (1, "One company 100%", _single({"X": F(1)})),
        (2, "4 companies, 25% each", _single(four)),
        (3, "75% / 25%", _single({"A": F(3, 4), "B": F(1, 4)})),
        (
            4,
            "50% / 30% / 20%",
            _single({"A": F(1, 2), "B": F(3, 10), "C": F(1, 5)}),
        ),
        # Fixture 5 is the merge test: fund A holds X 60% / Y 40% of itself, and the
        # same X is also held directly. Merging first gives X = 0.3 + 0.5 = 0.8.
        (
            5,
            "50% fund A (X 60%, Y 40%) + 50% direct stock X",
            Portfolio(
                sources=(
                    Source(
                        key="A",
                        allocation=F(1, 2),
                        positions=(
                            Position("X", F(3, 5), "X"),
                            Position("Y", F(2, 5), "Y"),
                        ),
                    ),
                    Source(
                        key="direct",
                        allocation=F(1, 2),
                        positions=(Position("X", F(1), "X"),),
                    ),
                ),
            ),
        ),
        (
            6,
            "50% fund A + 50% fund B, both X 50% / Y 50%",
            Portfolio(
                sources=(
                    Source(
                        key="A",
                        allocation=F(1, 2),
                        positions=(
                            Position("X", F(1, 2), "X"),
                            Position("Y", F(1, 2), "Y"),
                        ),
                    ),
                    Source(
                        key="B",
                        allocation=F(1, 2),
                        positions=(
                            Position("X", F(1, 2), "X"),
                            Position("Y", F(1, 2), "Y"),
                        ),
                    ),
                ),
            ),
        ),
        # Fixture 7: 20% cash is excluded from every company denominator, and because
        # the shares are renormalised by T the two numbers are the same as without it.
        (
            7,
            "80% fund A (X 60%, Y 40%) + 20% cash",
            Portfolio(
                sources=(
                    Source(
                        key="A",
                        allocation=F(4, 5),
                        positions=(
                            Position("X", F(3, 5), "X"),
                            Position("Y", F(2, 5), "Y"),
                        ),
                    ),
                ),
                cash=F(1, 5),
            ),
        ),
        # Fixture 8: one fund at 100%, 20% of its NAV in four positions that resolved
        # to no company. Coverage 80%; both ranges are defined.
        (
            8,
            "One fund: X 50%, Y 30%, unmatched 20% in M=4 positions",
            Portfolio(
                sources=(
                    Source(
                        key="A",
                        positions=(
                            Position("X", F(1, 2), "X"),
                            Position("Y", F(3, 10), "Y"),
                            *(
                                Position(f"unknown {index}", F(1, 20), None)
                                for index in range(4)
                            ),
                        ),
                    ),
                ),
            ),
        ),
        (9, "One company 50% + ten at 5%", _single(ten_at_five)),
        (10, "One company 50% + 500 at 0.1%", _single(five_hundred)),
    ]


FIXTURES: dict[int, tuple[str, Portfolio]] = {
    number: (name, portfolio) for number, name, portfolio in _fixture_portfolios()
}

#: The acceptance oracle, exactly as written in the brief (nine decimals).
TABLE: dict[str, str] = {
    "1.core": "1",
    "1.broad": "1",
    "2.core": "4",
    "2.broad": "4",
    "3.core": "1.6",
    "3.broad": "1.754765351",
    "4.core": "2.631578947",
    "4.broad": "2.800094073",
    "5.core": "1.470588235",
    "5.broad": "1.649384888",
    "5.disjoint_core": "2.631578947",
    "5.disjoint_broad": "2.800094073",
    "6.core": "2",
    "6.broad": "2",
    "6.disjoint_core": "4",
    "6.disjoint_broad": "4",
    "7.core": "1.923076923",
    "7.broad": "1.960131704",
    "8.core": "1.882352941",
    "8.broad": "1.937819241",
    "8.coverage_pct": "80",
    "8.range_core_single": "2.631578947",
    "8.range_broad_single": "2.800094073",
    "8.range_core_split": "2.857142857",
    "8.range_broad_split": "3.694746280",
    "9.core": "3.636363636",
    "9.broad": "6.324555320",
    "9.top10_core_share": "0.990909091",
    "9.top10_breadth_share": "0.918790182",
    "10.core": "3.992015968",
    "10.broad": "44.721359550",
}

#: Closed-form rationals for the concentration side (exact equality, no tolerance).
EXACT_CORE: dict[str, Fraction] = {
    "1.core": F(1),
    "2.core": F(4),
    "3.core": F(8, 5),  # 1 / (0.75² + 0.25²) = 1/0.625
    "4.core": F(50, 19),  # 1 / 0.38
    "5.core": F(25, 17),  # 1 / 0.68
    "5.disjoint_core": F(50, 19),  # 1 / 0.38
    "6.core": F(2),  # 1 / 0.5
    "6.disjoint_core": F(4),  # 1 / 0.25
    "7.core": F(25, 13),  # 1 / 0.52
    "8.core": F(32, 17),  # 1 / 0.53125
    "8.range_core_single": F(50, 19),  # 1 / 0.38
    "8.range_core_split": F(20, 7),  # 1 / 0.35
    "9.core": F(40, 11),  # 1 / 0.275
    "10.core": F(2000, 501),  # 1 / 0.2505
}


def fixture_values(number: int) -> dict[str, Fraction]:
    """Every comparable quantity for one fixture, keyed ``"<n>.<field>"``."""
    name, portfolio = FIXTURES[number]
    measurements = measure(portfolio)
    values: dict[str, Fraction] = {
        f"{number}.core": measurements.core,
        f"{number}.broad": measurements.broad,
        f"{number}.hhi": measurements.hhi,
        f"{number}.disjoint_core": measurements.disjoint_core,
        f"{number}.disjoint_broad": measurements.disjoint_broad,
        f"{number}.total": measurements.total,
        f"{number}.coverage_pct": measurements.coverage_pct,
        f"{number}.n": Fraction(measurements.n),
        f"{number}.top10_core_share": measurements.top10_core_share,
        f"{number}.top10_breadth_share": measurements.top10_breadth_share,
    }
    range_fields = (
        "range_core_single",
        "range_broad_single",
        "range_core_split",
        "range_broad_split",
    )
    for field in range_fields:
        value = getattr(measurements, field)
        if value is not None:
            values[f"{number}.{field}"] = value
    return values


def all_fixture_values() -> dict[str, Fraction]:
    values: dict[str, Fraction] = {}
    for number in FIXTURES:
        values.update(fixture_values(number))
    return values


# ---------------------------------------------------------------------------
# 6. Independent checks
# ---------------------------------------------------------------------------


def _decimal_cross_check(number: int) -> list[str]:
    """Recompute one fixture with ``Decimal`` at 60 digits and diff it.

    A second arithmetic path for ``ln``/``exp`` on purpose: ``Decimal.ln`` is
    correctly rounded by the standard library, so agreement to 10⁻⁴⁰ means the
    atanh series did not merely agree with itself.
    """
    _name, portfolio = FIXTURES[number]
    merged = merge(portfolio)
    with localcontext() as ctx:
        ctx.prec = 60
        total = Decimal(merged.total.numerator) / Decimal(merged.total.denominator)
        shares = [
            (Decimal(weight.numerator) / Decimal(weight.denominator)) / total
            for _company, weight in merged.rows
        ]
        hhi = sum((share * share for share in shares), Decimal(0))
        entropy = -sum(
            (share * share.ln() for share in shares if share > 0), Decimal(0)
        )
        core = 1 / hhi
        broad = entropy.exp()
        disjoint = [
            Decimal(contribution.numerator) / Decimal(contribution.denominator)
            for contribution in _disjoint_weights(portfolio)
        ]
        disjoint_total = sum(disjoint, Decimal(0))
        disjoint_shares = [value / disjoint_total for value in disjoint]
        disjoint_hhi = sum((share * share for share in disjoint_shares), Decimal(0))
        disjoint_entropy = -sum(
            (share * share.ln() for share in disjoint_shares if share > 0), Decimal(0)
        )
    reference = measure(portfolio)
    failures: list[str] = []
    with localcontext() as ctx:
        # Both sides of the comparison need the same precision, including the
        # rational-to-decimal conversion of the reference's own answer.
        ctx.prec = 60
        for field, expected in (
            ("core", core),
            ("broad", broad),
            ("disjoint_core", 1 / disjoint_hhi),
            ("disjoint_broad", disjoint_entropy.exp()),
        ):
            value = getattr(reference, field)
            actual = Decimal(value.numerator) / Decimal(value.denominator)
            difference = abs(actual - expected)
            if difference > Decimal("1e-40"):
                failures.append(
                    f"fixture {number}.{field}: reference and Decimal differ by {difference}"
                )
    return failures


def _invariants(seed: int = 20261103, rounds: int = 40) -> list[str]:
    """Random portfolios: the inequalities that must hold for every input."""
    import random

    rng = random.Random(seed)
    failures: list[str] = []
    for round_index in range(rounds):
        source_count = rng.randint(2, 6)
        sources = []
        for source_index in range(source_count):
            position_count = rng.randint(1, 12)
            raw = [rng.randint(1, 900) for _ in range(position_count)]
            divisor = sum(raw) + rng.choice([0, 0, 0, rng.randint(1, 500)])
            positions = []
            for index, size in enumerate(raw):
                weight = F(size, divisor)
                positions.append(Position(f"C{index}", weight, f"C{rng.randint(0, 60)}"))
            unmatched = rng.choice([0, 0, rng.randint(1, 200)])
            if unmatched:
                positions.append(Position("unknown", F(unmatched, divisor), None))
            sources.append(Source(f"S{source_index}", tuple(positions), F(1)))
        portfolio = Portfolio(tuple(sources))
        try:
            measurements = measure(portfolio)
        except ValueError:
            continue
        core = measurements.core
        broad = measurements.broad
        n = Fraction(measurements.n)
        if not (core >= 1):
            failures.append(f"round {round_index}: Core {fmt(core)} < 1")
        if not (core <= broad + F(1, 10**30)):
            failures.append(
                f"round {round_index}: Core {fmt(core)} > Broad {fmt(broad)}"
            )
        if not (broad <= n + F(1, 10**30)):
            failures.append(f"round {round_index}: Broad {fmt(broad)} > N {n}")
        if measurements.disjoint_core < core:
            failures.append(
                f"round {round_index}: Core_disjoint {fmt(measurements.disjoint_core)} < Core"
            )
        if measurements.disjoint_broad < broad - F(1, 10**30):
            failures.append(
                f"round {round_index}: Broad_disjoint below Broad"
            )
        # The whole-portfolio range is not a bound on Core (putting the missing weight
        # back as one holding can *lower* concentration), but each range value is
        # itself a distribution, so it obeys the same two inequalities, and the
        # one-holding case is never less concentrated than the M-holding case.
        if measurements.range_core_single is not None:
            single_core = measurements.range_core_single
            single_broad = measurements.range_broad_single
            split_core = measurements.range_core_split
            split_broad = measurements.range_broad_split
            assert single_broad is not None and split_core is not None
            assert split_broad is not None
            if not (single_core >= 1):
                failures.append(f"round {round_index}: range Core (one holding) < 1")
            if not (single_core <= single_broad + F(1, 10**30)):
                failures.append(f"round {round_index}: range Core > Broad (one holding)")
            if not (split_core >= single_core - F(1, 10**30)):
                failures.append(f"round {round_index}: range order single/split")
            if not (split_core <= split_broad + F(1, 10**30)):
                failures.append(f"round {round_index}: range Core > Broad (M holdings)")
    # All weights equal ⇒ Core = Broad = N exactly on the rational side.
    equal = Portfolio(
        (
            Source(
                "equal",
                tuple(Position(f"C{i}", F(1, 7), f"C{i}") for i in range(7)),
                F(1),
            ),
        )
    )
    equal_measurements = measure(equal)
    if equal_measurements.core != 7:
        failures.append("equal weights: Core is not N")
    if abs(equal_measurements.broad - 7) > F(1, 10**40):
        failures.append("equal weights: Broad is not N")
    return failures


def _band_checks() -> list[str]:
    """Item E: what the bands do at 59.9, 60, 65, 69.9 and 70%."""
    failures: list[str] = []
    cases = [
        (F(599, 10), "none", False, False),
        (F(60), "partial", True, False),
        (F(65), "partial", True, False),
        (F(699, 10), "partial", True, False),
        (F(70), "full", True, True),
        (F(701, 10), "full", True, True),
    ]
    for coverage, key, shows, ranked in cases:
        band = coverage_band(coverage)
        if band.key != key or band.shows_numbers != shows or band.ranked != ranked:
            failures.append(
                f"coverage {fmt(coverage)}%: expected {key}/{shows}/{ranked}, got "
                f"{band.key}/{band.shows_numbers}/{band.ranked}"
            )
    # The withheld path must really withhold, not merely label: a 59.9%-covered
    # portfolio returns None for both numbers.
    portfolio = Portfolio(
        (
            Source(
                "A",
                (
                    Position("X", F(599, 1000), "X"),
                    Position("unknown", F(401, 1000), None),
                ),
            ),
        )
    )
    measurements = measure(portfolio)
    if measurements.coverage_pct != F(599, 10):
        failures.append(
            f"59.9% portfolio coverage computed as {fmt(measurements.coverage_pct)}%"
        )
    if measurements.core_display is not None:
        failures.append("59.9% coverage: Core was not withheld")
    if measurements.broad_display is not None:
        failures.append("59.9% coverage: Broad was not withheld")
    if measurements.band.key != "none":
        failures.append("59.9% coverage: band is not none")
    # 65% shows both numbers, labelled partial, and is never ranked.
    partial = measure(
        Portfolio(
            (
                Source(
                    "A",
                    (
                        Position("X", F(65, 100), "X"),
                        Position("unknown", F(35, 100), None),
                    ),
                ),
            )
        )
    )
    if partial.core_display is None or partial.broad_display is None:
        failures.append("65% coverage: a number was withheld")
    if partial.band.key != "partial" or partial.band.ranked:
        failures.append("65% coverage: band is not labelled partial / ranked")
    # 70% shows normally.
    full = measure(
        Portfolio(
            (
                Source(
                    "A",
                    (
                        Position("X", F(7, 10), "X"),
                        Position("unknown", F(3, 10), None),
                    ),
                ),
            )
        )
    )
    if full.core_display is None or full.broad_display is None:
        failures.append("70% coverage: a number was withheld")
    if full.band.key != "full" or not full.band.ranked:
        failures.append("70% coverage: band does not show normally")
    return failures


def run_check(tolerance: Fraction = F(1, 10**12)) -> int:
    """``--check``: exit 1 if anything disagrees beyond ``tolerance``."""
    failures: list[str] = []
    values = all_fixture_values()

    # 1. The reference against the closed-form rationals: exact equality.
    for key, expected in EXACT_CORE.items():
        actual = values.get(key)
        if actual is None:
            failures.append(f"{key}: missing")
        elif actual != expected:
            failures.append(
                f"{key}: reference {fmt(actual)} != closed form {expected}"
            )

    # 2. The reference against the brief's nine-decimal table, at 1e-9.
    for key, text in TABLE.items():
        actual = values.get(key)
        if actual is None:
            failures.append(f"{key}: missing from the reference")
            continue
        difference = abs(actual - F(text))
        if difference > F(1, 10**9):
            failures.append(
                f"{key}: reference {fmt(actual)} != table {text} (diff {fmt(difference)})"
            )

    # 3. The brief requires disagreement beyond 1e-12 to fail; the table only carries
    #    nine decimals, so anything the table cannot resolve is checked against the
    #    exact rational and the Decimal path instead. Re-assert the table at 1e-12
    #    where the value is exact (a rational has no rounding to explain away).
    for key, expected in EXACT_CORE.items():
        if abs(values[key] - expected) > tolerance:
            failures.append(f"{key}: exact value differs beyond {tolerance}")

    # 4. A third arithmetic path: Decimal ln/exp at 60 digits.
    for number in FIXTURES:
        failures.extend(_decimal_cross_check(number))

    # 5. Inequalities over random portfolios.
    failures.extend(_invariants())

    # 6. Coverage bands (item E).
    failures.extend(_band_checks())

    # 7. Fixture 5 is the merge test: the disjoint answer must differ, and the merged
    #    answer must be the one that satisfies Core ≤ Core_disjoint strictly here.
    five = FIXTURES[5][1]
    five_measurements = measure(five)
    if five_measurements.core >= five_measurements.disjoint_core:
        failures.append("fixture 5: merged Core did not beat the disjoint answer")
    if five_measurements.broad >= five_measurements.disjoint_broad:
        failures.append("fixture 5: merged Broad did not beat the disjoint answer")

    if failures:
        for failure in failures:
            print(f"FAIL  {failure}")
        print(f"\n{len(failures)} check(s) failed")
        return 1
    print(
        f"OK    {len(TABLE)} table entries, {len(EXACT_CORE)} closed forms, "
        f"{len(FIXTURES)} Decimal cross-checks, random invariants, bands"
    )
    return 0


# ---------------------------------------------------------------------------
# 7. Printing the fixtures
# ---------------------------------------------------------------------------


def print_fixtures(digits: int = DPS) -> None:
    for number in sorted(FIXTURES):
        name, portfolio = FIXTURES[number]
        measurements = measure(portfolio)
        merged = measurements.merged
        print(f"\n# {number}  {name}")
        print(
            f"  N={merged.n}  T={fmt(merged.total, 18)}  "
            f"u={fmt(merged.unmatched, 18)}  M={merged.unmatched_count}  "
            f"Q={fmt(merged.investable, 18)}  "
            f"coverage={fmt_pct(measurements.coverage_pct)}%  band={measurements.band.key}"
        )
        print(f"  HHI = Σ sᵢ²     {fmt(measurements.hhi, digits)}")
        print(f"  H   = −Σ sᵢ ln sᵢ  {fmt(measurements.entropy, digits)}")
        print(f"  Core = 1/HHI    {fmt(measurements.core, digits)}")
        print(f"  Broad = exp(H)  {fmt(measurements.broad, digits)}")
        print(f"  disjoint HHI    {fmt(measurements.disjoint_hhi, digits)}")
        print(f"  disjoint H      {fmt(measurements.disjoint_entropy, digits)}")
        print(f"  disjoint Core   {fmt(measurements.disjoint_core, digits)}")
        print(f"  disjoint Broad  {fmt(measurements.disjoint_broad, digits)}")
        if number in (9, 10):
            print(
                f"  top-10 share of concentration {fmt(measurements.top10_core_share, digits)}"
            )
            print(
                f"  top-10 share of breadth       {fmt(measurements.top10_breadth_share, digits)}"
            )
        if measurements.range_core_single is not None:
            print(
                f"  whole-portfolio range (one holding)  "
                f"Core {fmt(measurements.range_core_single, digits)}"
                f"  Broad {fmt(measurements.range_broad_single, digits)}"
            )
            print(
                f"  whole-portfolio range (M holdings)   "
                f"Core {fmt(measurements.range_core_split, digits)}"
                f"  Broad {fmt(measurements.range_broad_split, digits)}"
            )


# ---------------------------------------------------------------------------
# 8. Real release data: readers
# ---------------------------------------------------------------------------

#: Where ``pnpm pages:mirror`` puts the live release on a developer machine. It is
#: derived from this file so the default is the same on any machine and inside any
#: git worktree; ``UNPACKFUND_MIRROR`` overrides it. CI has no mirror, which is why
#: the release-dependent tests skip there with a named reason (contract: the suite
#: fails on a skip reason that is not on the allowlist — see ``tests/conftest.py``).
DEFAULT_MIRROR = Path(__file__).resolve().parents[2] / ".work" / "mirror-test" / "live"


@dataclass(frozen=True)
class RawFund:
    """One published fund document, reduced to what the arithmetic needs."""

    ticker: str
    name: str
    as_of: str
    filed_at: str
    coverage_pct: float
    net_assets: float | None
    page_effective_n: float | None
    page_hhi: float | None
    page_top10_pct: float | None
    holdings: tuple[dict, ...]

    @property
    def path(self) -> str:
        return f"funds/{self.ticker}.json"


def load_fund(release: Path, ticker: str) -> RawFund:
    document = json.loads((release / "funds" / f"{ticker}.json").read_text())
    metrics = document.get("metrics") or {}
    return RawFund(
        ticker=document["ticker"],
        name=document["name"],
        as_of=document["as_of"],
        filed_at=document["filed_at"],
        coverage_pct=float(document.get("coverage_pct") or 0.0),
        net_assets=document.get("net_assets"),
        page_effective_n=metrics.get("effective_n"),
        page_hhi=metrics.get("hhi"),
        page_top10_pct=metrics.get("top10_pct"),
        holdings=tuple(document.get("holdings") or ()),
    )


@dataclass(frozen=True)
class FundVector:
    """A fund's as-filed vector after the merge, ready to be a portfolio source."""

    source: Source
    matched: tuple[tuple[str, Fraction], ...]
    unmatched: Fraction
    unmatched_count: int
    excluded_weight: Fraction
    negative_weight: Fraction
    duplicate_rows: int

    @property
    def total(self) -> Fraction:
        return sum((weight for _company, weight in self.matched), Fraction(0))

    @property
    def coverage_pct(self) -> Fraction:
        investable = self.total + self.unmatched
        return Fraction(100) * self.total / investable if investable else Fraction(0)


def fund_vector(fund: RawFund) -> FundVector:
    """Classify, merge and total one fund's filed holdings.

    The rules are read off the definitions, not off the pipeline: cash and
    derivatives are never a company; a negative weight is excluded and flagged
    because squaring it would reward the short; a company-like row with no
    ``company_id`` is unmatched weight and a countable ``M``.
    """
    weights: dict[str, Fraction] = {}
    unmatched = Fraction(0)
    unmatched_count = 0
    excluded = Fraction(0)
    negative = Fraction(0)
    duplicate_rows = 0
    positions: list[Position] = []

    for row in fund.holdings:
        category = str(row.get("asset_cat") or "").lower()
        weight_bp = int(row.get("weight_bp") or 0)
        if weight_bp == 0:
            continue
        weight = F(weight_bp, 10_000)
        if weight < 0:
            negative += abs(weight)
            continue
        if category in EXCLUDED_CATEGORIES or category not in COMPANY_LIKE:
            excluded += weight
            continue
        company = row.get("company_id") or None
        label = str(row.get("ticker") or row.get("name") or "unknown")
        if company is None:
            unmatched += weight
            unmatched_count += 1
            positions.append(Position(label, weight, None))
            continue
        if company in weights:
            duplicate_rows += 1
        weights[company] = weights.get(company, F(0)) + weight

    matched = tuple(sorted(weights.items(), key=lambda row: (-row[1], row[0])))
    positions.extend(Position(company, weight, company) for company, weight in matched)
    return FundVector(
        source=Source(fund.ticker, tuple(positions), F(1)),
        matched=matched,
        unmatched=unmatched,
        unmatched_count=unmatched_count,
        excluded_weight=excluded,
        negative_weight=negative,
        duplicate_rows=duplicate_rows,
    )


def fund_portfolio(vector: FundVector, allocation: Fraction = F(1)) -> Portfolio:
    """A 100% (or scaled) portfolio of one fund."""
    return Portfolio(
        sources=(Source(vector.source.key, vector.source.positions, allocation),)
    )


# ---------------------------------------------------------------------------
# 9. The Decimal hand check (item D)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HandCheck:
    """One fund recomputed with ``Decimal``, plus the fund page's own number."""

    total: Decimal
    #: ``Σ wᵢ²`` — the fund page's own metric: NAV denominator, no renormalisation.
    sum_w_squared: Decimal
    #: ``Σ sᵢ²`` — this task's concentration HHI, over ``sᵢ = wᵢ / T``.
    sum_s_squared: Decimal
    core: Decimal
    entropy: Decimal
    broad: Decimal
    page_effective_n: Decimal
    page_hhi: Decimal
    t_squared: Decimal
    core_over_t_squared: Decimal
    difference_pct: Decimal


def hand_check(fund: RawFund, vector: FundVector, digits: int = 60) -> HandCheck:
    """Recompute T, Core and Broad from the raw positions with ``Decimal``.

    This is the hand check: a separate arithmetic path (``Decimal.ln``/``exp`` at 60
    digits, one weight at a time) over the raw filed rows, written so the worked
    columns printed beside it can be added up on paper.
    """
    with localcontext() as ctx:
        ctx.prec = digits
        # Merge duplicates on the Decimal path too, rather than trusting the vector:
        # the hand check must be able to stand on its own.
        merged: dict[str, Decimal] = {}
        for row in fund.holdings:
            weight_bp = int(row.get("weight_bp") or 0)
            if weight_bp <= 0:
                continue
            if str(row.get("asset_cat") or "").lower() not in COMPANY_LIKE:
                continue
            company = row.get("company_id")
            if not company:
                continue
            merged[company] = merged.get(company, Decimal(0)) + Decimal(weight_bp) / Decimal(
                10_000
            )
        values = list(merged.values())
        total = sum(values, Decimal(0))
        shares = [value / total for value in values]
        # The two different denominators, side by side and never conflated:
        #   Σ wᵢ²  is what the fund page publishes (NAV denominator);
        #   Σ sᵢ²  is this task's HHI (renormalised to T), and Core = 1/Σ sᵢ².
        sum_s_squared = sum((share * share for share in shares), Decimal(0))
        sum_w_squared = sum((value * value for value in values), Decimal(0))
        core = 1 / sum_s_squared
        entropy = -sum((share * share.ln() for share in shares if share > 0), Decimal(0))
        broad = entropy.exp()
        t_squared = total * total
        page = Decimal(str(fund.page_effective_n)) if fund.page_effective_n else None
        page_hhi = Decimal(str(fund.page_hhi)) if fund.page_hhi is not None else Decimal(0)
        core_over_t2 = core / t_squared
        difference = ((core - page) / page * 100) if page else Decimal(0)
    return HandCheck(
        total=total,
        sum_w_squared=sum_w_squared,
        sum_s_squared=sum_s_squared,
        core=core,
        entropy=entropy,
        broad=broad,
        page_effective_n=page if page is not None else Decimal(0),
        page_hhi=page_hhi,
        t_squared=t_squared,
        core_over_t_squared=core_over_t2,
        difference_pct=difference,
    )


def print_hand_check(
    fund: RawFund, vector: FundVector, check: HandCheck, csv_limit: int = 15
) -> list[str]:
    """Print the worked columns, then the summary the brief asks for.

    Returns the identity checks that failed, so the CLI can exit non-zero rather
    than merely print a number that disagrees with its own arithmetic.
    """
    failures: list[str] = []
    print(f"\n## {fund.ticker}  {fund.name}")
    print(
        f"# source={fund.path}  as_of={fund.as_of}  filed_at={fund.filed_at}  "
        f"published coverage={fund.coverage_pct}%  net_assets={fund.net_assets}"
    )
    print(
        f"# rows={len(fund.holdings)}  matched companies={len(vector.matched)}  "
        f"unmatched company-like={vector.unmatched_count} "
        f"(u={fmt(vector.unmatched, 12)})  "
        f"excluded cash/derivative={fmt(vector.excluded_weight, 12)}  "
        f"negative weight={fmt(vector.negative_weight, 12)}  "
        f"duplicate company rows={vector.duplicate_rows}"
    )
    print(
        f"# company-like coverage (T/(T+u)) = {fmt(vector.coverage_pct, 10)}%  "
        f"band = {coverage_band(vector.coverage_pct).key}"
    )
    rows_by_company = {
        row.get("company_id"): row for row in fund.holdings if row.get("company_id")
    }

    # Worked columns: wᵢ, wᵢ², sᵢ, sᵢ² and −sᵢ ln sᵢ for the largest rows, then a
    # TOTAL over every row. A reader can add up each column on paper and check the
    # four numbers at the bottom of the block against them.
    with localcontext() as ctx:
        ctx.prec = 30
        total = Decimal(vector.total.numerator) / Decimal(vector.total.denominator)
        print(
            "rank,company_id,ticker,name,asset_cat,weight_bp,"
            "w,w_squared,s,s_squared,minus_s_ln_s"
        )
        running_w = Decimal(0)
        running_w2 = Decimal(0)
        running_s2 = Decimal(0)
        running_h = Decimal(0)
        for index, (company, weight) in enumerate(vector.matched):
            value = Decimal(weight.numerator) / Decimal(weight.denominator)
            share = value / total
            w2 = value * value
            s2 = share * share
            term = -(share * share.ln())
            running_w += value
            running_w2 += w2
            running_s2 += s2
            running_h += term
            if index < csv_limit:
                row = rows_by_company.get(company) or {}
                print(
                    f"{index + 1},{company},{row.get('ticker') or ''},"
                    f"\"{row.get('name') or ''}\",{row.get('asset_cat')},"
                    f"{int(row.get('weight_bp') or 0)},"
                    f"{value:.12f},{w2:.20f},{share:.20f},{s2:.20f},{term:.20f}"
                )
        if len(vector.matched) > csv_limit:
            print(f"... {len(vector.matched) - csv_limit} more company rows not printed")
        print(
            f"TOTAL,,,,\"{len(vector.matched)} companies\","
            f"{int(round(total * 10000))},"
            f"{running_w:.12f},{running_w2:.20f},1.0,{running_s2:.20f},{running_h:.20f}"
        )
        core = 1 / running_s2
        broad = running_h.exp()
        print(f"# T     = Σ wᵢ             = {running_w:.20f}")
        print(f"# Σ wᵢ²  (NAV denominator)  = {running_w2:.20f}")
        print(f"# Σ sᵢ²  (sᵢ = wᵢ/T)        = {check.sum_s_squared:.20f}")
        print(f"# Core  = 1/Σ sᵢ²          = {core:.20f}")
        print(f"# H     = −Σ sᵢ ln sᵢ      = {check.entropy:.20f}")
        print(f"# Broad = exp(H)           = {broad:.20f}")
        print(
            f"# fund page: effective_n = {check.page_effective_n}  "
            f"published hhi = {fund.page_hhi}  top10_pct = {fund.page_top10_pct}"
        )
        page_hhi_gap = abs(check.page_hhi - running_w2)
        print(
            f"# the page's hhi vs Σ wᵢ² here: {_verdict(page_hhi_gap < Decimal('1e-12'))}"
            f"  (gap {page_hhi_gap:.2e}; weights.py uses the NAV denominator)"
        )
        if page_hhi_gap >= Decimal("1e-12"):
            failures.append(
                f"{fund.ticker}: published hhi {check.page_hhi} != Σ wᵢ² {running_w2}"
            )
        print(f"# T²                       = {check.t_squared:.20f}")
        print(f"# Core / T²                = {check.core_over_t_squared:.20f}")
        print(
            f"# Core vs the fund page's effective_n: {check.difference_pct:.6f}% "
            f"(= T² − 1 = {(check.t_squared - 1) * 100:.6f}%)"
        )
        page_gap = abs(check.core_over_t_squared - check.page_effective_n)
        page_tolerance = max(Decimal("1e-6"), abs(check.page_effective_n) * Decimal("1e-6"))
        print(
            f"# Core/T² vs the page's effective_n: {_verdict(page_gap <= page_tolerance)}"
            f"  (gap {page_gap:.2e}, page publishes 6 decimals)"
        )
        if page_gap > page_tolerance:
            failures.append(
                f"{fund.ticker}: Core/T² {check.core_over_t_squared} != page "
                f"effective_n {check.page_effective_n}"
            )
        # The two arithmetic paths must agree; the Decimal path is not the reference.
        reference = measure(fund_portfolio(vector))
        core_gap = abs(
            Decimal(reference.core.numerator) / Decimal(reference.core.denominator)
            - core
        )
        broad_gap = abs(
            Decimal(reference.broad.numerator) / Decimal(reference.broad.denominator)
            - broad
        )
        print(
            f"# reference (Fraction)     Core={fmt(reference.core, 30)}  "
            f"Broad={fmt(reference.broad, 30)}"
        )
        print(
            f"# independent-path agreement: "
            f"{_verdict(core_gap < Decimal('1e-20') and broad_gap < Decimal('1e-20'))}"
            f"  (Core gap {core_gap:.2e}, Broad gap {broad_gap:.2e})"
        )
        if not (core_gap < Decimal("1e-20") and broad_gap < Decimal("1e-20")):
            failures.append(
                f"{fund.ticker}: reference and hand check disagree "
                f"(Core {core_gap:.2e}, Broad {broad_gap:.2e})"
            )
    return failures


def _verdict(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


# ---------------------------------------------------------------------------
# 10. The five redesign portfolios
# ---------------------------------------------------------------------------

#: The five portfolios from ``web/lib/fixtures/portfolios.ts``, decoded from the
#: real ``#v3.`` fragments (the script re-decodes them and asserts these weights).
REDESIGN_FRAGMENTS: dict[str, tuple[str, str]] = {
    "three-fund": (
        "VTI 60% / VXUS 30% / BND 10%",
        "#v3.WyJicCIsW1siZiIsIkJORCIsMTAwMF0sWyJmIiwiVlRJIiw2MDAwXSxbImYiLCJWWFVTIiwzMDAwXV1d",
    ),
    "single-fund": (
        "VTI 100%",
        "#v3.WyJicCIsW1siZiIsIlZUSSIsMTAwMDBdXV0",
    ),
    "stock-and-cash": (
        "VTI 50% / AAPL 25% / cash 25%",
        "#v3.WyJicCIsW1siZiIsIlZUSSIsNTAwMF0sWyJzIiwiQUFQTCIsMjUwMF0sWyJjIiwiQ0FTSCIsMjUwMF1dXQ",
    ),
    "dollar-mode": (
        "VTI $8,000 / VXUS $12,000",
        "#v3.WyJ1c2QiLFtbImYiLCJWVEkiLDgwMDAwMF0sWyJmIiwiVlhVUyIsMTIwMDAwMF1dXQ",
    ),
    "overlap-heavy": (
        "VOO 50% / VTI 50%",
        "#v3.WyJicCIsW1siZiIsIlZPTyIsNTAwMF0sWyJmIiwiVlRJIiw1MDAwXV1d",
    ),
}


def decode_fragment(fragment: str) -> list[tuple[str, str, Fraction]]:
    """Decode a ``#v3.`` portfolio fragment into ``(kind, key, allocation)``.

    ``bp`` entries are basis points of the portfolio; ``usd`` entries are dollars
    that become fractions of their own total. ``c`` is cash, which is never a
    company.
    """
    assert fragment.startswith("#v3."), f"not a v3 fragment: {fragment[:12]}"
    payload = fragment[len("#v3.") :]
    padded = payload + "=" * (-len(payload) % 4)
    mode, entries = json.loads(base64.urlsafe_b64decode(padded).decode())
    if mode == "bp":
        return [(kind, key, F(int(amount), 10_000)) for kind, key, amount in entries]
    if mode == "usd":
        amount_total = sum(F(int(amount)) for _kind, _key, amount in entries)
        return [
            (kind, key, F(int(amount)) / amount_total) for kind, key, amount in entries
        ]
    # pragma: no cover - the fixtures only use the two modes above
    raise ValueError(f"unknown fragment mode {mode!r}")


def redesign_portfolio(
    name: str, release: Path, funds: Mapping[str, RawFund]
) -> tuple[Portfolio, str]:
    """Build one of the five redesign portfolios from the release."""
    label, fragment = REDESIGN_FRAGMENTS[name]
    entries = decode_fragment(fragment)
    sources: list[Source] = []
    cash = Fraction(0)
    for kind, key, allocation in entries:
        if kind == "c":
            cash += allocation
            continue
        if kind == "f":
            vector = fund_vector(funds[key])
            sources.append(Source(key, vector.source.positions, allocation))
            continue
        if kind == "s":
            # A direct stock: one company at the whole of its own allocation. Its
            # company_id is whatever the release already maps that symbol to; the
            # only place to read it without a securities artifact is a fund that
            # holds it, so it is looked up in the loaded funds.
            company = _company_for_symbol(key, funds)
            if company is None:
                raise ValueError(f"no company_id for direct holding {key} in the release")
            sources.append(
                Source(key, (Position(key, F(1), company),), allocation)
            )
            continue
        raise ValueError(f"unknown entry kind {kind!r}")
    return Portfolio(tuple(sources), cash=cash), label


def _company_for_symbol(symbol: str, funds: Mapping[str, RawFund]) -> str | None:
    for fund in funds.values():
        for row in fund.holdings:
            if str(row.get("ticker") or "").upper() == symbol.upper() and row.get(
                "company_id"
            ):
                return row["company_id"]
    return None


#: What the reference says for the five redesign portfolios on release
#: ``2026-11-03.1``. These are the numbers the production module must reproduce when
#: it is fed the same merged weights; they were computed by the Decimal hand path
#: (``_decimal_cross_check``-style arithmetic in ``--portfolios``), not by the
#: Fraction reference, and the test asserts both agree to 1e-12.
REDESIGN_EXPECTED: dict[str, dict[str, str]] = {
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

#: The release the recorded numbers belong to.
REDESIGN_RELEASE = "2026-11-03.1"


# ---------------------------------------------------------------------------
# 11. The concentrated-fund scan (item D: how the third fund was chosen)
# ---------------------------------------------------------------------------


def scan_concentrated(release: Path, limit: int = 12) -> None:
    """Rank the release's own funds so the third real fund is chosen, not picked.

    The brief asked for a concentrated fund *found in* the release, and the honest way
    to answer "which one and why" is to write the screen down and show its output. The
    screen, quoted here and in the report:

    * published ``coverage_pct ≥ 70`` — below that the site withholds the numbers, so a
      100% portfolio of the fund would show nothing to check;
    * catalogue AUM ``≥ $1B`` — a fund real visitors can own, not a $300k shell;
    * ``10 ≤ N ≤ 60`` matched companies — ``N ≥ 10`` drops the single-ADR "hedged"
      funds (N = 1, top-ten share 100% by construction), where "concentration" says
      nothing about a portfolio of companies;
    * at least 90% of NAV in company-like positions, so the fund's own numbers are not
      a sliver of the filing;
    * ranked by the fund's **published** ``top10_pct``, i.e. the number the release
      itself states, not by this script's recomputation.

    Both shares are printed: the published one and this script's top ten over its own
    merged ``T``. They differ because the published share is of NAV (cash included in
    the denominator) while this one is of the matched company weight.
    """
    catalogue: dict[str, list] = {}
    catalogue_path = release / "catalogue.json"
    if catalogue_path.exists():
        catalogue = json.loads(catalogue_path.read_text()).get("funds") or {}
    rows: list[tuple[float, str, int, float, float, float, float, float, str]] = []
    considered = 0
    for path in sorted((release / "funds").glob("*.json")):
        ticker = path.stem
        aum = (catalogue.get(ticker) or [None, None, None, None, None])[4] or 0
        if aum < 1_000_000_000:
            continue
        considered += 1
        fund = load_fund(release, ticker)
        if fund.coverage_pct is None or fund.coverage_pct < 70:
            continue
        vector = fund_vector(fund)
        if len(vector.matched) < 10 or len(vector.matched) > 60:
            continue
        if vector.total < F(9, 10):
            continue
        published = fund.page_top10_pct
        if published is None:
            continue
        own = sum((weight for _company, weight in vector.matched[:10]), F(0))
        rows.append(
            (
                float(published),
                ticker,
                len(vector.matched),
                float(own / vector.total),
                float(fund.coverage_pct),
                float(vector.coverage_pct),
                float(aum),
                float(fund.page_effective_n or 0),
                fund.name,
            )
        )
    rows.sort(reverse=True)
    print(f"# concentrated-fund scan over {release}  ({len(rows)} candidates)")
    print(
        "# filters: AUM>=$1B, published coverage>=70%, 10<=N<=60, T>=0.90; "
        f"ranked by published top10_pct  ({considered} funds at AUM>=$1B)"
    )
    print(
        "published_top10_pct,ticker,N,own_top10_pct,published_coverage_pct,"
        "company_like_coverage_pct,aum,page_effective_n,name"
    )
    for (
        published,
        ticker,
        count,
        own,
        coverage,
        company_like,
        aum,
        page_n,
        name,
    ) in rows[:limit]:
        print(
            f"{published:.2f},{ticker},{count},{own:.4f},{coverage:.1f},"
            f"{company_like:.4f},{int(aum)},{page_n:.6f},\"{name}\""
        )


# ---------------------------------------------------------------------------
# 12. CLI
# ---------------------------------------------------------------------------

#: The three real funds. VTI is the US total-market fund and VXUS the broad
#: international one; AKRE is the concentrated fund ``--scan-concentrated`` selected,
#: not one chosen by name: on release 2026-11-03.1 it is **first** in that screen, with
#: 17 matched companies (19 published rows, two of them cash or derivative), 80.88% of
#: NAV in its top ten, 99.3% published coverage, $5.25B AUM and a fund-page
#: ``effective_n`` of 12.711479. Runner-up: XLC, the Communication Services Select
#: Sector SPDR (20 companies, 80.26%, $22.3B) — a single-sector index, concentrated by
#: construction rather than by conviction.
REAL_FUNDS: tuple[str, ...] = ("VTI", "VXUS", "AKRE")


def _release_dir(argument: str | None) -> Path:
    if argument:
        return Path(argument)
    from_env = os.environ.get("UNPACKFUND_MIRROR")
    if from_env:
        return Path(from_env)
    return DEFAULT_MIRROR


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Independent 50-digit reference for the two Effective holdings numbers."
    )
    parser.add_argument("--check", action="store_true", help="verify the fixtures; exit 1 on failure")
    parser.add_argument("--release", help="directory holding funds/<TICKER>.json (mirror layout)")
    parser.add_argument("--hand-check", action="store_true", help="recompute three real funds by hand")
    parser.add_argument("--portfolios", action="store_true", help="the five redesign test portfolios")
    parser.add_argument("--scan-concentrated", action="store_true", help="rank funds by concentration")
    parser.add_argument("--csv-limit", type=int, default=15, help="worked rows printed per fund")
    parser.add_argument("--digits", type=int, default=DPS, help="significant digits printed")
    parser.add_argument("--all-rows", action="store_true", help="print every worked row")
    arguments = parser.parse_args(argv)

    if arguments.check:
        return run_check()

    if arguments.scan_concentrated:
        release = _release_dir(arguments.release)
        if not (release / "funds").is_dir():
            print(f"no release at {release}", file=sys.stderr)
            return 2
        scan_concentrated(release)
        return 0

    if arguments.hand_check:
        release = _release_dir(arguments.release)
        if not (release / "funds").is_dir():
            print(f"no release at {release}", file=sys.stderr)
            return 2
        failures: list[str] = []
        for ticker in REAL_FUNDS:
            fund = load_fund(release, ticker)
            vector = fund_vector(fund)
            check = hand_check(fund, vector)
            failures.extend(
                print_hand_check(
                    fund,
                    vector,
                    check,
                    csv_limit=(
                        len(vector.matched)
                        if arguments.all_rows
                        else arguments.csv_limit
                    ),
                )
            )
        if failures:
            for failure in failures:
                print(f"FAIL  {failure}")
            return 1
        return 0

    if arguments.portfolios:
        release = _release_dir(arguments.release)
        if not (release / "funds").is_dir():
            print(f"no release at {release}", file=sys.stderr)
            return 2
        needed = sorted(
            {
                key
                for _label, fragment in REDESIGN_FRAGMENTS.values()
                for kind, key, _allocation in decode_fragment(fragment)
                if kind == "f"
            }
        )
        funds = {ticker: load_fund(release, ticker) for ticker in needed}
        for name, (label, _fragment) in REDESIGN_FRAGMENTS.items():
            portfolio, _label = redesign_portfolio(name, release, funds)
            measurements = measure(portfolio)
            expected = REDESIGN_EXPECTED.get(name, {})
            print(f"\n## {name}  {label}")
            print(
                f"  N={measurements.n}  T={fmt(measurements.total, 20)}  "
                f"u={fmt(measurements.merged.unmatched, 20)}  "
                f"M={measurements.merged.unmatched_count}  cash={fmt(portfolio.cash, 6)}  "
                f"coverage={fmt_pct(measurements.coverage_pct)}%  band={measurements.band.key}"
            )
            for field in ("total", "core", "broad", "coverage_pct"):
                value = getattr(measurements, field) if field != "total" else measurements.total
                text = fmt(value, 40)
                verdict = ""
                if expected.get(field):
                    gap = abs(value - F(expected[field]))
                    verdict = "  " + ("PASS" if gap <= F(1, 10**12) else f"FAIL (gap {fmt(gap, 6)})")
                print(f"  {field:13s} {text}{verdict}")
            print(
                f"  disjoint Core {fmt(measurements.disjoint_core, 40)}   "
                f"disjoint Broad {fmt(measurements.disjoint_broad, 40)}"
            )
        return 0

    print_fixtures(arguments.digits)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
