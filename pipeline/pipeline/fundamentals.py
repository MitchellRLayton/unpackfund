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
