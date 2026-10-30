"""The fund-share join: how much of the unmapped fund weight our own catalogue closes.

    python -m pipeline.fund_shares measure --release artifacts/universe-c/releases/2026-10-30.5

The gap this measures is the release's largest free one. Of 48,234,821 bp of unmapped
published weight, **10,024,325 bp is shares of US funds** — the ``fund`` asset category,
99.7% of it US-domiciled
([`2026-10-30-international-and-identifier-data-options.md`] §1). The research note that
found it also said where the weight is: 25.52% of it matches a fund we already publish by
exact name, and the top unmatched names are **registrant trusts** — ``ISHARES TRUST``
(351,689 bp), ``FIDELITY SALEM STREET TRUST`` (345,283), ``FIDELITY INVESTMENT TRUST``
(222,534) — i.e. the filing recorded the trust, not the series. It called the rest "a
join defect on public data" and left the recoverable share as a hypothesis. This module
measures it, and refuses the parts that cannot be defended.

Four questions, one run each:

1. **What are those rows?** Every published ``fund`` row with no ``company_id`` is
   classified into the brief's four buckets — exact/near name match (``a_*``),
   registrant-trust / series recovered from the filing's own text (``b_trust_series``),
   money-market and lending vehicles (``c_money_market``), genuinely unknown or refused
   (``d_unknown``) — by weight and by row, with its denominator stated.
2. **Which joins are trustworthy?** A name match is an *inference*: two funds can share a
   name, and a fund's name is not its identity. Every resolution carries an evidence label
   and a tier, and only two tiers count as a join: ``identity`` (a machine key in the row
   resolves to exactly one published fund) and ``corroborated`` (**two independent fields
   of the filing agree** — name and title, title and registrant, truncated title and
   registrant). An ``uncorroborated`` single-field match is measured and reported but
   **not** counted: that is the tier where a generic name like ``INTERNATIONAL EQUITY
   FUND`` silently attributes one fund's portfolio to another, and it is also exactly what
   a naive exact-name join would claim.
3. **What does it buy?** A joined row stops being unmapped, and where the matched fund is
   one we publish, its own holdings can be looked through: depth 1 and depth 2 are
   reported separately, each weighted by the inner fund's *own* coverage, so the number is
   company weight actually recovered and not "the whole position". Loops (A holds B holds
   A) and self-holdings are detected, counted, and terminated — termination is a property
   of the code, not of the data being well behaved.
4. **Does it move the 60% gate?** The per-fund coverage histogram before → after, in both
   readings: ``identity`` (the row is attributed to a fund we publish) and
   ``look-through`` (the row is attributed to that fund's *companies*). The second is the
   only one that can justify a company metric, and ``lookthrough-math-and-qa`` §1 fixes
   look-through at one level deep, so depth 2 is reported and explicitly not shippable.

Method, and the same honesty rules the two measurement notes use:

* **The artifact is the authority.** A row is unmapped when ``company_id`` is null in
  ``funds/<TICKER>.json``; the evidence for it is recovered from the very N-PORT document
  that produced it, parsed from the build's own cache at ``sha256(source_url)``. The join
  key is ``(published name, category)`` because ``weights.build_vector`` merges filing rows
  on exactly that key and the published row *is* that group.
* **The unit of decision is the filing row, the unit of weight is the published row.**
  This is the one place where the two differ, and it matters: ``ISHARES TRUST`` is one
  published row merging many filings' worth of different series, so deciding the published
  row as a unit would refuse 351,689 bp of perfectly identifiable weight. Each filing row
  is decided on its own evidence, and its share of the published weight is
  ``published_bp × filed_bp / recovered_bp``. A wired join would achieve the same by
  putting the fund identity in ``build_vector``'s group key, so the merged row splits — an
  artifact change, which this measurement does *not* make.
* **Which identifier can be a key is measured, not assumed.** The only identifier present
  on both sides is the **share-class ticker**: a filing row carries it, and our release
  publishes it (``catalogue.json`` plus the ``aliases.json`` class-ticker map). The
  CUSIP — present on 97.8% of fund-category rows — has nothing to join to: our own
  documents publish an SEC **class ID** (``C000225169``), not a share-class CUSIP, and the
  survey below counts the header ids to prove it (22,136 of 22,136 are class-ID shaped,
  none CUSIP-shaped). That rules out an identifier join for held fund shares and is
  itself a finding: it is why the join has to go through names at all.
* **The join must reconcile.** Recovered fund-category weight is compared with the
  artifact's own total and the residual is reported. A join that silently drops rows shows
  up there, which is the whole reason to compute it.
* **No identifier is ever printed.** CUSIP, ISIN and LEI appear only as in-memory evidence
  flags; the report counts them and never echoes a value. Names are printed through
  ``identifiers.public_name``, the same redaction the artifact applies.
* **Measurement, not integration.** Nothing is written, no artifact field changes, no
  release is rebuilt. A measurement that changes the thing it measures is not a
  measurement (``lookthrough-math-and-qa`` §7a).

N-PORT splits a fund across two elements, and that split is the whole defect: the filer
writes the **registrant (trust)** in ``<name>`` and the **series** in ``<title>``
(``name="ISHARES TRUST"``, ``title="ISHARES CORE DIV"``). So the series is recoverable from
the filing's own text — when the title is not one of Fidelity's 16-character truncations,
which the prefix rule handles by matching a unique token-prefix of a published name and
requiring the registrant to agree.
"""

from __future__ import annotations

import argparse
import bisect
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from . import classify, identifiers, nport, paths, weights

BP_PER_UNIT = 10_000

#: The release these numbers are defined against, as both research notes are.
DEFAULT_RELEASE = paths.ARTIFACTS / "universe-c" / "releases" / "2026-10-30.5"

#: The coverage bands of ``lookthrough-math-and-qa`` §5, half-open on the lower edge.
GATE_PARTIAL_PCT = 60.0
GATE_RANKED_PCT = 70.0

COUNTRY_US = "US"

# --- buckets ---------------------------------------------------------------

A_NAME_EXACT = "a_name_exact"
A_NAME_NEAR = "a_name_near"
B_TRUST_SERIES = "b_trust_series"
C_MONEY_MARKET = "c_money_market"
D_UNKNOWN = "d_unknown"

BUCKETS = (A_NAME_EXACT, A_NAME_NEAR, B_TRUST_SERIES, C_MONEY_MARKET, D_UNKNOWN)
BUCKET_LABELS = {
    A_NAME_EXACT: "(a) exact name match to a published fund",
    A_NAME_NEAR: "(a) near name match to a published fund",
    B_TRUST_SERIES: "(b) series recovered from the filing's own text",
    C_MONEY_MARKET: "(c) money-market / lending / master-portfolio vehicle",
    D_UNKNOWN: "(d) genuinely unknown or refused",
}

# --- evidence labels and tiers ---------------------------------------------

EVIDENCE_TICKER = "ticker"
EVIDENCE_NAME_AND_TITLE = "name_and_title"
EVIDENCE_TITLE_AND_REGISTRANT = "title_and_registrant"
EVIDENCE_PREFIX_AND_REGISTRANT = "truncated_title_and_registrant"
EVIDENCE_NAME_AND_REGISTRANT = "name_and_registrant"
EVIDENCE_NAME_EXACT = "name_exact"
EVIDENCE_TITLE_EXACT = "title_exact"
EVIDENCE_TITLE_PREFIX = "truncated_title"
EVIDENCE_NAME_NEAR = "name_near"

#: Only the first two tiers are counted as a join. See ``decide``.
TIER_IDENTITY = "identity"
TIER_CORROBORATED = "corroborated"
TIER_UNCORROBORATED = "uncorroborated"
TIERS = (TIER_IDENTITY, TIER_CORROBORATED, TIER_UNCORROBORATED)
COUNTED_TIERS = (TIER_IDENTITY, TIER_CORROBORATED)

STATUS_JOINED = "joined"
STATUS_REFUSED = "refused"
STATUS_NO_MATCH = "no_match"

#: Why a row was refused. Each reason is a different fix, or no fix at all.
REFUSE_AMBIGUOUS_NAME = "ambiguous_name"
REFUSE_AMBIGUOUS_TITLE = "ambiguous_title"
REFUSE_AMBIGUOUS_IDENTITY = "ambiguous_identity"
REFUSE_TRUST_ONLY = "trust_only_no_series"
REFUSE_CONTRADICTED = "name_contradicted_by_title"
REFUSE_TRUST_SERIES_UNMATCHED = "registrant_known_series_unmatched"
REFUSE_SERIES_NOT_MATCHED = "series_not_matched"
REFUSE_UNMATCHED = "no_candidate"
REFUSE_FILING_UNAVAILABLE = "filing_unavailable"
REFUSE_DUPLICATE_ROW = "duplicate_row_name"

