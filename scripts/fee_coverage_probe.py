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
import http.client
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

from pipeline import sec  # noqa: E402
from pipeline.cover_shares import (  # noqa: E402
    _index_items,
    _instance_name,
    _number,
    _primary_name,
    _recent_rows,
    _scale,
    _split,
)
from pipeline.universe import _mf_map  # noqa: E402

#: Filings whose fee table the oef taxonomy tags. 485BPOS is the effective registration
#: statement; a 497 can restate the fee table in a supplement.
FEE_FORMS = ("485BPOS", "497")

OEF_PREFIX = "http://xbrl.sec.gov/oef/"
XSI_NIL = "{http://www.w3.org/2001/XMLSchema-instance}nil"

#: oef local name → our field name.
ELEMENTS = {
    "ExpensesOverAssets": "total",
    "NetExpensesOverAssets": "net",
    "FeeWaiverOrReimbursementOverAssets": "waiver",
}

_SERIES = re.compile(r"S\d{9}")
_CLASS = re.compile(r"C\d{9}")
_CIK_IN_URL = re.compile(r"/edgar/data/(\d+)/")

#: Two values closer than this are the same fee (the facts carry 4 decimals).
EPS = 5e-5


# --- parsing one instance ----------------------------------------------------


@dataclass
class ClassFees:
    """Every value one share class's contexts carry, per field."""

    values: dict[str, set] = field(default_factory=lambda: defaultdict(set))

    def add(self, name: str, value: float | None) -> None:
        self.values[name].add(value)

    def resolved(self, name: str) -> tuple[str, float | None]:
        """``(state, value)``: ``absent`` · ``nil`` · ``ok`` · ``ambiguous``."""
        seen = self.values.get(name)
        if not seen:
            return "absent", None
        numbers = sorted(v for v in seen if v is not None)
        if not numbers:
            return "nil", None
        if numbers[-1] - numbers[0] > EPS:
            return "ambiguous", None
        return "ok", numbers[0]


def _member(dims: Iterable[tuple[str, str]], axis: str, pattern: re.Pattern) -> str | None:
    for dimension, member in dims:
        if dimension.endswith(axis):
            found = pattern.search(member)
            if found:
                return found.group(0)
    return None


def parse_instance(xml_bytes: bytes) -> dict[tuple[str | None, str | None], ClassFees]:
    """``(series_id, class_id) → ClassFees`` for every oef fee fact in an instance.

    ``None`` in the key means the context has no such axis: a single-series registrant
    omits ``LegalEntityAxis``, a single-class series may omit ``ClassAxis``.
    """
    root = ET.fromstring(xml_bytes)
    contexts: dict[str, tuple[tuple[str, str], ...]] = {}
    for element in root.iter():
        _, local = _split(element.tag)
        if local != "context" or not element.get("id"):
            continue
        dims = []
        for child in element.iter():
            _, child_local = _split(child.tag)
            if child_local == "explicitMember":
                dims.append(((child.get("dimension") or "").strip(), (child.text or "").strip()))
        contexts[element.get("id").strip()] = tuple(dims)

    found: dict[tuple[str | None, str | None], ClassFees] = defaultdict(ClassFees)
    for element in root.iter():
        namespace, local = _split(element.tag)
        if local == "nonFraction":
            # Inline XBRL: the concept is the ``name`` attribute, and the text is the
            # displayed figure — ``0.40`` with ``scale="-2"`` is 0.0040.
            prefix, _, concept = (element.get("name") or "").rpartition(":")
            name = ELEMENTS.get(concept) if "oef" in prefix.lower() else None
            if name is None:
                continue
            value = _inline_value(element)
        else:
            name = ELEMENTS.get(local)
            if name is None or not namespace.startswith(OEF_PREFIX):
                continue
            if element.get(XSI_NIL) == "true":
                value = None
            else:
                try:
                    value = float((element.text or "").strip())
                except ValueError:
                    value = None
        dims = contexts.get((element.get("contextRef") or "").strip(), ())
        key = (
            _member(dims, "LegalEntityAxis", _SERIES),
            _member(dims, "ClassAxis", _CLASS),
        )
        found[key].add(name, value)
    return dict(found)


def _inline_value(element: ET.Element) -> float | None:
    if element.get(XSI_NIL) == "true":
        return None
    if (element.get("format") or "").endswith(("fixed-zero", "fixedzero")):
        # "None" or "—" in the fee table, tagged as a zero.
        return 0.0
    value = _number(
        "".join(element.itertext()),
        scale=_scale(element),
        negative=(element.get("sign") or "").strip() == "-",
    )
    return None if value is None else round(value, 8)


