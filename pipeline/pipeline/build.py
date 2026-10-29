"""Build a release: funds in, immutable per-fund JSON + manifest out.

    python -m pipeline.build --tickers VOO,AVUV,SPY,QQQ,ARKK
    python -m pipeline.build --universe all --limit 50
    python -m pipeline.build --universe all          # the whole SEC fund universe

Every fund passes three gates **before** its file is written, so a bad filing
cannot produce a published artifact:

1. the filing's holdings reconcile to NAV (``|Σ valUSD / netAssets − 1| ≤ 5%``,
   which is the skill's N-PORT reconciliation band and the reason a fund with
   derivatives is not rejected for summing to 100.09%);
2. the emitted weight vector is a plausible whole (``9,000 ≤ Σ bp ≤ 10,500``) —
   the check that catches "parsed half the holdings" and "double-counted a fund";
3. the per-fund file is under the size budget.

Nothing is fetched twice: the byte cache under ``data/cache`` is the only source
after the first run, which is what makes the determinism check meaningful.

**Scale.** A single-fund build is the day-1 shape; a 12,000-series build is what
day 4 asks for, and three things had to change for it: the universe is enumerated
rather than typed (``--universe all``), funds are built on a small thread pool
(the SEC client still throttles the whole process to 8 req/s, but a build spends
most of its wall clock parsing and hashing, not waiting), and a failing fund is
**recorded** instead of aborting the run — a universe walk that dies on the first
fund with an odd filing never finishes. ``--on-error fail`` restores the strict
behaviour, and publishing uses it: a release must be clean.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from . import (
    artifact,
    catalogue,
    classify,
    filings,
    manifest as manifest_mod,
    universe,
    weights,
)
from .companies import CompanyIndex
from .nport import NportParseError

REPO_ROOT = Path(__file__).resolve().parents[2]
#: One owner for the number: the module that produces the bytes (artifact.py).
MAX_FUND_BYTES = artifact.MAX_FUND_BYTES
MIN_TOTAL_BP = 9_000
MAX_TOTAL_BP = 10_500
NAV_RESIDUAL_LIMIT = 0.05
DEFAULT_WORKERS = 8
RUNG_NAMES = ("ticker", "name_exact", "unmapped")


class GateError(RuntimeError):
    pass


def _log(message: str) -> None:
    print(message, flush=True)


def _alias_map(builds: list["FundBuild"]) -> dict[str, str]:
    """Share-class ticker → the published ticker of the same series.

    Only aliases that point at a fund this release actually published are kept: an
    alias to a missing page would be a dead end that looks like a redirect. A class
    symbol that another series publishes as its own primary ticker is skipped too —
    the release can only have one page per ticker — and both skips are counted in
    the build summary rather than silently dropped.
    """
    published = {build.ticker for build in builds}
    aliases: dict[str, str] = {}
    for build in builds:
        for symbol in build.ref_symbols:
            if symbol == build.ticker or symbol in published or symbol in aliases:
                continue
            aliases[symbol] = build.ticker
    return aliases


@dataclass
class FundBuild:
    """One fund's artifact plus everything the run summary needs about it."""

    ticker: str
    document: dict
    payload: bytes
    stats: dict = field(default_factory=dict)
    #: Every symbol the fund's series reports, so the release can publish the
    #: classes it does not name as files.
    ref_symbols: tuple[str, ...] = ()