# --- name normalisation ----------------------------------------------------

#: Legal form of the vehicle's *issuer*, not identity: ``T. Rowe Price Value Fund,
#: Inc.`` and ``T ROWE PRICE VALUE FUND`` are the same fund.
_LEGAL_WORDS = frozenset(
    {
        "inc", "incorporated", "corp", "corporation", "co", "company", "companies",
        "ltd", "limited", "plc", "llc", "lp", "llp", "sa", "nv", "ag", "se", "oyj",
        "ab", "as", "spa", "bv", "the", "n",
    }
)

#: Words that describe the wrapper, not the fund. Dropped only for the *near* key:
#: dropping them from the exact key would merge ``X Index Fund`` with ``X ETF``, two
#: different funds from one family. The near match is a weaker, separate tier precisely
#: because it cannot tell those apart.
_GENERIC_WORDS = frozenset(
    {"fund", "funds", "trust", "trusts", "portfolio", "portfolios", "series", "index", "etf", "etfs"}
)

#: Roman numerals numbering a trust's series (``JOHN HANCOCK FUNDS II``), not identity.
_ROMAN_WORDS = frozenset({"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"})

#: Trailing share-class designators: ``AMERICAN BALANCED FUND-R6``, ``TRP VALUE FD-Z``,
#: ``Nuveen Equity Index Fund, Class R6``. A class is not a series, so the trailing
#: designator is dropped from the exact key too — otherwise a filing that names the class
#: never matches the series we publish. Only *trailing* tokens are dropped, so a name that
#: uses one of these words in the middle (``Vanguard Institutional Index Fund``) is intact.
_CLASS_DESIGNATORS = frozenset(
    {
        "a", "b", "c", "d", "i", "k", "n", "r", "s", "t", "z",
        "adm", "admiral", "adv", "advisor", "cl", "class", "cls", "sh", "shares", "shs",
        "inst", "instl", "institutional", "inv", "investor",
        "prime", "ret", "retirement", "r1", "r2", "r3", "r4", "r5", "r6",
        "svc", "service", "super", "ultra",
    }
)

_FKA = re.compile(
    r"\b(?:f\s*/\s*k\s*/\s*a|fka|n\s*/\s*k\s*/\s*a|formerly(?:\s+known\s+as)?)\b",
    re.IGNORECASE,
)
#: A filer's former name is written in parentheses: ``ACME TRUST (F/K/A OLD TRUST)``.
#: Matching both names would produce a key no fund has, so the whole clause goes — the
#: current name is the only identity, and the old one is history.
_PARENS = re.compile(r"\(([^()]*)\)")
#: ``Series 1`` on a unit investment trust is identity — ``Invesco QQQ Trust, Series 1``
#: is one trust of a series — so the numeral stays and only the spelling is normalised.
_SERIES_NUMBER = re.compile(r"\bseries\s+([0-9]+)\b")
_MONEY_MARKET = re.compile(
    r"\b(?:money\s*market|mmkt|mmf|liquidity|prime\s+obligations|government\s+obligations|"
    r"treasury\s+only|treasury\s+portfolio|master\s+investment\s+portfolio|"
    r"master\s+portfolio|central\s+cash|cash\s+reserve|sweep|collateral|"
    r"short[\s-]term\s+investment\s+fund|stif)\b",
    re.IGNORECASE,
)
#: A truncated title is only used as a prefix key when it is long enough to be specific.
_PREFIX_MIN_LENGTH = 8
#: Fidelity's filer truncates the filed ``title`` at 16 characters, so a refused title of
#: about that length is reported as *suspect* truncation. It is a suspicion, not a verdict:
#: ``Eaton Vance Corp`` is also 15 characters and simply names no fund we publish.
_TITLE_TRUNCATION_LENGTHS = (15, 16, 17, 18)


def _drop_former_names(text: str) -> str:
    """Remove a parenthesised ``F/K/A`` clause, then any remaining marker."""
    without_clauses = _PARENS.sub(
        lambda match: " " if _FKA.search(match.group(1)) else match.group(0), text
    )
    return _FKA.sub(" ", without_clauses)


def _clean(text: str | None) -> str:
    lowered = _drop_former_names((text or "").lower())
    lowered = lowered.replace("&", " and ")
    # A percent sign is noise in a fund name, and so is the word it abbreviates.
    lowered = lowered.replace("%", " ").replace(" percent ", " ").replace(" pct ", " ")
    lowered = re.sub(r"['\u2019\u2018`]", "", lowered)
    lowered = re.sub(r"[^a-z0-9 ]+", " ", lowered)
    lowered = _SERIES_NUMBER.sub(r"series \1", lowered)
    return re.sub(r"\s+", " ", lowered).strip()


def normalize_fund_name(name: str | None) -> str:
    """The exact-match key for a fund name.

    Each step is a test in ``tests/test_fund_shares.py``: ``F/K/A`` and ``formerly known
    as`` are annotations, not words; ``&`` is ``and``; ``%`` disappears; an apostrophe is
    part of a word; ``Series 1`` keeps its numeral; legal form and a trailing share class
    are dropped but ``fund``, ``trust``, ``portfolio`` and ``index`` are identity and stay.
    """
    tokens = [token for token in _clean(name).split() if token not in _LEGAL_WORDS]
    while len(tokens) > 1 and tokens[-1] in _CLASS_DESIGNATORS:
        tokens.pop()
    return " ".join(tokens)


def near_fund_name(name: str | None) -> str:
    """The near-match key: exact key with wrapper words and series numerals gone.

    ``AMERICAN BALANCED FUND-R6`` and ``American Balanced Fund`` collapse together;
    ``iShares Core S&P 500 ETF`` and ``iShares Core S&P 500 Index Fund`` also collapse,
    which is exactly why a near match is never trusted on its own.
    """
    return " ".join(
        token
        for token in normalize_fund_name(name).split()
        if token not in _GENERIC_WORDS and token not in _ROMAN_WORDS
    )


def looks_like_money_market(*names: str | None) -> bool:
    """Whether the vehicle is a money-market, liquidity or master-portfolio position.

    Not a mapping failure and not a look-through win: a sweep's holdings are cash and
    Treasury paper, so attributing the row to a fund whose own portfolio has no company
    weight adds identity and no company exposure. Counting it as coverage would be the
    inflation §7b of the math skill forbids for borrowed cash.
    """
    return any(_MONEY_MARKET.search(name or "") for name in names if name)


def is_truncation_suspect(title: str | None) -> bool:
    """Whether a filed title that matched nothing looks cut short."""
    stripped = (title or "").strip()
    if not stripped or stripped.replace(" ", "").isdigit():
        return False
    return len(stripped) in _TITLE_TRUNCATION_LENGTHS


def looks_like_cusip(value: str | None) -> bool:
    """Whether a ``ticker`` field actually holds a CUSIP — a filer data defect we count."""
    text = (value or "").strip()
    if not text:
        return False
    return len(text) > 6 or not text.isalpha()


# --- the catalogue of funds we publish -------------------------------------


@dataclass(frozen=True)
class FundEntry:
    """One published fund, as the join needs to see it."""

    ticker: str
    name: str
    issuer: str
    etf: bool
    coverage_pct: float


