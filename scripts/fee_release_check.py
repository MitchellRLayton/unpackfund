"""Run the release build's fee step over a mirrored release — T-0052 phase 1 evidence.

    UNPACKFUND_CACHE=data/cache python scripts/fee_release_check.py \
        --mirror artifacts/mirror/live --out data/fee-step/<name> --filed-by 2026-11-24

It builds the objects build.build_release hands to the fee step (FundBuild stubs from
the published documents), calls the production functions (fees.collect,
build._attach_fees) and validates every resulting document with the production check
(validate._check_fees). It writes summary.json, classes.json (one row per class,
for hand-checking against filings) and missing.json (the band of every class without a
fee). Nothing is uploaded and no release is written, which is why it can run without the
N-PORT cache a full build needs. A warm SEC cache makes it ~40 s; a cold one is the walk the
phase 0 report costed.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipeline"))

from pipeline import build, fees, universe, validate  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--mirror", type=Path, required=True, help="a release's catalogue.json and funds/")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--filed-by", required=True, help="the release date: no later filing is read")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)

    catalogue = json.loads((args.mirror / "catalogue.json").read_text())
    mf = universe._mf_map()
    series_symbols = universe._series_symbols()
    builds = []
    for ticker in sorted(catalogue["funds"]):
        path = args.mirror / "funds" / f"{ticker}.json"
        if not path.exists():
            continue
        payload = path.read_bytes()
        document = json.loads(payload)
        mapped = mf.get(ticker)
        hit = re.search(r"/edgar/data/(\d+)/", str(document.get("source_url") or ""))
        cik = int(mapped[0]) if mapped else (int(hit.group(1)) if hit else None)
        builds.append(
            build.FundBuild(
                ticker=ticker,
                document=document,
                payload=payload,
                ref_symbols=series_symbols.get(document.get("fund_id"), ()),
                cik=cik,
            )
        )
    print(f"{len(builds):,} funds from the mirror (release as_of {catalogue.get('as_of')})", flush=True)

    started = time.monotonic()
    wants = build._fee_wants(builds)
    print(f"{sum(len(v) for v in wants.values()):,} classes wanted from {len(wants):,} registrants", flush=True)
    found = fees.collect(
        wants,
        filed_by=args.filed_by,
        workers=args.workers,
        log=lambda message: print(message, flush=True),
        overrides=fees.load_overrides(),
        series_counts=build._registrant_series_counts(),
    )
    print(f"walk took {time.monotonic() - started:.0f}s", flush=True)

    sizes = {b.ticker: len(b.payload) for b in builds}
    before_gz = sum(len(gzip.compress(b.payload)) for b in builds)
    summary = build._attach_fees(builds, found)
    summary["bytes_before"], summary["bytes_after"] = sum(sizes.values()), sum(len(b.payload) for b in builds)
    summary["gzip_before"] = before_gz
    summary["gzip_after"] = sum(len(gzip.compress(b.payload)) for b in builds)
    summary["largest_added"] = max(len(b.payload) - sizes[b.ticker] for b in builds)

    # The release's own alias map, so a fee row for a symbol the release does not publish for
    # the fund fails here as it would in the validator.
    aliases = build._alias_map(builds)
    report = validate.Report()
    for b in builds:
        validate._check_fees(b.document, args.filed_by, aliases, report)
    summary["validator_failures"] = report.failures

    rows = {}
    for b in builds:
        for symbol, row in (b.document.get("fees") or {}).get("classes", {}).items():
            rows[symbol] = {**row, "fund": b.ticker, "net_assets": b.document.get("net_assets")}
    (args.out / "classes.json").write_text(json.dumps(rows, indent=1))
    (args.out / "summary.json").write_text(json.dumps(summary, indent=1, sort_keys=True))
    (args.out / "missing.json").write_text(json.dumps(found.missing, indent=1, sort_keys=True))
    print(json.dumps(summary, indent=1, sort_keys=True), flush=True)
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(main())
