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
from collections import Counter, defaultdict
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
_RUNG_ISIN = "isin_corroborated"
_RUNG_LEI = "lei_corroborated"
_RUNG_NONE = "unmapped"
#: Every rung a row can be counted under, in the order the ladder is walked. The
#: manifest publishes counts per name, so adding a rung here is how it becomes
#: visible instead of silently landing in ``unmapped``.
ALL_RUNGS = (_RUNG_TICKER, _RUNG_NAME, _RUNG_ISIN, _RUNG_LEI, _RUNG_NONE)
#: The rungs that come from the corroborated-identity table rather than from a
#: direct identifier match on the row itself.
IDENTITY_RUNGS = (_RUNG_ISIN, _RUNG_LEI)
#: How many times a security identifier must have been seen pointing at one
#: company before the agreement is treated as an identity. One sighting is a
#: coincidence; two independent funds holding the same security and both resolving
#: it to the same issuer is a fact about the security.
IDENTITY_MIN_OCCURRENCES = 2


def normalize_name(name: str) -> str:
    text = name.lower().replace("&", " and ")
    # An apostrophe is part of a name, not a separator: ``Lowe's`` must normalize to
    # ``lowes`` or it stops matching EDGAR's ``LOWES COMPANIES INC``.
    text = re.sub(r"['\u2019]", "", text)
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = _LEGAL_SUFFIXES.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


#: Words that carry no identity: they are legal form, or the fund wrapper.
_NAME_NOISE = frozenset(
    {
        "the",
        "and",
        "of",
        "for",
        "new",
        "fund",
        "trust",
        "common",
        "stock",
        "class",
        "series",
        "shares",
        "inc",
        "corp",
        "co",
        "ltd",
        "plc",
        "sa",
        "se",
        "ag",
        "nv",
        "lp",
        "llc",
        "com",
        "cl",
        "cap",
        "stk",
        "depositary",
        "receipt",
    }
)


def name_tokens(name: str) -> list[str]:
    """The identity-bearing words of a company name, lowercased."""
    return [token for token in normalize_name(name).split() if token not in _NAME_NOISE]


def names_agree(reported: str, title: str) -> bool:
    """Whether a filing's name for a holding corroborates the company it mapped to.

    The ticker rung is the one rung that can be confidently wrong. N-PORT filers
    write a bare symbol with no exchange, and a bare symbol is not unique across
    markets: on the day-5 release, 71 holdings named ``SCHNEIDER ELECTRIC SE``
    carried the ticker ``SU`` and mapped to Suncor Energy, ``ALLIANZ SE`` mapped to
    Autoliv, ``VINCI SA`` to Dollar General, ``LVMH`` to Moelis. Each is a plausible
    row in a ledger and a wrong answer about what the visitor owns.

    So a ticker match now has to be corroborated by the name. The test is
    deliberately loose about *form* and strict about *identity*:

    - a shared word is enough (``AAR CORP.`` / ``AAR Corp``);
    - so is one name being a prefix of the other once concatenated
      (``Exxon Mobil`` / ``ExxonMobil Holdings Corp``);
    - so are initials (``IBM`` / ``International Business Machines``, ``TSMC`` /
      ``Taiwan Semiconductor Manufacturing``);
    - so is a shared three-character stem (``F.N.B.`` / ``FNB Corp``).

    It is not loose about a name that names a different company. A rejected ticker
    match falls through to the name rung and, if that fails too, to ``unmapped`` —
    which is disclosed and counted, where a misattribution is neither.
    """
    reported_tokens = name_tokens(reported)
    if not reported_tokens:
        # Nothing to contradict the ticker; it is the only signal there is.
        return True
    title_tokens = name_tokens(title)
    if not title_tokens:
        return True
    if set(reported_tokens) & set(title_tokens):
        return True

    reported_key = "".join(reported_tokens)
    title_key = "".join(title_tokens)
    if reported_key.startswith(title_key) or title_key.startswith(reported_key):
        return True
    initials = "".join(token[0] for token in title_tokens)
    if len(initials) >= 2 and (
        reported_key.startswith(initials) or initials.startswith(reported_key)
    ):
        return True
    return reported_key[:3] == title_key[:3]


