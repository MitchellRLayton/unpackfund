"""The company→country map, and the vote that decides it.

No filing states a company's country. N-PORT reports ``invCountry`` per *holding
row*, so a company's domicile has to be decided from the funds that hold it, and
the ledger's country tag is only honest if that decision is stated, weighted, and
allowed to fail. This module owns the decision and the compact object a browser
reads:

    companies/countries.json    company_id -> ISO 3166-1 alpha-2, pre-rolled

Four rules, each of which exists because the alternative is a guess:

* **Value-weighted majority at a stated floor.** Every publishing fund adds the
  dollar value of its position in the company to that company's country tally, and
  a country is published only when the winner holds at least ``MIN_AGREEMENT_BP`` of
  the company's traced value. Below the floor the company has **no** country: a
  company reported as US by 60% of the money and IE by 40% is evidence of
  disagreement, not of domicile, and the US-only answer would be a proxy
  (``lookthrough-math-and-qa`` §5).
* **Two filings, minimum.** One row from one fund is a single source, and N-PORT
  filers do sometimes put their own country in ``invCountry``. A company named by
  one filing gets no tag; the seed is not allowed to look like a consensus.
* **A code that is not ISO alpha-2 is not a vote.** Files carry blanks, names and
  occasional junk in that element; only a two-letter alphabetic value counts. The
  number of rows thrown away is published as a build statistic (``invalid_rows``,
  like ``catalogue.etf_classifier``: provenance the validator cannot recompute).
* **A fund position does not vote, and is never placed.** A row classified ``fund``
  is another fund's *domicile*, not a company's — VT is a US-domiciled fund that
  holds the world, so a tag reading "US" beside a global fund would be worse than no
  tag. Excluding fund rows is also what keeps the map a projection of what the
  release publishes: a flattened wrapper's sleeve rows leave the published vector, so
  a sleeve that only ever voted through a wrapper would appear in the map with no
  company shard behind it — which the validator caught on the first wide build
  (`2026-11-02.7`: `extra ['c_0001327068', 'c_0001383062', 'c_0001383082']`).
* **Absence is the answer for the undecided.** A company with no country key in the
  map is not "unknown country" to be defaulted — it is a company we decline to
  place, and the ledger shows no tag.
* **But an undecided company is asked once more, of its own registry record.** The
  vote is a consensus over *holders*; a company's own registry already knows where it
  is registered, and on the 2026-11-02.7 release that second question placed 1,610 of
  the 1,610 LEI companies and 862 of the 1,092 CIK companies the vote could not
  decide — leaving 230 of 12,895 unplaced, against 2,702 before. The fallback is
  therefore not a tie-break inside the vote — it never touches a company the vote
  decided — and it is tried in one fixed order: GLEIF ``jurisdiction`` (the golden
  copy is already cached for the ``l_`` namespace, and it is CC0), then EDGAR
  ``stateOfIncorporation`` for a ``c_`` company, through the pipeline's own request
  cache. A company neither record places stays absent, which is still the answer
  rather than an error.
* **The fallback has to reproduce the vote, or the build fails.** Both sources are
  asked about companies the vote *did* decide, and the share that agrees with the
  published country is computed on every build and published beside the counts
  (``agreement``). A source that agrees below its floor is not "new data disagreeing
  with old data" — it means the code table (EDGAR) or the field being read (GLEIF)
  is wrong, so the build raises instead of shipping a quietly worse map. Sample
  sizes are published with the rates, and a floor is only enforced once the
  comparison set is big enough to mean something.

Arithmetic is integer dollars, not floats: the same release built twice must
produce the same bytes, and float addition is not associative across the order the
thread pool finishes funds in (``validate._check_company_countries`` re-derives the
projection, so a drifting tally would fail the release rather than ship).
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable, Mapping

from pipeline import classify, gleif

from .artifact import sha256_hex

#: Bumped only for a breaking change to this object's shape.
SCHEMA_VERSION = 1

#: ``kind`` names the object so a consumer cannot read a fund document as one.
KIND = "company_countries"

SOURCE = "SEC N-PORT invCountry"

#: The decision rule, in the object itself, because a reader of the data is entitled
#: to know how the fact was inferred without finding this module.
RULE = "value-weighted majority of the funds holding the company; published only at or above 80% agreement"

#: The agreement floor, in basis points of the company's traced value.
MIN_AGREEMENT_BP = 8_000

#: How many independent filings must name the company before its country is decided.
MIN_FILINGS = 2

#: The floor for the *contested* map, in basis points of the company's traced value.
#: Deliberately lower than ``MIN_AGREEMENT_BP``, because it answers a different
#: question: not "what is this company's domicile" but "which market holds the largest
#: share of the money in it". A company the vote refuses to place is still weight the
#: Markets bar has to draw somewhere, and the largest share is the best answer the
#: filings contain — but a three-way split has no plurality, so the floor stays.
MIN_PLURALITY_BP = 4_000

#: The contested rule, published beside the vote's rule so a reader can see that the
#: bar's answer and the company tag's answer are two questions, not one number twice.
CONTESTED_RULE = (
    "for a company the vote does not decide, the country holding the largest share of "
    "its traced value, at or above 40%; used only to place the position in a market "
    "bucket, never as the company's country tag"
)

#: The fallback rule, published in the object beside the vote's rule: a reader is
#: entitled to know that two questions were asked, in which order, and that neither
#: answer overrides the vote.
FALLBACK_RULE = (
    "for a company the vote does not decide, its own registry record: GLEIF "
    "jurisdiction for an LEI entity, then EDGAR stateOfIncorporation for a CIK "
    "company, then the state or country of incorporation on that company's own "
    "annual report cover page; no answer overrides a decided company, and a company "
    "no record places stays undecided"
)

#: Agreement floors for the fallback, in basis points of the companies both answers
#: cover. Below these the table or the field is wrong, not the data: GLEIF agreed on
#: 5,958 of 6,003 decided LEI companies (9,925 bp) and EDGAR on 335 of 342 (9,795 bp)
#: on the 2026-11-02 release, so a rate under these floors cannot be explained by the
#: exceptions we already understand — Cayman and Bermuda holdcos whose N-PORT country
#: is the listing venue, dual-domiciled names — because those cost 0.75% and 2%, not
#: 5%. The floors sit 225 bp and 295 bp under the measured rates: wide enough for a
#: sample of 342 to move, narrow enough that a wrong code table cannot pass.
MIN_GLEIF_AGREEMENT_BP = 9_700
MIN_EDGAR_AGREEMENT_BP = 9_500

#: The agreement floor for the cover-page rung, in basis points of the companies both
#: answers cover. Measured 9,871 bp on the 2026-11-04 release — 154 of the 156
#: companies the vote decided and the cover page also answered — so the floor sits
#: 371 bp under the measured rate, the same headroom the other two sources carry. The
#: two disagreements were both ``IL`` → ``US``: Israeli companies incorporated in
#: Delaware, which is the dual-domicile class this floor exists to tolerate.
MIN_COVER_AGREEMENT_BP = 9_500

#: The annual reports whose cover page states a jurisdiction. A company that files
#: none of these has no cover page to read, which is an answer rather than an error.
COVER_PAGE_FORMS = ("10-K", "20-F", "40-F")

#: The cover page's own field, as EDGAR's ``R1.htm`` rendering prints it. Two
#: spellings because the label is rendered from the filing's own text and both appear
#: in the wild; the value is required to be uppercase alphanumeric, which is what stops
#: an empty cell from capturing the first two letters of the next label.
_COVER_PAGE_CODE = re.compile(
    r"(?:Entity Incorporation, State or Country Code|State or Country of Incorporation)"
    r"[:\s]*([A-Z0-9]{2})\b"
)

#: The smallest comparison set a floor is enforced on. A rate over 40 companies is
#: noise; the build publishes the rate and the counts either way, and only refuses
#: the release once the sample can carry the claim.
MIN_AGREEMENT_SAMPLE = 200

#: How many already-decided CIK companies the build asks EDGAR about, so the EDGAR
#: rate has a comparison set at all. Chosen once and measured: the deterministic
#: sample (sorted by sha256 of the company id) of 400 ids answered with a mappable
#: code for 342 of them on the 2026-11-02 release — over the 200 a floor is enforced
#: on, which is the only reason the size is in the code at all.
EDGAR_AGREEMENT_SAMPLE = 400

#: How long a cached EDGAR submissions document is trusted, in seconds. A company's
#: state of incorporation does not change on a filing cadence, and this is the same
#: six-hour-at-the-shortest discipline as the rest of the pipeline: the number only
#: has to be short enough that a re-run after a broken fetch heals.
EDGAR_MAX_AGE_S = 30 * 24 * 60 * 60

#: EDGAR's ``stateOfIncorporation`` vocabulary is its own: a US state code, a
#: Canadian province, or an alphanumeric country code that is *not* ISO. Resolving it
#: is therefore ordered — a US state first, because ``DE`` is Delaware and Germany is
#: ``2M``; ``CA`` is California before it is Canada, and Canada's provinces are
#: ``A1``/``A6``/``Z4``/... rather than ``CA``.
US_STATES = frozenset(
    {
        "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
        "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
        "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
        "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
        "WV", "WI", "WY",
        # Territories, which EDGAR also files as a state of incorporation.
        "AS", "GU", "MP", "PR", "VI",
    }
)

#: Canadian provinces and territories, EDGAR's other literal vocabulary.
CA_PROVINCES = frozenset(
    {"AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"}
)

#: EDGAR foreign incorporation code -> ISO 3166-1 alpha-2, and the number of
#: already-decided CIK companies that carried the code in the 2026-11-02 join (450
#: decided companies, 367 with a code; every count below is the whole sample for that
#: code, and all of them agreed except where noted in the build log).
#: Only codes that were unanimous and observed more than a handful of times are here.
#: The five that are **not** here are absent on purpose, and the reason is the same
#: for all of them: either too thin to be evidence or already mixed —
#: ``D8`` (3 observations: CN/KY/VG), ``U3`` (2: LU/ES), ``C3`` (2: AU/NO), ``X1``
#: (1: US), ``A4`` (1: CA). A company whose code is absent stays undecided, which is
#: the same answer a company with no code gets (``2026-11-02`` build log).
EDGAR_COUNTRY_CODES: dict[str, str] = {
    "2M": "DE",  # 5
    "A0": "CA",  # 5
    "A1": "CA",  # 24
    "A6": "CA",  # 11
    "A8": "CA",  # 3
    "C1": "AR",  # 2
    "D0": "BM",  # 6
    "D5": "BR",  # 3
    "E9": "KY",  # 27
    "F3": "CL",  # 1
    "F5": "TW",  # 1
    "G7": "DK",  # 1
    "I0": "FR",  # 5
    "K3": "HK",  # 1
    "K7": "IN",  # 1
    "L2": "IE",  # 1
    "L3": "IL",  # 7
    "L6": "IT",  # 1
    "M0": "JP",  # 10
    "N4": "LU",  # 1
    "O5": "MX",  # 1
    "P7": "NL",  # 6
    "R1": "PA",  # 1
    "T3": "ZA",  # 1
    "U0": "SG",  # 1
    "V7": "SE",  # 4
    "V8": "CH",  # 7
    "X0": "GB",  # 17
    "Y8": "IM",  # 1
    "Z4": "CA",  # 11
    "1T": "MH",  # 2
}


class CountryFallbackError(RuntimeError):
    """A fallback source stopped reproducing the vote, so the build refuses."""

#: The ceiling on the object. It exists to fail a build, not to warn: the object's
#: only reason to exist is being small enough for `/x`. The wide universe is about
#: 5,000 companies, ~110 kB raw and ~30 kB gzipped, so this is a wide margin.
MAX_COUNTRIES_BYTES = 2_000_000


class Tally:
    """Per-company country votes, in whole dollars and filing counts.

    Two dicts rather than a list of rows because the release only needs the
    decision, and 8,500 funds × 1,000 companies of retained votes would be the
    largest object the build holds in memory. Funds fold their votes here and are
    then free — ``build._walk`` does exactly that.
    """

    __slots__ = ("dollars", "filings", "invalid_rows")

    def __init__(self) -> None:
        self.dollars: dict[str, dict[str, int]] = {}
        self.filings: dict[str, dict[str, int]] = {}
        #: Filing rows that carried an ``invCountry`` which was not an alpha-2 code.
        #: Published as a build statistic so a release cannot hide what it discarded.
        self.invalid_rows = 0

    def add_fund(
        self,
        votes: Mapping[str, tuple[str, int]],
        net_assets: float | None,
        invalid_rows: int = 0,
    ) -> None:
        """Fold one fund's ``company_id -> (country, abs weight_bp)`` into the tally.

        The dollar value is the fund's own claim on the company — its weight times
        its net assets — so a $500bn index fund outvotes a $10m specialty fund on
        the same company, which is what "by value" means in the object's ``rule``.
        """
        self.invalid_rows += int(invalid_rows)
        assets = float(net_assets or 0.0)
        for company_id, (country, weight_bp) in votes.items():
            dollars = int(abs(weight_bp) * assets / 10_000.0) if assets else 0
            per_country = self.dollars.setdefault(company_id, {})
            per_country[country] = per_country.get(country, 0) + dollars
            filers = self.filings.setdefault(company_id, {})
            filers[country] = filers.get(country, 0) + 1

    def companies(self) -> int:
        return len(self.dollars)


def is_country_code(value: object) -> bool:
    """ISO 3166-1 alpha-2, uppercase: two letters and nothing else.

    Deliberately strict. ``invCountry`` also carries blanks, country *names*
    (``UNITED STATES``), and three-letter codes from filers who used a different
    vocabulary; accepting them would put an unvetted string in a published field and
    in a colour, and a two-letter field is what the consumer's tag can render.
    """
    return isinstance(value, str) and len(value) == 2 and value.isalpha() and value.isupper()


def decide(tally: Tally) -> tuple[dict[str, str], dict[str, int]]:
    """``company_id -> country`` for the companies the filings actually decide.

    Returns the map plus the build statistics that are not recomputable from the
    release (how many companies had any vote, how many fell below the floor). A
    company that fails either floor is **absent** from the map — never defaulted,
    never carried as ``null``.
    """
    decided: dict[str, str] = {}
    below_floor = 0
    for company_id in sorted(tally.dollars):
        per_country = tally.dollars[company_id]
        filers = tally.filings.get(company_id, {})
        total = sum(per_country.values())
        if not total:
            below_floor += 1
            continue
        # Sorted, so a tie cannot be decided by dict order.
        ranked = sorted(per_country.items(), key=lambda pair: (-pair[1], pair[0]))
        winner, value = ranked[0]
        if value * 10_000 < total * MIN_AGREEMENT_BP:
            below_floor += 1
            continue
        if filers.get(winner, 0) < MIN_FILINGS:
            below_floor += 1
            continue
        decided[company_id] = winner
    return decided, {"with_votes": tally.companies(), "below_floor": below_floor}


def contested(tally: Tally, undecided: Iterable[str]) -> dict[str, str]:
    """``company_id -> country`` for the companies the vote could not decide.

    A second, weaker answer to a *different* question, published beside the first and
    never merged into it. The vote asks what a company's domicile is and refuses to
    answer when the filings split; this asks which market holds the largest share of
    the money in it, and answers with that share at ``MIN_PLURALITY_BP``.

    The Markets bar needs the second question answered — a position with no market is
    weight the bar cannot draw — while the company tag keeps the first answer, which
    is still "we decline to place it". Keeping them in one map would let a 45% share
    wear the authority of an 80% one.

    A company whose largest share is below the floor is absent here too: a three-way
    split has no plurality, and picking the biggest third would be a coin flip wearing
    a number.
    """
    out: dict[str, str] = {}
    for company_id in sorted(undecided):
        per_country = tally.dollars.get(company_id)
        if not per_country:
            continue
        total = sum(per_country.values())
        if not total:
            continue
        # Sorted, so a tie cannot be decided by dict order.
        ranked = sorted(per_country.items(), key=lambda pair: (-pair[1], pair[0]))
        winner, value = ranked[0]
        if value * 10_000 < total * MIN_PLURALITY_BP:
            continue
        if tally.filings.get(company_id, {}).get(winner, 0) < MIN_FILINGS:
            continue
        out[company_id] = winner
    return out


# --- the fallback ----------------------------------------------------------


def cik_of(company_id: str) -> str | None:
    """The zero-padded CIK a ``c_`` id carries, or ``None`` for another namespace."""
    if not company_id.startswith("c_"):
        return None
    digits = company_id[2:]
    return digits if digits.isdigit() and len(digits) == 10 else None


def gleif_country(jurisdiction: str | None) -> str | None:
    """GLEIF ``jurisdiction`` → ISO alpha-2: ``US-DE`` → ``US``, ``KY`` → ``KY``.

    GLEIF records a US entity's jurisdiction as a state (``US-DE``) and everyone
    else's as a country, so the part before the hyphen is the answer. A jurisdiction
    that is not two letters — or a country GLEIF spelled in another vocabulary — is
    no answer, never a guess.
    """
    if not jurisdiction:
        return None
    head = jurisdiction.strip().upper().split("-", 1)[0]
    return head if is_country_code(head) else None


def edgar_country(code: str | None) -> str | None:
    """EDGAR ``stateOfIncorporation`` → ISO alpha-2, or ``None`` when unmapped.

    Ordered on purpose (see ``US_STATES``): the field is EDGAR's own vocabulary, in
    which ``DE`` is Delaware and Germany is ``2M``, and ``CA`` is California — a
    company incorporated in Canada carries a province code (``A1``, ``A6``, ``Z4``…).
    A code that is not in the table and not a state or province is an answer we do
    not have, so the company stays undecided.
    """
    if not code:
        return None
    value = code.strip().upper()
    if value in US_STATES:
        return "US"
    if value in CA_PROVINCES:
        return "CA"
    return EDGAR_COUNTRY_CODES.get(value)


def release_companies(documents: Iterable[Mapping[str, Any]]) -> set[str]:
    """Every company the release publishes a shard for.

    Deliberately the same filter ``catalogue.company_objects`` applies — a row with
    a zero weight publishes no shard — because a country placed on a company the
    catalogue omitted is an *extra* key, and the release's projection gate refuses it
    (``validate._check_company_countries``).
    """
    return {
        row["company_id"]
        for document in documents
        for row in document.get("holdings", ())
        if row.get("company_id") and int(row.get("weight_bp") or 0)
    }


def project(decided: Mapping[str, str], companies: Iterable[str]) -> dict[str, str]:
    """The map as the release publishes it: only companies the release has a shard for.

    The vote's tally is built from every holding the build read, and the shards are
    built from the documents that survived the per-fund gates, so the two sets can
    differ by a company whose only holder failed a gate. A country on such a company
    is an *extra* key, and ``validate._check_company_countries`` refuses the release
    for it — which is what happened to the 2026-11-02 19:37 refresh, on three
    companies. Projecting here makes the map a projection by construction rather than
    by luck, and the fallback is asked about the same set, so the two cannot drift.
    """
    published = set(companies)
    return {
        company_id: code
        for company_id, code in decided.items()
        if company_id in published
    }


def edgar_incorporations(
    company_ids: Iterable[str],
    *,
    fetch: Any = None,
    log: Any = None,
) -> dict[str, str]:
    """``company_id -> stateOfIncorporation`` for the ``c_`` ids asked about.

    Fetches through :func:`pipeline.sec.fetch_json`, so every document lands in the
    pipeline's content-addressed cache (``data/cache/<2 hex>/<sha256>``) and a rebuild
    reads it back instead of re-asking SEC. ``fetch`` is injectable for tests, and a
    company whose fetch fails is simply absent: a missing answer is allowed, so no
    fetch may raise out of here (a 404 on a delisted CIK would otherwise fail a
    release over one company's domicile).
    """
    if fetch is None:
        from . import sec

        def fetch(cik: str) -> Mapping[str, Any]:
            return sec.fetch_json(sec.submissions_url(cik), max_age=EDGAR_MAX_AGE_S)

    codes: dict[str, str] = {}
    for company_id in sorted(company_ids):
        cik = cik_of(company_id)
        if cik is None:
            continue
        try:
            document = fetch(cik)
        except Exception as error:  # noqa: BLE001 - absence is an allowed answer
            if log is not None:
                log(f"edgar: {company_id} unanswered ({type(error).__name__})")
            continue
        value = document.get("stateOfIncorporation") if isinstance(document, Mapping) else None
        if isinstance(value, str) and value.strip():
            codes[company_id] = value.strip().upper()
    return codes


def cover_page_incorporations(
    company_ids: Iterable[str],
    *,
    fetch: Any = None,
    log: Any = None,
) -> dict[str, str]:
    """``company_id -> the code on its own annual report's cover page``.

    EDGAR's ``submissions`` summary carries ``stateOfIncorporation``, and for the
    companies this rung exists for it is an **empty string**: a foreign private issuer
    that files a 10-K or a 20-F has no state to report, and EDGAR's profile field is
    left blank. The company's own annual report states the same fact on its XBRL cover
    page, and it is populated where the summary is not — Seagate's 10-K cover reads
    ``L2`` while its submissions record is empty, and ``L2`` has been in
    :data:`EDGAR_COUNTRY_CODES` since 2026-11-02.

    The code is EDGAR's own vocabulary, not ISO, so it is resolved by
    :func:`edgar_country` exactly as the summary field is; a code the table does not
    map is no answer, never a guess.

    Two fetches per company, both through the pipeline's content-addressed cache: the
    submissions document (to find the latest annual report) and that report's
    ``R1.htm`` (the cover page as EDGAR renders it). A company with no annual report,
    no cover page, or a failed fetch is simply absent — absence is an allowed answer,
    so no fetch may raise out of here.
    """
    from . import sec

    if fetch is None:

        def fetch(url: str) -> bytes:
            return sec.fetch(url, max_age=EDGAR_MAX_AGE_S)

    codes: dict[str, str] = {}
    for company_id in sorted(company_ids):
        cik = cik_of(company_id)
        if cik is None:
            continue
        try:
            submissions = json.loads(fetch(sec.submissions_url(cik)))
            accession = _latest_annual_accession(submissions)
            if accession is None:
                continue
            body = fetch(
                f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession}/R1.htm"
            )
        except Exception as error:  # noqa: BLE001 - absence is an allowed answer
            if log is not None:
                log(f"cover page: {company_id} unanswered ({type(error).__name__})")
            continue
        code = _cover_page_code(body)
        if code is not None:
            codes[company_id] = code
    return codes


def _latest_annual_accession(submissions: Mapping[str, Any]) -> str | None:
    """The accession of the newest 10-K/20-F/40-F, digits only, or ``None``.

    ``filings.recent`` is newest-first, so the first match is the latest annual
    report. A company that files none of the three has no cover page to read, which is
    the answer for the 98 ADR-only registrants on the 2026-11-04 release.
    """
    if not isinstance(submissions, Mapping):
        return None
    recent = (submissions.get("filings") or {}).get("recent") or {}
    forms = recent.get("form") or []
    accessions = recent.get("accessionNumber") or []
    for form, accession in zip(forms, accessions):
        if form in COVER_PAGE_FORMS and isinstance(accession, str) and accession:
            return accession.replace("-", "")
    return None


def _cover_page_code(body: bytes | str) -> str | None:
    """The two-character code on a rendered cover page, or ``None``.

    The page is HTML and the label and its value sit in separate cells, so the tags are
    flattened to spaces first. The value must be uppercase alphanumeric, which is what
    stops an empty cell from capturing the first two letters of the next label —
    ``Entity Tax Identification Number`` would otherwise read as ``En``.
    """
    text = body.decode("utf-8", "replace") if isinstance(body, (bytes, bytearray)) else str(body)
    plain = re.sub(r"<[^>]+>", " ", text)
    plain = re.sub(r"\s+", " ", plain)
    match = _COVER_PAGE_CODE.search(plain)
    return match.group(1) if match else None


def apply_fallback(
    decided: Mapping[str, str],
    *,
    companies: Iterable[str],
    gleif_jurisdictions: Mapping[str, str] | None = None,
    edgar_codes: Mapping[str, str] | None = None,
    cover_page_codes: Mapping[str, str] | None = None,
) -> tuple[dict[str, str], dict[str, Any]]:
    """Place what the vote could not, and publish how well the fallback agrees.

    ``decided`` is the vote's map and is copied, never written to: a fallback may
    only add a company the vote left out. ``companies`` is the release's company
    set, so a company with no vote still gets a question (the vote's tally only
    knows companies that filed a usable row).

    The three sources are asked in one fixed order, and each is asked only about the
    companies the ones before it could not place: GLEIF for an LEI entity, then
    EDGAR's summary field for a CIK company, then that company's own annual report
    cover page. The last rung exists because the summary field is blank for exactly
    the companies that need it — a foreign private issuer has no state to report.

    The agreement rates compare each source against the **vote's** answer on the
    companies it did decide — the only population where both answers exist. They are
    published as basis points with their sample sizes, and the build refuses the
    release when a rate falls below its floor on a sample big enough to mean it.
    """
    placed = dict(decided)
    jurisdictions = gleif_jurisdictions or {}
    codes = edgar_codes or {}
    cover_codes = cover_page_codes or {}
    sources = {"nport": len(decided), "gleif": 0, "edgar": 0, "cover_page": 0}

    for company_id in sorted(companies):
        if company_id in placed:
            continue
        country = None
        if company_id.startswith(gleif.ID_PREFIX):
            country = gleif_country(jurisdictions.get(company_id))
            if country is not None:
                sources["gleif"] += 1
        elif company_id.startswith("c_"):
            country = edgar_country(codes.get(company_id))
            if country is not None:
                sources["edgar"] += 1
            else:
                # Asked second, so a company EDGAR's summary already placed is never
                # re-read: the cover page is the same vocabulary, one document deeper.
                country = edgar_country(cover_codes.get(company_id))
                if country is not None:
                    sources["cover_page"] += 1
        if country is not None:
            placed[company_id] = country

    gleif_matched, gleif_compared = _agreement(decided, jurisdictions, gleif_country)
    edgar_matched, edgar_compared = _agreement(decided, codes, edgar_country)
    cover_matched, cover_compared = _agreement(decided, cover_codes, edgar_country)
    agreement = {
        "gleif_bp": _basis_points(gleif_matched, gleif_compared),
        "gleif_compared": gleif_compared,
        "edgar_bp": _basis_points(edgar_matched, edgar_compared),
        "edgar_compared": edgar_compared,
        "cover_page_bp": _basis_points(cover_matched, cover_compared),
        "cover_page_compared": cover_compared,
    }
    _enforce("gleif", agreement["gleif_bp"], agreement["gleif_compared"], MIN_GLEIF_AGREEMENT_BP)
    _enforce("edgar", agreement["edgar_bp"], agreement["edgar_compared"], MIN_EDGAR_AGREEMENT_BP)
    _enforce(
        "cover_page",
        agreement["cover_page_bp"],
        agreement["cover_page_compared"],
        MIN_COVER_AGREEMENT_BP,
    )
    return placed, {"sources": sources, "agreement": agreement}


def _agreement(
    decided: Mapping[str, str],
    answers: Mapping[str, Any],
    resolve: Any,
) -> tuple[int, int]:
    """``(matched, compared)`` over the decided companies the source also answered.

    One pass for both numbers, because they belong to the same population: a company
    whose answer does not resolve to a country (an EDGAR code we decline to map) is
    not part of the rate, so counting it in the denominator would publish a rate over
    a sample the rate was not computed on.
    """
    matched = compared = 0
    for company_id in sorted(decided):
        answer = answers.get(company_id)
        if not answer:
            continue
        country = resolve(answer)
        if country is None:
            continue
        compared += 1
        matched += int(country == decided[company_id])
    return matched, compared


def _basis_points(matched: int, compared: int) -> int:
    """Agreement in basis points, rounded once, or ``0`` when nothing compared."""
    return int(round(10_000 * matched / compared)) if compared else 0


def _enforce(source: str, bp: int, compared: int, floor: int) -> None:
    """Refuse the release when a fallback stops reproducing the vote.

    Below ``MIN_AGREEMENT_SAMPLE`` the rate is published but not acted on: a 40-row
    sample disagreeing is not evidence that the table is wrong. Above it, a rate
    under the floor is — and a build that shipped it would quietly relabel hundreds
    of companies, which is worse than a failed build.
    """
    if compared < MIN_AGREEMENT_SAMPLE or bp >= floor:
        return
    raise CountryFallbackError(
        f"{source} agrees with the published country on {bp:,} bp of {compared:,} "
        f"companies, under its {floor:,} bp floor — the code table, not the data, is "
        f"wrong; refusing the release"
    )


def build_object(
    as_of: str,
    countries: Mapping[str, str],
    *,
    company_total: int,
    invalid_rows: int = 0,
    fallback: Mapping[str, Any] | None = None,
    contested_map: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """The published object: the map, its provenance, and its own coverage.

    ``counts`` carries only what a reader (and the validator) can recompute from the
    object itself and the release's company shards — the number of companies the
    release publishes, how many carry a country, and the US/elsewhere split. The one
    build-side statistic is ``invalid_rows``: rows whose ``invCountry`` was not an
    alpha-2 code, published so a release cannot hide how much of its evidence it
    discarded.
    """
    codes = {company_id: countries[company_id] for company_id in sorted(countries)}
    us = sum(1 for code in codes.values() if code == "US")
    document: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "kind": KIND,
        "as_of": as_of,
        "source": SOURCE,
        "rule": RULE,
    }
    # Additive by presence: a release that ran no fallback publishes neither key, so
    # the object a 2026-11-02 release produced is still readable by the same code.
    if fallback is not None:
        document["fallback_rule"] = FALLBACK_RULE
    document["counts"] = {
        "companies": int(company_total),
        "with_country": len(codes),
        "us": us,
        "non_us": len(codes) - us,
        "undecided": int(company_total) - len(codes),
        "invalid_rows": int(invalid_rows),
    }
    if fallback is not None:
        document["sources"] = {
            "nport": int((fallback.get("sources") or {}).get("nport", 0)),
            "gleif": int((fallback.get("sources") or {}).get("gleif", 0)),
            "edgar": int((fallback.get("sources") or {}).get("edgar", 0)),
            "cover_page": int((fallback.get("sources") or {}).get("cover_page", 0)),
        }
        agreement = fallback.get("agreement") or {}
        document["agreement"] = {
            "gleif_bp": int(agreement.get("gleif_bp", 0)),
            "gleif_compared": int(agreement.get("gleif_compared", 0)),
            "edgar_bp": int(agreement.get("edgar_bp", 0)),
            "edgar_compared": int(agreement.get("edgar_compared", 0)),
            "cover_page_bp": int(agreement.get("cover_page_bp", 0)),
            "cover_page_compared": int(agreement.get("cover_page_compared", 0)),
        }
    document["companies"] = codes
    # Additive by presence, and a *separate* map on purpose: it answers a different
    # question from ``companies`` and must never be read as the company's country.
    # A release that ran no vote publishes neither key.
    if contested_map is not None:
        document["contested_rule"] = CONTESTED_RULE
        document["contested"] = {
            company_id: contested_map[company_id] for company_id in sorted(contested_map)
        }
    return document


def canonical_bytes(document: dict[str, Any]) -> bytes:
    """Compact serialisation: fixed key order, no whitespace, trailing newline.

    Not ``artifact.canonical_bytes``: that one is indented because a fund document
    is diffed by humans. This object is fetched by a browser and read by nothing, so
    its job is to be small (``benchmarks.canonical_bytes`` is the same argument).
    Byte stability comes from the fixed key order and the sorted map.
    """
    return (json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def digest(payload: bytes) -> str:
    return sha256_hex(payload)


def fund_votes(holdings: Iterable[Any]) -> tuple[dict[str, tuple[str, int]], int]:
    """One fund's contribution: ``company_id -> (country, abs weight_bp)``, plus junk.

    A fund that reports the same company twice has already been merged into one row
    by ``weights.build_vector`` (one fact per company), so this is a filter, not a
    second rollup. The second return value counts rows whose ``invCountry`` was
    present but unusable — a blank or an absent element is silence, not an error,
    and is not counted.

    A row whose ``asset_cat`` is ``fund`` is skipped entirely: it is a *fund's*
    domicile, and after ``fund_lookthrough`` flattens a wrapper its sleeve rows are no
    longer published, so a sleeve that voted only through a wrapper would land in the
    map with no company shard behind it. The wide build of 2026-11-02.7 is the evidence
    — three such sleeves failed the release at the projection gate.
    """
    votes: dict[str, tuple[str, int]] = {}
    invalid = 0
    for row in holdings:
        company_id = getattr(row, "company_id", None)
        country = getattr(row, "country", None)
        weight_bp = getattr(row, "weight_bp", 0) or 0
        if not company_id or not weight_bp:
            continue
        if getattr(row, "asset_cat", None) == classify.FUND:
            continue
        if not is_country_code(country):
            if country:
                invalid += 1
            continue
        votes[company_id] = (country, int(weight_bp))
    return votes, invalid


__all__ = [
    "COVER_PAGE_FORMS",
    "EDGAR_AGREEMENT_SAMPLE",
    "EDGAR_COUNTRY_CODES",
    "FALLBACK_RULE",
    "KIND",
    "MAX_COUNTRIES_BYTES",
    "MIN_AGREEMENT_BP",
    "MIN_AGREEMENT_SAMPLE",
    "MIN_COVER_AGREEMENT_BP",
    "MIN_EDGAR_AGREEMENT_BP",
    "MIN_FILINGS",
    "MIN_GLEIF_AGREEMENT_BP",
    "RULE",
    "SCHEMA_VERSION",
    "SOURCE",
    "CountryFallbackError",
    "Tally",
    "apply_fallback",
    "build_object",
    "canonical_bytes",
    "cik_of",
    "cover_page_incorporations",
    "decide",
    "digest",
    "edgar_country",
    "edgar_incorporations",
    "fund_votes",
    "gleif_country",
    "is_country_code",
    "release_companies",
]
