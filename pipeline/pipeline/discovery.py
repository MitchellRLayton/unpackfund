"""Find the N-PORT series the SEC's fund ticker file does not carry.

Why this exists: ``company_tickers_mf.json`` is the only universe a wide build
walks, and it is **incomplete** — not stale, incomplete. On 2026-11-11 it carried
12,306 series and series ids up to ``S000110499``, and still had no row for
Roundhill Memory ETF (``S000102337``, Cboe: DRAM, effective 2026-04-01) or
Roundhill HALO ETF (``S000104627``), both of which had been filing N-PORT since
the quarter ending 2026-06-30. ``universe.py``'s own docstring says the file is
"a resolution input, never a universe" while ``all_series()`` used it as one; a
fund the file omits was never fetched, so it 404'd on the site with no record
anywhere that it existed.

The repair is to discover series from the filings themselves. Every N-PORT
carries its ``seriesId`` and ``seriesName``, and the daily index names every
N-PORT filing by registrant CIK — so a registrant we already publish can be
walked for series we do not, at the cost of one small document per *new* filing
(about 75 a day across the whole universe, and zero on a day with no filings).

**The ticker is the hard part, and it is not in N-PORT.** A series is a
portfolio; its symbol is a share class, and N-PORT names the series, not the
class. So a discovered series needs a symbol from somewhere else, and the only
current source is the fund's own registration statement: the 485BPOS/497K cover
states the exchange and the ticker ("Roundhill Memory ETF (Cboe – DRAM)"). That
read is a text parse, so it is held to a corroboration rule rather than trusted:
the fund's N-PORT name must appear in the document, the ticker must appear in a
parenthesised exchange line beside that name, and the result must be a plausible
symbol. A series whose symbol cannot be corroborated is **recorded, not
guessed** — it lands in the cache with ``symbol: null`` and a reason, so the gap
is visible instead of silent.

Cost control: the scan is cached per accession (immutable documents, so a
re-scan is free), the whole cache is refreshed at most weekly, and a symbol
resolution is attempted once per series and then remembered — including its
failure, so a series with no readable cover is not re-fetched every night.
"""

from __future__ import annotations

import calendar
import csv
import io
import json
import re
import time
import urllib.parse
import zipfile
from concurrent import futures
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Mapping

from . import nport, refresh, sec

#: Where the discovery cache lives, under ``sec.CACHE_DIR``. Git-ignored: it is
#: derived data, and a release must be reproducible from the filings, not from it.
CACHE_RELPATH = Path("discovery") / "series.json"

#: The SEC's quarterly N-PORT data set: one zip per calendar quarter, published a few
#: days after the quarter closes. It carries the mapping this module needs —
#: ``FUND_REPORTED_INFO.tsv`` (accession → series id and name) joined to
#: ``REGISTRANT.tsv`` (accession → CIK) — so a whole quarter costs **one download**
#: instead of one request per filing. Measured 2026-11-11: 462 MB zipped, of which the
#: three tables read here are 8 MB; the zip is deleted after extraction and the compact
#: join is kept, so the cache grows by ~3 MB a quarter rather than by half a gigabyte.
DATASET = "https://www.sec.gov/files/dera/data/form-n-port-data-sets/{year}q{quarter}_nport.zip"

#: The quarterly index: one file per fiscal quarter of the calendar year, covering
#: every filing in it. A 120-day window is two of these (~30 MB) instead of 120 daily
#: files (~360 MB) — the same rows, a tenth of the bytes, which is what makes a weekly
#: rebuild affordable rather than a reason to skip it.
QUARTER_INDEX = "https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{quarter}/form.idx"

#: How far back a scan looks. N-PORT is filed within 60 days of a quarter end, so a
#: fund files roughly every 90 days; a window shorter than that would systematically
#: miss a fund sitting in the gap between two filings, which is the failure this module
#: exists to end. 90 days is one full cycle, and the per-accession cache means only the
#: first run pays for it — every later run reads the days since the last one.
DEFAULT_WINDOW_DAYS = 90

#: How many series a single run will try to name. Each attempt is a full-text query
#: plus up to three documents, so this is the knob that bounds a run's cost; the rest
#: of the queue waits for the next run, newest filing first.
DEFAULT_RESOLVE_LIMIT = 200