@dataclass
class FundCatalogue:
    """Every fund the release publishes, indexed by the names a row can carry.

    Three name indexes, because a held row can name a *series* (the fund's own published
    name), a *registrant* (its trust), or a truncation of the series. Plus the class-ticker
    map: ``aliases.json`` routes a share-class symbol to the published ticker of its
    series, which is the only machine key the two sides share.
    """

    entries: dict[str, FundEntry] = field(default_factory=dict)
    by_name: dict[str, tuple[str, ...]] = field(default_factory=dict)
    by_near_name: dict[str, tuple[str, ...]] = field(default_factory=dict)
    by_issuer: dict[str, tuple[str, ...]] = field(default_factory=dict)
    aliases: dict[str, str] = field(default_factory=dict)
    etf_classifier: str = ""
    _sorted_names: list[tuple[str, str]] = field(default_factory=list, repr=False)

    @classmethod
    def from_release(cls, release: Path | str) -> "FundCatalogue":
        release_path = Path(release)
        catalogue_path = release_path / "catalogue.json"
        if not catalogue_path.exists():
            raise SystemExit(f"no catalogue.json under {release_path}")
        document = json.loads(catalogue_path.read_text())
        entries: dict[str, FundEntry] = {}
        for ticker, row in (document.get("funds") or {}).items():
            values = list(row) + [None] * (4 - len(row))
            name, issuer, etf, coverage = values[:4]
            entries[str(ticker)] = FundEntry(
                ticker=str(ticker),
                name=str(name or ""),
                issuer=str(issuer or ""),
                etf=bool(etf),
                coverage_pct=float(coverage or 0.0),
            )
        aliases: dict[str, str] = {}
        alias_path = release_path / "aliases.json"
        if alias_path.exists():
            aliases = {
                str(key).strip().upper(): str(value).strip().upper()
                for key, value in (json.loads(alias_path.read_text()).get("targets") or {}).items()
            }
        sorted_names = sorted(
            (normalize_fund_name(entry.name), entry.ticker)
            for entry in entries.values()
            if normalize_fund_name(entry.name)
        )
        return cls(
            entries=entries,
            by_name=_unique_index(entries, lambda entry: normalize_fund_name(entry.name)),
            by_near_name=_unique_index(entries, lambda entry: near_fund_name(entry.name)),
            by_issuer=_group_index(entries, lambda entry: normalize_fund_name(entry.issuer)),
            aliases=aliases,
            etf_classifier=str(document.get("etf_classifier") or ""),
            _sorted_names=sorted_names,
        )

    def name_candidates(self, name: str | None) -> tuple[str, ...]:
        key = normalize_fund_name(name)
        return self.by_name.get(key, ()) if key else ()

    def near_candidates(self, name: str | None) -> tuple[str, ...]:
        key = near_fund_name(name)
        return self.by_near_name.get(key, ()) if key else ()

    def trust_candidates(self, name: str | None) -> tuple[str, ...]:
        """Every published series under the registrant this name names, if any."""
        key = normalize_fund_name(name)
        return self.by_issuer.get(key, ()) if key else ()

    def prefix_candidates(self, title: str | None) -> tuple[str, ...]:
        """Published funds whose name *begins* with this truncated title, token-wise.

        Fidelity's filer cuts the filed title at 16 characters (``ISHARES CORE DIV`` for
        ``iShares Core Dividend Growth ETF``), and the cut lands *mid-word*, so the last
        token of a truncated title is a fragment of the real name's word. That is why this
        matches on the character prefix and not on a token boundary. A character prefix is
        a coincidence more easily than a name is, so a prefix match is only ever counted
        together with an agreeing registrant (``decide``), never on its own.
        """
        key = normalize_fund_name(title)
        if len(key) < _PREFIX_MIN_LENGTH or " " not in key:
            return ()
        hits: set[str] = set()
        index = bisect.bisect_left(self._sorted_names, (key, ""))
        while index < len(self._sorted_names):
            name, ticker = self._sorted_names[index]
            if not name.startswith(key):
                break
            hits.add(ticker)
            index += 1
        return tuple(sorted(hits))

    def ticker_candidates(self, ticker: str | None) -> tuple[str, ...]:
        symbol = (ticker or "").strip().upper()
        if not symbol:
            return ()
        if symbol in self.entries:
            return (symbol,)
        target = self.aliases.get(symbol)
        if target and target in self.entries:
            return (target,)
        return ()


def _unique_index(
    entries: dict[str, FundEntry], key_of: Callable[[FundEntry], str]
) -> dict[str, tuple[str, ...]]:
    """key → the one ticker that owns it.

    A key two funds share is dropped from this index on purpose: the caller must see *no*
    answer, not the alphabetically first one. ``by_issuer`` keeps those groups, because a
    name that maps to 333 series is evidence, not a dead end.
    """
    grouped: dict[str, list[str]] = defaultdict(list)
    for ticker in sorted(entries):
        key = key_of(entries[ticker])
        if key:
            grouped[key].append(ticker)
    return {key: (tickers[0],) for key, tickers in grouped.items() if len(tickers) == 1}


def _group_index(
    entries: dict[str, FundEntry], key_of: Callable[[FundEntry], str]
) -> dict[str, tuple[str, ...]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    for ticker in sorted(entries):
        key = key_of(entries[ticker])
        if key:
            grouped[key].append(ticker)
    return {key: tuple(tickers) for key, tickers in grouped.items()}


# --- which identifier can be a key: measured, not assumed ------------------

_CLASS_ID = re.compile(rb"<classId>\s*([^<]*?)\s*</classId>")
_SEC_CLASS_ID = re.compile(r"C\d{6,12}")
_CUSIP_SHAPED = re.compile(r"[0-9A-Z]{9}")


@dataclass
class IdentityKeySurvey:
    """What identifier our own documents actually publish for a fund's shares.

    The point of the survey is to answer, with a count rather than an assumption, whether a
    held row's CUSIP can be a join key. It cannot: every ``seriesClassInfo/classId`` in our
    own filings is an SEC **class ID** (``C000225169``), and a held row carries a share-class
    **CUSIP**. Two different identifier systems with no intersection — so the fund-share
    join has to go through names, and the only machine key it can use is the ticker.
    """

    headers: int = 0
    class_ids: int = 0
    sec_class_ids: int = 0
    cusip_shaped: int = 0
    missing_headers: int = 0

    @property
    def us_cusip_joinable(self) -> bool:
        return self.cusip_shaped > 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "headers_read": self.headers,
            "headers_missing": self.missing_headers,
            "class_ids": self.class_ids,
            "class_ids_sec_shaped": self.sec_class_ids,
            "class_ids_cusip_shaped": self.cusip_shaped,
            "cusip_joinable": self.us_cusip_joinable,
            "why": (
                "our own filings publish an SEC class ID (C…), never a share-class CUSIP, "
                "so a held row's CUSIP has nothing to join to"
                if not self.us_cusip_joinable
                else "some headers carry a CUSIP-shaped class id"
            ),
        }

    @classmethod
    def from_release(
        cls,
        release: Path | str,
        *,
        filing_cache: Path | None = None,
        read_header: Callable[[Path], bytes] | None = None,
    ) -> "IdentityKeySurvey":
        release_path = Path(release)
        cache_dir = filing_cache or identifiers.default_filing_cache()
        reader = read_header or _read_header
        survey = cls()
        for fund_path in sorted((release_path / "funds").glob("*.json")):
            try:
                document = json.loads(fund_path.read_text())
            except (OSError, ValueError):
                survey.missing_headers += 1
                continue
            path = identifiers.filing_path(cache_dir, str(document.get("source_url") or ""))
            if not path.exists():
                survey.missing_headers += 1
                continue
            survey.headers += 1
            for value in _class_ids(reader(path)):
                survey.class_ids += 1
                if _SEC_CLASS_ID.fullmatch(value):
                    survey.sec_class_ids += 1
                elif _CUSIP_SHAPED.fullmatch(value):
                    survey.cusip_shaped += 1
        return survey


def _read_header(path: Path, size: int = 4096) -> bytes:
    with open(path, "rb") as handle:
        return handle.read(size)


def _class_ids(header: bytes) -> list[str]:
    return [
        match.decode("ascii", "replace").strip().upper() for match in _CLASS_ID.findall(header)
    ]


# --- per-row evidence and the decision --------------------------------------


@dataclass(frozen=True)
class Candidates:
    """Every way a filing row could resolve, before the rules pick one."""

    name: tuple[str, ...] = ()
    near: tuple[str, ...] = ()
    title: tuple[str, ...] = ()
    title_prefix: tuple[str, ...] = ()
    ticker: tuple[str, ...] = ()
    trust: tuple[str, ...] = ()
    has_series_text: bool = False
    truncation_suspect: bool = False
    ticker_present_flag: bool = False
    ticker_malformed: bool = False

    @property
    def identity(self) -> tuple[str, ...]:
        """The published funds a machine key in this row resolves to.

        One key → one fund is identity. More than one is not a coin flip to be broken; it
        is a row the rules refuse (``REFUSE_AMBIGUOUS_IDENTITY``), because picking would
        attribute a real position to the wrong fund.
        """
        return tuple(sorted(set(self.ticker)))


@dataclass(frozen=True)
class Decision:
    """What this row is, and whether we will join it."""

    bucket: str
    status: str
    reason: str
    target: str | None
    evidence: str
    tier: str | None
    trust_series_count: int = 0
    truncation_suspect: bool = False
    ticker_present: bool = False
    ticker_malformed: bool = False

    @property
    def joined(self) -> bool:
        return self.status == STATUS_JOINED and self.tier in COUNTED_TIERS


def _bucket_for(candidates: Candidates, *, money_market: bool) -> str:
    """Which of the brief's four classes the row is in — by its *nature*, not its outcome.

    Money-market first, then our own catalogue's answer: a name we publish means (a), a
    name from which the filing's text recovered the series means (b), anything else is (d).
    A refused row keeps the bucket it was refused in, so "refused" never hides a class.
    """
    if money_market:
        return C_MONEY_MARKET
    if candidates.name:
        return A_NAME_EXACT
    if candidates.near:
        return A_NAME_NEAR
    if candidates.title or candidates.title_prefix or candidates.ticker or candidates.trust:
        return B_TRUST_SERIES
    return D_UNKNOWN


