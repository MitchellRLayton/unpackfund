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

Two more rungs exist for issuers that have no CIK at all — the foreign holdings
that are 96.6% of this product's coverage gap (2026-10-30 measurement):

3. ``lei_issuer`` — the row carries the issuer's LEI and GLEIF publishes that
   entity, so the row resolves into the **``l_`` namespace** with GLEIF's legal
   name. Direct evidence: the identifier is the filing's own statement about this
   row.
4. ``isin_lei_issuer`` — the row carries no LEI but its ISIN maps to exactly one
   in GLEIF's ISIN-to-LEI file. Inferred from the security rather than the row, so
   it is a separate rung and the manifest keeps the two apart.

## The two namespaces, and why they never touch

| prefix | id | describes | source |
|---|---|---|---|
| ``c_`` | ``c_`` + 10-digit CIK | an SEC operating company | EDGAR |
| ``l_`` | ``l_`` + 16 hex of sha256(LEI) | a GLEIF-registered legal entity | GLEIF (CC0) |

An ``l_`` id is never produced by the CIK ladder and a ``c_`` id is never produced
by the LEI path: a fund-share holding must not become an operating company, and an
issuer must not be looked up by a CIK-shaped guess. The LEI itself is internal —
it is hashed into the id so that no entity identifier appears in an artifact or in
HTML, the same rule that keeps CUSIP and ISIN out.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from . import gleif, sec

OPERATING_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

# EDGAR writes the state of incorporation into the title, in every punctuation variant
# it felt like: "BANK OF AMERICA CORP /DE/", "COSTCO WHOLESALE CORP /NEW",
# "APPLIED MATERIALS INC /DE", "WELLS FARGO & COMPANY/MN". None of it is part of a
# legal name, so no GLEIF name carries it and an exact comparison against those titles
# fails for exactly the largest US companies. Kept separate from ``normalize_name`` on
# purpose: changing that function would move every rung count in every release, and
# this is only used to bridge an LEI to an SEC identity.
#
# The same slot carries the *listing line*, not just a jurisdiction: a depositary's
# title is "SUMITOMO ELECTRIC INDUSTRIES LTD/ADR/", "ROCKWOOL A/S/CAN" (measured:
# 548 of ~12,000 titles carry ``/ADR``). An ADR is the same issuer as its ordinary
# shares, so the marker is stripped the same way — otherwise the bridge misses every
# company whose only SEC presence is a sponsored ADR, which is most of the foreign
# issuers this namespace exists to name. Two to five letters covers the state codes,
# ``NEW``, ``ADR``, ``ADS`` and country codes like ``CAN``; a real legal name does not
# end in a slash, and an ambiguous result is refused by the single-candidate rule.
EDGAR_JURISDICTION_RE = re.compile(r"\s*/\s*(?:[A-Za-z]{2,5}|NEW)\s*/?\s*$")


def strip_edgar_markers(title: str) -> str:
    """``"SUMITOMO ELECTRIC INDUSTRIES LTD/ADR/"`` → ``"SUMITOMO ELECTRIC INDUSTRIES LTD"``.

    Applied repeatedly because EDGAR stacks them (``"FOO CORP /DE/ ADR"``), and a
    single pass would leave a marker behind and turn a match into a miss.
    """
    stripped = title
    for _ in range(3):
        candidate = EDGAR_JURISDICTION_RE.sub(" ", stripped)
        if candidate == stripped:
            break
        stripped = candidate
    return stripped