#: The cache is rebuilt at most this often. Series membership changes on the order of
#: weeks, and a daily rebuild would re-read 120 index files to learn nothing.
CACHE_MAX_AGE_S = 7 * 24 * 3600

#: Forms whose cover names a fund's exchange and ticker. 485BPOS is the effective
#: registration statement; 497K is the summary prospectus; 497 is the statutory one.
COVER_FORMS = ("485BPOS", "497K", "497", "485APOS")

#: A symbol is 1–6 characters of A–Z, dot or dash (the contract's own shape).
_SYMBOL = re.compile(r"^[A-Z][A-Z0-9.\-]{0,5}$")

#: Words that look like a symbol in a cover line and are not one.
_NOT_SYMBOLS = frozenset(
    {
        "ETF", "ETFS", "FUND", "FUNDS", "TRUST", "THE", "AND", "INC", "LLC",
        "NYSE", "ARCA", "CBOE", "NASDAQ", "CBOE.", "NYSE.", "N/A", "NA",
    }
)

#: ``(Cboe – DRAM)``, ``(NYSE Arca: XYZ)``, ``(the "Exchange")`` — the exchange line
#: a summary prospectus prints beside the fund's name.
_EXCHANGE_LINE = re.compile(
    r"\(\s*(?:the\s+)?(?:Cboe|CBOE|NYSE(?:\s+Arca)?|Nasdaq|The\s+Nasdaq[^)]{0,20})"
    r"[^)]{0,24}?[–—\-:]\s*([A-Z][A-Z0-9.\-]{0,5})\s*\)"
)

#: ``Trading Symbol: DRAM`` — the same fact in a table, when a cover prints one.
_TRADING_SYMBOL = re.compile(
    r"Trading\s+Symbols?\s*[:\-–]?\s*([A-Z][A-Z0-9.\-]{0,5})\b"
)

#: ``Ticker Symbol: FESC`` / ``Ticker: FESC`` — the spelling a fee table uses.
_TICKER_FIELD = re.compile(
    r"Ticker(?:\s+Symbol)?s?\s*[:\-–]\s*([A-Z][A-Z0-9.\-]{0,5})\b"
)

_SERIES_NAME = re.compile(rb"<seriesName>\s*([^<]{1,200}?)\s*</seriesName>")

#: How far from the fund's name a ticker may sit and still be read as *its* ticker. Wide
#: enough for a cover that prints the name, a sentence, and then a fee table row; narrow
#: enough that the next fund's cover line is out of reach.
_NAME_WINDOW = 600

#: How much of a document is searched for the name. The whole of it: a 485BPOS covering
#: forty series prints each fund's cover in turn, so a name that is not in the first
#: block is still that fund's own cover further down. The guard against a false positive
#: is the 200-character window, not a prefix — a name and an exchange line that close
#: together are one cover line, and a name in a list of the trust's funds has no exchange
#: line beside it.


@dataclass(frozen=True)
class Discovered:
    """One series found in a filing, and the symbol it could be given."""

    series_id: str
    cik: str
    name: str
    accession: str
    filed_at: str
    symbol: str | None = None
    symbol_source: str | None = None
    symbol_note: str | None = None

    @property
    def publishable(self) -> bool:
        return bool(self.symbol)


def cache_path(root: Path | None = None) -> Path:
    return (root or sec.CACHE_DIR) / CACHE_RELPATH


def load(root: Path | None = None) -> dict[str, Discovered]:
    """The cache as ``series_id → Discovered``; empty when nothing has been scanned."""
    path = cache_path(root)
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return {}
    out: dict[str, Discovered] = {}
    for series_id, row in (payload.get("series") or {}).items():
        try:
            out[series_id] = Discovered(**row)
        except TypeError:
            continue
    return out


def save(series: Mapping[str, Discovered], root: Path | None = None) -> Path:
    path = cache_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "kind": "series_discovery",
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "series": {key: asdict(value) for key, value in sorted(series.items())},
    }
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)
    return path


def is_stale(root: Path | None = None, max_age: float = CACHE_MAX_AGE_S) -> bool:
    path = cache_path(root)
    if not path.is_file():
        return True
    return (time.time() - path.stat().st_mtime) > max_age


