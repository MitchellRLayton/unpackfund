"""The typed-symbol identity object: an SEC symbol → the ``company_id`` funds use.

A visitor may type a stock ticker, not only a fund ticker. The ledger merges by
``company_id``, so the only thing a typed symbol has to produce is the id the
published fund rows already carry — and it can, without a join: EDGAR's symbol
file gives the CIK, and ``c_`` + zero-padded CIK is the published key
(``companies.company_id``). Measured on 2026-11-01: ``AMZN`` resolved this way is
the same string as VT's Amazon holding, ``companies/index.json`` and EDGAR.

What this module decides, and what it refuses to decide
------------------------------------------------------

The file has **four** fields — ``cik``, ``name``, ``ticker``, ``exchange`` — and
**no instrument-type field**. A symbol alone therefore cannot tell you whether it
is common stock, a preferred series, a warrant, a unit or a note. The rule that
follows is the math skill's own (§3a): a heuristic may **refuse**, never **accept**.

So classification here is *conservative and measured*, not clever:

- ``fund``      the symbol is a published fund ticker or share-class alias. The
                fund path wins; the stock path is refused. Measured: 2 symbols
                (``SPY``, ``SPCX``) out of 10,423.
- ``pfd``       a ``-P…`` suffix (``WFC-PZ``, ``BAC-PB``, ``ETI-P``). Measured:
                377 symbols, and the file's own names for them are the issuer's,
                so nothing else distinguishes them.
- ``wnt``/``unit``/``rgt``  five characters ending ``W``/``U``/``R`` **whose
                first four characters are also a symbol** (``TACHW``→``TACH``,
                ``HACQU``→``HACQ``, ``CORZR``→``CORZ``). Measured: 348 / 241 / 99
                symbols. Requiring the base symbol is what keeps this from
                eating ordinary five-letter tickers.
- ``twin``      the same company is also published in the ``l_`` namespace — 18
                companies today (Sumitomo Electric is 1 fund under ``c_`` and 227
                under ``l_``). Accepting both spellings would list one company
                twice, which is the "two Amazon lines" failure the ledger exists
                to avoid. Computed against the release's own company index.
- ``ok``        everything else: common stock and ADRs. An ADR is the same issuer
                as its ordinary shares, so its ``c_`` id is correct; the twin
                check above is what catches the cases where funds report the
                foreign listing instead.

**Known limit, stated rather than hidden:** an exchange-traded *note* (``FNGU`` is
Bank of Montreal's, filed as FWP) is a debt obligation that this file reports
exactly like a listed share of its issuer, with no field to distinguish it. It is
accepted as ``ok`` and the confirmation step shows the issuer's own name, which is
the only signal available. Naming a limit in the object beats an unmaintainable
denylist of ETN issuers.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

from . import sec
from .catalogue import SHARD_OTHER, encode, object_entry, shard_for
from .companies import company_id, normalize_name

SECURITIES_URL = "https://www.sec.gov/files/company_tickers_exchange.json"

#: Accepted: common stock or an ADR of an operating company.
STATUS_OK = "ok"
#: Refused, with the reason the UI names. Short because it ships on every row.
STATUS_FUND = "fund"
STATUS_PREFERRED = "pfd"
STATUS_WARRANT = "wnt"
STATUS_UNIT = "unit"
STATUS_RIGHT = "rgt"
STATUS_TWIN = "twin"

#: The statuses a portfolio may accept. Everything else is a refusal with a reason.
ACCEPTED = frozenset({STATUS_OK})

#: ``WFC-PZ``, ``BAC-PB``, ``ETI-P``: a hyphen and a P-prefixed series suffix.
#: ``BRK-A`` is a *class*, not a series, and does not match — which is the point.
_PREFERRED_RE = re.compile(r"^[A-Z0-9]{1,6}-P[A-Z0-9]{0,2}$")

#: Five characters where the four-character stem is itself a listed symbol: the
#: SPAC warrant/unit/right convention (``TACHW``, ``HACQU``, ``CORZR``).
_SUFFIX_STATUS = {"W": STATUS_WARRANT, "U": STATUS_UNIT, "R": STATUS_RIGHT}


def fetch_document() -> dict:
    """EDGAR's symbol file, cached and re-fetched on the same 6-hour clock as other
    index files (``sec.py``) — it is rewritten in place, so a stale copy is a real
    risk for a symbol that was just relisted."""
    return sec.fetch_json(SECURITIES_URL)


def rows(document: dict) -> list[dict[str, Any]]:
    """``{fields, data}`` → one dict per symbol. EDGAR's own field order is kept."""
    fields = document.get("fields") or []
    data = document.get("data") or []
    if not fields or not data:
        raise ValueError("company_tickers_exchange.json has no fields/data")
    index = {name: position for position, name in enumerate(fields)}
    missing = {"cik", "name", "ticker", "exchange"} - set(index)
    if missing:
        raise ValueError(f"company_tickers_exchange.json is missing {sorted(missing)}")
    return [
        {
            "cik": row[index["cik"]],
            "name": str(row[index["name"]] or ""),
            "ticker": str(row[index["ticker"]] or "").strip().upper(),
            "exchange": row[index["exchange"]],
        }
        for row in data
    ]