_LEGAL_SUFFIXES = re.compile(
    r"\b(incorporated|inc|corporation|corp|company|co|ltd|limited|plc|llc|lp|"
    r"holdings?|group|the|sa|nv|ag|se|oyj|ab|as|spa|reit|trust|fund|"
    r"class\s+[a-z]|cl\s+[a-z]|series\s+[a-z0-9]+)\b"
)
_RUNG_TICKER = "ticker"
_RUNG_NAME = "name_exact"
_RUNG_ISIN = "isin_corroborated"
_RUNG_LEI = "lei_corroborated"
_RUNG_LEI_ISSUER = gleif.RUNG_LEI
_RUNG_ISIN_LEI_ISSUER = gleif.RUNG_ISIN_LEI
_RUNG_NONE = "unmapped"
#: The rung a row is counted under when it resolves to nothing. Public because a
#: caller's own refusal rule (``weights.build_vector``) has to name it as well.
RUNG_UNMAPPED = _RUNG_NONE
#: Every rung a row can be counted under, in the order the ladder is walked. The
#: manifest publishes counts per name, so adding a rung here is how it becomes
#: visible instead of silently landing in ``unmapped``.
ALL_RUNGS = (
    _RUNG_TICKER,
    _RUNG_NAME,
    _RUNG_ISIN,
    _RUNG_LEI,
    _RUNG_LEI_ISSUER,
    _RUNG_ISIN_LEI_ISSUER,
    _RUNG_NONE,
)
#: The rungs that resolve a row into the foreign-issuer namespace (``l_``).
ISSUER_RUNGS = (_RUNG_LEI_ISSUER, _RUNG_ISIN_LEI_ISSUER)
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


#: Words that are not identity *by themselves*: "bank" is not the word BANK, and
#: "American", "United", "First" and "Capital" open thousands of unrelated names. A
#: name match that shares only one of these is a coincidence, not corroboration.
#:
#: Kept apart from ``_NAME_NOISE`` on purpose. Noise is legal form (``Inc``, ``S.A.``)
#: and is *deleted*; this set is meaningful vocabulary that cannot distinguish two
#: companies and is only *disqualified* as a shared token. An exact or prefix match
#: still stands, so ``UNITED AIRLINES HOLDINGS INC`` / ``United Airlines`` resolves on
#: the words they do not share.
#:
#: (``mapping_report._STOPWORDS`` is the diagnostic's own list for its near-miss
#: measurement. The two answer different questions and drift apart on purpose; this
#: one decides identity, so it is the stricter of the two.)
_GENERIC_NAME_WORDS = frozenset(
    {
        "united",
        "general",
        "american",
        "national",
        "first",
        "global",
        "international",
        "worldwide",
        "capital",
        "financial",
        "industries",
        "industrial",
        "systems",
        "technologies",
        "technology",
        "resources",
        "energy",
        "group",
        "holdings",
        "holding",
        "partners",
        "associates",
        "services",
        "solutions",
        "products",
        "ventures",
        "investment",
        "investments",
        "management",
        "bancorp",
        "bankshares",
        "bank",
        "banking",
        "insurance",
        "companies",
        "company",
        "trust",
        "fund",
        "index",
        "growth",
        "value",
        "income",
        "dividend",
        "large",
        "small",
        "mid",
        "cap",
        "emerging",
        "developed",
        "asia",
        "europe",
        "pacific",
        "japan",
        "china",
        "india",
    }
)

#: The shortest concatenated key that may corroborate a ticker through the prefix
#: rule. Below this a "prefix" is a letter stem rather than a name: ``dan`` is a
#: prefix of both ``danieli…`` and ``dana``, which is exactly the Danieli→DANA
#: defect — a three-character stem was the old rule's last resort and it is gone.
_MIN_PREFIX_CHARS = 4

#: How much a name match is worth, weakest to strongest. ``names_agree`` reads this
#: as a yes/no; ``weights.build_vector`` reads the degree, because a weak yes cannot
#: hold a row against an LEI that names a different entity.
MATCH_WEAK = "weak"
MATCH_DISTINCTIVE = "distinctive"
MATCH_EXACT = "exact"
_STRENGTH = {None: 0, MATCH_WEAK: 1, MATCH_DISTINCTIVE: 2, MATCH_EXACT: 3}


def name_tokens(name: str) -> list[str]:
    """The identity-bearing words of a company name, lowercased.

    A run of one-letter words is joined into one token, because that is what it is:
    ``F.N.B. CORP`` is ``FNB``. The joining is what lets the shared-word rule accept
    ``F.N.B. CORP (PENNSYLVANIA)`` / ``FNB CORP/PA/`` — ``fnb`` is the same word in
    both — without the three-character stem the old rule used to accept them (and
    accept ``DANIELI`` as ``DANA``). Concatenating the tokens is unaffected, since
    joining only moves the boundaries, so the prefix and initials rules see exactly
    the concatenation they saw before.
    """
    tokens: list[str] = []
    initials: list[str] = []
    for token in normalize_name(name).split():
        if token in _NAME_NOISE:
            continue
        if len(token) == 1:
            initials.append(token)
            continue
        if initials:
            tokens.append("".join(initials))
            initials = []
        tokens.append(token)
    if initials:
        tokens.append("".join(initials))
    return tokens


