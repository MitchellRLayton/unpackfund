"""Ticker → registrant CIK → N-PORT series.

Resolution is two-step and deliberately dumb, because every clever version of it
has been wrong:

1. ``company_tickers_mf.json`` — the SEC's own fund ticker file, which maps a
   trading symbol to ``(cik, seriesId, classId)``. It covers ~78% of N-PORT
   series (measured 2026-10-28); it is a *resolution* input, never a universe.
2. ``pipeline/overrides/tickers.csv`` — reviewed rows for what the file misses,
   chiefly unit investment trusts (SPY) that file N-PORT with no series id at
   all. Overrides are code-adjacent, versioned and tested (conventions I5), and
   each row's ``registrant`` is checked against EDGAR's own entity name so a typo
   in a CIK fails the build rather than mapping a symbol to the wrong trust.

A ticker that resolves through neither is an error, not a guess.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Mapping

from . import sec

if TYPE_CHECKING:  # pragma: no cover - import cycle at runtime, types only
    from .discovery import Discovered

MF_TICKERS_URL = "https://www.sec.gov/files/company_tickers_mf.json"
OVERRIDES = Path(__file__).resolve().parent.parent / "overrides" / "tickers.csv"


@dataclass(frozen=True)
class FundRef:
    ticker: str
    cik: str
    series_id: str | None
    resolved_by: str
    expected_registrant: str | None = None
    #: Every ticker the fund's own series reports, primary symbol included. A
    #: series is a portfolio; its symbols are its share classes, and a person
    #: holds a class, not a portfolio. The release publishes one symbol per
    #: series (a file per ticker), so the rest are published as aliases — the
    #: difference between reaching 8,531 of the SEC's 28,613 fund tickers and
    #: reaching most of them.
    symbols: tuple[str, ...] = ()

    @property
    def fund_id(self) -> str:
        """Stable key for the artifact: the series, else ``CIK…`` when there is none."""
        return self.series_id or f"CIK{int(self.cik):010d}"


@lru_cache(maxsize=1)
def _mf_map() -> dict[str, tuple[str, str, str]]:
    """symbol → (cik, seriesId, classId) from the SEC fund ticker file.

    Cached for the life of the process: a universe run resolves thousands of
    symbols, and re-parsing this 2 MB document per call dominated the first
    widened run. ``_clear_caches`` exists for tests and for an in-process reload.
    """
    document = sec.fetch_json(MF_TICKERS_URL, max_age=sec.INDEX_MAX_AGE_S)
    fields = document["fields"]
    index = {name: position for position, name in enumerate(fields)}
    out: dict[str, tuple[str, str, str]] = {}
    for row in document["data"]:
        symbol = str(row[index["symbol"]]).strip().upper()
        if not symbol:
            continue
        out[symbol] = (
            f"{int(row[index['cik']]):010d}",
            str(row[index["seriesId"]]).strip(),
            str(row[index["classId"]]).strip(),
        )
    return out


@lru_cache(maxsize=1)
def _series_symbols() -> dict[str, tuple[str, ...]]:
    """seriesId → every symbol the fund ticker file reports for that series.

    A series is a portfolio and its symbols are its share classes, so this is what
    turns "resolve one ticker" into a complete alias set. Without it a build from an
    explicit ticker list publishes no ``aliases.json`` at all — 13,118 share-class
    symbols silently absent, and a visitor typing one gets "not a fund we publish"
    for a fund that is on the site. The alias set belongs to the series, not to how
    the series was selected.
    """
    grouped: dict[str, list[str]] = {}
    for symbol, (_cik, series, _class_id) in _mf_map().items():
        if series:
            grouped.setdefault(series, []).append(symbol)
    return {series: tuple(sorted(set(symbols))) for series, symbols in grouped.items()}


@lru_cache(maxsize=1)
def _overrides() -> dict[str, tuple[str, str | None, str | None]]:
    """ticker → (cik, series_id, registrant). ``#`` comment lines are skipped."""
    if not OVERRIDES.exists():
        return {}
    raw = OVERRIDES.read_text()
    body = "\n".join(
        line for line in raw.splitlines() if not line.lstrip().startswith("#")
    )
    out: dict[str, tuple[str, str | None, str | None]] = {}
    for row in csv.DictReader(io.StringIO(body)):
        ticker = (row.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        series = (row.get("series_id") or "").strip() or None
        registrant = (row.get("registrant") or "").strip() or None
        out[ticker] = (f"{int(row['cik']):010d}", series, registrant)
    return out


def resolve(ticker: str) -> FundRef:
    symbol = ticker.strip().upper()
    overrides = _overrides()
    if symbol in overrides:
        cik, series, registrant = overrides[symbol]
        if registrant:
            name = str(
                sec.fetch_json(
                    sec.submissions_url(cik), max_age=sec.INDEX_MAX_AGE_S
                ).get("name")
                or ""
            )
            if name.strip().upper() != registrant.strip().upper():
                raise LookupError(
                    f"{symbol}: override registrant {registrant!r} does not match "
                    f"EDGAR CIK {cik} ({name!r}) — fix the override, do not guess"
                )
        return FundRef(symbol, cik, series, "override", registrant)

    mf = _mf_map()
    for candidate in (symbol, f"{symbol}.X"):  # the mf file suffixes some lines
        if candidate in mf:
            cik, series, _class_id = mf[candidate]
            return FundRef(
                symbol,
                cik,
                series,
                "company_tickers_mf",
                symbols=_series_symbols().get(series, ()) if series else (),
            )

    raise LookupError(
        f"{symbol}: not in company_tickers_mf.json and no override row — add "
        f"pipeline/overrides/tickers.csv (cik, series_id, registrant) rather than guessing"
    )


def _clear_caches() -> None:
    """Drop the parsed SEC maps. For tests and for a long-lived process."""
    _mf_map.cache_clear()
    _series_symbols.cache_clear()
    _overrides.cache_clear()


#: The artifact contract's ticker shape (also the app's filename regex). Five
#: rows in the SEC fund file do not match it — four parenthesised symbols and one
#: literal ``N/A`` — so they are cleaned or skipped rather than written as a file
#: name the browser cannot request.
SYMBOL_PATTERN = re.compile(r"[A-Z0-9.\-]{1,10}")


def clean_symbol(symbol: str) -> str | None:
    """A contract-shaped ticker, or ``None`` when the row carries no usable one."""
    candidate = symbol.strip().upper().strip("()").strip()
    return candidate if SYMBOL_PATTERN.fullmatch(candidate) else None


def _primary_symbol(symbols: list[str]) -> str | None:
    """The one ticker a series is shown as.

    A series (``S000002839``) can carry four share classes — VOO, VFIAX, VFINX,
    VFFSX — and the artifact is per series, so exactly one has to be the name of
    the row. Shortest wins, then alphabetical: the exchange-traded class is
    almost always the shortest symbol, and where it is not, the rule is at least
    deterministic and visible rather than "whichever row the file listed first".
    Aliases are not a gap any more: ``resolve`` now carries the series' full symbol
    list, so a build from an explicit ticker list publishes the same alias set as a
    full universe walk.
    """
    usable = {cleaned for symbol in symbols if (cleaned := clean_symbol(symbol))}
    if not usable:
        return None
    return sorted(usable, key=lambda symbol: (len(symbol), symbol))[0]


def all_series(discovered: Mapping[str, "Discovered"] | None = None) -> list[FundRef]:
    """Every N-PORT series the free SEC files can name, one ``FundRef`` each.

    This is the universe a widened run walks: the fund ticker file's distinct
    ``(cik, seriesId)`` pairs, the reviewed override rows (chiefly unit investment
    trusts, which file with no series id), and — since 2026-11-11 — the series
    ``discovery`` found in the registrants' own N-PORT filings. Dedupe is by
    ``fund_id``, so a registrant with fifty share classes resolves to one row per
    series, and the choice of display ticker is ``_primary_symbol``'s.

    ``discovered`` is passed in rather than read from disk so this function stays
    pure: the cache is the caller's business (``build`` loads it, tests pass a
    literal), and a test that forgot to pass one cannot silently depend on whatever
    the machine happened to scan last.

    Why the third source exists: the ticker file is **incomplete**, not stale — on
    2026-11-11 it carried 12,306 series and still had no row for Roundhill Memory
    ETF, which had been filing N-PORT for two quarters. A fund the file omits was
    never fetched and 404'd with no record that it existed. The file is a
    *resolution* input; the filings are the universe.
    """
    grouped: dict[str, dict[str, object]] = {}
    for symbol, (cik, series, _class_id) in _mf_map().items():
        fund_id = series or f"CIK{int(cik):010d}"
        entry = grouped.setdefault(
            fund_id, {"cik": cik, "series": series, "symbols": [], "source": "company_tickers_mf"}
        )
        entry["symbols"].append(symbol)  # type: ignore[union-attr]
    for symbol, (cik, series, registrant) in _overrides().items():
        fund_id = series or f"CIK{int(cik):010d}"
        entry = grouped.setdefault(
            fund_id, {"cik": cik, "series": series, "symbols": [], "source": "override"}
        )
        entry["symbols"].append(symbol)  # type: ignore[union-attr]
        entry["registrant"] = registrant

    for series_id, row in (discovered or {}).items():
        if not getattr(row, "symbol", None) or series_id in grouped:
            continue
        grouped[series_id] = {
            "cik": row.cik,
            "series": series_id,
            "symbols": [row.symbol],
            "source": "discovery",
        }

    refs: list[FundRef] = []
    unnamed = 0
    for fund_id, entry in grouped.items():
        symbols = entry["symbols"]  # type: ignore[assignment]
        ticker = _primary_symbol(list(symbols))  # type: ignore[arg-type]
        if ticker is None:
            unnamed += 1
            continue
        refs.append(
            FundRef(
                ticker=ticker,
                cik=str(entry["cik"]),
                series_id=entry["series"] or None,  # type: ignore[arg-type]
                resolved_by=str(entry["source"]),
                symbols=tuple(sorted(symbols)),
            )
        )
    # One artifact per file name: two series claiming the same ticker would write
    # the same path, so the first (already sorted deterministically) wins and the
    # collision is counted rather than silently overwriting.
    unique: dict[str, FundRef] = {}
    for ref in sorted(refs, key=lambda item: (item.ticker, item.cik, item.series_id or "")):
        unique.setdefault(ref.ticker, ref)
    collisions = len(refs) - len(unique)
    if unnamed or collisions:
        print(
            f"universe: {len(unique)} series with a usable ticker "
            f"({unnamed} unnamed, {collisions} duplicate symbols skipped)",
            flush=True,
        )
    return sorted(unique.values(), key=lambda ref: ref.ticker)


#: Alias the build CLI uses: ``--universe all``.
UNIVERSE_ALL = "all"