@dataclass
class CompanyIndex:
    by_ticker: dict[str, str] = field(default_factory=dict)
    # normalized name -> company_id, only where the key is unique
    by_name: dict[str, str] = field(default_factory=dict)
    # company_id -> a listed symbol for that CIK, used when the filer omits one
    primary_ticker: dict[str, str] = field(default_factory=dict)
    # company_id -> EDGAR's own title, used to corroborate a ticker match
    title_by_id: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls) -> "CompanyIndex":
        """Build the index from EDGAR's operating-company ticker file."""
        return cls.from_document(sec.fetch_json(OPERATING_TICKERS_URL))

    @classmethod
    def from_document(cls, document: dict) -> "CompanyIndex":
        """Build the index from an already-fetched ticker document (tests, replays)."""
        by_ticker: dict[str, str] = {}
        primary_ticker: dict[str, str] = {}
        title_by_id: dict[str, str] = {}
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
            if title:
                title_by_id.setdefault(cid, title)
            key = normalize_name(title)
            if key:
                name_candidates.setdefault(key, set()).add(cid)
        # Ambiguous keys are dropped rather than resolved to "most likely".
        by_name = {
            key: next(iter(ids)) for key, ids in name_candidates.items() if len(ids) == 1
        }
        return cls(
            by_ticker=by_ticker,
            by_name=by_name,
            primary_ticker=primary_ticker,
            title_by_id=title_by_id,
        )

    def symbol(self, company_id: str | None) -> str | None:
        """A listed symbol for a resolved company, or None."""
        return self.primary_ticker.get(company_id) if company_id else None

    def explain(self, ticker: str | None, name: str | None) -> str:
        """Why a holding did or did not map — the rung, and for a miss the reason.

        ``resolve`` answers "which company"; this answers "which branch decided".
        A diagnostic needs the second: 26% of resolved equity weight is unmapped,
        and "unmapped" covers four different problems with four different fixes —
        a symbol the index has never heard of, a symbol the name refused, a name
        no company in EDGAR shares, and a row with no identifier at all.

        The branch order and the corroboration rule are the same as ``resolve`` by
        construction: both are written against ``by_ticker``/``by_name``/
        ``names_agree`` in the same order, and the test suite pins them together.
        """
        if ticker:
            hit = self.by_ticker.get(ticker.strip().upper())
            if hit:
                if names_agree(name or "", self.title_by_id.get(hit, "")):
                    return _RUNG_TICKER
                return "ticker_rejected_by_name"
            if name and self.by_name.get(normalize_name(name)):
                return _RUNG_NAME
            return "ticker_unknown"
        if name:
            return _RUNG_NAME if self.by_name.get(normalize_name(name)) else "name_unmatched"
        return "no_identifier"

    def resolve(self, ticker: str | None, name: str | None) -> tuple[str | None, str]:
        if ticker:
            hit = self.by_ticker.get(ticker.strip().upper())
            # A ticker without a name that corroborates it is a coincidence, not an
            # identity — see ``names_agree``.
            if hit and names_agree(name or "", self.title_by_id.get(hit, "")):
                return hit, _RUNG_TICKER
        if name:
            hit = self.by_name.get(normalize_name(name))
            if hit:
                return hit, _RUNG_NAME
        return None, _RUNG_NONE


def company_id(cik: str | int) -> str:
    """Contract form: ``c_`` + 10-digit zero-padded CIK."""
    return f"c_{int(cik):010d}"