def name_corroboration(reported: str, title: str) -> str | None:
    """How strongly ``reported`` corroborates ``title``, or ``None`` for "no".

    Loose about *form* and strict about *identity*:

    - ``MATCH_EXACT`` — the identity words are the same;
    - ``MATCH_DISTINCTIVE`` — a shared word that is not one every second company
      uses (``AAR``, ``Lowes``, and ``FNB`` once ``F.N.B.`` is read as the initialism
      it is), or one name being a prefix of the other with at least
      ``_MIN_PREFIX_CHARS`` characters of agreement (``Exxon Mobil`` /
      ``ExxonMobil Holdings``);
    - ``MATCH_WEAK`` — initials (``IBM`` / ``International Business Machines``), a
      short prefix of fewer than ``_MIN_PREFIX_CHARS`` characters (``DAN`` /
      ``DANA``), or a name that is silent on one side. A shared *generic* word only
      (``FIRST BANCORP`` / ``FIRST CAPITAL``) is not weak, it is no corroboration at
      all and ``None`` is returned.

    The three-character stem the old rule ended on is not in this list: it accepted
    ``DANIELI & C OFFICINE MECCANICHE SPA`` as ``DANA INC`` in the live release.
    A weak match is still a match for the ladder — but ``weights.build_vector`` lets
    the row's own LEI/ISIN overrule it, so the degree has to be visible.

    EDGAR writes the jurisdiction or listing line into its titles
    (``FIRST BANCORP /PR/``, ``SUMITOMO ELECTRIC INDUSTRIES LTD/ADR/``). It is not
    part of the legal name, so a title carrying one is compared a second time with
    the marker removed — the stripped variant the name rung already looks up — and
    the stronger of the two answers stands. It can only help: without it,
    ``First BanCorp/Puerto Rico`` stops corroborating ``FIRST BANCORP /PR/`` and
    41 bp of AVUV goes unmapped for a punctuation reason.
    """
    strength = _name_match(reported, title)
    stripped = strip_edgar_markers(title)
    if stripped != title:
        stripped_strength = _name_match(reported, stripped)
        if _STRENGTH[stripped_strength] > _STRENGTH[strength]:
            strength = stripped_strength
    return strength


def _name_match(reported: str, title: str) -> str | None:
    """One comparison of two names: ``name_corroboration`` with a single title."""
    reported_tokens = name_tokens(reported)
    title_tokens = name_tokens(title)
    if not reported_tokens or not title_tokens:
        # Nothing to contradict the ticker: the name is silent, which is the weakest
        # corroboration there is — an identifier may speak instead.
        return MATCH_WEAK
    if reported_tokens == title_tokens:
        return MATCH_EXACT
    if (set(reported_tokens) & set(title_tokens)) - _GENERIC_NAME_WORDS:
        return MATCH_DISTINCTIVE

    reported_key = "".join(reported_tokens)
    title_key = "".join(title_tokens)
    if reported_key == title_key:
        # Same identity words in a different split: Exxon Mobil / ExxonMobil.
        return MATCH_EXACT
    if reported_key.startswith(title_key) or title_key.startswith(reported_key):
        shorter = min(len(reported_key), len(title_key))
        return MATCH_DISTINCTIVE if shorter >= _MIN_PREFIX_CHARS else MATCH_WEAK
    initials = "".join(token[0] for token in title_tokens)
    if len(initials) >= 2 and (
        reported_key.startswith(initials) or initials.startswith(reported_key)
    ):
        return MATCH_WEAK
    return None