def decide(candidates: Candidates, *, money_market: bool = False) -> Decision:
    """Apply the join rules to one filing row. Pure, deterministic, testable on its own.

    The order is the honesty order, and the tier is what the evidence *is*, not how good it
    feels:

    1. **Money-market and lending vehicles are their own bucket** even when they resolve:
       a sweep is cash, not company exposure.
    2. **A machine key wins outright.** One ticker resolving to one published fund is the
       only unreservedly trusted evidence — it is the filing's own statement of which
       series the row is, not a reading of its words.
    3. **Two machine keys cannot both be right** and a merged row cannot be split: refused.
    4. **A registrant name is never read as a series name.** ``VANGUARD INDEX FUNDS`` is a
       trust in our own catalogue; a near match against one of its funds would be an
       accident of the wrapper words.
    5. **One text field is an inference; two agreeing fields are corroboration.** Name and
       title agreeing, title and registrant agreeing, or a unique truncated-title prefix
       with an agreeing registrant, are counted. A lone field is measured, reported, and
       refused — that is the ``uncorroborated`` tier, and it is exactly what a naive
       exact-name join would have claimed.
    6. **A trust name with no series is a refusal, with its candidate count recorded.**
       ``ISHARES TRUST`` is 333 published series; naming one from the trust name would be
       guessing, and a wrong guess misattributes a whole fund's portfolio.
    """
    bucket = _bucket_for(candidates, money_market=money_market)
    identity = candidates.identity
    flags = {
        "trust_series_count": len(candidates.trust),
        "truncation_suspect": candidates.truncation_suspect,
        "ticker_present": bool(candidates.ticker) or candidates.ticker_present_flag,
        "ticker_malformed": candidates.ticker_malformed,
    }
    if money_market:
        identified = len(identity) == 1
        return Decision(
            bucket=bucket,
            status=STATUS_JOINED if identified else STATUS_REFUSED,
            reason="money_market_identified" if identified else "money_market_unidentified",
            target=identity[0] if identified else None,
            evidence=EVIDENCE_TICKER if identified else "",
            tier=TIER_IDENTITY if identified else None,
            **flags,
        )
    if len(identity) == 1:
        # A name match that disagrees with the machine key is a name-join defect: reported,
        # and the key still decides.
        reason = (
            "series_key"
            if not candidates.name or candidates.name == identity
            else "series_key_name_disagrees"
        )
        return Decision(
            bucket=bucket,
            status=STATUS_JOINED,
            reason=reason,
            target=identity[0],
            evidence=EVIDENCE_TICKER,
            tier=TIER_IDENTITY,
            **flags,
        )
    if len(identity) > 1:
        return _refusal(REFUSE_AMBIGUOUS_IDENTITY, candidates, bucket, flags)

    trust = candidates.trust
    name = candidates.name
    title = candidates.title
    if len(name) > 1:
        return _refusal(REFUSE_AMBIGUOUS_NAME, candidates, bucket, flags)
    if len(name) == 1:
        target = name[0]
        if title and title != name:
            return _refusal(REFUSE_CONTRADICTED, candidates, bucket, flags)
        if title and title == name:
            return _join(title[0], EVIDENCE_NAME_AND_TITLE, candidates, bucket, flags)
        if target in trust:
            return _join(target, EVIDENCE_NAME_AND_REGISTRANT, candidates, bucket, flags)
        return _unsure(target, EVIDENCE_NAME_EXACT, "name_uncorroborated", candidates, bucket, flags)
    if len(title) > 1:
        return _refusal(REFUSE_AMBIGUOUS_TITLE, candidates, bucket, flags)
    if len(title) == 1:
        target = title[0]
        if target in trust:
            return _join(target, EVIDENCE_TITLE_AND_REGISTRANT, candidates, bucket, flags)
        return _unsure(target, EVIDENCE_TITLE_EXACT, "title_uncorroborated", candidates, bucket, flags)
    if len(candidates.title_prefix) > 1:
        # A truncated title that is a prefix of two of our funds cannot be resolved without
        # a registrant that picks one.
        narrowed = tuple(item for item in candidates.title_prefix if item in trust)
        if len(narrowed) == 1:
            return _join(
                narrowed[0], EVIDENCE_PREFIX_AND_REGISTRANT, candidates, bucket, flags
            )
        return _refusal(REFUSE_AMBIGUOUS_TITLE, candidates, bucket, flags)
    if len(candidates.title_prefix) == 1:
        target = candidates.title_prefix[0]
        if target in trust:
            return _join(target, EVIDENCE_PREFIX_AND_REGISTRANT, candidates, bucket, flags)
        return _unsure(
            target, EVIDENCE_TITLE_PREFIX, "title_prefix_uncorroborated", candidates, bucket, flags
        )
    # From here the row's own name is the only name left. If it names a registrant, it is a
    # trust and not a series, so no name-based inference may be read off it — a near match
    # against one of its funds would be an accident of the wrapper words.
    if not trust:
        if len(candidates.near) > 1:
            return _refusal(REFUSE_AMBIGUOUS_NAME, candidates, bucket, flags)
        if len(candidates.near) == 1:
            return _unsure(
                candidates.near[0],
                EVIDENCE_NAME_NEAR,
                "name_near_uncorroborated",
                candidates,
                bucket,
                flags,
            )
    if candidates.has_series_text:
        # The filing names a series we could not match to a fund this release publishes. Two
        # causes, and they need different fixes: a fund we do not publish (a Fidelity internal
        # "Series" fund, a DFA collective trust) or a filer abbreviation of one we do
        # (``SS TECH SEL SECT``). The reason separates the rows whose registrant we know from
        # the rows where we have nothing at all.
        return _refusal(
            REFUSE_TRUST_SERIES_UNMATCHED if trust else REFUSE_SERIES_NOT_MATCHED,
            candidates,
            bucket,
            flags,
        )
    if trust:
        return _refusal(REFUSE_TRUST_ONLY, candidates, bucket, flags)
    return Decision(
        bucket=bucket,
        status=STATUS_NO_MATCH,
        reason=REFUSE_UNMATCHED,
        target=None,
        evidence="",
        tier=None,
        **flags,
    )


def _join(
    target: str, evidence: str, candidates: Candidates, bucket: str, flags: dict[str, Any]
) -> Decision:
    return Decision(
        bucket=bucket,
        status=STATUS_JOINED,
        reason=evidence,
        target=target,
        evidence=evidence,
        tier=TIER_CORROBORATED,
        **flags,
    )


def _unsure(
    target: str,
    evidence: str,
    reason: str,
    candidates: Candidates,
    bucket: str,
    flags: dict[str, Any],
) -> Decision:
    """One field matched and nothing agrees with it: measured, reported, not counted."""
    return Decision(
        bucket=bucket,
        status=STATUS_REFUSED,
        reason=reason,
        target=target,
        evidence=evidence,
        tier=TIER_UNCORROBORATED,
        **flags,
    )


def _refusal(
    reason: str, candidates: Candidates, bucket: str, flags: dict[str, Any]
) -> Decision:
    return Decision(
        bucket=bucket,
        status=STATUS_REFUSED,
        reason=reason,
        target=None,
        evidence=_evidence_of(candidates),
        tier=None,
        **flags,
    )


def _evidence_of(candidates: Candidates) -> str:
    if candidates.ticker:
        return EVIDENCE_TICKER
    if candidates.name:
        return EVIDENCE_NAME_EXACT
    if candidates.title:
        return EVIDENCE_TITLE_EXACT
    if candidates.title_prefix:
        return EVIDENCE_TITLE_PREFIX
    if candidates.near:
        return EVIDENCE_NAME_NEAR
    return ""


# --- the measurement --------------------------------------------------------


@dataclass(frozen=True)
class FilingRow:
    """One N-PORT holding row, recovered from the filing that produced a published row.

    ``bp`` is the row's own weight as a fraction of the filing's net assets — the same
    quantity the build rounds, computed separately so a merged published group can be split
    back into its members. ``title`` is the element that matters: filers put the *series*
    there and the registrant trust in ``name``, so the trust-name defect is recoverable
    from the filing's own text.
    """

    name: str
    title: str
    ticker: str
    cusip: str
    bp: float
    country: str = ""


@dataclass(frozen=True)
class Unit:
    """One decided weight: a filing row's share of its published row."""

    ticker: str
    name: str
    bp: float
    decision: Decision
    country: str = ""


@dataclass
class PublishedFundRow:
    """One published ``fund`` row with no ``company_id`` — the artifact's own unit."""

    name: str
    published_bp: int
    filing_rows: list[FilingRow] = field(default_factory=list)
    units: list[Unit] = field(default_factory=list)
    duplicate: bool = False

    @property
    def key(self) -> str:
        return self.name.upper()

    @property
    def recovered_bp(self) -> float:
        return sum(row.bp for row in self.filing_rows)

    @property
    def joined_bp(self) -> float:
        return sum(unit.bp for unit in self.units if unit.decision.joined)