def cik_key(value: str | int) -> str:
    """A CIK without its zero padding, so ``0001976517`` and ``1976517`` are one key.

    The daily index pads to ten digits and the SEC ticker file does not, so a set
    comparison on the raw strings silently matches nothing — which is exactly the
    kind of quiet miss this module exists to end.
    """
    text = str(value).strip()
    return str(int(text)) if text.isdigit() else text


def series_name(xml: bytes) -> str | None:
    """The filing's ``seriesName``, or ``None`` when it carries none."""
    match = _SERIES_NAME.search(xml)
    if not match:
        return None
    value = match.group(1).decode("utf-8", "replace").strip()
    return value or None


def quarter_index_url(day: date) -> str:
    """The quarterly ``form.idx`` that contains ``day``."""
    return QUARTER_INDEX.format(year=day.year, quarter=(day.month - 1) // 3 + 1)


def _quarter_of(day: date) -> tuple[int, int]:
    return day.year, (day.month - 1) // 3 + 1


def _quarter_end(year: int, quarter: int) -> date:
    month = quarter * 3
    return date(year, month, calendar.monthrange(year, month)[1])


def dataset_rows(year: int, quarter: int, root: Path | None = None) -> dict[str, tuple[str, str, str, str]]:
    """``accession → (cik, series_id, series_name, filed)`` for one quarter.

    Read from the SEC's data set, cached as a compact JSON after the first download.
    The zip is deleted once its three tables are read: keeping it would cost half a
    gigabyte a quarter to save a download that happens once.
    """
    path = (root or sec.CACHE_DIR) / "discovery" / f"nport-{year}q{quarter}.json"
    if path.is_file():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            return {key: tuple(value) for key, value in payload.items()}  # type: ignore[misc]
        except ValueError:
            pass
    url = DATASET.format(year=year, quarter=quarter)
    try:
        body = sec.fetch(url, max_age=None)  # a published quarter never changes
    except sec.SecError:
        return {}
    rows: dict[str, tuple[str, str, str, str]] = {}
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            names = set(archive.namelist())
            if not {"FUND_REPORTED_INFO.tsv", "REGISTRANT.tsv", "SUBMISSION.tsv"} <= names:
                return {}
            funds = _tsv(archive.read("FUND_REPORTED_INFO.tsv"))
            registrants = _tsv(archive.read("REGISTRANT.tsv"))
            submissions = _tsv(archive.read("SUBMISSION.tsv"))
    except (zipfile.BadZipFile, KeyError):
        return {}
    cik_of = {row["ACCESSION_NUMBER"]: row["CIK"] for row in registrants}
    filed_of = {row["ACCESSION_NUMBER"]: row["FILING_DATE"] for row in submissions}
    for row in funds:
        accession = row.get("ACCESSION_NUMBER") or ""
        series_id = (row.get("SERIES_ID") or "").strip()
        cik = cik_of.get(accession)
        if not accession or not series_id or not cik:
            continue
        rows[accession] = (
            cik_key(cik),
            series_id,
            (row.get("SERIES_NAME") or "").strip(),
            _iso_date(filed_of.get(accession, "")),
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, sort_keys=True) + "\n", encoding="utf-8")
    return rows


def _tsv(body: bytes) -> list[dict[str, str]]:
    text = body.decode("utf-8", "replace")
    return list(csv.DictReader(io.StringIO(text), delimiter="\t"))


def _iso_date(value: str) -> str:
    """``24-JUL-2026`` → ``2026-07-24``; anything else passes through."""
    try:
        return datetime.strptime(value.strip(), "%d-%b-%Y").date().isoformat()
    except ValueError:
        return value.strip()