def build_fund(ref: universe.FundRef, index: CompanyIndex) -> FundBuild:
    started = time.monotonic()
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
            f"{ref.ticker}: holdings sum to {filed_total:,.0f} vs netAssets "
            f"{filing.net_assets:,.0f} ({residual:.2%}) — over the {NAV_RESIDUAL_LIMIT:.0%} band"
        )

    # Gate 2 — the vector is a whole fund, not a fragment or a double count.
    if not MIN_TOTAL_BP <= vector.total_bp <= MAX_TOTAL_BP:
        raise GateError(
            f"{ref.ticker}: weight vector totals {vector.total_bp} bp, outside "
            f"[{MIN_TOTAL_BP}, {MAX_TOTAL_BP}]"
        )

    # One name test, one place: the artifact carries the label, and the
    # catalogue, the manifest count and (later) a fund page all read that field
    # instead of re-deriving it.
    fund_name = filing.series_name or filing.registrant_name or ref.ticker
    fund_issuer = filing.registrant_name or ""
    is_etf = classify.looks_like_etf(fund_name, fund_issuer)

    document = artifact.build_fund_artifact(
        ticker=ref.ticker,
        fund_id=ref.fund_id,
        name=fund_name,
        issuer=fund_issuer,
        etf=is_etf,
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
            f"{ref.ticker}: artifact is {len(payload):,} bytes, over the "
            f"{MAX_FUND_BYTES:,}-byte budget"
        )

    stats = {
        "rungs": dict(vector.rung_counts),
        "asset_cats": dict(vector.asset_cat_counts),
        "total_bp": vector.total_bp,
        "net_assets": filing.net_assets,
        "as_of": found.report_date,
        "name": document["name"],
        "issuer": document["issuer"],
        "coverage_pct": document["coverage_pct"],
        # Provisional ETF label (ADR-0007 C3): a name test, recorded in the
        # manifest as such. It selects nothing and gates nothing — a reviewer
        # needs the split to see the universe, and naming the test is how the
        # pre-ADR [open] stays visible instead of looking settled.
        "etf": is_etf,
        "seconds": round(time.monotonic() - started, 3),
    }
    return FundBuild(
        ticker=ref.ticker,
        document=document,
        payload=payload,
        stats=stats,
        ref_symbols=ref.symbols,
    )


def _attempt(
    ref: universe.FundRef, index: CompanyIndex
) -> tuple[FundBuild | None, str | None]:
    try:
        return build_fund(ref, index), None
    except Exception as error:  # noqa: BLE001 — a universe walk records and continues
        # Deliberately broad: one malformed filing, one EDGAR hiccup after its own
        # retries, one unexpected shape must not throw away 12,000 built funds. The
        # failure is recorded with its type and counted, and `--on-error fail`
        # (which publishing uses) still refuses to write a release with holes.
        return None, f"{type(error).__name__}: {error}"


def resolve_universe(
    spec: str,
    *,
    limit: int | None = None,
    top: int | None = None,
    from_summary: Path | None = None,
) -> list[universe.FundRef]:
    """Turn ``--universe`` / ``--tickers`` into a deterministic list of funds.

    ``all`` is the SEC fund file's series, ``tickers:VOO,QQQ`` the reviewed list,
    and ``--top N --from-summary`` ranks a previous walk's funds by N-PORT net
    assets — which is how a publishable subset is chosen without a second
    universe sweep and without a hand-maintained list.
    """
    if spec == universe.UNIVERSE_ALL:
        refs = universe.all_series()
        if top is not None:
            if from_summary is None:
                raise GateError("--top needs --from-summary from an earlier walk")
            summary = json.loads(from_summary.read_text())
            ranked = sorted(
                (row for row in summary.get("funds", []) if row.get("net_assets")),
                key=lambda row: (-float(row["net_assets"]), row["ticker"]),
            )
            wanted = {row["ticker"]: float(row["net_assets"]) for row in ranked[:top]}
            refs = [ref for ref in refs if ref.ticker in wanted]
            refs.sort(key=lambda ref: (-wanted[ref.ticker], ref.ticker))
            missing = sorted(set(wanted) - {ref.ticker for ref in refs})
            if missing:
                raise GateError(
                    f"--top: {len(missing)} funds are not in the universe: {missing[:5]}"
                )
        if limit is not None:
            refs = refs[:limit]
        return refs
    if spec.startswith("tickers:"):
        wanted = [t.strip().upper() for t in spec.split(":", 1)[1].split(",") if t.strip()]
        refs = [universe.resolve(ticker) for ticker in wanted]
        if limit is not None:
            refs = refs[:limit]
        return refs
    raise GateError(f"unknown universe spec {spec!r} — use 'all' or 'tickers:VOO,QQQ'")