@dataclass
class FundStats:
    """One published fund as the measurement needs it."""

    ticker: str
    gross_bp: float = 0.0
    mapped_bp: float = 0.0
    coverage_pct: float = 0.0
    published_coverage_pct: float = 0.0
    rows: int = 0
    fund_rows: list[PublishedFundRow] = field(default_factory=list)
    error: str | None = None

    @property
    def unmapped_bp(self) -> float:
        return self.gross_bp - self.mapped_bp

    @property
    def fund_unmapped_bp(self) -> float:
        return sum(row.published_bp for row in self.fund_rows)

    @property
    def units(self) -> list[Unit]:
        return [unit for row in self.fund_rows for unit in row.units]

    @property
    def filing_rows(self) -> list[FilingRow]:
        return [row for published in self.fund_rows for row in published.filing_rows]


def measure(
    release: Path | str = DEFAULT_RELEASE,
    *,
    filing_cache: Path | None = None,
    catalogue: FundCatalogue | None = None,
    survey: IdentityKeySurvey | None = None,
    load_filing: Callable[[str], nport.NportFiling] | None = None,
    limit: int = 0,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Measure the fund-share join over one release. Offline, read-only, deterministic."""
    release_path = Path(release)
    if not (release_path / "funds").is_dir():
        raise SystemExit(f"no funds/ under {release_path}")
    catalogue = catalogue or FundCatalogue.from_release(release_path)
    cache_dir = filing_cache or identifiers.default_filing_cache()
    if survey is None:
        survey = IdentityKeySurvey.from_release(release_path, filing_cache=cache_dir)
    loader = load_filing or (lambda url: identifiers.load_nport_filing(url, cache_dir))

    fund_paths = sorted((release_path / "funds").glob("*.json"))
    if limit:
        fund_paths = fund_paths[:limit]
    stats: dict[str, FundStats] = {}
    for index, path in enumerate(fund_paths, 1):
        document = _read_document(path)
        fund = _read_fund(path.stem, document)
        stats[fund.ticker] = fund
        if fund.fund_rows and document is not None:
            _attach_evidence(fund, document, loader, catalogue)
        if progress is not None and index % 2_000 == 0:
            progress(f"measured {index:,}/{len(fund_paths):,} funds")

    return _summarise(release_path, stats, catalogue, survey)


def _read_document(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _read_fund(ticker: str, document: dict[str, Any] | None) -> FundStats:
    fund = FundStats(ticker=ticker)
    if document is None:
        fund.error = "unreadable document"
        return fund
    fund.published_coverage_pct = float(document.get("coverage_pct") or 0.0)
    for row in document.get("holdings") or []:
        weight = abs(int(row.get("weight_bp") or 0))
        category = str(row.get("asset_cat") or classify.OTHER)
        fund.gross_bp += weight
        fund.rows += 1
        if row.get("company_id"):
            fund.mapped_bp += weight
            continue
        if category != classify.FUND:
            continue
        fund.fund_rows.append(
            PublishedFundRow(name=identifiers.public_name(row.get("name")), published_bp=weight)
        )
    # The contract's own denominator, recomputed: gross holding weight, one decimal.
    fund.coverage_pct = _coverage(fund.mapped_bp, fund.gross_bp)
    return fund


def _attach_evidence(
    fund: FundStats,
    document: dict[str, Any],
    loader: Callable[[str], nport.NportFiling],
    catalogue: FundCatalogue,
) -> None:
    """Recover each published row's filing rows, decide each filing row, split the weight."""
    by_name: dict[str, list[PublishedFundRow]] = defaultdict(list)
    for row in fund.fund_rows:
        by_name[row.key].append(row)
    duplicates = {key for key, rows in by_name.items() if len(rows) > 1}
    recovered: dict[str, list[FilingRow]] = defaultdict(list)
    try:
        filing = loader(str(document.get("source_url") or ""))
    except (identifiers.IdentifierError, nport.NportParseError, OSError, ValueError) as error:
        fund.error = f"{type(error).__name__}: {error}"
        for row in fund.fund_rows:
            row.units = [
                _whole_row_unit(
                    fund.ticker,
                    row,
                    REFUSE_FILING_UNAVAILABLE,
                )
            ]
        return
    for holding in filing.holdings:
        classification = classify.classify(
            holding.asset_cat, holding.issuer_cat, holding.is_derivative
        )
        if classification.category != classify.FUND:
            continue
        key = identifiers.public_name(holding.name).upper()
        if key not in by_name:
            # The published group kept a different category than this filing row: it cannot
            # be attributed to a published row without guessing, and the reconciliation
            # reports the shortfall instead of hiding it.
            continue
        fraction = weights._fraction(holding, filing.net_assets)
        if fraction is None:
            continue
        recovered[key].append(
            FilingRow(
                name=identifiers.public_name(holding.name),
                title=identifiers.public_name(holding.title),
                ticker=(holding.ticker or "").strip().upper(),
                cusip=(holding.cusip or "").strip().upper(),
                bp=abs(fraction * BP_PER_UNIT),
                country=(holding.inv_country or "").strip().upper(),
            )
        )
    for key, rows in by_name.items():
        filing_rows = recovered.get(key, [])
        for row in rows:
            row.filing_rows = list(filing_rows)
            if key in duplicates:
                # Two published rows share this name after redaction: their evidence cannot
                # be split between them, so neither joins.
                row.duplicate = True
                row.units = [_whole_row_unit(fund.ticker, row, REFUSE_DUPLICATE_ROW)]
                continue
            row.units = _decide_row(fund.ticker, row, catalogue)


def _whole_row_unit(ticker: str, row: PublishedFundRow, reason: str) -> Unit:
    return Unit(
        ticker=ticker,
        name=row.name,
        bp=float(row.published_bp),
        decision=Decision(
            bucket=D_UNKNOWN,
            status=STATUS_REFUSED,
            reason=reason,
            target=None,
            evidence="",
            tier=None,
        ),
    )


def _decide_row(
    ticker: str, row: PublishedFundRow, catalogue: FundCatalogue
) -> list[Unit]:
    """Decide each filing row, then split the published weight across them.

    ``recovered_bp`` is the denominator of the split — the merged group's own filed weight.
    Where the artifact and the filing disagree (rounding, a dropped row) the published bp
    stays authoritative and the split is proportional, so no weight is created or lost.
    """
    if not row.filing_rows:
        decision = decide(_candidates(row.name, None, catalogue))
        return [Unit(ticker=ticker, name=row.name, bp=float(row.published_bp), decision=decision)]
    total = row.recovered_bp
    units: list[Unit] = []
    for filing_row in row.filing_rows:
        decision = decide(
            _candidates(row.name, filing_row, catalogue),
            money_market=looks_like_money_market(row.name, filing_row.title),
        )
        share = (filing_row.bp / total) if total > 0 else (1.0 / len(row.filing_rows))
        units.append(
            Unit(
                ticker=ticker,
                name=row.name,
                bp=row.published_bp * share,
                decision=decision,
                country=filing_row.country,
            )
        )
    return units


def _candidates(
    row_name: str, filing_row: FilingRow | None, catalogue: FundCatalogue
) -> Candidates:
    if filing_row is None:
        return Candidates(
            name=catalogue.name_candidates(row_name),
            near=catalogue.near_candidates(row_name),
            trust=catalogue.trust_candidates(row_name),
        )
    title_candidates = catalogue.name_candidates(filing_row.title)
    prefix = () if title_candidates else catalogue.prefix_candidates(filing_row.title)
    ticker_candidates = catalogue.ticker_candidates(filing_row.ticker)
    malformed = looks_like_cusip(filing_row.ticker)
    truncation = not title_candidates and not prefix and is_truncation_suspect(filing_row.title)
    return Candidates(
        name=catalogue.name_candidates(row_name),
        near=catalogue.near_candidates(row_name),
        title=title_candidates,
        title_prefix=prefix,
        ticker=ticker_candidates,
        trust=catalogue.trust_candidates(row_name),
        has_series_text=bool(filing_row.title),
        truncation_suspect=truncation,
        ticker_present_flag=bool(filing_row.ticker),
        ticker_malformed=malformed,
    )


def _summarise(
    release: Path,
    stats: dict[str, FundStats],
    catalogue: FundCatalogue,
    survey: IdentityKeySurvey,
) -> dict[str, Any]:
    published_gross = sum(fund.gross_bp for fund in stats.values())
    published_mapped = sum(fund.mapped_bp for fund in stats.values())
    fund_rows = [row for fund in stats.values() for row in fund.fund_rows]
    published_fund_bp = sum(row.published_bp for row in fund_rows)
    recovered_fund_bp = sum(row.recovered_bp for row in fund_rows)
    units = [unit for fund in stats.values() for unit in fund.units]
    recovered_by_name = {
        row.key: row.recovered_bp for row in fund_rows
    }

    buckets: dict[str, dict[str, Any]] = {
        bucket: {"bp": 0.0, "trusted_bp": 0.0, "refused_bp": 0.0, "rows": 0}
        for bucket in BUCKETS
    }
    tier_bp: Counter[str] = Counter()
    tier_rows: Counter[str] = Counter()
    reasons: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"bp": 0.0, "names": Counter()}
    )
    evidence_bp: Counter[str] = Counter()
    trust_named_bp = 0.0
    trust_series_dist: Counter[int] = Counter()
    trust_names: Counter[str] = Counter()
    money_market_bp = 0.0
    money_market_identified_bp = 0.0
    contradicted_bp = 0.0
    truncation_suspect_bp = 0.0
    country_bp: Counter[str] = Counter()
    country_joined_bp: Counter[str] = Counter()
    top_joined: Counter[str] = Counter()
    links: dict[str, list[tuple[str, float]]] = defaultdict(list)

    for unit in units:
        decision = unit.decision
        weight = unit.bp
        country = COUNTRY_US if unit.country == COUNTRY_US else "non_US_or_unknown"
        country_bp[country] += weight
        entry = buckets[decision.bucket]
        entry["bp"] += weight
        entry["rows"] += 1
        evidence_bp[decision.evidence or "none"] += weight
        if decision.joined:
            entry["trusted_bp"] += weight
            country_joined_bp[country] += weight
            top_joined[decision.target or ""] += weight
            links[unit.ticker].append((decision.target or "", weight))
        else:
            entry["refused_bp"] += weight
            reasons[decision.reason]["bp"] += weight
            reasons[decision.reason]["names"][unit.name] += int(weight)
            if decision.truncation_suspect:
                truncation_suspect_bp += weight
        if decision.tier:
            tier_bp[decision.tier] += weight
            tier_rows[decision.tier] += 1
        if decision.trust_series_count:
            trust_series_dist[min(decision.trust_series_count, 999)] += 1
            trust_names[unit.name] += int(weight)
            trust_named_bp += weight
        if decision.bucket == C_MONEY_MARKET:
            money_market_bp += weight
            if decision.target:
                money_market_identified_bp += weight
        if decision.reason == "series_key_name_disagrees":
            contradicted_bp += weight

    joined_bp = sum(tier_bp[tier] for tier in COUNTED_TIERS)
    coverage = _coverage_bands(stats)
    lookthrough = _lookthrough(stats, links)
    # Key-presence rates are over the fund-category *filing* rows that were recovered, not
    # over the published rows they merge into, and the denominator is stated with them.
    filing_row_bp = sum(fr.bp for fund in stats.values() for fr in fund.filing_rows)
    filing_row_count = sum(len(fund.filing_rows) for fund in stats.values())
    ticker_present_bp = sum(
        fr.bp for fund in stats.values() for fr in fund.filing_rows if fr.ticker
    )
    ticker_resolved_bp = sum(
        fr.bp
        for fund in stats.values()
        for fr in fund.filing_rows
        if catalogue.ticker_candidates(fr.ticker)
    )
    ticker_malformed_rows = sum(
        1 for fund in stats.values() for fr in fund.filing_rows if looks_like_cusip(fr.ticker)
    )
    cusip_present_rows = sum(
        1 for fund in stats.values() for fr in fund.filing_rows if fr.cusip
    )
    return {
        "release": release.name,
        "as_of": release.name,
        "catalogue": {
            "funds": len(catalogue.entries),
            "distinct_names": len(catalogue.by_name),
            "distinct_issuers": len(catalogue.by_issuer),
            "aliases": len(catalogue.aliases),
            "etf_classifier": catalogue.etf_classifier,
        },
        "funds": len(stats),
        "published": {
            "gross_bp": published_gross,
            "mapped_bp": published_mapped,
            "unmapped_bp": published_gross - published_mapped,
            "fund_unmapped_bp": published_fund_bp,
            "fund_rows": len(fund_rows),
            "fund_names": len({row.key for row in fund_rows}),
            "fund_rows_with_evidence": sum(1 for row in fund_rows if row.filing_rows),
            "fund_unmapped_pct_of_gross": _share(published_fund_bp, published_gross),
            "fund_unmapped_pct_of_unmapped": _share(
                published_fund_bp, published_gross - published_mapped
            ),
        },
        "recovered": {
            "fund_bp": recovered_fund_bp,
            "residual_bp": recovered_fund_bp - published_fund_bp,
            "reconciliation_pct": _share(recovered_fund_bp - published_fund_bp, published_fund_bp),
            "unattributed_published_bp": max(0.0, published_fund_bp - recovered_fund_bp),
            "funds_with_unreadable_filing": sum(1 for fund in stats.values() if fund.error),
            "filing_rows": filing_row_count,
            "filing_row_bp": filing_row_bp,
            "distinct_recovered_names": len(recovered_by_name),
        },
        "identity_keys": {
            **survey.as_dict(),
            "ticker_present_bp": ticker_present_bp,
            "ticker_present_pct": _share(ticker_present_bp, filing_row_bp),
            "ticker_resolved_bp": ticker_resolved_bp,
            "ticker_resolved_pct": _share(ticker_resolved_bp, filing_row_bp),
            "identity_joined_published_bp": tier_bp[TIER_IDENTITY],
            "ticker_malformed_rows": ticker_malformed_rows,
            "cusip_present_rows": cusip_present_rows,
        },
        "country": {
            "us_bp": country_bp[COUNTRY_US],
            "non_us_or_unknown_bp": country_bp["non_US_or_unknown"],
            "us_joined_bp": country_joined_bp[COUNTRY_US],
            "non_us_or_unknown_joined_bp": country_joined_bp["non_US_or_unknown"],
        },
        "classes": {
            bucket: {
                "label": BUCKET_LABELS[bucket],
                "bp": row["bp"],
                "units": row["rows"],
                "trusted_bp": row["trusted_bp"],
                "refused_bp": row["refused_bp"],
                "share_of_fund_unmapped_pct": _share(row["bp"], published_fund_bp),
                "share_of_gross_pct": _share(row["bp"], published_gross),
            }
            for bucket, row in buckets.items()
        },
        "joined": {
            "bp": joined_bp,
            "share_of_fund_unmapped_pct": _share(joined_bp, published_fund_bp),
            "share_of_gross_pct": _share(joined_bp, published_gross),
            "units": sum(tier_rows[tier] for tier in COUNTED_TIERS),
        },
        "tiers": {
            "bp": {tier: tier_bp[tier] for tier in TIERS},
            "units": {tier: tier_rows[tier] for tier in TIERS},
            "identity_bp": tier_bp[TIER_IDENTITY],
            "corroborated_bp": tier_bp[TIER_CORROBORATED],
            "uncorroborated_bp": tier_bp[TIER_UNCORROBORATED],
            "uncorroborated_pct": _share(tier_bp[TIER_UNCORROBORATED], published_fund_bp),
        },
        "evidence": {
            label: {"bp": weight, "share_pct": _share(weight, published_fund_bp)}
            for label, weight in sorted(evidence_bp.items(), key=lambda item: -item[1])
        },
        "trust_named": {
            "bp": trust_named_bp,
            "distinct_names": len(trust_names),
            "share_of_fund_unmapped_pct": _share(trust_named_bp, published_fund_bp),
            "top": [{"name": name, "bp": bp} for name, bp in trust_names.most_common(15)],
            "candidate_series": {
                "1": trust_series_dist[1],
                "2-5": sum(count for key, count in trust_series_dist.items() if 2 <= key <= 5),
                "6-50": sum(count for key, count in trust_series_dist.items() if 6 <= key <= 50),
                "51+": sum(count for key, count in trust_series_dist.items() if key > 50),
            },
        },
        "money_market": {
            "bp": money_market_bp,
            "identified_bp": money_market_identified_bp,
            "share_of_fund_unmapped_pct": _share(money_market_bp, published_fund_bp),
        },
        "name_contradicted_bp": contradicted_bp,
        "truncation_suspect_bp": truncation_suspect_bp,
        "refusals": [
            {
                "reason": reason,
                "bp": row["bp"],
                "names": len(row["names"]),
                "share_of_fund_unmapped_pct": _share(row["bp"], published_fund_bp),
                "top": [{"name": name, "bp": bp} for name, bp in row["names"].most_common(12)],
            }
            for reason, row in sorted(reasons.items(), key=lambda item: -item[1]["bp"])
        ],
        "coverage": coverage,
        "lookthrough": lookthrough,
        "top_joined_funds": [
            {"ticker": ticker, "bp": bp} for ticker, bp in top_joined.most_common(20)
        ],
    }


