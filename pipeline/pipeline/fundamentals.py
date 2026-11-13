"""Company profitability metrics from SEC XBRL, for the fund-page profitability table.

One selection rule, taken from ``docs/01-research/2026-11-11-sec-xbrl-fundamentals/metrics_spec.md``:

* the **anchor** is the latest balance-sheet date asserted by an annual report (10-K / 20-F family);
* every input must resolve **at that anchor** — instants at ``end == anchor``, flows with a 340–380-day window
  ending at it — so a ratio never mixes two fiscal periods;
* where two filings assert the same period, the latest ``filed`` wins.

Definitions (``mspec`` C8, C4, C17, C15):

    ROE  = NetIncomeLoss / book equity
    OP   = (revenue − cost of revenue − SG&A − interest) / book equity   [banks/insurers excluded: no cost line]
    CBOP = (operating cash flow + interest) / book equity                 [the cash-flow analogue]
    LEV  = (assets − book equity) / assets

Book equity is stockholders' equity + deferred income tax liabilities − preferred stock. A missing preferred or
deferred-tax line is treated as a filed zero (absence of a balance-sheet line, not missing data — measured at a
1.3–2.0 % error rate); a missing cost-of-revenue or interest line is treated as zero **and flagged**, because
absence usually means the company has none and sometimes means the filer did not tag it.

The module is pure: it reads already-extracted ``companyfacts`` documents and returns dicts. It never fetches.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any, Iterable

ANNUAL_FORMS = ("10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A")
FINANCIAL_SIC_PREFIXES = ("60", "61", "62", "63", "64")
ANNUAL_DAYS = (340, 380)

#: Ordered tag ladders. First tag with a fact at the anchor wins; the order is the one measured in the
#: investigation (``concept_map.json``), not a guess.
LADDERS: dict[str, tuple[str, ...]] = {
    "equity": (
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ),
    "preferred": ("PreferredStockValue", "PreferredStockCarryingAmount"),
    "deferred_tax": ("DeferredIncomeTaxLiabilities", "DeferredIncomeTaxLiabilitiesNet"),
    "assets": ("Assets",),
    "revenue": (
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
    ),
    "cogs": ("CostOfRevenue", "CostOfGoodsAndServicesSold"),
    "gross_profit": ("GrossProfit",),
    "sga": ("SellingGeneralAndAdministrativeExpense", "GeneralAndAdministrativeExpense"),
    "interest": ("InterestExpense", "InterestExpenseNonoperating"),
    "net_income": ("NetIncomeLoss", "ProfitLoss"),
    "cfo": ("NetCashProvidedByUsedInOperatingActivities",),
}


def _annual_days(fact: dict[str, Any]) -> int:
    start, end = fact.get("start"), fact.get("end")
    if not start or not end:
        return 0
    return (date.fromisoformat(end) - date.fromisoformat(start)).days


def _latest(facts: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not facts:
        return None
    return max(facts, key=lambda f: (f.get("filed", ""), f.get("accn", "")))


def _instant(gaap: dict[str, Any], tags: Iterable[str], anchor: str) -> dict[str, Any] | None:
    for tag in tags:
        rows = [
            f
            for f in (gaap.get(tag) or {}).get("units", {}).get("USD", [])
            if f.get("end") == anchor and not f.get("start")
        ]
        best = _latest(rows)
        if best:
            return best
    return None


def _duration(gaap: dict[str, Any], tags: Iterable[str], anchor: str) -> dict[str, Any] | None:
    lo, hi = ANNUAL_DAYS
    for tag in tags:
        rows = [
            f
            for f in (gaap.get(tag) or {}).get("units", {}).get("USD", [])
            if f.get("end") == anchor and lo <= _annual_days(f) <= hi
        ]
        best = _latest(rows)
        if best:
            return best
    return None


def company_metrics(document: dict[str, Any], *, sic: str | None = None) -> dict[str, Any] | None:
    """Return the metric block for one ``companyfacts`` document, or ``None`` when it has no annual anchor."""
    gaap = (document.get("facts") or {}).get("us-gaap") or {}
    annual_assets = [
        f
        for f in (gaap.get("Assets") or {}).get("units", {}).get("USD", [])
        if f.get("form") in ANNUAL_FORMS and f.get("end")
    ]
    if not annual_assets:
        return None
    anchor = max(f["end"] for f in annual_assets)

    equity = _instant(gaap, LADDERS["equity"], anchor)
    if equity is None:
        return None
    preferred = _instant(gaap, LADDERS["preferred"], anchor)
    deferred = _instant(gaap, LADDERS["deferred_tax"], anchor)
    assets = _instant(gaap, LADDERS["assets"], anchor)
    book_equity = equity["val"] + (deferred["val"] if deferred else 0.0) - (preferred["val"] if preferred else 0.0)
    if book_equity <= 0 or not assets or assets["val"] <= 0:
        return None

    net_income = _duration(gaap, LADDERS["net_income"], anchor)
    cfo = _duration(gaap, LADDERS["cfo"], anchor)
    interest = _duration(gaap, LADDERS["interest"], anchor)
    revenue = _duration(gaap, LADDERS["revenue"], anchor)
    cogs = _duration(gaap, LADDERS["cogs"], anchor)
    gross_profit = _duration(gaap, LADDERS["gross_profit"], anchor)
    sga = _duration(gaap, LADDERS["sga"], anchor)

    is_financial = (sic or "").startswith(FINANCIAL_SIC_PREFIXES)
    flags: list[str] = []
    if interest is None:
        flags.append("interest_absent_as_zero")
    if not is_financial and cogs is None and gross_profit is None:
        flags.append("cogs_absent_as_zero")

    def ratio(numerator: float | None) -> float | None:
        return None if numerator is None else numerator / book_equity

    roe = ratio(net_income["val"]) if net_income else None

    cbop = None
    if cfo is not None:
        cbop = (cfo["val"] + (interest["val"] if interest else 0.0)) / book_equity

    op = None
    if not is_financial and revenue is not None and sga is not None:
        cost = cogs["val"] if cogs else (revenue["val"] - gross_profit["val"] if gross_profit else 0.0)
        op = (revenue["val"] - cost - sga["val"] - (interest["val"] if interest else 0.0)) / book_equity

    return {
        "anchor": anchor,
        "filed": max(f.get("filed", "") for f in annual_assets),
        "is_financial": is_financial,
        "book_equity": book_equity,
        "assets": assets["val"],
        # Numerators are carried as well as ratios: a fund publishes an aggregate ratio (sum of numerators over sum
        # of book equity), which cannot be recovered from per-company ratios.
        "net_income": net_income["val"] if net_income else None,
        "op_numerator": (revenue["val"] - (cogs["val"] if cogs else (revenue["val"] - gross_profit["val"] if gross_profit else 0.0))
                         - sga["val"] - (interest["val"] if interest else 0.0))
                        if (not is_financial and revenue is not None and sga is not None) else None,
        "cbop_numerator": (cfo["val"] + (interest["val"] if interest else 0.0)) if cfo is not None else None,
        "roe": roe,
        "op": op,
        "cbop": cbop,
        "leverage": (assets["val"] - book_equity) / assets["val"],
        "flags": flags,
    }


def load_sic(path: Path) -> str | None:
    """The 4-digit SIC from a ``submissions`` document, or ``None`` — needed only to exclude financials from OP."""
    try:
        with path.open("rb") as fh:
            sic = (json.load(fh) or {}).get("sic") or ""
    except (OSError, json.JSONDecodeError):
        return None
    return str(sic) if sic else None


def build(facts_dir: Path, submissions_dir: Path) -> dict[str, dict[str, Any]]:
    """Every company in ``facts_dir`` that has an annual anchor, keyed by 10-digit CIK."""
    out: dict[str, dict[str, Any]] = {}
    for path in sorted(facts_dir.glob("CIK*.json")):
        cik = path.stem.replace("CIK", "")
        try:
            with path.open("rb") as fh:
                document = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        metrics = company_metrics(document, sic=load_sic(submissions_dir / f"{path.name}"))
        if metrics:
            out[cik] = metrics
    return out


if __name__ == "__main__":  # pragma: no cover - operator check, not a gate
    import argparse
    import time

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--facts", default="data/xbrl-bulk/companyfacts")
    parser.add_argument("--submissions", default="data/xbrl-bulk/submissions")
    parser.add_argument("--out", default="artifacts/fundamentals/company_metrics.json")
    args = parser.parse_args()

    started = time.time()
    metrics = build(Path(args.facts), Path(args.submissions))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"anchor_rule": "latest annual balance-sheet date", "companies": metrics}, separators=(",", ":")))
    have = {k: sum(1 for m in metrics.values() if m.get(k) is not None) for k in ("roe", "op", "cbop", "leverage")}
    print(json.dumps({"companies": len(metrics), "seconds": round(time.time() - started, 1), "with": have, "out_bytes": out.stat().st_size}))


# --------------------------------------------------------------------------- fund level

MEASURES = ("roe", "op", "cbop", "leverage")


def _winsorised(values: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Clip each value to the 1st/99th percentile of the covered set, keeping weights.

    The mean is not publishable without this: one company with a book equity near zero produces a ratio in the
    thousands, and the weighted mean is dominated by it. The median is reported beside the mean for the same reason.
    """
    if not values:
        return []
    ordered = sorted(v for v, _ in values)
    n = len(ordered)
    lo, hi = ordered[max(0, int(0.01 * n))], ordered[min(n - 1, int(0.99 * n))]
    return [(min(max(v, lo), hi), w) for v, w in values]