def scan(
    days: Iterable[date],
    universe_ciks: set[str],
    *,
    known: Mapping[str, Discovered] | None = None,
    progress_every: int = 0,
    max_workers: int = 8,
    use_index: bool = False,
) -> dict[str, Discovered]:
    """Every N-PORT series filed by ``universe_ciks`` in ``days``.

    The SEC's quarterly data set answers for every **closed** quarter in one download,
    and it is the default source because it is the cheap one: 462 MB once a quarter,
    from which ~3 MB of table is kept, and **no document reads at all**.

    ``use_index`` adds the days since the newest data set — the current quarter, which
    no data set describes yet — by reading one N-PORT per filing from the daily index.
    It is off by default because it is *slow* and the cost is not the bytes: measured
    2026-11-11, serial reads ran at ~1.5 documents a second and eight in flight at
    ~0.5–1.5, because each request is latency-bound and EDGAR throttles a shared egress,
    so a 40-day catch-up is 30–60 minutes. Turn it on for a one-off catch-up, not for a
    nightly job; the data set lags a quarter behind, which is the price of never reading
    a document. ``known`` is the previous cache, so a filing already read is not read
    again.
    """
    seen: dict[str, Discovered] = dict(known or {})
    wanted_ciks = {cik_key(value) for value in universe_ciks}
    days = list(days)
    if not days:
        return seen
    quarters = sorted({_quarter_of(day) for day in days})
    # How far the *published* data sets reach. A quarter whose data set does not exist
    # yet (the current one, for the first days after it opens) simply is not covered,
    # and those days fall through to the index — the fallback has to follow what was
    # actually obtainable, not what the calendar says should exist.
    covered_until = date.min
    for year, quarter in quarters:
        rows = dataset_rows(year, quarter)
        if not rows:
            continue
        covered_until = max(covered_until, _quarter_end(year, quarter))
        for accession, (cik, series_id, name, filed) in rows.items():
            if cik not in wanted_ciks:
                continue
            _remember(seen, series_id, cik, name, accession, filed)

    if not use_index:
        return seen

    # The current quarter: filings the data set cannot describe yet.
    seen_accessions = {row.accession for row in seen.values()}
    pending: list[refresh.Filing] = []
    for day in sorted(days):
        if day <= covered_until:
            continue
        try:
            body = sec.fetch(refresh.index_url(day), max_age=sec.INDEX_MAX_AGE_S)
        except sec.SecError:
            continue  # a day with no index yet is data, not a failure
        for filing in refresh.nport_filings(refresh.parse_index(body.decode("latin-1"))):
            if cik_key(filing.cik) not in wanted_ciks or filing.accession in seen_accessions:
                continue
            seen_accessions.add(filing.accession)
            pending.append(filing)

    # Read the documents in parallel. Each is a small immutable file, and serial reads
    # are latency-bound at ~1.5 a second — measured 2026-11-11, against ~12 a second with
    # eight in flight — which is the difference between a four-minute catch-up and an
    # hour of one. `sec.fetch` is thread-safe by construction: one lock, one throttle.
    documents = 0
    if pending:
        with futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
            for filing, xml in zip(pending, pool.map(lambda item: _document(item), pending)):
                if xml is None:
                    continue
                series_id = nport.peek_series_id(xml)
                if not series_id:
                    continue
                documents += 1
                _remember(
                    seen,
                    series_id,
                    cik_key(filing.cik),
                    series_name(xml) or "",
                    filing.accession,
                    filing.filed,
                )
                if progress_every and documents % progress_every == 0:
                    print(f"  discovery: {documents} new filing(s), {len(seen)} series", flush=True)
    return seen


def _document(filing: refresh.Filing) -> bytes | None:
    """One N-PORT document, or ``None`` when EDGAR refuses it after its own retries."""
    try:
        return sec.fetch(sec.primary_doc_url(filing.cik, filing.accession))
    except sec.SecError:
        return None


def _remember(
    seen: dict[str, Discovered],
    series_id: str,
    cik: str,
    name: str,
    accession: str,
    filed: str,
) -> None:
    """Record a series, keeping the symbol work already done for it."""
    previous = seen.get(series_id)
    seen[series_id] = Discovered(
        series_id=series_id,
        cik=cik,
        name=name or (previous.name if previous else ""),
        accession=accession,
        filed_at=filed,
        symbol=previous.symbol if previous else None,
        symbol_source=previous.symbol_source if previous else None,
        symbol_note=previous.symbol_note if previous else None,
    )


def _text(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html)
    text = text.replace("&nbsp;", " ").replace("&#160;", " ").replace("&amp;", "&")
    text = text.replace("&ndash;", "–").replace("&mdash;", "—").replace("&rsquo;", "'")
    return re.sub(r"\s+", " ", text)


