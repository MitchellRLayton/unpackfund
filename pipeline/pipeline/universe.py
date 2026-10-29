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
from dataclasses import dataclass
from pathlib import Path

from . import sec

MF_TICKERS_URL = "https://www.sec.gov/files/company_tickers_mf.json"
OVERRIDES = Path(__file__).resolve().parent.parent / "overrides" / "tickers.csv"


@dataclass(frozen=True)
class FundRef:
    ticker: str
    cik: str
    series_id: str | None
    resolved_by: str
    expected_registrant: str | None = None

    @property
    def fund_id(self) -> str:
        """Stable key for the artifact: the series, else ``CIK…`` when there is none."""
        return self.series_id or f"CIK{int(self.cik):010d}"


def _mf_map() -> dict[str, tuple[str, str, str]]:
    """symbol → (cik, seriesId, classId) from the SEC fund ticker file."""
    document = sec.fetch_json(MF_TICKERS_URL)
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
            name = str(sec.fetch_json(sec.submissions_url(cik)).get("name") or "")
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
            return FundRef(symbol, cik, series, "company_tickers_mf")

    raise LookupError(
        f"{symbol}: not in company_tickers_mf.json and no override row — add "
        f"pipeline/overrides/tickers.csv (cik, series_id, registrant) rather than guessing"
    )