def _weighted_median(values: list[tuple[float, float]]) -> float | None:
    if not values:
        return None
    total = sum(w for _, w in values)
    running = 0.0
    for value, weight in sorted(values):
        running += weight
        if running >= total / 2:
            return value
    return sorted(values)[-1][0]


def _aggregate(rows: list[tuple[str, float]], metrics: dict[str, dict[str, Any]], measure: str) -> float | None:
    """``sum of numerators / sum of book equity`` over the holdings where the measure is defined."""
    numerator_key = {"op": "op_numerator", "cbop": "cbop_numerator"}.get(measure)
    ratios = [
        (metrics[cik][numerator_key if numerator_key else "net_income"] / metrics[cik]["book_equity"])
        for cik, _w in rows
        if cik in metrics and metrics[cik]["book_equity"] > 0
        and metrics[cik].get(numerator_key if numerator_key else "net_income") is not None
    ]
    lo = hi = None
    if ratios:
        ordered = sorted(ratios)
        lo, hi = ordered[max(0, int(0.01 * len(ordered)))], ordered[min(len(ordered) - 1, int(0.99 * len(ordered)))]
    numerator = 0.0
    denominator = 0.0
    for cik, _weight in rows:
        company = metrics.get(cik)
        if not company or company["book_equity"] <= 0:
            continue
        # A book equity under 1 % of assets makes the company's ratio unstable (``metrics_spec`` §4): its numerator is
        # real but its denominator is noise, and in a sum of ratios it can dominate the fund. Excluded from the
        # aggregate for the same reason it is excluded from a mean.
        if company["book_equity"] / company["assets"] < 0.01:
            continue
        value = company.get(numerator_key) if numerator_key else company.get("net_income")
        if value is None:
            continue
        ratio = value / company["book_equity"]
        # Clip the company's ratio to the covered set's 1st/99th percentile before it enters the sum. Without this the
        # aggregate is not robust either: one filer whose cost line we treated as zero can carry a numerator many times
        # its book equity and swamp the fund. Clipping is published as part of the definition.
        if lo is not None:
            ratio = min(max(ratio, lo), hi)
        numerator += ratio * company["book_equity"]
        denominator += company["book_equity"]
    return (numerator / denominator) if denominator else None