def _share(numerator: float, denominator: float) -> float:
    return round(100 * numerator / denominator, 4) if denominator else 0.0


def _coverage(mapped_bp: float, gross_bp: float) -> float:
    """``coverage_pct`` exactly as the contract defines it: gross denominator, one decimal."""
    return round(100 * mapped_bp / gross_bp, 1) if gross_bp > 0 else 0.0


def _identity_joined_bp(fund: FundStats) -> float:
    """Published bp the join attributes to a fund we publish, money-market excluded."""
    return sum(
        unit.bp
        for unit in fund.units
        if unit.decision.joined and unit.decision.bucket != C_MONEY_MARKET
    )


def _lookthrough_joined_bp(fund: FundStats, stats: dict[str, FundStats]) -> float:
    """Company weight recovered by looking through one fund's joined rows, depth 1."""
    total = 0.0
    for unit in fund.units:
        if not unit.decision.joined or unit.decision.bucket == C_MONEY_MARKET:
            continue
        target = unit.decision.target or ""
        inner = stats.get(target)
        if inner is None or inner.gross_bp <= 0 or target == fund.ticker:
            continue
        total += unit.bp * (inner.mapped_bp / inner.gross_bp)
    return total


def _coverage_bands(stats: dict[str, FundStats]) -> dict[str, Any]:
    """The per-fund coverage histogram, before and after the join, plus the crossings.

    Two readings, because they are two different claims:

    * ``after_identity`` — the row is attributed to a *fund we publish*. Coverage rises
      because the row is no longer unmapped; the company layer has not moved.
    * ``after_lookthrough`` — each joined row is replaced by the matched fund's own mapped
      weight at that fund's own coverage, one level deep. This is the only version that can
      justify showing a company metric.

    Both use the contract's denominator: gross holding weight, mapped weight over it,
    ``coverage_pct`` to one decimal (``data-contract-and-release`` §2). Crossings are
    counted per fund — ``before < gate <= after`` — not by differencing band sizes, which
    would net a fund that left a band at the top against one that entered it at the bottom.
    Money-market and lending weight is excluded from both readings, stated rather than
    netted silently.
    """
    before = {ticker: fund.coverage_pct for ticker, fund in stats.items()}
    identity = {
        ticker: _coverage(fund.mapped_bp + _identity_joined_bp(fund), fund.gross_bp)
        for ticker, fund in stats.items()
    }
    lookthrough = {
        ticker: _coverage(fund.mapped_bp + _lookthrough_joined_bp(fund, stats), fund.gross_bp)
        for ticker, fund in stats.items()
    }
    return {
        "denominator": "gross holding weight per fund (sum |weight_bp|); coverage_pct to one decimal",
        "before": _bands(stats, before),
        "after_identity": _bands(stats, identity),
        "after_lookthrough": _bands(stats, lookthrough),
        "funds_moved": {
            "partial_gate": _crossed(stats, before, identity, GATE_PARTIAL_PCT),
            "ranked_gate": _crossed(stats, before, identity, GATE_RANKED_PCT),
            "partial_gate_lookthrough": _crossed(stats, before, lookthrough, GATE_PARTIAL_PCT),
            "ranked_gate_lookthrough": _crossed(stats, before, lookthrough, GATE_RANKED_PCT),
        },
        "published_vs_recomputed": _coverage_drift(stats.values()),
    }


