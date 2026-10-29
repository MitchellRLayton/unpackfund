"""Where the unmapped weight goes, measured rather than guessed.

    python -m pipeline.mapping_report --release artifacts/releases/2026-10-30.2 --sample 400

The release publishes ``coverage_pct`` per fund and ``mapping_rungs`` per release,
and both say the same unhelpful thing about the gap: "unmapped". That word covers
four different problems with four different fixes —

    ticker_unknown           the filing's symbol is not in EDGAR's company ticker file
    ticker_rejected_by_name  the symbol is, but the name does not corroborate it
    name_unmatched           no symbol, and no company in EDGAR shares the filed name
    no_identifier            neither a symbol nor a usable name

— and until they are separated by weight, "raise coverage" is a wish. This module
runs the same classification and the same resolution rules as the build, on a
deterministic sample of the release's own funds, and attributes every basis point
of company-exposure weight to one of those branches or to a company.

It reads only the cache the build already has, writes a JSON and a Markdown report,
and is safe to re-run: no fetch beyond what ``filings.latest`` already caches, no
release mutation, no network-only dependency for the report itself.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from . import classify, filings, paths, universe, weights
from .build import resolve_universe
from .companies import CompanyIndex, name_tokens

MAPPED_RUNGS = {"ticker", "name_exact"}

#: A filed name that reads like a fund rather than an operating company. Some
#: filings put another fund's shares in ``assetCat`` EC (equity) without the
#: ``issuerCat`` code that would reclassify them, so a fund-of-funds' holdings
#: land in the equity denominator and depress coverage for a reason that is not
#: about company mapping at all.
_FUND_NAME = __import__("re").compile(
    r"\b(?:FUND|PORTFOLIO|TRUST|SERIES|ETF|INDEX|CLASS)\b", __import__("re").IGNORECASE
)


#: Words that identify a corporate form, not a company. Matching on them is how a
#: "Global Infrastructure Trust" becomes any infrastructure fund in the index.
_STOPWORDS = frozenset(
    {
        "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD",
        "LIMITED", "PLC", "SA", "NV", "AG", "SE", "GROUP", "HOLDINGS", "HOLDING",
        "THE", "AND", "OF", "TRUST", "FUND", "CLASS", "NEW", "COM", "SPA", "BV",
        "AB", "ASA", "OYJ", "SHS", "ADR", "REIT", "LP", "LLC", "INTERNATIONAL",
    }
)


def near_miss(
    name: str | None, tokens_by_company: dict[str, set[str]], by_token: dict[str, set[str]]
) -> bool:
    """Whether one company in the index shares most of an unmapped name's words.

    This separates the two fixes that "name_unmatched" hides: a name a better
    matcher would find (token overlap with exactly one company), and a name no
    EDGAR title resembles at all (which needs an identifier source, not a regex).
    """
    if not name:
        return False
    tokens = {token for token in set(name_tokens(name)) - _STOPWORDS if len(token) > 2}
    if not tokens:
        return False
    candidates: set[str] = set()
    for token in tokens:
        candidates |= by_token.get(token, set())
    if len(candidates) != 1:
        return False
    company = next(iter(candidates))
    theirs = tokens_by_company.get(company, set())
    if not theirs:
        return False
    return len(tokens & theirs) / max(len(tokens), 1) >= 0.5


def looks_like_fund_position(
    name: str | None, ticker: str | None, mf_tickers: set[str] | None
) -> bool:
    """Whether an unmapped row is probably another fund, not a company.

    Two independent signals, either enough: the symbol is in the SEC *fund* ticker
    file (28,613 real fund tickers, the same file the universe comes from), or the
    filed name contains a word only funds use. Both are reported as a split of the
    gap, never used to move weight: a measurement that changes the thing it
    measures is not a measurement.
    """
    if ticker and mf_tickers and ticker.strip().upper() in mf_tickers:
        return True
    return bool(name and _FUND_NAME.search(name))

#: Reasons a row did not map, in the order the resolver tries them.
REASONS = (
    "ticker_unknown",
    "ticker_rejected_by_name",
    "name_unmatched",
    "no_identifier",
)


def _tickers_from_release(release_dir: Path) -> tuple[str, list[str]]:
    document = json.loads((release_dir / "tickers.json").read_text())
    return str(document.get("as_of") or release_dir.name), list(document.get("tickers") or [])


def _sample(tickers: list[str], sample: int | None) -> list[str]:
    """Every ``k``-th ticker, so the sample is reproducible and spread alphabetically."""
    if not sample or sample >= len(tickers):
        return tickers
    step = len(tickers) / sample
    return [tickers[int(index * step)] for index in range(sample)]


def analyse(
    refs: list[universe.FundRef],
    index: CompanyIndex,
    *,
    workers: int = 4,
    progress_every: int = 0,
    mf_tickers: set[str] | None = None,
) -> dict[str, Any]:
    """Buckets of company-exposure weight, in basis points, over ``refs``."""
    reasons: Counter[str] = Counter()
    reason_rows: Counter[str] = Counter()
    categories: dict[str, Counter[str]] = {}
    category_totals: dict[str, dict[str, float]] = {}
    # token -> the companies whose title contains it, rebuilt once: the near-miss
    # test is per row and the index is ~8,000 titles, so a per-row scan is O(n²).
    tokens_by_company: dict[str, set[str]] = {
        company: {token for token in name_tokens(title) if len(token) > 2}
        for company, title in index.title_by_id.items()
    }
    by_token: dict[str, set[str]] = {}
    for company, tokens in tokens_by_company.items():
        for token in tokens:
            by_token.setdefault(token, set()).add(company)
    unmapped_rows: list[dict[str, Any]] = []
    per_fund: list[dict[str, Any]] = []
    failures: list[str] = []
    exposure_bp = 0
    mapped_bp = 0

    def measure(ref: universe.FundRef) -> dict[str, Any]:
        found = filings.latest(ref)
        filing = found.filing
        fund = {
            "ticker": ref.ticker,
            "exposure_bp": 0,
            "mapped_bp": 0,
            "reasons": Counter(),
            "rows": [],
        }
        for holding in filing.holdings:
            fraction = weights._fraction(holding, filing.net_assets)
            if fraction is None:
                continue
            classification = classify.classify(
                holding.asset_cat, holding.issuer_cat, holding.is_derivative
            )
            if not classification.is_company_exposure:
                continue
            bp = fraction * 10_000
            fund["exposure_bp"] += bp
            reason = index.explain(holding.ticker, holding.name)
            category = classification.category
            totals = category_totals.setdefault(
                category, {"exposure_bp": 0.0, "mapped_bp": 0.0}
            )
            totals["exposure_bp"] += bp
            if reason in MAPPED_RUNGS:
                fund["mapped_bp"] += bp
                totals["mapped_bp"] += bp
                continue
            fund["reasons"][reason] += 1
            fund["rows"].append(
                {
                    "name": (holding.name or "unknown").strip()[:60],
                    "ticker": holding.ticker,
                    "weight_bp": round(bp, 3),
                    "reason": reason,
                    "category": classification.category,
                    "fund_like": looks_like_fund_position(
                        holding.name, holding.ticker, mf_tickers
                    ),
                }
            )
        return fund

    from concurrent.futures import ThreadPoolExecutor

    def attempt(ref: universe.FundRef) -> dict[str, Any] | None:
        try:
            return measure(ref)
        except Exception as error:  # a report is not a gate; record and continue
            failures.append(f"{ref.ticker}: {type(error).__name__}: {error}")
            return None

    results: list[dict[str, Any]] = []
    if workers <= 1:
        for ref in refs:
            result = attempt(ref)
            if result:
                results.append(result)
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = [row for row in pool.map(attempt, refs) if row]

    for fund in results:
        exposure_bp += fund["exposure_bp"]
        mapped_bp += fund["mapped_bp"]
        total_reason_bp = 0.0
        for row in fund["rows"]:
            total_reason_bp += row["weight_bp"]
            reasons[row["reason"]] += row["weight_bp"]
            reason_rows[row["reason"]] += 1
            category = categories.setdefault(row["category"], Counter())
            category[row["reason"]] += row["weight_bp"]
            unmapped_rows.append({**row, "fund": fund["ticker"]})
        reasons.setdefault("__none__", 0)
        per_fund.append(
            {
                "ticker": fund["ticker"],
                "exposure_bp": round(fund["exposure_bp"], 2),
                "mapped_bp": round(fund["mapped_bp"], 2),
                "mapped_pct": round(
                    100 * fund["mapped_bp"] / fund["exposure_bp"], 2
                )
                if fund["exposure_bp"]
                else None,
                "unmapped_bp": round(total_reason_bp, 2),
            }
        )

    reasons.pop("__none__", None)
    total_reasons = sum(reasons.values())
    bucket_share = {
        reason: {
            "rows": reason_rows[reason],
            "weight_bp": round(weight, 2),
            "share_of_unmapped_pct": round(100 * weight / total_reasons, 2)
            if total_reasons
            else 0.0,
            "share_of_exposure_pct": round(100 * weight / exposure_bp, 2)
            if exposure_bp
            else 0.0,
        }
        for reason, weight in sorted(reasons.items(), key=lambda row: -row[1])
    }

    equity_gap = {
        "fund_positions_bp": 0.0,
        "companies_bp": 0.0,
        "near_miss_bp": 0.0,
        "no_signal_bp": 0.0,
        "fund_like_rows": 0,
    }
    for row in unmapped_rows:
        if row["category"] != "equity":
            continue
        if row["fund_like"]:
            equity_gap["fund_positions_bp"] += row["weight_bp"]
            equity_gap["fund_like_rows"] += 1
            continue
        equity_gap["companies_bp"] += row["weight_bp"]
        if near_miss(row["name"], tokens_by_company, by_token):
            equity_gap["near_miss_bp"] += row["weight_bp"]
        else:
            equity_gap["no_signal_bp"] += row["weight_bp"]
    equity_unmapped = equity_gap["fund_positions_bp"] + equity_gap["companies_bp"]
    equity_gap = {
        **{key: round(value, 2) for key, value in equity_gap.items() if key.endswith("_bp")},
        "fund_like_rows": equity_gap["fund_like_rows"],
        "unmapped_bp": round(equity_unmapped, 2),
        "fund_position_pct": round(100 * equity_gap["fund_positions_bp"] / equity_unmapped, 2)
        if equity_unmapped
        else None,
        "near_miss_pct_of_companies": round(
            100 * equity_gap["near_miss_bp"] / equity_gap["companies_bp"], 2
        )
        if equity_gap["companies_bp"]
        else None,
    }
    unmapped_rows.sort(key=lambda row: -row["weight_bp"])
    by_category = {
        category: {
            reason: round(weight, 2) for reason, weight in counter.most_common()
        }
        for category, counter in sorted(categories.items())
    }
    # Equity is the number the look-through product is judged on, and mixing it
    # with debt positions (which almost never name a company) hides that: the
    # blended figure is 49% where equity alone is above 70%.
    categories_report = {
        category: {
            "exposure_bp": round(totals["exposure_bp"], 2),
            "mapped_bp": round(totals["mapped_bp"], 2),
            "mapped_pct": round(100 * totals["mapped_bp"] / totals["exposure_bp"], 2)
            if totals["exposure_bp"]
            else None,
        }
        for category, totals in sorted(
            category_totals.items(), key=lambda row: -row[1]["exposure_bp"]
        )
    }

    return {
        "funds": {"sampled": len(refs), "measured": len(results), "failed": len(failures)},
        "failures": failures[:20],
        "company_exposure": {
            "weight_bp": round(exposure_bp, 2),
            "mapped_bp": round(mapped_bp, 2),
            "unmapped_bp": round(total_reasons, 2),
            "mapped_pct": round(100 * mapped_bp / exposure_bp, 2) if exposure_bp else None,
            "identity_ok": abs(exposure_bp - mapped_bp - total_reasons) < 0.5,
        },
        "buckets": bucket_share,
        "categories": categories_report,
        "equity_gap": equity_gap,
        "by_category": by_category,
        "per_fund": per_fund,
        "top_unmapped": unmapped_rows[:40],
    }


def render_markdown(report: dict[str, Any], *, release: str, sample: int | None) -> str:
    exposure = report["company_exposure"]
    lines = [
        f"# Mapping report — release {release}",
        "",
        f"Sample: {report['funds']['sampled']:,} fund(s) requested, "
        f"{report['funds']['measured']:,} measured, {report['funds']['failed']:,} failed"
        + (f" (first failure: {report['failures'][0]})" if report["failures"] else ""),
        "",
        "## Company exposure",
        "",
        "| | weight (bp) | share |",
        "|---|---:|---:|",
        f"| resolved to a company | {exposure['mapped_bp']:,.0f} | {exposure['mapped_pct']}% |",
        f"| unmapped | {exposure['unmapped_bp']:,.0f} | "
        f"{round(100 - (exposure['mapped_pct'] or 0), 2)}% |",
        f"| total | {exposure['weight_bp']:,.0f} | 100% |",
        "",
        f"Identity (mapped + unmapped = total): **{'ok' if exposure['identity_ok'] else 'BROKEN'}**",
        "",
        "## Why the unmapped weight is unmapped",
        "",
        "| reason | rows | weight (bp) | share of unmapped | share of exposure |",
        "|---|---:|---:|---:|---:|",
    ]
    for reason, row in report["buckets"].items():
        lines.append(
            f"| `{reason}` | {row['rows']:,} | {row['weight_bp']:,.0f} | "
            f"{row['share_of_unmapped_pct']}% | {row['share_of_exposure_pct']}% |"
        )
    lines += [
        "",
        "## Resolution by asset category",
        "",
        "| category | exposure (bp) | mapped (bp) | mapped |",
        "|---|---:|---:|---:|",
    ]
    for category, row in report["categories"].items():
        lines.append(
            f"| `{category}` | {row['exposure_bp']:,.0f} | {row['mapped_bp']:,.0f} | "
            f"{row['mapped_pct']}% |"
        )
    gap = report.get("equity_gap") or {}
    if gap.get("unmapped_bp"):
        lines += [
            "",
            "## The equity gap: fund shares or companies?",
            "",
            f"Unmapped equity weight is {gap['unmapped_bp']:,.0f} bp: "
            f"**{gap['fund_positions_bp']:,.0f} bp ({gap['fund_position_pct']}%)** is another "
            f"fund's shares filed under an equity asset category "
            f"({gap['fund_like_rows']:,} rows), and {gap['companies_bp']:,.0f} bp is "
            "company-like weight that no rung could resolve.",
            "",
            f"Of that company-like weight, {gap['near_miss_bp']:,.0f} bp "
            f"({gap['near_miss_pct_of_companies']}%) shares most of its words with "
            f"exactly one indexed company — a matcher fix — and {gap['no_signal_bp']:,.0f} bp "
            "shares nothing with any EDGAR title, which no matcher will recover.",
            "",
        ]
    lines += ["", "## What is unmapped, by category (weight bp)", ""]
    for category, buckets in report["by_category"].items():
        detail = ", ".join(f"{reason} {weight:,.0f}" for reason, weight in buckets.items())
        lines.append(f"- `{category}`: {detail}")
    lines += ["", "## Largest unmapped holdings", "", "| weight (bp) | name | ticker | reason | fund |", "|---:|---|---|---|---|"]
    for row in report["top_unmapped"]:
        lines.append(
            f"| {row['weight_bp']:,.1f} | {row['name']} | {row['ticker'] or '—'} | "
            f"{row['reason']} | {row['fund']} |"
        )
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.mapping_report", description=__doc__
    )
    parser.add_argument("--release", type=Path, required=True, help="a built release directory")
    parser.add_argument("--sample", type=int, default=400, help="measure every k-th fund (0 = all)")
    parser.add_argument("--tickers", default=None, help="comma-separated override")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--out", type=Path, default=None, help="output directory")
    parser.add_argument("--progress-every", type=int, default=0)
    parser.add_argument(
        "--no-fund-tickers",
        action="store_true",
        help="skip the SEC fund ticker file when splitting the gap (offline runs)",
    )
    args = parser.parse_args(argv)

    release, published = _tickers_from_release(args.release)
    if args.tickers:
        refs = resolve_universe(f"tickers:{args.tickers}")
        sample = None
    else:
        # The release names the funds; the universe names their series. Every
        # published ticker is a series ticker, so this is a filter, not a join.
        wanted = set(_sample(published, None if args.sample == 0 else args.sample))
        refs = [ref for ref in resolve_universe("all") if ref.ticker in wanted]
        sample = args.sample

    index = CompanyIndex.load()
    mf_tickers = set(universe._mf_map()) if not args.no_fund_tickers else None
    report = analyse(
        refs,
        index,
        workers=args.workers,
        progress_every=args.progress_every,
        mf_tickers=mf_tickers,
    )
    report["release"] = release
    report["sample"] = sample

    out_dir = args.out or (paths.ARTIFACTS / "mapping" / release)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(json.dumps(report, indent=2, sort_keys=False) + "\n")
    markdown = render_markdown(report, release=release, sample=sample)
    (out_dir / "report.md").write_text(markdown + "\n")

    exposure = report["company_exposure"]
    print(
        f"mapping report: {report['funds']['measured']:,} fund(s), "
        f"exposure {exposure['weight_bp']:,.0f} bp, mapped {exposure['mapped_pct']}%, "
        f"unmapped {exposure['unmapped_bp']:,.0f} bp"
    )
    for reason, row in report["buckets"].items():
        print(
            f"  {reason:<24} {row['rows']:>8,} rows  {row['weight_bp']:>12,.0f} bp  "
            f"{row['share_of_unmapped_pct']:>5.1f}% of unmapped"
        )
    print(f"wrote {out_dir / 'report.json'} and report.md")
    return 0 if exposure["identity_ok"] else 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
