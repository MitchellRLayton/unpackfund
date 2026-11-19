"""Funds that are registered and listed but have not filed their first N-PORT.

Why this exists: a fund's holdings reach this product through exactly one SEC form,
N-PORT, and a new fund does not file one for months. The report covers a fiscal
quarter and is due 60 days after it ends, so a fund that starts operating just after a
quarter closes publishes its first N-PORT about five months later. Measured 2026-11-19:
Corgi MANGOS ETF (MN, inception 2026-10-02) and Roundhill Magnificent Seven Plus ETF
(MAGP, listed 2026-11-12) were both live, both registered, both absent from the release
— not because anything failed but because no filing existed to read. A fund the product
cannot yet X-ray should still be *named*, with the reason, rather than 404.

What the SEC does publish on day one is the **prospectus**: a 485BPOS (the effective
registration statement) and the 497/497K that follow. Each filing's SGML header lists
the series and class it covers, so one 8 kB document per filing says which funds exist —
no 600 kB prospectus has to be opened to learn that. The header is served at
``…/<accession>-index-headers.html``.

What this module deliberately does **not** do:

* It never reports holdings, weights, a fee or a launch date. The only facts it
  publishes are ones a filing states: the series' name, its ticker, the date and
  accession of the prospectus that names it, and the registrant's fiscal year end.
* It never claims the fund is trading. A prospectus is effective before a fund lists,
  and the SEC publishes no "first trade" date; the page says "registered", and that is
  all the evidence supports. The reader is told the fund "may not have started trading".
* It never guesses a ticker. A symbol comes from the SEC fund ticker file or from a
  registration statement's own cover (``discovery.resolve_symbol``'s corroboration
  rule); a series with neither is recorded with the reason and not published.

A series is **pending** only when it has an effective prospectus in the window, a symbol,
and — checked against the registrant's own filings, the same test the build uses — no
N-PORT at all. A series that has one is the build's business, including the ones the
build then refuses (a leveraged fund, a NAV mismatch): calling those "pending" would
tell a reader a fund has never reported when it has.
"""

from __future__ import annotations

import calendar
import json
import re
import time
from concurrent import futures
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Mapping

from . import discovery, filings, refresh, sec, universe

#: Forms whose filing is an *effective* prospectus. 485APOS is a draft amendment and
#: 485BXT only extends a pending effective date, so neither says a fund exists to a
#: reader; 497J is a certification that adds nothing.
PROSPECTUS_FORMS = ("485BPOS", "497", "497K")

#: ``…/<accession>-index-headers.html``: the SGML header of one filing, ~8 kB.
HEADER_URL = (
    "https://www.sec.gov/Archives/edgar/data/{cik}/{nodash}/{accession}-index-headers.html"
)

#: How far back a scan looks. A fund can wait up to about five months for its first
#: N-PORT (launch just after a quarter end, plus 60 days), so a window shorter than that
#: would stop naming a fund while it is still pending. The per-accession cache means only
#: the first run pays for the whole window.
DEFAULT_WINDOW_DAYS = 150

#: How many headers a single run reads, newest first. Measured 2026-11-19: 13,320
#: prospectus filings in the last 150 days, so a cold run could not finish one sitting;
#: a new fund's prospectus is among the newest, and the cache makes every later run read
#: only the days since the last one.
DEFAULT_READ_LIMIT = 1500

#: The N-PORT filing deadline, in days after the end of the fiscal quarter it reports
#: (Investment Company Act Rule 30b1-9). It is the bound the window below is built from.
REPORT_DUE_DAYS = 60

#: Money-market funds report on N-MFP and never file N-PORT, so "waiting for its first
#: N-PORT" would be false for them. The name is the only signal on a prospectus header.
_MONEY_MARKET = re.compile(r"\bmoney[\s-]+market\b", re.IGNORECASE)

#: The release object, at the release root beside ``catalogue.json``.
PENDING_FILE = "pending.json"

CACHE_RELPATH = Path("pending") / "headers.json"
SYMBOLS_RELPATH = Path("pending") / "symbols.json"
CACHE_SCHEMA = 1