def fees_for(
    facts: Mapping[tuple[str | None, str | None], ClassFees],
    series_id: str,
    class_id: str | None,
) -> tuple[str, ClassFees | None]:
    """The facts for one published class: ``(match, fees)``.

    ``match`` says how the class was found — ``class`` (exact series and class),
    ``class-no-series`` (class axis only), ``series-single-class`` (the series has one
    class in the filing and the published class is unknown or untagged), ``series``
    (series-level facts, no class axis) — or ``none``.
    """
    if class_id and (series_id, class_id) in facts:
        return "class", facts[(series_id, class_id)]
    if class_id and (None, class_id) in facts:
        return "class-no-series", facts[(None, class_id)]
    if (series_id, None) in facts:
        return "series", facts[(series_id, None)]
    in_series = [key for key in facts if key[0] == series_id and key[1] is not None]
    if len(in_series) == 1 and class_id is None:
        return "series-single-class", facts[in_series[0]]
    return "none", None


def series_in(facts: Mapping[tuple[str | None, str | None], ClassFees]) -> set[str | None]:
    return {key[0] for key, fees in facts.items() if fees.values.get("total")}


def classes_without_series(facts: Mapping[tuple[str | None, str | None], ClassFees]) -> set[str]:
    """Classes tagged with a total but no ``dei:LegalEntityAxis`` member."""
    return {key[1] for key, fees in facts.items() if key[0] is None and key[1] and fees.values.get("total")}


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


#: A body cut short mid-read (``http.client.IncompleteRead``) escapes ``sec.fetch``'s retry
#: loop, which catches ``OSError`` and HTTP status errors only. Seen once on the full run
#: (registrant 550, a 9,349-byte instance one byte short). Retried here; a persistent one is
#: counted as a filing error, never silently read as "no fees".
TRANSIENT = (http.client.HTTPException,)


def _fetch(url: str, *, as_json: bool = False, tries: int = 3, **kwargs):
    for attempt in range(tries):
        try:
            return sec.fetch_json(url, **kwargs) if as_json else sec.fetch(url, **kwargs)
        except TRANSIENT:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def _instance_facts(cik: int, row: Mapping[str, Any]) -> tuple[dict | None, str]:
    """The filing's fee facts and where they came from: ``instance`` or ``inline``.

    A filing flagged XBRL with no ``*_htm.xml`` beside it is Inline XBRL only, and its
    primary document carries the facts.
    """
    directory = sec.filing_dir_url(cik, str(row.get("accessionNumber") or ""))
    index = _fetch(directory + "index.json", as_json=True)
    items = _index_items(index) if isinstance(index, dict) else []
    name = _instance_name(items)
    if name is not None:
        return parse_instance(_fetch(directory + name)), "instance"
    if row.get("isInlineXBRL"):
        primary = _primary_name(items, dict(row))
        if primary is not None:
            return parse_instance(_fetch(directory + primary)), "inline"
    return None, "none"


def _fee_rows(rows: Iterable[Mapping[str, Any]], since: str = "") -> list[dict]:
    """Fee-form rows filed on or after ``since``, newest first."""
    picked = [
        dict(r)
        for r in rows
        if r.get("form") in FEE_FORMS and str(r.get("filingDate") or "") >= since
    ]
    picked.sort(key=lambda r: (str(r.get("filingDate") or ""), str(r.get("accessionNumber"))), reverse=True)
    return picked


def _older_page(name: str) -> list[dict]:
    """One of ``filings.files``: the same columns as ``recent``, without the wrapper."""
    page = _fetch(f"https://data.sec.gov/submissions/{name}", as_json=True)
    return _recent_rows({"filings": {"recent": page}})


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
    rows = _fee_rows(_recent_rows(submissions), since)
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
    while pending and walked < max_filings:
        if position >= len(xbrl_rows):
            if pages_read >= min(max_pages, len(older)):
                break
            page_rows = _fee_rows(_older_page(older[pages_read]), since)
            pages_read += 1
            rows.extend(page_rows)
            xbrl_rows.extend(r for r in page_rows if r.get("isXBRL") or r.get("isInlineXBRL"))
            continue
        row = xbrl_rows[position]
        position += 1
        walked += 1
        try:
            facts, basis = _instance_facts(cik, row)
        except (sec.SecError, ET.ParseError, *TRANSIENT) as error:
            stats["filing_errors"] += 1
            stats[f"error:{type(error).__name__}"] += 1
            continue
        if facts is None:
            stats["xbrl_flag_but_no_document"] += 1
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


def summarise(results: list[Result]) -> dict[str, Any]:
    covered = [r for r in results if r.band == "covered"]
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