def fund_profitability(
    holdings: list[dict[str, Any]],
    metrics: dict[str, dict[str, Any]],
    *,
    universe: dict[str, list[float]] | None = None,
) -> dict[str, Any]:
    """The variant-C table for one fund: median, mean, coverage and (optionally) a percentile per measure.

    ``holdings`` are the fund's published rows (``company_id`` is ``c_<CIK>``, ``weight_bp`` is basis points).
    ``metrics`` is this module's ``build()`` output keyed by 10-digit CIK. Coverage is measured against the fund's
    equity weight, except operating profit, which is measured against the weight of companies it applies to — banks
    and insurers have no cost-of-revenue line, so counting them in the denominator understates it by up to 20 points.
    """
    rows = [
        (row["company_id"][2:], float(row["weight_bp"]))
        for row in holdings
        if str(row.get("company_id", "")).startswith("c_") and str(row.get("asset_cat")) == "equity"
    ]
    equity_weight = sum(w for _, w in rows)
    applicable_weight = sum(w for cik, w in rows if not (metrics.get(cik) or {}).get("is_financial"))

    block: dict[str, Any] = {"as_of_rule": "latest annual anchor per company", "measures": {}}
    for measure in MEASURES:
        pairs = [(metrics[cik][measure], w) for cik, w in rows if cik in metrics and metrics[cik].get(measure) is not None]
        denominator = applicable_weight if measure == "op" else equity_weight
        covered = sum(w for _, w in pairs)
        clipped = _winsorised(pairs)
        entry: dict[str, Any] = {
            "median": _weighted_median(pairs),
            # The aggregate ratio is what a portfolio sort measures: sum of numerators over sum of book equity across
            # the fund's holdings. Published beside the median; the winsorised mean stays internal (diagnostic only),
            # because a single company with a book equity near zero dominates it.
            "aggregate": _aggregate(rows, metrics, measure),
            "mean_winsorised_internal": (sum(v * w for v, w in clipped) / covered) if covered else None,
            "coverage_pct": round(100 * covered / denominator, 2) if denominator else 0.0,
            "companies": len(pairs),
        }
        if universe and measure in universe and entry["median"] is not None:
            band = universe[measure]
            below = sum(1 for v in band if v <= entry["median"])
            entry["percentile"] = round(100 * below / len(band), 1) if band else None
            entry["percentile_of"] = len(band)
        block["measures"][measure] = entry
    return block