def build_release(
    refs: list[universe.FundRef],
    *,
    out_dir: Path,
    release_id: str | None = None,
    generated_at: str | None = None,
    workers: int = 1,
    on_error: str = "fail",
    label: str = "tickers",
    progress_every: int = 0,
) -> Path:
    started = time.monotonic()
    index = CompanyIndex.load()
    _log(f"company index: {len(index.by_ticker):,} tickers, {len(index.by_name):,} unique names")

    release = release_id or time.strftime("%Y-%m-%d", time.gmtime()) + ".1"
    release_dir = out_dir / "releases" / release
    funds_dir = release_dir / "funds"
    funds_dir.mkdir(parents=True, exist_ok=True)

    _log(f"building release {release} → {release_dir} ({len(refs):,} funds, {label})")

    # Resolve every registrant's series→filing index up front. This is the whole
    # reason a 12,000-fund run is affordable: fetching inside the build loop made
    # a trust's filing history be re-read once per series (O(n²) per trust).
    started_prefetch = time.monotonic()
    indexed = filings.prefetch(
        refs, workers=workers, progress=_log if progress_every else None
    )
    _log(
        f"indexed {indexed['documents']:,} N-PORT documents across "
        f"{indexed['registrants']:,} registrants (largest {indexed['largest']:,} series) "
        f"in {time.monotonic() - started_prefetch:.1f}s"
    )

    builds: list[FundBuild] = []
    failures: list[dict[str, str]] = []
    done = 0

    def record(result: tuple[FundBuild | None, str | None], ref: universe.FundRef) -> None:
        nonlocal done
        build, problem = result
        done += 1
        if build is None:
            failures.append({"ticker": ref.ticker, "cik": ref.cik, "error": problem or ""})
            if progress_every:
                _log(f"  !! {ref.ticker}: {problem}")
        else:
            builds.append(build)
        if progress_every and done % progress_every == 0:
            elapsed = time.monotonic() - started
            rate = done / elapsed if elapsed else 0
            _log(
                f"  … {done:,}/{len(refs):,} funds, {len(failures)} failed, "
                f"{rate:.1f} funds/s, {elapsed / 60:.1f} min elapsed"
            )

    if workers <= 1:
        for ref in refs:
            record(_attempt(ref, index), ref)
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [(ref, pool.submit(_attempt, ref, index)) for ref in refs]
            for ref, future in futures:
                record(future.result(), ref)

    if failures and on_error == "fail":
        preview = "; ".join(f"{row['ticker']}: {row['error']}" for row in failures[:5])
        raise GateError(
            f"{len(failures):,} of {len(refs):,} funds failed — refusing the release "
            f"({preview}{' …' if len(failures) > 5 else ''})"
        )

    builds.sort(key=lambda build: build.ticker)
    files: list[dict] = []
    rung_totals: dict[str, int] = {}
    cat_totals: dict[str, int] = {}
    documents: list[dict] = []
    summary_funds: list[dict] = []
    for build in builds:
        rel_path = f"funds/{build.ticker}.json"
        (release_dir / rel_path).write_bytes(build.payload)
        documents.append(build.document)
        files.append(manifest_mod.file_entry(rel_path, build.payload))
        for rung, count in build.stats["rungs"].items():
            rung_totals[rung] = rung_totals.get(rung, 0) + count
        for category, count in build.stats["asset_cats"].items():
            cat_totals[category] = cat_totals.get(category, 0) + count
        summary_funds.append(
            {
                "ticker": build.ticker,
                "name": build.stats["name"],
                "issuer": build.stats["issuer"],
                "as_of": build.stats["as_of"],
                "net_assets": build.stats["net_assets"],
                "coverage_pct": build.stats["coverage_pct"],
                "bytes": len(build.payload),
                "total_bp": build.stats["total_bp"],
                "etf": build.stats["etf"],
                "seconds": build.stats["seconds"],
            }
        )

    document = manifest_mod.build_manifest(
        release_id=release,
        funds=documents,
        files=files,
        rung_counts={name: int(rung_totals.get(name, 0)) for name in RUNG_NAMES},
        asset_cat_counts=dict(sorted(cat_totals.items())),
        generated_at=generated_at,
    )
    payload = artifact.canonical_bytes(document)
    (release_dir / "manifest.json").write_bytes(payload)

    # What a browser actually reads. The manifest above is the inventory (8,533
    # entries at day-4 scale, 0.42 MB gzipped, on nobody's critical path); these
    # are the catalogue, the per-letter hash shards, and the reverse X-Ray shards.
    new_aliases = _alias_map(builds)
    browser_objects = catalogue.write_release_objects(
        release_dir,
        release=release,
        documents=documents,
        files=files,
        header=document,
        manifest_payload=payload,
        aliases=new_aliases,
        etf_classifier=classify.ETF_CLASSIFIER,
    )
    elapsed = time.monotonic() - started
    _log(
        f"manifest: {len(documents):,} funds, {document['company_count']:,} companies, "
        f"{len(payload):,}B, etf={document['etf_count']:,}, "
        f"coverage={document['coverage_histogram']}"
    )
    _log(f"browser objects: {browser_objects['summary']}")

    summary = {
        "release": release,
        "release_dir": str(release_dir),
        "universe": label,
        "funds": summary_funds,
        "fund_count": len(documents),
        "attempted": len(refs),
        "failed": sorted(failures, key=lambda row: row["ticker"]),
        "company_count": document["company_count"],
        "etf_count": document["etf_count"],
        "etf_classifier": document["etf_classifier"],
        "rungs": document["mapping_rungs"],
        "coverage_histogram": document["coverage_histogram"],
        "manifest_bytes": len(payload),
        "manifest_sha256": artifact.sha256_hex(payload),
        "release_object_bytes": browser_objects["release_bytes"],
        "release_object_sha256": browser_objects["release_sha256"],
        "browser_objects": browser_objects["sizes"],
        "elapsed_seconds": round(elapsed, 1),
        "workers": workers,
        "generated_at": document["generated_at"],
    }
    (release_dir / "build-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n"
    )
    _log(
        f"done in {elapsed:.1f}s — {len(documents):,} funds, {len(failures):,} failed, "
        f"{sum(row['bytes'] for row in summary_funds) / 1e6:.1f} MB of fund files"
    )
    return release_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.build", description=__doc__)
    parser.add_argument(
        "--tickers",
        default=None,
        help="comma-separated tickers (the day-1 slice; same as --universe tickers:…)",
    )
    parser.add_argument(
        "--universe",
        default=None,
        help="'all' for every SEC fund series, or 'tickers:VOO,QQQ' (default: VOO)",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=None,
        help="with --universe all and --from-summary: keep the N largest funds by N-PORT net assets",
    )
    parser.add_argument(
        "--from-summary",
        type=Path,
        default=None,
        help="a previous release's build-summary.json, used by --top",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="first N funds of the resolved universe (a deterministic sample)",
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
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="funds built concurrently (default 1; SEC requests stay throttled to 8/s)",
    )
    parser.add_argument(
        "--on-error",
        choices=("fail", "skip"),
        default=None,
        help="fail on the first unusable fund (default for tickers) or record it and "
        "continue (default for --universe all)",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=0,
        help="print a progress line every N funds (0 = only the final summary)",
    )
    args = parser.parse_args(argv)

    if args.universe:
        spec = args.universe
    else:
        spec = f"tickers:{args.tickers or 'VOO'}"
    label = spec if args.top is None and args.limit is None else (
        f"{spec} top={args.top} limit={args.limit}"
    )
    on_error = args.on_error or ("fail" if spec.startswith("tickers:") else "skip")

    try:
        refs = resolve_universe(
            spec, limit=args.limit, top=args.top, from_summary=args.from_summary
        )
        build_release(
            refs,
            out_dir=args.out,
            release_id=args.release_id,
            generated_at=args.generated_at,
            workers=max(1, args.workers),
            on_error=on_error,
            label=label,
            progress_every=max(0, args.progress_every),
        )
    except (GateError, NportParseError, LookupError, filings.NoFilingError) as error:
        _log(f"FAILED: {type(error).__name__}: {error}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
