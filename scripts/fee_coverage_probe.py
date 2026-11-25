"""How much of the published universe has a stated expense ratio in SEC XBRL — T-0052 phase 0.

    python scripts/fee_coverage_probe.py --catalogue <mirror>/catalogue.json --out <dir>
    python scripts/fee_coverage_probe.py ... --registrants 15      # the sample: largest 15 by assets

**Measurement only.** It reads the published release (catalogue + fund documents) and SEC
filings, and writes a JSON result and a Markdown summary to ``--out``. It never writes an
artifact, and nothing reads its output. Plan:
``docs/02-planning/2026-11-24-net-expense-ratio-plan.md`` (workspace).

What it measures, per published fund (one series, one published ticker):

* the newest 485BPOS/497 filing of the registrant whose XBRL instance tags a fee fact for
  that series, walked newest-first per registrant;
* in that filing, for the published ticker's share class: ``oef:ExpensesOverAssets``
  (total, gross), ``oef:NetExpensesOverAssets`` (net) and
  ``oef:FeeWaiverOrReimbursementOverAssets`` (waiver), each matched by local name under
  any ``http://xbrl.sec.gov/oef/<year>`` namespace;
* whether a later 497 exists for the registrant (a weak stale-prospectus signal: the 497
  may concern another series).

Every rate is reported twice, by fund count and by net assets, because the largest funds
are where a gap matters (skill ``fund-reference-extraction`` §5, denominator rule).

Rules taken from the skill, not re-derived: a nil fact is ``None``, never 0; a class whose
contexts disagree on a value is ``ambiguous`` and its value is dropped, not picked; net is
never computed from gross and waiver.

All HTTP goes through ``pipeline.sec`` (User-Agent, ≤8 req/s, retry, byte cache), so a
second run reads the cache and costs nothing.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable, Mapping

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipeline"))

from pipeline import sec, xbrl  # noqa: E402
from pipeline.fees import (  # noqa: E402
    ELEMENTS,
    EPS,
    FEE_CEILING,
    NET_OVER_TOTAL,
    UNREADABLE,
    ClassFees,
    _fee_rows,
    _instance_facts as _read_filing,
    classes_without_series,
    fees_for,
    is_recoupment as _is_recoupment,
    parse_instance,
    refusal,
    series_in,
)
from pipeline.universe import _mf_map  # noqa: E402

_CIK_IN_URL = re.compile(r"/edgar/data/(\d+)/")

# Parsing, matching and the validator's rules live in ``pipeline.fees`` — one definition,
# shared with the release build. This script keeps only what a measurement needs and
# production does not: ``Result`` per fund, the stale-prospectus signal, the report. Its
# registrant walk is the measured one (phase 0); ``fees.registrant_fees`` is the
# production walk, which adds a point-in-time bound and withholds a fee behind an
# unreadable newer filing.


# --- the walk ---------------------------------------------------------------


@dataclass
class Fund:
    ticker: str
    series_id: str
    class_id: str | None
    cik: int | None
    net_assets: float
    etf: bool
    name: str


@dataclass
class Result:
    ticker: str
    series_id: str
    class_id: str | None
    cik: int | None
    net_assets: float
    etf: bool
    name: str
    band: str
    match: str = "none"
    total: float | None = None
    net: float | None = None
    waiver: float | None = None
    total_state: str = "absent"
    net_state: str = "absent"
    waiver_state: str = "absent"
    form: str | None = None
    filed: str | None = None
    accession: str | None = None
    later_497: bool = False
    basis: str | None = None
    #: Accession of a newer fee filing this registrant filed that could not be read. The
    #: fee shown came from an older filing, so it may be out of date (review R1).
    newer_filing_unread: str | None = None


def _fund_docs(funds_dir: Path, tickers: Iterable[str]) -> dict[str, dict]:
    docs = {}
    for ticker in tickers:
        path = funds_dir / f"{ticker}.json"
        if path.exists():
            docs[ticker] = json.loads(path.read_text())
    return docs


def load_funds(catalogue_path: Path) -> list[Fund]:
    catalogue = json.loads(catalogue_path.read_text())
    rows = catalogue["funds"]
    docs = _fund_docs(catalogue_path.parent / "funds", rows)
    mf = _mf_map()
    funds = []
    for ticker, (name, _issuer, etf, _coverage, net_assets) in sorted(rows.items()):
        doc = docs.get(ticker, {})
        series_id = str(doc.get("fund_id") or "")
        mapped = mf.get(ticker)
        cik = None
        if mapped:
            cik = int(mapped[0])
        else:
            hit = _CIK_IN_URL.search(str(doc.get("source_url") or ""))
            cik = int(hit.group(1)) if hit else None
        class_id = mapped[2] if mapped and mapped[1] == series_id else None
        funds.append(
            Fund(ticker, series_id, class_id, cik, float(net_assets or 0), bool(etf), name)
        )
    return funds


def _older_page(name: str) -> list[dict]:
    page = sec.fetch_json(f"https://data.sec.gov/submissions/{name}")
    return xbrl.recent_rows({"filings": {"recent": page}})


def _fetch(url: str, *, as_json: bool = False, **kwargs):
    return sec.fetch_json(url, **kwargs) if as_json else sec.fetch(url, **kwargs)


def _instance_facts(cik: int, row: Mapping[str, Any]) -> tuple[dict | None, str]:
    """The filing's fee facts and where they came from — ``fees._instance_facts`` less the URL."""
    filing, basis, _url = _read_filing(cik, row)
    return (filing.facts if filing is not None else None), basis