def classify(
    symbol: str,
    *,
    symbols: frozenset[str] | set[str],
    fund_tickers: frozenset[str],
) -> str:
    """The refusal reason this symbol carries, or ``STATUS_OK``.

    Symbol-shape only. A name-token rule was measured and rejected: the only titles
    containing ``PREFERRED``/``WARRANT`` in the live file are *funds* (``Nuveen
    Preferred & Income Opportunities Fund``), so matching on names would refuse
    ordinary fund tickers and never catch a SPAC warrant, whose title is the
    blank-check company's.
    """
    if symbol in fund_tickers:
        return STATUS_FUND
    if _PREFERRED_RE.match(symbol):
        return STATUS_PREFERRED
    if len(symbol) == 5 and symbol[4] in _SUFFIX_STATUS and symbol[:4] in symbols:
        return _SUFFIX_STATUS[symbol[4]]
    return STATUS_OK


def twin_names(company_rows: Iterable[Iterable[Any]]) -> set[str]:
    """Normalized names of companies published in the ``l_`` namespace.

    ``company_rows`` is the release's ``companies/index.json`` rows —
    ``[company_id, name, ticker, holder_count]``. A company reachable through both
    namespaces is refused as a typed symbol: the ledger would otherwise show it
    twice (``c_`` for the funds that file a CIK, ``l_`` for the funds that file an
    LEI), understating overlap.
    """
    return {
        normalize_name(str(row[1]))
        for row in company_rows
        if str(row[0]).startswith("l_") and len(row) > 1 and row[1]
    }


def build(
    document: dict,
    *,
    fund_tickers: Iterable[str] = (),
    alias_tickers: Iterable[str] = (),
    twins: set[str] | None = None,
) -> dict[str, list[Any]]:
    """``SYMBOL → [company_id, name, exchange, status]`` for every listed symbol.

    Sorted by symbol so two builds of the same file are byte-identical.
    """
    parsed = rows(document)
    symbols = frozenset(row["ticker"] for row in parsed if row["ticker"])
    known_funds = frozenset(t.upper() for t in fund_tickers) | frozenset(
        t.upper() for t in alias_tickers
    )
    twin_keys = twins if twins is not None else set()

    securities: dict[str, list[Any]] = {}
    for row in parsed:
        symbol = row["ticker"]
        if not symbol or symbol in securities:
            continue
        status = classify(symbol, symbols=symbols, fund_tickers=known_funds)
        if status == STATUS_OK and twin_keys:
            name_key = normalize_name(row["name"])
            if name_key and name_key in twin_keys:
                status = STATUS_TWIN
        securities[symbol] = [
            company_id(row["cik"]),
            row["name"],
            row["exchange"] or None,
            status,
        ]
    return dict(sorted(securities.items()))


def shards(securities: dict[str, list[Any]]) -> dict[str, dict[str, Any]]:
    """First-character shards, so one typed symbol costs one small request."""
    grouped: dict[str, dict[str, list[Any]]] = {}
    for symbol, value in securities.items():
        grouped.setdefault(shard_for(symbol), {})[symbol] = value
    return {
        shard: {"securities": dict(sorted(rows_.items()))}
        for shard, rows_ in sorted(grouped.items())
    }


def counts(securities: dict[str, list[Any]]) -> dict[str, int]:
    """How many symbols carry each status — published so a refusal rate is visible."""
    tally: dict[str, int] = {}
    for value in securities.values():
        tally[value[3]] = tally.get(value[3], 0) + 1
    return dict(sorted(tally.items()))


def write_release_objects(
    release_dir: Path | str,
    *,
    release: str,
    securities: dict[str, list[Any]],
    source_url: str = SECURITIES_URL,
) -> dict:
    """Write ``securities/{L}.json`` and return the descriptor fragment + sizes."""
    release_dir = Path(release_dir)
    prefix = "securities/"
    written: dict[str, int] = {}
    entries: dict[str, dict] = {}
    for shard, body in shards(securities).items():
        document = {"as_of": release, "source_url": source_url, "securities": body["securities"]}
        payload = encode(document)
        relative = f"{prefix}{shard}.json"
        target = release_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        written[relative] = len(payload)
        entries[shard] = object_entry(relative, payload)
    return {
        "objects": {
            "prefix": prefix,
            # Per-shard bytes + sha256, not just names: the client fetches one shard
            # and must be able to verify it, or a truncated object would become a
            # plausible wrong company id on screen (I6).
            "shards": dict(sorted(entries.items())),
            "count": len(securities),
            "statuses": counts(securities),
            "bytes": sum(written.values()),
        },
        "sizes": written,
    }


__all__ = [
    "ACCEPTED",
    "SECURITIES_URL",
    "STATUS_FUND",
    "STATUS_OK",
    "STATUS_PREFERRED",
    "STATUS_RIGHT",
    "STATUS_TWIN",
    "STATUS_UNIT",
    "STATUS_WARRANT",
    "build",
    "classify",
    "counts",
    "fetch_document",
    "rows",
    "shards",
    "twin_names",
    "write_release_objects",
]

_ = json  # json is used by callers reading these objects back in tests