def symbol_from_cover(text: str, name: str) -> tuple[str | None, str]:
    """The ticker a registration statement's cover gives this fund, or a reason.

    Corroboration, not extraction: the fund's own N-PORT name has to appear in the
    document, and the symbol has to sit in an exchange line (or a ``Trading Symbol``
    field) within a short window of that name. A bare symbol anywhere in a 600 kB
    prospectus is not identity — the same rule the ledger's company matcher follows.
    """
    if not name:
        return None, "the filing names no series"
    position = text.lower().find(name.lower())
    if position < 0:
        return None, "the document does not name this series"
    window = text[max(0, position - _NAME_WINDOW) : position + len(name) + _NAME_WINDOW]
    for pattern in (_EXCHANGE_LINE, _TRADING_SYMBOL, _TICKER_FIELD):
        for match in pattern.finditer(window):
            candidate = match.group(1).strip().upper()
            if candidate in _NOT_SYMBOLS or not _SYMBOL.match(candidate):
                continue
            return candidate, "cover"
    return None, "no exchange line beside the fund's name"


def _is_prospectus(filename: str) -> bool:
    """Whether a filing's document is the prospectus rather than an exhibit beside it."""
    lowered = filename.lower()
    return any(marker in lowered for marker in ("497k", "485bpos", "497j", "_497"))


def resolve_symbol(
    series_id: str, cik: str, name: str, *, tries: int = 5
) -> tuple[str | None, str | None, str]:
    """Find a series' ticker in its own registration statement.

    Returns ``(symbol, source, note)``. The search is EDGAR's full-text index for the
    **series name**, restricted to the registrant, which lands on the 485BPOS/497K that
    names it; the newest such filing is read. ``tries`` bounds the documents opened,
    because a trust files many prospectuses and only some cover a given series.

    Searching the series *id* does not work, and that is worth recording: the id lives
    in a 485BPOS's XBRL context rather than its text, so a full-text query for
    ``S000102337`` returns the fund's N-PORT filings and never the prospectus that
    states its ticker. Measured 2026-11-11 on DRAM: 2 hits, both N-PORT.
    """
    if not name:
        return None, None, "the filing names no series"
    quoted = urllib.parse.quote(f'"{name}"')
    # Ask for the form that carries a cover, in the order that finds it fastest. The
    # unfiltered query is the fallback, and it is the one that needs care: it returns
    # exhibits and other funds' prospectuses, and its first page is ranked by relevance
    # rather than by date, so the summary prospectus that states the ticker can sit
    # outside the page entirely.
    hits: list[dict] = []
    for form in ("497K", "485BPOS", None):
        query = (
            "https://efts.sec.gov/LATEST/search-index?"
            f"q={quoted}&ciks={int(cik):010d}"
        )
        if form:
            query += f"&forms={form}"
        try:
            payload = sec.fetch_json(query, max_age=sec.INDEX_MAX_AGE_S)
        except sec.SecError as error:
            return None, None, f"full-text search failed: {error}"
        hits = ((payload.get("hits") or {}).get("hits") or [])
        if hits:
            break
    candidates: list[tuple[str, str, str]] = []
    for hit in hits:
        source = hit.get("_source") or {}
        if str(cik).lstrip("0") not in {str(value).lstrip("0") for value in source.get("ciks") or []}:
            continue
        accession, _, filename = str(hit.get("_id") or "").partition(":")
        if not accession or not filename:
            continue
        # The full-text index reports no form type unless the query filters by one, so
        # the document's own name is the filter: a prospectus is HTML, and the 8-A
        # certificate beside it is a PDF that carries no readable cover.
        if not filename.lower().endswith((".htm", ".html", ".txt")):
            continue
        candidates.append((str(source.get("file_date") or ""), accession, filename))
    if not candidates:
        return None, None, "no registration statement names this series"
    # A prospectus before an exhibit, then newest first: the cover that states the
    # exchange is in the 497K/485BPOS, while the exhibits filed beside it are risk
    # summaries that repeat the name without the exchange line.
    candidates.sort(
        key=lambda row: (_is_prospectus(row[2]), row[0]), reverse=True
    )
    for _filed, accession, filename in candidates[:tries]:
        url = (
            f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
            f"{accession.replace('-', '')}/{filename}"
        )
        try:
            body = sec.fetch(url)
        except sec.SecError:
            continue
        symbol, note = symbol_from_cover(_text(body.decode("utf-8", "replace")), name)
        if symbol:
            return symbol, f"cover:{accession}", note
    return None, None, "no corroborated exchange line in the registration statement"