def probe_registrant(
    cik: int, funds: list[Fund], max_filings: int, max_pages: int = 3, since: str = ""
) -> tuple[list[Result], dict]:
    """Walk one registrant's fee filings newest-first until every fund has a filing.

    ``recent`` holds at most about a year for a busy trust (iShares: 2,522 filings back
    to 2025-11-21), and an annual prospectus can sit just before it, so older pages
    are read — lazily, only while a fund is still unmatched — up to ``max_pages``.

    Nothing filed before ``since`` is read. A fund must update its prospectus within
    16 months (Securities Act §10(a)(3)), so an older fee table is stale by
    definition, and walking to it cost the first full run hours on a few trusts
    (one walked 2020 filings of ~10 MB each for a single unmatched class).
    """
    stats = Counter()
    submissions = _fetch(sec.submissions_url(cik), as_json=True, max_age=sec.INDEX_MAX_AGE_S)
    rows = _fee_rows(xbrl.recent_rows(submissions), since, "9999-12-31")
    older = [
        f["name"]
        for f in (submissions.get("filings") or {}).get("files", [])
        if f.get("name") and str(f.get("filingTo") or "9999") >= since
    ]
    xbrl_rows = [r for r in rows if r.get("isXBRL") or r.get("isInlineXBRL")]

    pending = {f.ticker: f for f in funds if f.series_id}
    results: dict[str, Result] = {}
    partial: dict[str, Result] = {}
    single_series = len({f.series_id for f in funds}) == 1
    walked = 0
    position = 0
    pages_read = 0
    # The newest fee filing we could not read. The walk is newest-first, so every fee
    # matched after it comes from an older filing and is flagged, never passed as current.
    unread: str | None = None
    while pending and walked < max_filings:
        if position >= len(xbrl_rows):
            if pages_read >= min(max_pages, len(older)):
                break
            page_rows = _fee_rows(_older_page(older[pages_read]), since, "9999-12-31")
            pages_read += 1
            rows.extend(page_rows)
            xbrl_rows.extend(r for r in page_rows if r.get("isXBRL") or r.get("isInlineXBRL"))
            continue
        row = xbrl_rows[position]
        position += 1
        walked += 1
        try:
            facts, basis = _instance_facts(cik, row)
        except (sec.SecError, ET.ParseError) as error:
            stats["filing_errors"] += 1
            stats[f"error:{type(error).__name__}"] += 1
            unread = unread or str(row.get("accessionNumber"))
            continue
        if facts is None:
            stats["xbrl_flag_but_no_document"] += 1
            unread = unread or str(row.get("accessionNumber"))
            continue
        stats[f"read_{basis}"] += 1
        tagged = series_in(facts)
        # Some trusts (T. Rowe Price) tag the class axis with no series axis at all, so a
        # filing whose series list lacks the fund can still carry its class.
        class_only = classes_without_series(facts)
        for ticker, fund in list(pending.items()):
            if fund.series_id in tagged or (fund.class_id and fund.class_id in class_only):
                key_series = fund.series_id
            elif single_series and None in tagged:
                key_series = None
            else:
                continue
            match, fees = fees_for(facts, key_series, fund.class_id)
            if fees is None:
                # The series is in this filing but not the published class. Keep walking:
                # an older filing may be the class's own prospectus.
                band = "class-unknown" if fund.class_id is None else "class-not-in-filing"
                partial.setdefault(ticker, _result(fund, band, row))
                continue
            result = _result(fund, "found", row)
            result.match = match
            result.basis = basis
            result.newer_filing_unread = unread
            for name in ELEMENTS.values():
                state, value = fees.resolved(name)
                setattr(result, f"{name}_state", state)
                setattr(result, name, value)
            result.band = "covered" if result.total_state == "ok" else f"total-{result.total_state}"
            results[ticker] = result
            del pending[ticker]
    stats["filings_walked"] = walked
    stats["older_pages_read"] = pages_read
    stats["fee_filings"] = len(rows)
    stats["fee_filings_xbrl"] = len(xbrl_rows)
    history_left = position < len(xbrl_rows) or pages_read < len(older)

    for ticker, fund in pending.items():
        if ticker in partial:
            results[ticker] = partial[ticker]
            continue
        if not rows:
            band = "no-fee-filing"
        elif not xbrl_rows:
            band = "no-xbrl-filing"
        elif history_left:
            # Stopped by --max-filings or --max-pages with history unread: not a finding.
            band = "walk-cap"
        else:
            band = "series-not-tagged"
        results[ticker] = _result(fund, band, None)

    for result in results.values():
        if result.filed:
            result.later_497 = any(
                r.get("form") == "497" and str(r.get("filingDate")) > result.filed for r in rows
            )
    return list(results.values()), dict(stats)


