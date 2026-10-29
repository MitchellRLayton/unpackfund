"""Build a release: tickers in, immutable per-fund JSON + manifest out.

    python -m pipeline.build --tickers VOO,AVUV,SPY,QQQ,ARKK

Every fund passes three gates **before** the release is written, so a bad filing
cannot produce a published artifact:

1. the filing's holdings reconcile to NAV (``|Σ valUSD / netAssets − 1| ≤ 5%``,
   which is the skill's N-PORT reconciliation band and the reason a fund with
   derivatives is not rejected for summing to 100.09%);
2. the emitted weight vector is a plausible whole (``9,000 ≤ Σ bp ≤ 10,500``) —
   the check that catches "parsed half the holdings" and "double-counted a fund";
3. the per-fund file is under the size budget.

Nothing is fetched twice: the byte cache under ``data/cache`` is the only source
after the first run, which is what makes the determinism check meaningful.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

from . import artifact, filings, manifest as manifest_mod, universe, weights
from .companies import CompanyIndex, rung_counts
from .nport import NportParseError

REPO_ROOT = Path(__file__).resolve().parents[2]
MAX_FUND_BYTES = 200_000
MIN_TOTAL_BP = 9_000
MAX_TOTAL_BP = 10_500
NAV_RESIDUAL_LIMIT = 0.05


class GateError(RuntimeError):
    pass


def _log(message: str) -> None:
    print(message, flush=True)


def build_fund(ticker: str, index: CompanyIndex) -> tuple[dict, bytes, dict]:
    ref = universe.resolve(ticker)
    found = filings.latest(ref)
    filing = found.filing

    lag_days = artifact._days_between(found.filing_date, found.report_date)

    vector = weights.build_vector(
        filing.holdings, index, filing.net_assets, lag_days=lag_days
    )

    # Gate 1 — the filing reconciles to its own NAV.
    filed_total = sum(row.val_usd or 0.0 for row in filing.holdings)
    residual = abs(filed_total / filing.net_assets - 1) if filing.net_assets else None
    if residual is not None and residual > NAV_RESIDUAL_LIMIT:
        raise GateError(
            f"{ticker}: holdings sum to {filed_total:,.0f} vs netAssets "
            f"{filing.net_assets:,.0f} ({residual:.2%}) — over the {NAV_RESIDUAL_LIMIT:.0%} band"
        )

    # Gate 2 — the vector is a whole fund, not a fragment or a double count.
    if not MIN_TOTAL_BP <= vector.total_bp <= MAX_TOTAL_BP:
        raise GateError(
            f"{ticker}: weight vector totals {vector.total_bp} bp, outside "
            f"[{MIN_TOTAL_BP}, {MAX_TOTAL_BP}]"
        )

    document = artifact.build_fund_artifact(
        ticker=ref.ticker,
        fund_id=ref.fund_id,
        name=filing.series_name or filing.registrant_name or ref.ticker,
        issuer=filing.registrant_name or "",
        as_of=found.report_date,
        filed_at=found.filing_date,
        source_url=found.source_url,
        coverage_pct=vector.coverage_pct,
        holdings=[
            artifact.holding_row(
                company_id=row.company_id,
                name=row.name,
                ticker=row.ticker,
                asset_cat=row.asset_cat,
                weight_bp=row.weight_bp,
            )
            for row in vector.holdings
        ],
        metrics=weights.metrics(vector.holdings),
        warnings=vector.warnings,
    )
    payload = artifact.canonical_bytes(document)

    # Gate 3 — the size budget the plan promises the browser.
    if len(payload) > MAX_FUND_BYTES:
        raise GateError(
            f"{ticker}: artifact is {len(payload):,} bytes, over the "
            f"{MAX_FUND_BYTES:,}-byte budget"
        )

    _log(
        f"  {ref.ticker:6} {document['as_of']} lag={document['lag_days']:>3}d "
        f"cover={document['coverage_pct']:>5.1f}% rows={len(document['holdings']):>4} "
        f"bp={vector.total_bp:>5} {len(payload):>7,}B "
        f"rungs={dict(vector.rung_counts)} warnings={document['warnings']}"
    )
    stats = {
        "rungs": vector.rung_counts,
        "asset_cats": vector.asset_cat_counts,
    }
    return document, payload, stats


def build_release(
    tickers: list[str],
    *,
    out_dir: Path,
    release_id: str | None = None,
    generated_at: str | None = None,
) -> Path:
    started = time.time()
    index = CompanyIndex.load()
    _log(f"company index: {len(index.by_ticker):,} tickers, {len(index.by_name):,} unique names")

    release = release_id or time.strftime("%Y-%m-%d", time.gmtime()) + ".1"
    release_dir = out_dir / "releases" / release
    funds_dir = release_dir / "funds"
    funds_dir.mkdir(parents=True, exist_ok=True)

    documents: list[dict] = []
    files: list[dict] = []
    rung_totals: Counter[str] = Counter()
    cat_totals: Counter[str] = Counter()

    _log(f"building release {release} → {release_dir}")
    for ticker in tickers:
        document, payload, stats = build_fund(ticker, index)
        rel_path = f"funds/{document['ticker']}.json"
        (release_dir / rel_path).write_bytes(payload)
        documents.append(document)
        files.append(manifest_mod.file_entry(rel_path, payload))
        rung_totals.update(stats["rungs"])
        cat_totals.update(stats["asset_cats"])

    document = manifest_mod.build_manifest(
        release_id=release,
        funds=documents,
        files=files,
        rung_counts=rung_counts(rung_totals),
        asset_cat_counts=dict(sorted(cat_totals.items())),
        etf_count=None,  # ETF vs mutual fund needs a classifier (ADR-0007 C3)
        generated_at=generated_at,
    )
    payload = artifact.canonical_bytes(document)
    (release_dir / "manifest.json").write_bytes(payload)
    _log(
        f"manifest: {len(documents)} funds, {document['company_count']:,} companies, "
        f"{len(payload):,}B, coverage={document['coverage_histogram']}"
    )
    _log(f"done in {time.time() - started:.1f}s")

    summary = {
        "release": release,
        "release_dir": str(release_dir),
        "funds": len(documents),
        "company_count": document["company_count"],
        "rungs": document["mapping_rungs"],
    }
    (release_dir / "build-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n"
    )
    return release_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.build", description=__doc__)
    parser.add_argument(
        "--tickers",
        default="VOO",
        help="comma-separated tickers (default: VOO — one fund, the day-1 slice)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=REPO_ROOT / "artifacts",
        help="output root (default: artifacts/)",
    )
    parser.add_argument(
        "--release-id",
        default=None,
        help="release id, YYYY-MM-DD[.N]; default is today's UTC date with .1",
    )
    parser.add_argument(
        "--generated-at",
        default=None,
        help="override generated_at (ISO 8601) — use with SOURCE_DATE_EPOCH for "
        "byte-identical rebuilds",
    )
    args = parser.parse_args(argv)

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    try:
        build_release(
            tickers,
            out_dir=args.out,
            release_id=args.release_id,
            generated_at=args.generated_at,
        )
    except (GateError, NportParseError, LookupError, filings.NoFilingError) as error:
        _log(f"FAILED: {type(error).__name__}: {error}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