_FORM = re.compile(r"CONFORMED SUBMISSION TYPE:\s*(\S+)")
_FILED = re.compile(r"FILED AS OF DATE:\s*(\d{8})")
_FYE = re.compile(r"FISCAL YEAR END:\s*(\d{4})")
_REGISTRANT = re.compile(r"COMPANY CONFORMED NAME:\s*(.+)")
_SERIES = re.compile(r"<SERIES-ID>\s*(S\d{9})\s*\r?\n\s*<SERIES-NAME>\s*(.+?)\s*\r?\n")


@dataclass(frozen=True)
class Header:
    """What one prospectus filing's SGML header says."""

    accession: str
    cik: str
    form: str
    filed: str
    fiscal_year_end: str
    registrant: str
    series: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class PendingFund:
    """One fund the release can name but not yet X-ray."""

    series_id: str
    cik: str
    registrant: str
    name: str
    ticker: str
    symbol_source: str
    first_prospectus_filed: str
    latest_prospectus_form: str
    latest_prospectus_filed: str
    latest_prospectus_accession: str
    fiscal_year_end: str
    earliest_report_period_end: str
    earliest_report_due_by: str
    latest_report_due_by: str


# ---------------------------------------------------------------------------- parse


def parse_header(accession: str, cik: str, text: str) -> Header | None:
    """The facts a header states, or ``None`` when it is not a header we can read.

    The SGML sits twice in the page — as a comment and as escaped text — so every
    field is matched on whichever copy comes first. A header that names no series (a
    filing for the trust itself) is valid and carries an empty ``series``.
    """
    form = _FORM.search(text)
    filed = _FILED.search(text)
    if not form or not filed:
        return None
    fye = _FYE.search(text)
    registrant = _REGISTRANT.search(text)
    seen: dict[str, str] = {}
    for series_id, name in _SERIES.findall(text):
        seen.setdefault(series_id, name.strip())
    return Header(
        accession=accession,
        cik=discovery.cik_key(cik),
        form=form.group(1),
        filed=_iso(filed.group(1)),
        fiscal_year_end=fye.group(1) if fye else "",
        registrant=(registrant.group(1).strip() if registrant else ""),
        series=tuple(sorted(seen.items())),
    )


def _iso(compact: str) -> str:
    return f"{compact[:4]}-{compact[4:6]}-{compact[6:8]}"


def header_url(cik: str | int, accession: str) -> str:
    return HEADER_URL.format(
        cik=int(cik), nodash=accession.replace("-", ""), accession=accession
    )


# ------------------------------------------------------------------- the schedule