def _bands(stats: dict[str, FundStats], coverage: dict[str, float]) -> dict[str, Any]:
    bands = {
        "under_60": {"funds": 0, "gross_bp": 0.0},
        "60_to_70": {"funds": 0, "gross_bp": 0.0},
        "70_and_up": {"funds": 0, "gross_bp": 0.0},
    }
    for ticker, fund in stats.items():
        value = coverage[ticker]
        band = (
            "under_60"
            if value < GATE_PARTIAL_PCT
            else "60_to_70"
            if value < GATE_RANKED_PCT
            else "70_and_up"
        )
        bands[band]["funds"] += 1
        bands[band]["gross_bp"] += fund.gross_bp
    total = sum(band["gross_bp"] for band in bands.values())
    for band in bands.values():
        band["gross_pct"] = _share(band["gross_bp"], total)
    return bands


def _crossed(
    stats: dict[str, FundStats],
    before: dict[str, float],
    after: dict[str, float],
    gate: float,
) -> dict[str, Any]:
    """Funds that were below ``gate`` and are at or above it after the change."""
    crossed = [ticker for ticker in stats if before[ticker] < gate <= after[ticker]]
    return {
        "gate_pct": gate,
        "funds": len(crossed),
        "gross_bp": sum(stats[ticker].gross_bp for ticker in crossed),
        "by_ticker": sorted(crossed),
        "before_band": {
            "funds": sum(1 for value in before.values() if value >= gate),
            "gross_bp": sum(fund.gross_bp for ticker, fund in stats.items() if before[ticker] >= gate),
        },
        "after_band": {
            "funds": sum(1 for value in after.values() if value >= gate),
            "gross_bp": sum(fund.gross_bp for ticker, fund in stats.items() if after[ticker] >= gate),
        },
    }


def _coverage_drift(funds: Iterable[FundStats]) -> dict[str, Any]:
    """Recomputed coverage against the published field — a check on the denominator."""
    worst = 0.0
    mismatched = 0
    for fund in funds:
        drift = abs(fund.coverage_pct - fund.published_coverage_pct)
        worst = max(worst, drift)
        if drift > 0.05:
            mismatched += 1
    return {"max_abs_drift_pct": round(worst, 3), "funds_over_tolerance": mismatched}


def _lookthrough(stats: dict[str, FundStats], links: dict[str, list[tuple[str, float]]]) -> dict[str, Any]:
    """What honest look-through adds, depth 1 and depth 2, with loops terminated.

    Depth 1 replaces each joined fund-share row with the matched fund's *mapped* weight — the
    whole position does not become a company, only the part of the inner fund that is
    attributed today. Depth 2 continues through the inner fund's own joined rows.

    Loops are why this is not a recursive sum: a fund can hold another fund that holds the
    first. Every walk carries its path, a repeat is counted as a cycle with its weight, and
    the branch stops. A fund holding itself is a cycle of length one and is caught by the
    same rule — termination is a property of the code, not of the data being well behaved.
    """
    depth1_total = 0.0
    depth2_total = 0.0
    cycles: list[dict[str, Any]] = []
    self_holds = 0
    joined_links = 0
    for outer in sorted(stats):
        for target, weight in links.get(outer, ()):
            inner = stats.get(target)
            if inner is None or inner.gross_bp <= 0:
                continue
            joined_links += 1
            if target == outer:
                self_holds += 1
                cycles.append({"path": [outer, target], "bp": weight, "depth": 1})
                continue
            depth1_total += weight * (inner.mapped_bp / inner.gross_bp)
            for second, second_weight in links.get(target, ()):
                grand = stats.get(second)
                if grand is None or grand.gross_bp <= 0:
                    continue
                if second in (outer, target):
                    cycles.append(
                        {"path": [outer, target, second], "bp": second_weight, "depth": 2}
                    )
                    continue
                depth2_total += (
                    weight * (second_weight / inner.gross_bp) * (grand.mapped_bp / grand.gross_bp)
                )
    published_gross = sum(fund.gross_bp for fund in stats.values())
    fund_gap_bp = sum(row.published_bp for fund in stats.values() for row in fund.fund_rows)
    return {
        "depth1": {
            "company_bp": depth1_total,
            "share_of_fund_unmapped_pct": _share(depth1_total, fund_gap_bp),
            "share_of_gross_pct": _share(depth1_total, published_gross),
            "joined_links": joined_links,
        },
        "depth2": {
            "company_bp": depth2_total,
            "share_of_gross_pct": _share(depth2_total, published_gross),
            "share_of_fund_unmapped_pct": _share(depth2_total, fund_gap_bp),
            "shippable": False,
            "note": "lookthrough-math-and-qa §1 fixes look-through at one level deep [dec]",
        },
        "cycles": {
            "count": len(cycles),
            "self_holds": self_holds,
            "bp": sum(cycle["bp"] for cycle in cycles),
            "examples": sorted(cycles, key=lambda cycle: -cycle["bp"])[:10],
            "terminated": True,
        },
    }


# --- the CLI ----------------------------------------------------------


def _format_bp(value: float) -> str:
    return f"{value:,.0f}"