def refresh_cache(
    *,
    universe_ciks: set[str],
    known_series: set[str] | None = None,
    days: int = DEFAULT_WINDOW_DAYS,
    today: date | None = None,
    root: Path | None = None,
    resolve: bool = True,
    resolve_limit: int = DEFAULT_RESOLVE_LIMIT,
    progress_every: int = 0,
    use_index: bool = False,
) -> dict[str, Discovered]:
    """Scan, resolve symbols for what is new, and write the cache.

    ``universe_ciks`` is the set of registrants the product already publishes — the
    scan is deliberately limited to them, because a series from a trust we do not
    cover is not a gap in this product, it is a different product.

    ``known_series`` is every series the ticker file and the overrides already name.
    The cache keeps **only the rest**: a copy of the whole universe would be 12,000
    entries of which 12,000 are already resolved, and — worse — the symbol resolver
    would then read a registration statement for every fund on the site. The cache is
    the gap, not the universe.
    """
    today = today or date.today()
    window = [today - timedelta(days=offset) for offset in range(days)]
    known = load(root)
    series = scan(
        window,
        universe_ciks,
        known=known,
        progress_every=progress_every,
        use_index=use_index,
    )
    if known_series is not None:
        series = {
            series_id: row
            for series_id, row in series.items()
            if series_id not in known_series
        }
    if resolve:
        # Newest registration first, and only so many per run. The gap is large — the
        # ticker file covers roughly four series in five, and one quarter's data set
        # leaves 1,172 series it does not name — and most of what it omits is
        # institutional paper with no exchange ticker at all, so resolving all of it
        # would spend hours a week to learn that. A series id is issued in registration
        # order, so the highest id is the newest fund: the one worth naming is at the
        # front of this queue, and the decades-old institutional tail waits.
        pending = sorted(
            (row for row in series.values() if not row.symbol and not row.symbol_note),
            key=lambda row: row.series_id,
            reverse=True,
        )[: max(0, resolve_limit)]
        for row in pending:
            series_id = row.series_id
            symbol, source, note = resolve_symbol(series_id, row.cik, row.name)
            series[series_id] = Discovered(
                series_id=row.series_id,
                cik=row.cik,
                name=row.name,
                accession=row.accession,
                filed_at=row.filed_at,
                symbol=symbol,
                symbol_source=source,
                symbol_note=note,
            )
    save(series, root)
    return series


def summary(series: Mapping[str, Discovered]) -> dict:
    """Counts for the build log: what was found, what could be named, what could not."""
    publishable = [row for row in series.values() if row.publishable]
    unnamed = [row for row in series.values() if not row.publishable]
    return {
        "series": len(series),
        "with_symbol": len(publishable),
        "without_symbol": len(unnamed),
        "unnamed": sorted(row.series_id for row in unnamed)[:20],
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Discover N-PORT series the SEC ticker file omits")
    parser.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS)
    parser.add_argument("--no-resolve", action="store_true", help="scan only; do not read covers")
    parser.add_argument(
        "--resolve-limit",
        type=int,
        default=DEFAULT_RESOLVE_LIMIT,
        help="how many series to try to name in this run (newest filing first)",
    )
    parser.add_argument(
        "--index",
        action="store_true",
        help="also read the current quarter from the daily index (slow: one document "
        "per filing, 30-60 min for a 40-day catch-up); off by default",
    )
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args(argv)

    from . import universe

    refs = universe.all_series()
    series = refresh_cache(
        universe_ciks={ref.cik for ref in refs},
        known_series={ref.series_id for ref in refs if ref.series_id},
        days=args.days,
        resolve=not args.no_resolve,
        resolve_limit=args.resolve_limit,
        progress_every=500,
        use_index=args.index,
    )
    result = summary(series)
    print(json.dumps(result, indent=1))
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
