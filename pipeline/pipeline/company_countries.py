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

Arithmetic is integer dollars, not floats: the same release built twice must
produce the same bytes, and float addition is not associative across the order the
thread pool finishes funds in (``validate._check_company_countries`` re-derives the
projection, so a drifting tally would fail the release rather than ship).
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Mapping

from pipeline import classify

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


def build_object(
    as_of: str,
    countries: Mapping[str, str],
    *,
    company_total: int,
    invalid_rows: int = 0,
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
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": KIND,
        "as_of": as_of,
        "source": SOURCE,
        "rule": RULE,
        "counts": {
            "companies": int(company_total),
            "with_country": len(codes),
            "us": us,
            "non_us": len(codes) - us,
            "undecided": int(company_total) - len(codes),
            "invalid_rows": int(invalid_rows),
        },
        "companies": codes,
    }


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
    "KIND",
    "MAX_COUNTRIES_BYTES",
    "MIN_AGREEMENT_BP",
    "MIN_FILINGS",
    "RULE",
    "SCHEMA_VERSION",
    "SOURCE",
    "Tally",
    "build_object",
    "canonical_bytes",
    "decide",
    "digest",
    "fund_votes",
    "is_country_code",
]