def _result(fund: Fund, band: str, row: Mapping[str, Any] | None) -> Result:
    result = Result(**asdict(fund), band=band)
    if row is not None:
        result.form = row.get("form")
        result.filed = row.get("filingDate")
        result.accession = row.get("accessionNumber")
    return result


# --- the report -------------------------------------------------------------


def _rate(part: Iterable[Result], whole: list[Result]) -> dict[str, Any]:
    part = list(part)
    assets = sum(r.net_assets for r in whole) or 1.0
    return {
        "funds": len(part),
        "of_funds": len(whole),
        "pct_funds": round(100 * len(part) / max(len(whole), 1), 1),
        "pct_assets": round(100 * sum(r.net_assets for r in part) / assets, 1),
    }




def is_recoupment(r: Result) -> bool:
    return _is_recoupment(r.total, r.net, r.waiver)


def phase1_refusal(r: Result) -> str | None:
    """Why phase 1's validator would publish no fee for a covered class, or ``None``."""
    return refusal(r.total, r.net, r.waiver)


def summarise(results: list[Result]) -> dict[str, Any]:
    covered = [r for r in results if r.band == "covered"]
    refusals = Counter(reason for r in covered if (reason := phase1_refusal(r)))
    shippable = [r for r in covered if phase1_refusal(r) is None]
    above = [r for r in covered if r.net is not None and r.total is not None and r.net > r.total + NET_OVER_TOTAL]
    unread = [r for r in covered if r.newer_filing_unread]
    net_ok = [r for r in covered if r.net_state == "ok"]
    differs = [r for r in net_ok if abs((r.net or 0) - (r.total or 0)) > EPS]
    waiver_ok = [r for r in covered if r.waiver_state == "ok"]
    waiver_sign = Counter(
        "negative" if (r.waiver or 0) < -EPS else "positive" if (r.waiver or 0) > EPS else "zero"
        for r in waiver_ok
    )
    waiver_no_net = [r for r in waiver_ok if abs(r.waiver or 0) > EPS and r.net_state != "ok"]
    uncovered = sorted((r for r in results if r.band != "covered"), key=lambda r: -r.net_assets)
    return {
        "bands": dict(Counter(r.band for r in results).most_common()),
        "match": dict(Counter(r.match for r in covered).most_common()),
        "basis": dict(Counter(r.basis for r in covered).most_common()),
        "filed_year": dict(sorted(Counter((r.filed or "")[:4] for r in covered).items())),
        "total_stated": _rate(covered, results),
        "shippable": _rate(shippable, results),
        "phase1_refusals": dict(refusals.most_common()),
        "net_above_total": {"threshold": NET_OVER_TOTAL, "funds": len(above),
                            "recoupments": sum(is_recoupment(r) for r in above)},
        "newer_filing_unread": {**_rate(unread, results),
                                "accessions": dict(Counter(r.newer_filing_unread for r in unread).most_common(10))},
        "net_tagged": _rate(net_ok, results),
        "net_tagged_of_covered": _rate(net_ok, covered),
        "net_differs_from_total": _rate(differs, results),
        "waiver_tagged": _rate(waiver_ok, results),
        "waiver_sign": dict(waiver_sign),
        "waiver_nonzero_without_net": len(waiver_no_net),
        "states": {
            name: dict(Counter(getattr(r, f"{name}_state") for r in results if r.band == "covered" or r.band.startswith("total-")))
            for name in ELEMENTS.values()
        },
        "later_497_of_covered": _rate((r for r in covered if r.later_497), covered),
        "by_type": {
            label: _rate((r for r in covered if r.etf is etf), [r for r in results if r.etf is etf])
            for label, etf in (("etf", True), ("mutual_fund", False))
        },
        "largest_uncovered": [
            {"ticker": r.ticker, "name": r.name, "band": r.band, "net_assets": r.net_assets}
            for r in uncovered[:20]
        ],
        "largest_net_differs": [
            {"ticker": r.ticker, "name": r.name, "total": r.total, "net": r.net, "waiver": r.waiver,
             "accession": r.accession}
            for r in sorted(differs, key=lambda r: -r.net_assets)[:10]
        ],
    }