class IdentityEvidence:
    """What the ladder saw: security identifier → the companies it resolved to.

    Recorded only for rows the ladder itself resolved, by construction — the
    caller observes a row *before* any identity table is consulted (see
    ``weights.build_vector``), so the table can never grow from its own
    inferences. That is the difference between evidence and a second guess.
    """

    def __init__(self) -> None:
        self.isin: dict[str, Counter[str]] = defaultdict(Counter)
        self.lei: dict[str, Counter[str]] = defaultdict(Counter)

    def observe(
        self, isin: str | None, lei: str | None, company_id: str | None
    ) -> None:
        """Credit one ladder-resolved row to its ISIN and its LEI, if it has them."""
        if not company_id:
            return
        if isin:
            self.isin[isin][company_id] += 1
        if lei:
            self.lei[lei][company_id] += 1

    def merge(self, other: "IdentityEvidence") -> None:
        for key, counts in other.isin.items():
            self.isin[key].update(counts)
        for key, counts in other.lei.items():
            self.lei[key].update(counts)

    def table(self) -> "IdentityTable":
        return IdentityTable.from_evidence(self)


def _unanimous(
    candidates: dict[str, Counter[str]],
) -> tuple[dict[str, str], int, int]:
    """Keep identifier keys with one company and enough sightings.

    Returns ``(agreed, contested, thin)``. Both rejected shapes are counted rather
    than dropped silently: a reviewer needs to know what the discipline cost, and
    the answer is that it costs almost nothing (113 ISINs and 58 LEIs of 28,695
    and 5,127 keys, 1,548 bp of 92.5M).
    """
    agreed: dict[str, str] = {}
    contested = 0
    thin = 0
    for key, counts in candidates.items():
        if len(counts) > 1:
            contested += 1
            continue
        company_id, occurrences = next(iter(counts.items()))
        if occurrences < IDENTITY_MIN_OCCURRENCES:
            thin += 1
            continue
        agreed[key] = company_id
    return agreed, contested, thin


@dataclass(frozen=True)
class IdentityTable:
    """Corroborated ISIN/LEI → company_id for rows the ladder could not resolve.

    An identifier is admitted only when **every** sighting agreed on one company
    and that agreement was seen at least twice. Two companies claiming the same
    identifier means at least one of them is wrong, and a wrong company
    attribution is worse than an unmapped row: the row stays ``unmapped`` and the
    disagreement is counted. Rows resolved here are recorded under their own rung
    names so the manifest keeps showing how much of a release is direct.
    """

    by_isin: dict[str, str] = field(default_factory=dict)
    by_lei: dict[str, str] = field(default_factory=dict)
    #: Rejected key counts, by identifier kind — the visible cost of the rule.
    contested: dict[str, int] = field(default_factory=dict)
    thin: dict[str, int] = field(default_factory=dict)

    @classmethod
    def empty(cls) -> "IdentityTable":
        return cls()

    @classmethod
    def from_evidence(cls, evidence: IdentityEvidence) -> "IdentityTable":
        by_isin, contested_isin, thin_isin = _unanimous(evidence.isin)
        by_lei, contested_lei, thin_lei = _unanimous(evidence.lei)
        return cls(
            by_isin=by_isin,
            by_lei=by_lei,
            contested={"isin": contested_isin, "lei": contested_lei},
            thin={"isin": thin_isin, "lei": thin_lei},
        )

    def resolve(self, isin: str | None, lei: str | None) -> tuple[str | None, str]:
        """The company this security is, or ``(None, "unmapped")``."""
        from_isin = self.by_isin.get(isin) if isin else None
        from_lei = self.by_lei.get(lei) if lei else None
        if from_isin and from_lei and from_isin != from_lei:
            # The security's own ISIN and LEI disagree about its issuer. Refusing
            # here is the whole point of the rule: the ladder has no tie-break.
            return None, _RUNG_NONE
        if from_isin:
            return from_isin, _RUNG_ISIN
        if from_lei:
            return from_lei, _RUNG_LEI
        return None, _RUNG_NONE


def rung_counts(rungs: Counter[str]) -> dict[str, int]:
    return {rung: rungs[rung] for rung in ALL_RUNGS}