def names_agree(reported: str, title: str) -> bool:
    """Whether a filing's name for a holding corroborates the company it mapped to.

    The ticker rung is the one rung that can be confidently wrong. N-PORT filers
    write a bare symbol with no exchange, and a bare symbol is not unique across
    markets: on the day-5 release, 71 holdings named ``SCHNEIDER ELECTRIC SE``
    carried the ticker ``SU`` and mapped to Suncor Energy, ``ALLIANZ SE`` mapped to
    Autoliv, ``VINCI SA`` to Dollar General, ``LVMH`` to Moelis. Each is a plausible
    row in a ledger and a wrong answer about what the visitor owns.

    So a ticker match now has to be corroborated by the name, and the degrees are
    ``name_corroboration``'s: a shared identity-bearing word, a full prefix, exact
    identity words, or initials. Two cases are refused that used to pass — a name
    that agrees only on a generic corporate word, and a bare three-character stem —
    because the first is not evidence and the second mapped the Italian issuer
    ``DANIELI & C OFFICINE MECCANICHE SPA`` to ``DANA INC``.

    A rejected ticker match falls through to the name rung and then to the row's
    LEI/ISIN; if neither resolves it, the row is ``unmapped`` — which is disclosed
    and counted, where a misattribution is neither.
    """
    return name_corroboration(reported, title) is not None


@dataclass
class CompanyIndex:
    by_ticker: dict[str, str] = field(default_factory=dict)
    # normalized name -> company_id, only where the key is unique
    by_name: dict[str, str] = field(default_factory=dict)
    # the same keys with EDGAR's jurisdiction suffix removed ("COSTCO WHOLESALE CORP
    # /NEW/" -> "costco wholesale"); see resolve_gleif_name
    by_name_stripped: dict[str, str] = field(default_factory=dict)
    # company_id -> a listed symbol for that CIK, used when the filer omits one
    primary_ticker: dict[str, str] = field(default_factory=dict)
    # company_id -> EDGAR's own title, used to corroborate a ticker match
    title_by_id: dict[str, str] = field(default_factory=dict)

    def resolve_gleif_name(self, name: str) -> str | None:
        """The SEC company a GLEIF legal name belongs to, when exactly one does.

        Used only to keep one company in one namespace: the issuer namespace resolves
        a holding by its LEI, and if that legal entity is also an SEC registrant the
        row must carry the ``c_`` id, or the ledger — which merges on ``company_id`` —
        would list the same company twice (once per spelling) and understate overlap.

        The rule is the ladder's own: exact normalized equality, single candidate, and
        a refusal rather than a guess when two CIKs share the name. EDGAR's title
        markers — state of incorporation, and the ``/ADR/`` listing line that is the
        only SEC presence most foreign issuers have — are stripped first, because
        neither is part of a legal name and GLEIF carries neither.
        """
        cid, _ = self.resolve(None, name)
        if cid is not None:
            return cid
        return self.by_name_stripped.get(normalize_name(name))

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
        stripped_candidates: dict[str, set[str]] = {}
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
                stripped = normalize_name(strip_edgar_markers(title))
                if stripped and stripped != key:
                    stripped_candidates.setdefault(stripped, set()).add(cid)
        # Ambiguous keys are dropped rather than resolved to "most likely".
        by_name = {
            key: next(iter(ids)) for key, ids in name_candidates.items() if len(ids) == 1
        }
        by_name_stripped = {
            key: next(iter(ids)) for key, ids in stripped_candidates.items() if len(ids) == 1
        }
        return cls(
            by_ticker=by_ticker,
            by_name=by_name,
            by_name_stripped=by_name_stripped,
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

    def corroboration(
        self, company_id: str | None, rung: str, name: str | None
    ) -> str | None:
        """How strongly the filing's name supports an answer ``resolve`` returned.

        ``resolve`` says *which* company and *which rung*; this says *how much the
        name is worth*, which is the input ``weights.build_vector`` needs to decide
        whether a row's own LEI/ISIN may overrule the answer. The name rung is exact
        by construction (that is its lookup key); the ticker rung carries whatever
        ``name_corroboration`` graded it; every other rung rests on an identifier
        rather than on the name.
        """
        if company_id is None:
            return None
        if rung == _RUNG_NAME:
            return MATCH_EXACT
        if rung == _RUNG_TICKER:
            return name_corroboration(name or "", self.title_by_id.get(company_id, ""))
        return None


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