def markdown(summary: Mapping[str, Any], meta: Mapping[str, Any]) -> str:
    def rate(key: str) -> str:
        r = summary[key]
        return f"{r['funds']:,} of {r['of_funds']:,} funds ({r['pct_funds']}%) · {r['pct_assets']}% of assets"

    lines = [
        "# Fee coverage probe",
        "",
        f"Release `{meta['release']}` · {meta['funds']:,} funds · {meta['registrants']:,} registrants · "
        f"{meta['filings_walked']:,} filings walked (cap {meta['max_filings']}/registrant, filed since {meta['since']})",
        "",
        f"- **Total (gross) stated:** {rate('total_stated')}",
        f"- **Shippable under phase 1's validator:** {rate('shippable')} · refused {summary['phase1_refusals']}",
        f"- **Net above total (by more than {summary['net_above_total']['threshold']}):** "
        f"{summary['net_above_total']['funds']}, of which stated recoupments {summary['net_above_total']['recoupments']}",
        f"- **Fee read from an older filing because a newer one was unreadable:** {rate('newer_filing_unread')} · "
        f"{summary['newer_filing_unread']['accessions']}",
        f"- **Net tagged:** {rate('net_tagged')}",
        f"- **Net tagged, of covered funds:** {rate('net_tagged_of_covered')}",
        f"- **Net differs from total:** {rate('net_differs_from_total')}",
        f"- **Waiver tagged:** {rate('waiver_tagged')} · signs {summary['waiver_sign']} · "
        f"non-zero waiver without net: {summary['waiver_nonzero_without_net']}",
        f"- **Later 497 exists (weak stale signal), of covered:** {rate('later_497_of_covered')}",
        f"- **ETFs:** {summary['by_type']['etf']['pct_funds']}% of funds, {summary['by_type']['etf']['pct_assets']}% of assets"
        f" · **Mutual funds:** {summary['by_type']['mutual_fund']['pct_funds']}% / {summary['by_type']['mutual_fund']['pct_assets']}%",
        "",
        "## Bands",
        "",
        "| Band | Funds |",
        "|---|---:|",
        *[f"| {band} | {count:,} |" for band, count in summary["bands"].items()],
        "",
        f"Class match among covered: {summary['match']} · read from: {summary['basis']} · "
        f"filing year: {summary['filed_year']}",
        "",
        "## 20 largest funds without a stated total",
        "",
        "| Ticker | Name | Band | Net assets ($bn) |",
        "|---|---|---|---:|",
        *[
            f"| {r['ticker']} | {r['name']} | {r['band']} | {r['net_assets'] / 1e9:,.1f} |"
            for r in summary["largest_uncovered"]
        ],
        "",
        "## Largest funds where net differs from total",
        "",
        "| Ticker | Name | Total | Net | Waiver | Accession |",
        "|---|---|---:|---:|---:|---|",
        *[
            f"| {r['ticker']} | {r['name']} | {r['total']} | {r['net']} | {r['waiver']} | {r['accession']} |"
            for r in summary["largest_net_differs"]
        ],
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--catalogue", type=Path, required=True, help="a release's catalogue.json, with funds/ beside it")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--registrants", type=int, default=0, help="only the N largest registrants by assets (0 = all)")
    parser.add_argument("--max-filings", type=int, default=150, help="XBRL fee filings walked per registrant")
    parser.add_argument(
        "--window-days", type=int, default=548,
        help="read only filings this many days before the release date (548 ≈ 18 months, past the 16-month update rule)",
    )
    parser.add_argument("--max-pages", type=int, default=3, help="older submissions pages read per registrant")
    args = parser.parse_args(argv)

    release = json.loads(args.catalogue.read_text()).get("as_of")
    since = (date.fromisoformat(str(release)[:10]) - timedelta(days=args.window_days)).isoformat()
    funds = load_funds(args.catalogue)
    by_cik: dict[int | None, list[Fund]] = defaultdict(list)
    for fund in funds:
        by_cik[fund.cik].append(fund)
    order = sorted((c for c in by_cik if c is not None), key=lambda c: -sum(f.net_assets for f in by_cik[c]))
    if args.registrants:
        order = order[: args.registrants]

    results: list[Result] = []
    stats = Counter()
    started = time.monotonic()
    for done, cik in enumerate(order, 1):
        try:
            rows, registrant_stats = probe_registrant(
                cik, by_cik[cik], args.max_filings, args.max_pages, since
            )
        except sec.SecError as error:
            rows = [_result(f, "registrant-error", None) for f in by_cik[cik]]
            registrant_stats = {"registrant_errors": 1}
            print(f"  cik {cik}: {error}", file=sys.stderr, flush=True)
        results.extend(rows)
        stats.update(registrant_stats)
        if done % 25 == 0 or done == len(order):
            print(
                f"{done}/{len(order)} registrants · {stats['filings_walked']} filings · "
                f"{time.monotonic() - started:,.0f} s",
                file=sys.stderr, flush=True,
            )
    if not args.registrants:
        results.extend(_result(f, "no-cik", None) for f in by_cik.get(None, []))

    summary = summarise(results)
    meta = {
        "release": release,
        "since": since,
        "funds": len(results),
        "registrants": len(order),
        "filings_walked": stats["filings_walked"],
        "max_filings": args.max_filings,
        "stats": dict(stats),
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "fee-coverage.json").write_text(
        json.dumps({"meta": meta, "summary": summary, "results": [asdict(r) for r in results]}, indent=1, sort_keys=True)
    )
    (args.out / "fee-coverage.md").write_text(markdown(summary, meta))
    print(markdown(summary, meta))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