def _month_end(year: int, month: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


def quarter_ends_after(effective: date, fiscal_year_end: str, count: int = 2) -> list[date]:
    """The first ``count`` fiscal-quarter ends strictly after ``effective``.

    A fiscal year ending ``MMDD`` puts quarter ends at that month plus three, six and
    nine months. An unreadable or missing ``fiscal_year_end`` is read as December, which
    is what 12-31 filers — nearly every ETF trust — report.
    """
    try:
        anchor = int(fiscal_year_end[:2])
    except (ValueError, TypeError):
        anchor = 12
    if not 1 <= anchor <= 12:
        anchor = 12
    months = sorted({((anchor - 1 + 3 * step) % 12) + 1 for step in range(4)})
    ends: list[date] = []
    for year in (effective.year, effective.year + 1, effective.year + 2):
        for month in months:
            end = _month_end(year, month)
            if end > effective:
                ends.append(end)
    return sorted(ends)[:count]


def report_window(effective: str, fiscal_year_end: str) -> tuple[str, str, str]:
    """``(earliest period end, earliest due date, latest due date)`` for a first N-PORT.

    The first report covers the first fiscal quarter-end *after the fund starts
    operating* and is due 60 days after it. The SEC publishes no start date, so the
    effective date of the prospectus bounds it from below and the following quarter from
    above: a fund effective just before a quarter end may not have started operating
    until after it. Both bounds are published; neither is called "the" date.
    """
    first, second = quarter_ends_after(date.fromisoformat(effective), fiscal_year_end, 2)
    return (
        first.isoformat(),
        (first + timedelta(days=REPORT_DUE_DAYS)).isoformat(),
        (second + timedelta(days=REPORT_DUE_DAYS)).isoformat(),
    )


# ------------------------------------------------------------------------- caches


def _cache_file(relpath: Path, root: Path | None) -> Path:
    return (root or sec.CACHE_DIR) / relpath


def load_headers(root: Path | None = None) -> dict[str, Header]:
    path = _cache_file(CACHE_RELPATH, root)
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return {}
    if payload.get("schema_version") != CACHE_SCHEMA:
        return {}
    out: dict[str, Header] = {}
    for accession, row in (payload.get("headers") or {}).items():
        try:
            out[accession] = Header(
                accession=accession,
                cik=row["cik"],
                form=row["form"],
                filed=row["filed"],
                fiscal_year_end=row["fiscal_year_end"],
                registrant=row["registrant"],
                series=tuple((a, b) for a, b in row["series"]),
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


def save_headers(headers: Mapping[str, Header], root: Path | None = None) -> Path:
    path = _cache_file(CACHE_RELPATH, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "kind": "prospectus_headers",
        "schema_version": CACHE_SCHEMA,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "headers": {
            key: {k: v for k, v in asdict(value).items() if k != "accession"}
            for key, value in sorted(headers.items())
        },
    }
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    return path


def _load_symbols(root: Path | None) -> dict[str, dict]:
    path = _cache_file(SYMBOLS_RELPATH, root)
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except ValueError:
        return {}


def _save_symbols(table: Mapping[str, dict], root: Path | None) -> None:
    path = _cache_file(SYMBOLS_RELPATH, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(table, sort_keys=True) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------- scan


def prospectus_filings(days: Iterable[date]) -> list[refresh.Filing]:
    """Effective-prospectus filings made on ``days``, newest first.

    Read from the quarterly index (one file per calendar quarter, covering every
    filing in it), not 150 daily ones — the same rows at a tenth of the bytes, which is
    what ``discovery`` does for the same reason.
    """
    wanted = {day.isoformat() for day in days}
    quarters = sorted({((day.year, (day.month - 1) // 3 + 1)) for day in days})
    rows: list[refresh.Filing] = []
    for year, quarter in quarters:
        try:
            body = sec.fetch(
                discovery.QUARTER_INDEX.format(year=year, quarter=quarter),
                max_age=sec.INDEX_MAX_AGE_S,
            )
        except sec.SecError:
            continue
        for filing in refresh.parse_index(body.decode("latin-1")):
            if filing.form in PROSPECTUS_FORMS and filing.filed in wanted:
                rows.append(filing)
    rows.sort(key=lambda row: (row.filed, row.accession), reverse=True)
    return rows


def read_headers(
    filings_to_read: list[refresh.Filing],
    *,
    known: Mapping[str, Header] | None = None,
    read_limit: int = DEFAULT_READ_LIMIT,
    max_workers: int = 8,
) -> dict[str, Header]:
    """Headers for ``filings_to_read``, reading at most ``read_limit`` that are new.

    Newest first, so a cold run covers the days a new fund's prospectus is in and a
    warm one reads only what was filed since. An accession is immutable, so a header
    read once is never read again. A filing whose header EDGAR refuses is skipped and
    left for the next run: it is not recorded as empty, because an empty record would
    hide a series for the length of the window.
    """
    seen: dict[str, Header] = dict(known or {})
    todo = [row for row in filings_to_read if row.accession not in seen][: max(0, read_limit)]
    if not todo:
        return seen

    def one(row: refresh.Filing) -> Header | None:
        try:
            body = sec.fetch(header_url(row.cik, row.accession))
        except sec.SecError:
            return None
        return parse_header(row.accession, row.cik, body.decode("utf-8", "replace"))

    with futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        for row, header in zip(todo, pool.map(one, todo)):
            if header is not None:
                seen[row.accession] = header
    return seen


# --------------------------------------------------------------------------- decide


def is_money_market(name: str) -> bool:
    return bool(_MONEY_MARKET.search(name))


def candidate_series(
    headers: Iterable[Header],
    *,
    window_start: str,
) -> dict[str, list[Header]]:
    """``series_id → headers`` (oldest first) for effective prospectuses since ``window_start``."""
    grouped: dict[str, list[Header]] = {}
    for header in headers:
        if header.form not in PROSPECTUS_FORMS or header.filed < window_start:
            continue
        for series_id, _name in header.series:
            grouped.setdefault(series_id, []).append(header)
    for rows in grouped.values():
        rows.sort(key=lambda row: (row.filed, row.accession))
    return grouped


def build_pending(
    candidates: Mapping[str, list[Header]],
    *,
    has_nport: Mapping[str, bool],
    symbols: Mapping[str, tuple[str | None, str]],
) -> tuple[list[PendingFund], dict[str, list[str]]]:
    """Decide which candidates are pending funds, and say why each other one is not.

    ``has_nport`` is the authoritative test (the registrant's own filings, as the build
    reads them); ``symbols`` maps a series to ``(ticker, source-or-reason)``. Both are
    arguments so this function stays pure and a test states the facts it relies on.
    """
    pending: list[PendingFund] = []
    skipped: dict[str, list[str]] = {"has_nport": [], "money_market": [], "no_symbol": []}
    for series_id in sorted(candidates):
        rows = candidates[series_id]
        newest = rows[-1]
        name = dict(newest.series).get(series_id, "")
        if has_nport.get(series_id, False):
            skipped["has_nport"].append(series_id)
            continue
        if is_money_market(name):
            skipped["money_market"].append(series_id)
            continue
        ticker, source = symbols.get(series_id, (None, "not resolved"))
        if not ticker:
            skipped["no_symbol"].append(series_id)
            continue
        earliest_end, earliest_due, latest_due = report_window(
            rows[0].filed, newest.fiscal_year_end
        )
        pending.append(
            PendingFund(
                series_id=series_id,
                cik=newest.cik,
                registrant=newest.registrant,
                name=name,
                ticker=ticker,
                symbol_source=source,
                first_prospectus_filed=rows[0].filed,
                latest_prospectus_form=newest.form,
                latest_prospectus_filed=newest.filed,
                latest_prospectus_accession=newest.accession,
                fiscal_year_end=newest.fiscal_year_end,
                earliest_report_period_end=earliest_end,
                earliest_report_due_by=earliest_due,
                latest_report_due_by=latest_due,
            )
        )
    return pending, skipped


# ------------------------------------------------------------------------ the run


def _symbol_for(
    series_id: str,
    cik: str,
    name: str,
    *,
    refs: Mapping[str, universe.FundRef],
    cache: dict[str, dict],
    resolve_budget: list[int],
) -> tuple[str | None, str]:
    """A series' ticker from the SEC fund ticker file, else its own cover."""
    ref = refs.get(series_id)
    if ref is not None:
        return ref.ticker, f"sec_ticker_file:{ref.resolved_by}"
    remembered = cache.get(series_id)
    if remembered is not None:
        return remembered.get("symbol"), remembered.get("source") or remembered.get("note") or ""
    if resolve_budget[0] <= 0:
        return None, "resolution budget spent; retried next run"
    resolve_budget[0] -= 1
    symbol, source, note = discovery.resolve_symbol(series_id, cik, name)
    # Only a success is remembered. A failure is retried on the next run, bounded by
    # ``resolve_limit``: a fund this scan names is days old, and a cover the reader did not
    # understand yesterday may be one a fixed rule reads today (MAGP stayed unnamed for a
    # week behind a remembered failure until the cover rule learned its shape).
    if symbol:
        cache[series_id] = {"symbol": symbol, "source": source, "note": note}
    return symbol, source or note


def run(
    *,
    days: int = DEFAULT_WINDOW_DAYS,
    today: date | None = None,
    read_limit: int = DEFAULT_READ_LIMIT,
    resolve_limit: int = 100,
    root: Path | None = None,
    nport_known: set[str] | None = None,
    nport_absent: set[str] | None = None,
    only_series: set[str] | None = None,
) -> tuple[list[PendingFund], dict]:
    """Scan the window, decide, and return ``(pending funds, report)``.

    ``nport_known`` is the set of series already known to have an N-PORT (the build's
    published series and the discovery cache) and ``nport_absent`` the set already known
    to have none (the funds the build attempted and could not find one for). Neither costs
    a lookup. Every other candidate — a series the build never saw, like a fund the SEC
    ticker file does not list yet — is checked against its registrant's filings, which
    is the test the build itself applies. That test is the expensive one: proving an
    absence walks a registrant's N-PORT filings, so it is spent only where nothing else
    already answers.
    """
    today = today or date.today()
    window = [today - timedelta(days=offset) for offset in range(1, days + 1)]
    window_start = window[-1].isoformat()

    filings_in_window = prospectus_filings(window)
    known_headers = load_headers(root)
    headers = read_headers(filings_in_window, known=known_headers, read_limit=read_limit)
    save_headers(headers, root)

    by_series = candidate_series(headers.values(), window_start=window_start)
    if only_series is not None:  # a diagnostic: decide these series and no others
        by_series = {sid: rows for sid, rows in by_series.items() if sid in only_series}
    skip_known = set(nport_known or ())
    skip_absent = set(nport_absent or ()) - skip_known
    survivors = {sid: rows for sid, rows in by_series.items() if sid not in skip_known}

    discovered = discovery.load(root)
    refs = {
        ref.series_id: ref
        for ref in universe.all_series(discovered)
        if ref.series_id
    }

    # The authoritative test, per registrant, once: index the registrant's N-PORT filings
    # and ask whether the series is among them. Money-market funds are excluded first —
    # they would fail the test for the wrong reason and cost a registrant walk each.
    probe: dict[str, universe.FundRef] = {}
    for series_id, rows in survivors.items():
        newest = rows[-1]
        name = dict(newest.series).get(series_id, "")
        if is_money_market(name) or series_id in skip_absent:
            continue
        probe[series_id] = universe.FundRef(
            ticker=series_id, cik=f"{int(newest.cik):010d}", series_id=series_id,
            resolved_by="pending",
        )
    filings.prefetch(probe.values(), workers=8)
    has_nport = {
        series_id: filings.has_nport(ref.cik, series_id) for series_id, ref in probe.items()
    }
    for series_id in skip_known & set(by_series):
        has_nport[series_id] = True
    for series_id in skip_absent & set(survivors):
        has_nport[series_id] = False

    symbol_cache = _load_symbols(root)
    budget = [max(0, resolve_limit)]
    symbols: dict[str, tuple[str | None, str]] = {}
    for series_id, rows in survivors.items():
        if has_nport.get(series_id, False) or (
            series_id not in probe and series_id not in skip_absent
        ):
            continue
        newest = rows[-1]
        symbols[series_id] = _symbol_for(
            series_id,
            newest.cik,
            dict(newest.series).get(series_id, ""),
            refs=refs,
            cache=symbol_cache,
            resolve_budget=budget,
        )
    _save_symbols(symbol_cache, root)

    pending, skipped = build_pending(survivors | {sid: by_series[sid] for sid in skip_known & set(by_series)},
                                     has_nport=has_nport, symbols=symbols)
    report = {
        "window_days": days,
        "prospectus_filings_in_window": len(filings_in_window),
        "headers_cached": len(headers),
        "headers_unread": len([f for f in filings_in_window if f.accession not in headers]),
        "candidate_series": len(by_series),
        "pending": len(pending),
        "skipped": {key: len(value) for key, value in skipped.items()},
        "no_symbol_series": sorted(skipped["no_symbol"])[:20],
    }
    return pending, report


def document(pending: list[PendingFund], *, as_of: str, report: Mapping | None = None) -> dict:
    """The release object: ``pending.json``, keyed by ticker, deterministic."""
    funds: dict[str, dict] = {}
    for fund in sorted(pending, key=lambda row: (row.ticker, row.series_id)):
        funds.setdefault(
            fund.ticker,
            {
                "series_id": fund.series_id,
                "name": fund.name,
                "registrant": fund.registrant,
                "symbol_source": fund.symbol_source,
                "first_prospectus_filed": fund.first_prospectus_filed,
                "latest_prospectus": {
                    "form": fund.latest_prospectus_form,
                    "filed_at": fund.latest_prospectus_filed,
                    "accession": fund.latest_prospectus_accession,
                    "source_url": sec.filing_dir_url(fund.cik, fund.latest_prospectus_accession),
                },
                "fiscal_year_end": fund.fiscal_year_end,
                "first_report": {
                    "earliest_period_end": fund.earliest_report_period_end,
                    "earliest_due_by": fund.earliest_report_due_by,
                    "latest_due_by": fund.latest_report_due_by,
                },
            },
        )
    return {
        "schema_version": 1,
        "kind": "pending_funds",
        "as_of": as_of,
        "source": "SEC EDGAR prospectus filings (485BPOS, 497, 497K)",
        "rule": (
            "A series with an effective prospectus in the window, a symbol from the SEC "
            "fund ticker file or its own cover, and no N-PORT filing at all. Holdings "
            "are not published: none has been filed."
        ),
        "counts": {"funds": len(funds), **({"window_days": report["window_days"]} if report else {})},
        "funds": funds,
    }


def write(body: Mapping, release_dir: Path) -> tuple[Path, bytes]:
    """Write ``pending.json`` into a release and return its path and bytes.

    Compact and key-sorted, so two builds of the same scan hash identically. Like the
    size table it is a build-time object: the page generator reads it and no browser
    path does, so the descriptor does not list it (see ``data-contract-and-release``).
    """
    target = Path(release_dir) / PENDING_FILE
    payload = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    target.write_bytes(payload)
    return target, payload


#: The release object is a handful of rows, so a file this large is a defect, not growth.
MAX_PENDING_BYTES = 500_000

#: Keys a pending row must not carry: each is a fact no prospectus header states, and a
#: page reading one would be printing something this module never established.
FORBIDDEN_KEYS = frozenset(
    {"holdings", "weight_bp", "coverage_pct", "metrics", "expense_ratio", "net_assets",
     "launch", "launch_date", "inception", "inception_date", "trading", "aum"}
)

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SERIES_ID = re.compile(r"^S\d{9}$")
_ROW_KEYS = {
    "series_id", "name", "registrant", "symbol_source", "first_prospectus_filed",
    "latest_prospectus", "fiscal_year_end", "first_report",
}


def validate_document(
    body: object, *, as_of: str, published: Iterable[str], size: int
) -> list[str]:
    """Every reason ``pending.json`` may not ship; an empty list means it may.

    Pure, so the release validator and the tests state the same rules. The object is
    additive, so *absence* is valid and never reaches here; what is checked is that a
    present file cannot say more than the filings do, cannot shadow a published fund, and
    recomputes its own count.
    """
    problems: list[str] = []
    if size > MAX_PENDING_BYTES:
        problems.append(f"{size:,} B is over the {MAX_PENDING_BYTES:,} B ceiling")
    if not isinstance(body, dict):
        return problems + ["not a JSON object"]
    if body.get("kind") != "pending_funds":
        problems.append(f"kind is {body.get('kind')!r}")
    if body.get("schema_version") != 1:
        problems.append(f"schema_version is {body.get('schema_version')!r}")
    if body.get("as_of") != as_of:
        problems.append(f"as_of {body.get('as_of')!r} != release as_of {as_of!r}")
    funds = body.get("funds")
    if not isinstance(funds, dict):
        return problems + ["funds is not an object"]
    counts = body.get("counts") or {}
    if counts.get("funds") != len(funds):
        problems.append(f"counts.funds {counts.get('funds')!r} != {len(funds)} rows")
    taken = set(published)
    series_seen: dict[str, str] = {}
    for ticker, row in funds.items():
        where = f"{ticker}"
        if not isinstance(row, dict):
            problems.append(f"{where}: row is not an object")
            continue
        if ticker in taken:
            problems.append(f"{where}: is a published fund, so it cannot also be pending")
        banned = sorted(FORBIDDEN_KEYS & set(row))
        if banned:
            problems.append(f"{where}: carries {banned}, which no prospectus header states")
        extra = sorted(set(row) - _ROW_KEYS)
        missing = sorted(_ROW_KEYS - set(row))
        if extra or missing:
            problems.append(f"{where}: keys differ from the contract (extra {extra}, missing {missing})")
            continue
        if not _SERIES_ID.match(str(row["series_id"])):
            problems.append(f"{where}: series_id {row['series_id']!r}")
        if row["series_id"] in series_seen:
            problems.append(f"{where}: series {row['series_id']} is also {series_seen[row['series_id']]}")
        series_seen[row["series_id"]] = ticker
        prospectus = row["latest_prospectus"]
        window = row["first_report"]
        dates = [
            row["first_prospectus_filed"], prospectus.get("filed_at"),
            window.get("earliest_period_end"), window.get("earliest_due_by"),
            window.get("latest_due_by"),
        ]
        if not all(isinstance(value, str) and _ISO.match(value) for value in dates):
            problems.append(f"{where}: a date is not YYYY-MM-DD")
            continue
        if prospectus.get("form") not in PROSPECTUS_FORMS:
            problems.append(f"{where}: prospectus form {prospectus.get('form')!r}")
        if not str(prospectus.get("source_url", "")).startswith("https://www.sec.gov/"):
            problems.append(f"{where}: source_url is not an sec.gov URL")
        if row["first_prospectus_filed"] > prospectus["filed_at"]:
            problems.append(f"{where}: first prospectus is after the newest")
        if not window["earliest_due_by"] <= window["latest_due_by"]:
            problems.append(f"{where}: the report window runs backwards")
    return problems


def known_nport_series(
    published: Iterable[str],
    refs: Iterable[universe.FundRef],
    failures: Iterable[Mapping[str, str]],
    discovered: Iterable[str] = (),
) -> set[str]:
    """Series the build already knows have an N-PORT, so ``run`` skips their lookup.

    Published funds, discovered series (found *in* an N-PORT), and every fund the build
    attempted whose failure was anything but "no N-PORT filing" — a leveraged fund or a
    NAV mismatch has filed, so it is not pending.
    """
    series_of = {ref.ticker: ref.series_id for ref in refs if ref.series_id}
    known = set(published) | set(discovered)
    for row in failures:
        if "has no N-PORT filing" in (row.get("error") or ""):
            continue
        series = series_of.get(row.get("ticker", ""))
        if series:
            known.add(series)
    return known


def absent_nport_series(
    refs: Iterable[universe.FundRef], failures: Iterable[Mapping[str, str]]
) -> set[str]:
    """Series the build attempted and found no N-PORT for — ``run``'s ``nport_absent``."""
    series_of = {ref.ticker: ref.series_id for ref in refs if ref.series_id}
    return {
        series_of[row["ticker"]]
        for row in failures
        if "has no N-PORT filing" in (row.get("error") or "") and row.get("ticker") in series_of
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Find funds registered but not yet reporting")
    parser.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS)
    parser.add_argument("--read-limit", type=int, default=DEFAULT_READ_LIMIT)
    parser.add_argument("--resolve-limit", type=int, default=100)
    parser.add_argument(
        "--series",
        nargs="+",
        default=None,
        metavar="S000000000",
        help="decide only these series (a diagnostic: checks one fund end to end)",
    )
    parser.add_argument("--as-of", default=date.today().isoformat())
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args(argv)

    started = datetime.now()
    pending, report = run(
        days=args.days,
        read_limit=args.read_limit,
        resolve_limit=args.resolve_limit,
        only_series=set(args.series) if args.series else None,
    )
    report["seconds"] = round((datetime.now() - started).total_seconds(), 1)
    print(json.dumps(report, indent=1))
    body = document(pending, as_of=args.as_of, report=report)
    for ticker, row in list(body["funds"].items())[:40]:
        print(f"  {ticker:8} {row['series_id']}  {row['name']}  (prospectus {row['latest_prospectus']['filed_at']})")
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(body, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
