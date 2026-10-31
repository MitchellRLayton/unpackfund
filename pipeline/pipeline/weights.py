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

from . import classify, gleif, identifiers
from .classify import Classification
from .companies import CompanyIndex, IdentityEvidence, IdentityTable
from .nport import Holding

BP_PER_UNIT = 10_000
METRIC_CATEGORIES = classify.COMPANY_CATEGORIES
STALE_LAG_DAYS = 90
#: Asset categories the foreign-issuer namespace applies to. Equity only, and on
#: purpose: the 2026-10-30 measurement that sized this change was of *equity*
#: issuers (96.6% of the gap, 82.65% carrying an LEI), and a debt row is the
#: issuer's obligation rather than a share of it. Extending the namespace to debt
#: would move the site-wide coverage number by a reason nobody has measured, and a
#: weight that looks better for an unmeasured reason is the failure mode this
#: project keeps writing rules about.
ISSUER_CATEGORIES = frozenset({"equity"})


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


def _label(as_filed: str | None, issuer_legal_name: str | None) -> str:
    """The name a row ships with.

    The filing's own label wins whenever it survives redaction: it is what the fund
    called the security, it is already published for that row today, and keeping it
    means the identity namespace changes a row's *id* and its *coverage*, not its
    name. GLEIF's legal name fills in only when the filing's label was unusable —
    a CUSIP where the name belongs, a Bloomberg string, nothing at all — so a row
    resolved through the LEI namespace still ships a name instead of
    ``UNNAMED_HOLDING``. ``artifact.holding_row`` redacts again; redaction is
    idempotent.
    """
    cleaned = identifiers.public_name(as_filed)
    if issuer_legal_name and cleaned == identifiers.UNNAMED_HOLDING:
        return issuer_legal_name
    return (as_filed or "unknown").strip()


def build_vector(
    holdings: list[Holding],
    index: CompanyIndex,
    net_assets: float | None,
    *,
    lag_days: int | None,
    identity: IdentityTable | None = None,
    evidence: IdentityEvidence | None = None,
    issuers: "gleif.IssuerIndex | None" = None,
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
        # Observed *before* the identity table is consulted, so the table can only
        # ever learn from rows the ladder resolved on their own evidence.
        if evidence is not None:
            evidence.observe(holding.isin, holding.lei, company_id)
        if company_id is None and identity is not None:
            company_id, rung = identity.resolve(holding.isin, holding.lei)
        issuer_label: str | None = None
        issuer_row = False
        if company_id is None and issuers is not None:
            if classification.category in ISSUER_CATEGORIES:
                resolution = issuers.resolve(holding.lei, holding.isin)
                if resolution is not None:
                    company_id, rung = resolution.company_id, resolution.rung
                    issuer_label = resolution.name
                    issuer_row = True
                    # The LEI names a legal entity; when that entity is also an SEC
                    # registrant, the row belongs in the CIK namespace. Otherwise the
                    # same company would sit under two ids — ``c_`` in the funds
                    # whose filing spells the EDGAR name, ``l_`` in the funds whose
                    # filing uses the new brand — and the ledger, which merges on
                    # company_id, would stop merging it and understate overlap.
                    # Measured 2026-10-30: 22,775 rows (GE Aerospace, ExxonMobil
                    # Holdings, IBM). The test is the ladder's own exact, single-
                    # candidate name rule applied to GLEIF's *registered* name, not
                    # a fuzzy match: the evidence for the id is still the LEI.
                    sec_id = index.resolve_gleif_name(resolution.name)
                    if sec_id is not None:
                        company_id = sec_id
                        issuers.note_bridge(rung)
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
                "name": _label(holding.name, issuer_label),
                # A foreign issuer's as-filed symbol is its *local* listing code
                # (``PRU`` is Perseus Mining on the ASX, and Prudential in New
                # York). Publishing it beside a GLEIF legal name would invite
                # exactly the misreading this namespace exists to prevent, and the
                # row's identity is the LEI, not a symbol — so an issuer-namespace
                # row carries no ticker.
                "ticker": (
                    (index.symbol(company_id) if issuer_row else holding.ticker)
                    or index.symbol(company_id)
                ),
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
            if holding.ticker and not issuer_row:
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
