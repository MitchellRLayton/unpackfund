"""Security → company identity, with the rung recorded.

The mapping ladder in ``sec-edgar-fundamentals-nport-core`` §5 is LEI → CUSIP →
ISIN → ticker. Measured on 2026-10-28 against real filings, that ladder cannot be
walked with free data:

| Fund | holdings | ticker | isin | lei | cusip |
|---|---|---|---|---|---|
| VOO  | 520 | **1** | 504 | 494 | 504 |
| AVUV | 798 | 797 | 797 | 569 | 796 |
| QQQ  | 105 | **1** | 102 | 101 | 101 |
| ARKK |  47 |  45 |  44 |  38 |  41 |

CUSIP and ISIN need a licensed security master; LEI needs an LEI→CIK table (a new
external source, so Class A). Vanguard and Invesco publish almost no tickers, so a
ticker-only mapper reports ~0.2% coverage on the two largest funds in the set —
a *labelled gap* that is worse than it needs to be, because every row does carry
an issuer name.

So day 1 walks two rungs, both **exact and deterministic**, and records which one
fired:

1. ``ticker`` — the holding's N-PORT ticker equals an SEC operating-company symbol.
2. ``name_exact`` — the holding's issuer name equals an SEC company title after
   lossless normalisation (case, punctuation, legal suffixes) **and exactly one**
   CIK normalises to that key. Two candidates means unmapped: guessing between
   them is how a ledger attributes 3% of a fund to the wrong company.

Anything else stays ``unmapped``, is counted, and is never redistributed. The
per-release rung counts go in the manifest so the confidence of a release is
visible without reading code.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from . import sec

OPERATING_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

_LEGAL_SUFFIXES = re.compile(
    r"\b(incorporated|inc|corporation|corp|company|co|ltd|limited|plc|llc|lp|"
    r"holdings?|group|the|sa|nv|ag|se|oyj|ab|as|spa|reit|trust|fund|"
    r"class\s+[a-z]|cl\s+[a-z]|series\s+[a-z0-9]+)\b"
)
_RUNG_TICKER = "ticker"
_RUNG_NAME = "name_exact"
_RUNG_NONE = "unmapped"


def normalize_name(name: str) -> str:
    text = name.lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = _LEGAL_SUFFIXES.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


@dataclass
class CompanyIndex:
    by_ticker: dict[str, str] = field(default_factory=dict)
    # normalized name -> company_id, only where the key is unique
    by_name: dict[str, str] = field(default_factory=dict)
    # company_id -> a listed symbol for that CIK, used when the filer omits one
    primary_ticker: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls) -> "CompanyIndex":
        """Build the index from EDGAR's operating-company ticker file."""
        return cls.from_document(sec.fetch_json(OPERATING_TICKERS_URL))

    @classmethod
    def from_document(cls, document: dict) -> "CompanyIndex":
        """Build the index from an already-fetched ticker document (tests, replays)."""
        by_ticker: dict[str, str] = {}
        primary_ticker: dict[str, str] = {}
        name_candidates: dict[str, set[str]] = {}
        for row in document.values():
            cik = row.get("cik_str")
            title = str(row.get("title") or "")
            ticker = str(row.get("ticker") or "").strip().upper()
            if cik is None:
                continue
            cid = company_id(cik)
            if ticker:
                by_ticker[ticker] = cid
                primary_ticker.setdefault(cid, ticker)
            key = normalize_name(title)
            if key:
                name_candidates.setdefault(key, set()).add(cid)
        # Ambiguous keys are dropped rather than resolved to "most likely".
        by_name = {
            key: next(iter(ids)) for key, ids in name_candidates.items() if len(ids) == 1
        }
        return cls(by_ticker=by_ticker, by_name=by_name, primary_ticker=primary_ticker)

    def symbol(self, company_id: str | None) -> str | None:
        """A listed symbol for a resolved company, or None."""
        return self.primary_ticker.get(company_id) if company_id else None

    def resolve(self, ticker: str | None, name: str | None) -> tuple[str | None, str]:
        if ticker:
            hit = self.by_ticker.get(ticker.strip().upper())
            if hit:
                return hit, _RUNG_TICKER
        if name:
            hit = self.by_name.get(normalize_name(name))
            if hit:
                return hit, _RUNG_NAME
        return None, _RUNG_NONE


def company_id(cik: str | int) -> str:
    """Contract form: ``c_`` + 10-digit zero-padded CIK."""
    return f"c_{int(cik):010d}"


def rung_counts(rungs: Counter[str]) -> dict[str, int]:
    return {rung: rungs[rung] for rung in (_RUNG_TICKER, _RUNG_NAME, _RUNG_NONE)}