def render_summary(report: dict[str, Any], *, top: int = 10) -> str:
    """The measurement as text: buckets, tiers, refusals, coverage, look-through."""
    published = report["published"]
    recovered = report["recovered"]
    joined = report["joined"]
    tiers = report["tiers"]
    keys = report["identity_keys"]
    lines: list[str] = []
    lines.append(
        f"fund-share join — release {report['release']}: {report['funds']:,} funds, "
        f"{_format_bp(published['gross_bp'])} bp published gross"
    )
    lines.append(
        f"  catalogue {report['catalogue']['funds']:,} funds · "
        f"{report['catalogue']['distinct_names']:,} distinct names · "
        f"{report['catalogue']['distinct_issuers']:,} registrants · "
        f"{report['catalogue']['aliases']:,} class aliases "
        f"({report['catalogue']['etf_classifier'] or 'no'} ETF classifier)"
    )
    lines.append("")
    lines.append(
        f"unmapped fund-category weight: {_format_bp(published['fund_unmapped_bp'])} bp "
        f"({published['fund_unmapped_pct_of_gross']}% of gross, "
        f"{published['fund_unmapped_pct_of_unmapped']}% of all unmapped), "
        f"{published['fund_rows']:,} published rows, {published['fund_names']:,} distinct names, "
        f"{published['fund_rows_with_evidence']:,} rows with filing evidence"
    )
    lines.append(
        f"  recovered from the filings: {_format_bp(recovered['fund_bp'])} bp "
        f"in {recovered['filing_rows']:,} filing rows — residual "
        f"{recovered['residual_bp']:+,.0f} bp ({recovered['reconciliation_pct']:+.3f}%)"
    )
    if recovered["funds_with_unreadable_filing"]:
        lines.append(
            f"  funds with an unreadable filing: {recovered['funds_with_unreadable_filing']:,}"
        )
    lines.append(
        f"  identity keys: ticker present on {keys['ticker_present_pct']:.1f}% of filing-row "
        f"weight and resolving on {keys['ticker_resolved_pct']:.1f}%; CUSIP present on "
        f"{keys['cusip_present_rows']:,} rows but NOT joinable — "
        f"{keys['class_ids_sec_shaped']:,} of {keys['class_ids']:,} ids in our own filing "
        f"headers are SEC class IDs, {keys['class_ids_cusip_shaped']} are CUSIP-shaped"
    )
    country = report["country"]
    lines.append(
        f"  by investment country: US {_format_bp(country['us_bp'])} bp "
        f"(joined {_format_bp(country['us_joined_bp'])}), non-US/unknown "
        f"{_format_bp(country['non_us_or_unknown_bp'])} bp "
        f"(joined {_format_bp(country['non_us_or_unknown_joined_bp'])})"
    )
    lines.append("")
    lines.append("| class | bp | trusted bp | refused bp | % of fund gap | % of gross |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for bucket in BUCKETS:
        row = report["classes"][bucket]
        lines.append(
            f"| {row['label']} | {_format_bp(row['bp'])} | "
            f"{_format_bp(row['trusted_bp'])} | {_format_bp(row['refused_bp'])} | "
            f"{row['share_of_fund_unmapped_pct']:.2f}% | {row['share_of_gross_pct']:.2f}% |"
        )
    lines.append("")
    lines.append(
        f"join that survives scrutiny: {_format_bp(joined['bp'])} bp "
        f"({joined['share_of_fund_unmapped_pct']:.2f}% of the fund gap, "
        f"{joined['share_of_gross_pct']:.2f}% of published gross) — identity "
        f"{_format_bp(tiers['identity_bp'])} + corroborated "
        f"{_format_bp(tiers['corroborated_bp'])} bp"
    )
    lines.append(
        f"  single-field matches (measured, NOT counted): "
        f"{_format_bp(tiers['uncorroborated_bp'])} bp "
        f"({tiers['uncorroborated_pct']:.2f}% of the fund gap) — this is what a naive "
        f"exact-name join would have claimed"
    )
    trust = report["trust_named"]
    lines.append(
        f"  rows whose name is a registrant trust: {_format_bp(trust['bp'])} bp "
        f"({trust['share_of_fund_unmapped_pct']:.2f}%), {trust['distinct_names']:,} names, "
        f"candidate series per name {trust['candidate_series']}"
    )
    lines.append("")
    lines.append("refusals — why the rest does not close:")
    # The reason names are of different lengths and one of them is long: sizing the column to
    # the widest keeps the bp column readable instead of ragged.
    width = max((len(row["reason"]) for row in report["refusals"][:top]), default=0)
    for row in report["refusals"][:top]:
        examples = ", ".join(f"{item['name']} {_format_bp(item['bp'])}" for item in row["top"][:3])
        lines.append(
            f"  {row['reason']:<{width}} {_format_bp(row['bp']):>10} bp "
            f"{row['share_of_fund_unmapped_pct']:>6.1f}%  {examples}"
        )
    coverage = report["coverage"]
    lines.append("")
    lines.append(
        f"coverage bands (denominator: {coverage['denominator']}; published-vs-recomputed "
        f"drift {coverage['published_vs_recomputed']['max_abs_drift_pct']} pct, "
        f"{coverage['published_vs_recomputed']['funds_over_tolerance']} funds over tolerance)"
    )
    lines.append("| band | before | after identity join | after look-through (depth 1) |")
    lines.append("|---|---:|---:|---:|")
    for band, label in (
        ("under_60", "under 60% (not covered)"),
        ("60_to_70", "60–70% (partial)"),
        ("70_and_up", "70%+ (rankable)"),
    ):
        before = coverage["before"][band]
        identity = coverage["after_identity"][band]
        look = coverage["after_lookthrough"][band]
        lines.append(
            f"| {label} | {before['funds']:,} funds / {_format_bp(before['gross_bp'])} bp | "
            f"{identity['funds']:,} / {_format_bp(identity['gross_bp'])} | "
            f"{look['funds']:,} / {_format_bp(look['gross_bp'])} |"
        )
    moved = coverage["funds_moved"]
    lines.append("")
    for key, label in (
        ("partial_gate", "60% gate (identity)"),
        ("partial_gate_lookthrough", "60% gate (look-through)"),
        ("ranked_gate", "70% gate (identity)"),
        ("ranked_gate_lookthrough", "70% gate (look-through)"),
    ):
        row = moved[key]
        lines.append(
            f"crossing the {label:<26} {row['funds']:>5,} funds "
            f"{_format_bp(row['gross_bp']):>12} bp of gross "
            f"(band {row['before_band']['funds']:,} → {row['after_band']['funds']:,} funds)"
        )
    look = report["lookthrough"]
    lines.append("")
    lines.append(
        f"look-through: depth 1 adds {_format_bp(look['depth1']['company_bp'])} bp of company "
        f"weight ({look['depth1']['share_of_gross_pct']:.2f}% of published gross) across "
        f"{look['depth1']['joined_links']:,} joined links; depth 2 adds "
        f"{_format_bp(look['depth2']['company_bp'])} bp more "
        f"({look['depth2']['share_of_gross_pct']:.2f}% of gross; not shippable — one level "
        "deep [dec])"
    )
    cycles = look["cycles"]
    lines.append(
        f"  cycles: {cycles['count']:,} found (self-holdings {cycles['self_holds']:,}), "
        f"{_format_bp(cycles['bp'])} bp involved, every walk terminated"
    )
    lines.append(
        f"  money-market/lending share: {_format_bp(report['money_market']['bp'])} bp "
        f"({report['money_market']['share_of_fund_unmapped_pct']:.2f}%), "
        f"{_format_bp(report['money_market']['identified_bp'])} bp of it identifiable"
    )
    if report["name_contradicted_bp"]:
        lines.append(
            f"  joins where a machine key overrode a disagreeing name: "
            f"{_format_bp(report['name_contradicted_bp'])} bp"
        )
    if report["truncation_suspect_bp"]:
        lines.append(
            f"  refusals where the filed title looks truncated: "
            f"{_format_bp(report['truncation_suspect_bp'])} bp"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.fund_shares",
        description="Measure the fund-share join against our own published catalogue.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    measure_parser = sub.add_parser(
        "measure", help="classify and measure the unmapped fund-category rows"
    )
    measure_parser.add_argument(
        "--release", type=Path, default=DEFAULT_RELEASE, help="a built release directory"
    )
    measure_parser.add_argument(
        "--filing-cache", type=Path, default=None, help="N-PORT cache (default: data/cache)"
    )
    measure_parser.add_argument("--limit", type=int, default=0, help="first N funds only (0 = all)")
    measure_parser.add_argument("--top", type=int, default=10, help="rows per table")
    measure_parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)

    if args.command != "measure":  # pragma: no cover - argparse enforces one command
        parser.error("unknown command")

    report = measure(
        args.release,
        filing_cache=args.filing_cache,
        limit=args.limit,
        progress=lambda message: print(f"  {message}", file=sys.stderr, flush=True),
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=False))
    else:
        print(render_summary(report, top=args.top))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
