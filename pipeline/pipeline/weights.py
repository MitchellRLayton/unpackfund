"""Holdings → integer basis points, coverage, and the per-fund metrics.

Two rules from the contract drive everything here:

* **Weights are integer basis points, derived from ``valUSD / netAssets``** — the
  fund's own NAV denominator, never a renormalised one. Holdings can legitimately
  sum above 10,000 bp (derivatives and liabilities sit outside ``invstOrSec``);
  measured on 2026-10-28, four of four funds did (10,006–10,028 bp), so the
  artifact keeps the filed residual and the ledger shows it.
* **Rounding is deterministic.** Basis points are allocated by largest remainder
  with a name tie-break, so two runs on the same filing produce byte-identical
  artifacts. ``round()`` per row would not: its sum drifts by row count.

Nothing here rescales to 1.0, drops a row, or merges an unmapped holding into a
company. Unmapped weight stays unmapped and is counted.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field

from . import classify, identifiers
from .classify import Classification
from .companies import CompanyIndex
from .nport import Holding

BP_PER_UNIT = 10_000
METRIC_CATEGORIES = classify.COMPANY_CATEGORIES
STALE_LAG_DAYS = 90


class WeightError(RuntimeError):
    """The filing is not usable as a weight vector."""


@dataclass
class FundHolding:
    company_id: str | None
    name: str
    ticker: str | None
    asset_cat: str
    weight_bp: int
    is_company_exposure: bool
    merged_rows: int = 0


@dataclass
class WeightVector:
    holdings: list[FundHolding] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    rung_counts: Counter[str] = field(default_factory=Counter)
    asset_cat_counts: Counter[str] = field(default_factory=Counter)
    total_bp: int = 0

    @property
    def coverage_pct(self) -> float:
        """Share of the fund's *gross* weight that we can attribute to a company.

        Gross, not net: a fund that holds 100% long and 50% short has a net weight of
        50%, so dividing mapped weight by the net total reported 111.2% coverage for
        AUEIX and 102.6% for ASPCX — 25 funds whose coverage then vanished from the
        manifest's histogram, because no band covers a value above 100. Both sides
        of a short are real exposure, so both sides are counted and the ratio cannot
        exceed 100.
        """
        gross = sum(abs(row.weight_bp) for row in self.holdings)
        if gross <= 0:
            return 0.0
        mapped = sum(abs(row.weight_bp) for row in self.holdings if row.company_id)
        return round(100 * mapped / gross, 1)


def _fraction(holding: Holding, net_assets: float | None) -> float | None:
    """Fraction of NAV for one row, from the filed value or the filed percent."""
    if holding.val_usd is not None and net_assets:
        return holding.val_usd / net_assets
    if holding.pct_val is not None:
        return holding.pct_val / 100
    return None


def allocate_bp(fractions: list[float]) -> list[int]:
    """Largest-remainder allocation of ``fractions`` to integer basis points.

    The total is ``round(Σ fractions × 10,000)``, so the vector keeps the filed
    residual instead of forcing it to 10,000. Ties break on the larger fraction,
    then on position — both deterministic.
    """
    scaled = [value * BP_PER_UNIT for value in fractions]
    floors = [math.floor(value) for value in scaled]
    target = round(sum(scaled))
    remainder = target - sum(floors)
    if remainder > 0:
        order = sorted(
            range(len(scaled)),
            key=lambda index: (-(scaled[index] - floors[index]), index),
        )
        for index in order[:remainder]:
            floors[index] += 1
    elif remainder < 0:
        order = sorted(
            range(len(scaled)),
            key=lambda index: ((scaled[index] - floors[index]), -index),
        )
        for index in order[: -remainder]:
            floors[index] -= 1
    return floors


def build_vector(
    holdings: list[Holding],
    index: CompanyIndex,
    net_assets: float | None,
    *,
    lag_days: int | None,
) -> WeightVector:
    if not holdings:
        raise WeightError("filing reports no holdings")

    # 1. Classify and resolve every row, then merge to one line per company.
    groups: dict[tuple, dict] = {}
    rungs: Counter[str] = Counter()
    asset_cats: Counter[str] = Counter()

    for holding in holdings:
        fraction = _fraction(holding, net_assets)
        if fraction is None:
            continue
        classification = classify.classify(
            holding.asset_cat, holding.issuer_cat, holding.is_derivative
        )
        asset_cats[classification.category] += 1
        company_id, rung = index.resolve(holding.ticker, holding.name)
        rungs[rung] += 1

        # Unmapped rows merge on identity of their own, so a fund with 500 distinct
        # unknown issuers does not collapse into one line called "unmapped".
        key = (
            company_id
            if company_id
            else (
                "unmapped",
                (holding.name or "unknown").strip().upper(),
                classification.category,
            )
        )
        group = groups.get(key)
        if group is None:
            group = {
                "company_id": company_id,
                "name": (holding.name or "unknown").strip(),
                "ticker": holding.ticker or index.symbol(company_id),
                "category": classification.category,
                "is_company_exposure": classification.is_company_exposure,
                "fraction": 0.0,
                "rows": 0,
                "largest": 0.0,
            }
            groups[key] = group
        group["fraction"] += fraction
        group["rows"] += 1
        if abs(fraction) > group["largest"]:
            group["largest"] = abs(fraction)
            group["category"] = classification.category
            group["is_company_exposure"] = classification.is_company_exposure
            if holding.ticker:
                group["ticker"] = holding.ticker

    # Allocate in fraction order (largest remainder depends on it), then sort the
    # published rows by weight so two runs cannot differ in layout.
    ordered = sorted(
        groups.values(), key=lambda row: (-row["fraction"], row["name"].upper())
    )
    bp = allocate_bp([row["fraction"] for row in ordered])

    vector = WeightVector(rung_counts=rungs, asset_cat_counts=asset_cats)
    for row, weight in zip(ordered, bp):
        vector.holdings.append(
            FundHolding(
                company_id=row["company_id"],
                name=row["name"],
                ticker=row["ticker"],
                asset_cat=row["category"],
                weight_bp=weight,
                is_company_exposure=row["is_company_exposure"],
                merged_rows=row["rows"],
            )
        )
    # Sorted by the *published* name: redaction can give two rows the same name,
    # and the validator re-derives this order from the artifact.
    vector.holdings.sort(
        key=lambda row: (-row.weight_bp, identifiers.public_name(row.name).upper())
    )
    vector.total_bp = sum(row.weight_bp for row in vector.holdings)

    # 2. Warnings: each one describes data the UI must label.
    warnings = set()
    if vector.coverage_pct < 70:
        warnings.add("partial_coverage")
    if any(row.weight_bp > 0 and row.company_id is None for row in vector.holdings):
        warnings.add("unmapped_holding")
    if vector.asset_cat_counts.get("cash") or vector.asset_cat_counts.get("derivative"):
        warnings.add("cash_or_derivative")
    if any(row.weight_bp < 0 for row in vector.holdings):
        warnings.add("negative_weight")
    if any(row.merged_rows > 1 and row.company_id for row in vector.holdings):
        warnings.add("duplicate_company")
    if any(row.asset_cat == "fund" for row in vector.holdings):
        warnings.add("fund_of_funds")
    if lag_days is not None and lag_days > STALE_LAG_DAYS:
        warnings.add("stale_filing")
    vector.warnings = sorted(warnings)
    return vector


def metrics(holdings: list[FundHolding]) -> dict[str, float | None]:
    """HHI, effective N and top-10 of one fund, from ``weight_bp`` alone.

    Population: company exposures with a positive weight. Cash and derivatives are
    not company weight, and a short would reward concentration if included.
    Denominator: NAV, as filed — no renormalisation, so a 91%-covered fund's HHI
    is computed over the whole fund and coverage is reported separately.
    """
    weights = sorted(
        (
            row.weight_bp / BP_PER_UNIT
            for row in holdings
            if row.is_company_exposure and row.company_id and row.weight_bp > 0
        ),
        reverse=True,
    )
    if not weights:
        return {"hhi": None, "hhi_pct2": None, "effective_n": None, "top10_pct": None}
    hhi = sum(weight * weight for weight in weights)
    return {
        "hhi": hhi,
        "hhi_pct2": round(hhi * 10_000, 4),
        "effective_n": round(1 / hhi, 6),
        "top10_pct": round(sum(weights[:10]) * 100, 4),
    }
