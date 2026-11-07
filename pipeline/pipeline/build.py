"""Build a release: funds in, immutable per-fund JSON + manifest out.

    python -m pipeline.build --tickers VOO,AVUV,SPY,QQQ,ARKK
    python -m pipeline.build --universe all --limit 50
    python -m pipeline.build --universe all          # the whole SEC fund universe

Every fund passes three gates **before** its file is written, so a bad filing
cannot produce a published artifact:

1. the filing's holdings reconcile to NAV (``|Σ valUSD / netAssets − 1| ≤ 5%``,
   which is the skill's N-PORT reconciliation band and the reason a fund with
   derivatives is not rejected for summing to 100.09%). Two cash rows are read as
   cash rather than as positions, because a schedule that is right *about them* is
   wrong as a fund: borrowed collateral (``lending_collateral``, offset by a
   liability) and unfunded cash (``unfunded_cash``, the row a filer reports on top
   of a book that already is the fund — IVAL's $20.3M money-market sweep);
2. the emitted weight vector is a plausible whole (``9,000 ≤ Σ bp ≤ 10,500``) —
   the check that catches "parsed half the holdings" and "double-counted a fund";
3. the per-fund file is under the size budget.

Nothing is fetched twice: the byte cache under ``data/cache`` is the only source
after the first run, which is what makes the determinism check meaningful.

**Scale.** A single-fund build is the day-1 shape; a 12,000-series build is what
day 4 asks for, and three things had to change for it: the universe is enumerated
rather than typed (``--universe all``), funds are built on a small thread pool
(the SEC client still throttles the whole process to 8 req/s, but a build spends
most of its wall clock parsing and hashing, not waiting), and a failing fund is
**recorded** instead of aborting the run — a universe walk that dies on the first
fund with an odd filing never finishes. ``--on-error fail`` restores the strict
behaviour, and publishing uses it: a release must be clean.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import sys
import time
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from . import (
    artifact,
    catalogue,
    classify,
    companies,
    company_countries,
    filings,
    fund_lookthrough,
    identifiers,
    manifest as manifest_mod,
    sec,
    securities,
    sizes,
    universe,
    weights,
)
from .companies import CompanyIndex, IdentityEvidence, IdentityTable
from . import gleif
from .nport import NportFiling, NportParseError

REPO_ROOT = Path(__file__).resolve().parents[2]
#: One owner for the number: the module that produces the bytes (artifact.py).
MAX_FUND_BYTES = artifact.MAX_FUND_BYTES
MIN_TOTAL_BP = 9_000
MAX_TOTAL_BP = 10_500
NAV_RESIDUAL_LIMIT = 0.05
#: How close a cash row's value must sit to total liabilities before it is read as
#: borrowed collateral rather than a cash position. Same 5% band as the gate: one
#: number for "these are the same amount", used in one place.
COLLATERAL_BAND = 0.05
DEFAULT_WORKERS = 8
#: One owner for the warning threshold: the module that defines what "unresolved" means.
MIN_UNRESOLVED_BP = fund_lookthrough.MIN_UNRESOLVED_WARNING_BP
#: One owner for the rung names: companies.py walks the ladder, so it names the
#: rungs. The manifest publishes a count per name, and a rung missing here would
#: make its rows look like a mapping failure.
RUNG_NAMES = companies.ALL_RUNGS


class GateError(RuntimeError):
    pass


def _log(message: str) -> None:
    print(message, flush=True)


def _alias_map(builds: list["FundBuild"]) -> dict[str, str]:
    """Share-class ticker → the published ticker of the same series.

    Only aliases that point at a fund this release actually published are kept: an
    alias to a missing page would be a dead end that looks like a redirect. A class
    symbol that another series publishes as its own primary ticker is skipped too —
    the release can only have one page per ticker — and both skips are counted in
    the build summary rather than silently dropped.
    """
    published = {build.ticker for build in builds}
    aliases: dict[str, str] = {}
    for build in builds:
        for symbol in build.ref_symbols:
            if symbol == build.ticker or symbol in published or symbol in aliases:
                continue
            aliases[symbol] = build.ticker
    return aliases


@dataclass
class FundBuild:
    """One fund's artifact plus everything the run summary needs about it."""

    ticker: str
    document: dict
    payload: bytes
    stats: dict = field(default_factory=dict)
    #: Every symbol the fund's series reports, so the release can publish the
    #: classes it does not name as files.
    ref_symbols: tuple[str, ...] = ()
    #: What this fund's ladder-resolved rows said about ISIN/LEI identity. Only the
    #: first pass fills it; the second pass reads the table it produced.
    evidence: IdentityEvidence | None = None
    #: The vector the document was built from. Kept because a fund-of-funds is
    #: flattened *after* every fund in the release exists, and the flatten needs each
    #: sleeve's rows plus the fund edges' own identifiers, neither of which the
    #: published document carries.
    vector: weights.WeightVector | None = None
    #: The fund's own ``genInfo/seriesLei`` — the key a parent's holding row uses.
    series_lei: str | None = None
    #: ``company_id -> (invCountry, abs weight_bp)`` for this fund's mapped rows: one
    #: fund's contribution to the release-wide country vote. Folded into the tally
    #: and dropped as soon as the fund lands (``_walk``), because 8,500 of these at
    #: once would be the largest object the build holds.
    countries: dict[str, tuple[str, int]] = field(default_factory=dict)
    #: Rows whose ``invCountry`` was present but not an alpha-2 code. Published as the
    #: object's ``invalid_rows`` so a release cannot hide what it discarded.
    invalid_country_rows: int = 0


@dataclass(frozen=True)
class Collateral:
    """Cash in the schedule that is borrowed, not owned.

    A securities-lending or repo program appears in N-PORT twice: a cash-like row
    inside ``invstOrSec`` (the collateral received) and a liability of the same
    size (the obligation to return it). Publishing the row as a holding overstates
    the fund by that amount, depresses every other weight, and — because the gate
    reconciles the schedule against *net* assets — rejects a filing that is
    perfectly good: EA Bridgeway Omni Small-Cap Value (BSVO) holds $237.6M of
    collateral against $245.0M of borrowings, so its schedule reads 9.93% over net
    assets while sitting 0.3% under total assets.

    The rows are set aside only when the numbers fit one story: cash ≈ liabilities
    *and* the remaining schedule ≈ net assets. A fund with a genuine cash position
    and unrelated borrowings fails at least one test and keeps every row it filed.
    """

    rows: frozenset[int]
    usd: float


#: How many cash rows a fund may have before the collateral search stops enumerating
#: subsets of them. Funds hold one to five cash instruments; the cap exists so a pathological
#: schedule cannot turn a gate into a combinatorial search.
COLLATERAL_SUBSET_CAP = 10


def _collateral_shapes(cash: list[Holding]) -> list[list[Holding]]:
    """The cash subsets that could be the lending collateral, simplest first.

    A fund that lends securities receives cash collateral and invests it, and the filing
    shows that investment beside the fund's own liquidity. "Every cash row" is therefore
    only one of the shapes a collateral position takes: a repo program's collateral is one
    repo row next to a money-market sweep, and a fund that splits collateral across two
    tranches has two. Every subset is tried, smallest first, and the caller still requires
    both bands to pass — a wrong shape cannot be accepted by being tried, only by
    reconciling. The measured case is Transamerica's IIBAX/IIBPX: $1.73B of borrowings, a
    repo row that matches them, and a sweep of their own, which summed every cash row and
    saw leverage where the filing shows a lending program.
    """
    ordered = sorted(cash, key=lambda row: (-(row.val_usd or 0.0), row.name))
    if len(ordered) > COLLATERAL_SUBSET_CAP:
        return [ordered, ordered[:1], ordered[1:]]
    return [
        list(shape)
        for size in range(1, len(ordered) + 1)
        for shape in itertools.combinations(ordered, size)
    ]


def _cash_rows(holdings: list[Holding]) -> list[Holding]:
    """The schedule's cash-like rows. One definition, because two rules read it."""
    return [
        holding
        for holding in holdings
        if classify.classify(
            holding.asset_cat, holding.issuer_cat, holding.is_derivative
        ).category
        == classify.CASH
        and (holding.val_usd or 0.0) > 0
    ]


def lending_collateral(filing: NportFiling) -> Collateral:
    net = filing.net_assets or 0.0
    liabilities = filing.total_liabilities or 0.0
    if net <= 0 or liabilities <= 0:
        return Collateral(frozenset(), 0.0)
    cash = _cash_rows(filing.holdings)
    if not cash:
        return Collateral(frozenset(), 0.0)
    filed_total = sum(holding.val_usd or 0.0 for holding in filing.holdings)
    for shape in _collateral_shapes(cash):
        cash_usd = sum(holding.val_usd or 0.0 for holding in shape)
        if abs(cash_usd - liabilities) / liabilities > COLLATERAL_BAND:
            continue
        if abs((filed_total - cash_usd) - net) / net > COLLATERAL_BAND:
            continue
        return Collateral(frozenset(id(holding) for holding in shape), cash_usd)
    return Collateral(frozenset(), 0.0)


@dataclass(frozen=True)
class CashExcess:
    """Cash rows the filing's own totals do not fund.

    A filer can report its cash sweep *on top of* a book that is already fully invested.
    Alpha Architect International Quantitative Value (IVAL, 2026-06-30) files 50 positions
    of roughly 2% each — ``206,346,608.27``, or 99.31% of net assets — plus ``$20,297,444``,
    9.77%, in a government money-market fund. The schedule then reads 109.08% of net assets and 7.77% over the
    filing's own total assets: on the filing's own numbers that cash row cannot be owned,
    because the book already is the fund. Removing it reconciles the book to 0.69%.

    Set aside only when removing the cash lands the schedule inside the band, so a
    leveraged fund keeps its rows: its remainder is still far from net assets. Unlike
    borrowed collateral the remainder is renormalised — ``build_vector`` weights these
    funds against the investable book, so the vector totals 10,000 bp of holdings instead
    of ~9,900 bp of NAV with an unfunded cash line the reader cannot see.
    """

    rows: frozenset[int]
    usd: float


def unfunded_cash(
    filing: NportFiling, *, exclude: frozenset[int] = frozenset()
) -> CashExcess:
    """Cash that is not a position: the book alone already accounts for the NAV.

    ``exclude`` is the lending collateral, so the two rules stay disjoint: a cash row
    that already explains a liability is not re-read as an excess. A cash row worth more
    than net assets is never taken — a fund holding more cash than its own NAV is a
    leverage question, not a filing quirk.
    """
    net = filing.net_assets or 0.0
    if net <= 0:
        return CashExcess(frozenset(), 0.0)
    remaining = [holding for holding in filing.holdings if id(holding) not in exclude]
    filed_total = sum(holding.val_usd or 0.0 for holding in remaining)
    if abs(filed_total / net - 1) <= NAV_RESIDUAL_LIMIT:
        return CashExcess(frozenset(), 0.0)
    cash = _cash_rows(remaining)
    if not cash:
        return CashExcess(frozenset(), 0.0)
    cash_usd = sum(holding.val_usd or 0.0 for holding in cash)
    if cash_usd > net:
        return CashExcess(frozenset(), 0.0)
    if abs((filed_total - cash_usd) / net - 1) > NAV_RESIDUAL_LIMIT:
        return CashExcess(frozenset(), 0.0)
    return CashExcess(frozenset(id(holding) for holding in cash), cash_usd)


def _net_assets_usd(net_assets: float | None) -> int | None:
    """The filing's own net assets in whole dollars, or ``None`` when it filed none.

    N-PORT's ``netAssets`` is a decimal with cents; the `/funds` directory orders
    funds by it (operator's instruction, 2026-11-02), so it is rounded once, here, and
    every consumer reads the same integer. ``None`` stays distinct from ``0``: a
    filing that reports no figure is a fund with no size answer, and publishing zero
    would sort it beside a genuinely empty fund.
    """
    return None if net_assets is None else int(round(net_assets))


def _with_net_assets(document: dict, net_assets: int | None) -> dict:
    """A fund document carrying the filing's net assets beside its coverage.

    Additive to fund schema 1, the same pattern as ``etf`` and ``asset_cat``: a
    document without the field is valid, which is what lets the web bundle ship ahead
    of the release that publishes it (``data-contract-and-release`` §8) and what the
    validator's "absence stays valid" case pins. It is attached in the builder rather
    than in ``artifact.build_fund_artifact`` because the builder describes the shape
    every document must carry, and this number is optional by design.

    The insert is positional, after ``coverage_pct``, rather than appended: the
    document's key order is fixed and hashed, and a size belongs beside the other
    per-fund figure a reader checks. The second call site is
    ``_flatten_fund_of_funds``: ``artifact.attach_fund_of_funds`` rebuilds a wrapper's
    document field by field so its hash covers the contract's order, and it knows
    nothing about a size — without re-attaching, exactly the funds that were flattened
    would lose the figure the catalogue still carries.
    """
    published: dict = {}
    for key, value in document.items():
        published[key] = value
        if key == "coverage_pct":
            published["net_assets"] = net_assets
    if "net_assets" not in published:
        # The builder always writes coverage_pct, so this is a guard rather than a
        # path: a document must not lose the number because its key order changed.
        published["net_assets"] = net_assets
    return published


def build_fund(
    ref: universe.FundRef,
    index: CompanyIndex,
    *,
    identity: IdentityTable | None = None,
    collect_evidence: bool = False,
    issuers: gleif.IssuerIndex | None = None,
    fund_leis: Mapping[str, str] | None = None,
    security_map: identifiers.SecurityMap | None = None,
) -> FundBuild:
    started = time.monotonic()
    found = filings.latest(ref)
    filing = found.filing

    lag_days = artifact._days_between(found.filing_date, found.report_date)

    collateral = lending_collateral(filing)
    excess = unfunded_cash(filing, exclude=collateral.rows)
    set_aside = collateral.rows | excess.rows
    investable = [
        holding
        for holding in filing.holdings
        if id(holding) not in set_aside
    ]
    # What the weights are a fraction of. The fund's own NAV, except for a filing whose
    # book already is the fund: there the cash is excluded and the investable book is the
    # denominator, so the published vector is a whole fund (10,000 bp) rather than 9,900.
    basis = filing.net_assets
    if excess.rows:
        basis = sum(holding.val_usd or 0.0 for holding in investable)
        _log(
            f"{ref.ticker}: {excess.usd:,.0f} of cash is not funded by the filing's own "
            f"totals — weighting against the investable book ({basis:,.0f})"
        )

    evidence = IdentityEvidence() if collect_evidence else None
    vector = weights.build_vector(
        investable,
        index,
        basis,
        lag_days=lag_days,
        identity=identity,
        evidence=evidence,
        issuers=issuers,
        fund_leis=fund_leis,
        security_map=security_map,
    )

    # Gate 1 — the *investable* schedule reconciles to the fund's own NAV.
    filed_total = sum(row.val_usd or 0.0 for row in investable)
    residual = abs(filed_total / filing.net_assets - 1) if filing.net_assets else None
    if residual is not None and residual > NAV_RESIDUAL_LIMIT:
        schedule_total = filed_total + collateral.usd
        assets = filing.total_assets or 0.0
        # A schedule that reconciles to total assets but not to net assets is a
        # leverage question, not a parse gap, and the two need different answers.
        against_assets = (
            abs(schedule_total / assets - 1) if assets else None
        )
        if against_assets is not None and against_assets <= NAV_RESIDUAL_LIMIT:
            raise GateError(
                f"{ref.ticker}: schedule reconciles to total assets "
                f"({schedule_total:,.0f} of {assets:,.0f}) but not to net assets "
                f"({filing.net_assets:,.0f}); liabilities are "
                f"{filing.total_liabilities or 0:,.0f} and no single cash row matches "
                "them, so this is leverage, not a truncated filing"
            )
        raise GateError(
            f"{ref.ticker}: holdings sum to {filed_total:,.0f} vs netAssets "
            f"{filing.net_assets:,.0f} ({residual:.2%}) — over the {NAV_RESIDUAL_LIMIT:.0%} band"
        )

    # Gate 2 — the vector is a whole fund, not a fragment or a double count.
    if not MIN_TOTAL_BP <= vector.total_bp <= MAX_TOTAL_BP:
        raise GateError(
            f"{ref.ticker}: weight vector totals {vector.total_bp} bp, outside "
            f"[{MIN_TOTAL_BP}, {MAX_TOTAL_BP}]"
        )

    # One name test, one place: the artifact carries the label, and the
    # catalogue, the manifest count and (later) a fund page all read that field
    # instead of re-deriving it.
    fund_name = filing.series_name or filing.registrant_name or ref.ticker
    fund_issuer = filing.registrant_name or ""
    is_etf = classify.looks_like_etf(fund_name, fund_issuer)

    document = artifact.build_fund_artifact(
        ticker=ref.ticker,
        fund_id=ref.fund_id,
        name=fund_name,
        issuer=fund_issuer,
        etf=is_etf,
        as_of=found.report_date,
        filed_at=found.filing_date,
        source_url=found.source_url,
        coverage_pct=vector.coverage_pct,
        # Both levels are the build's answer, computed from the rows it is publishing
        # (``weights.identified_split``), never left to be re-derived from the rows a
        # consumer happens to hold: the validator checks the number it recomputes
        # against this one, and the two must agree by construction, not by luck.
        identified_pct=vector.identified_pct,
        identified_by_cat=vector.identified_by_cat,
        holdings=[
            artifact.holding_row(
                company_id=row.company_id,
                name=row.name,
                ticker=row.ticker,
                asset_cat=row.asset_cat,
                weight_bp=row.weight_bp,
                identified=row.identified,
                # The filing's own invCountry, published only on a row that named no
                # company (``artifact.holding_row`` decides that, not this call site).
                # A placeholder is not a country: ``XX`` is ISO's user-assigned code and
                # filers use it for "no country", so it is dropped here rather than
                # published and then folded into a segment by the total rule.
                filed_country=(
                    row.country if company_countries.is_country_code(row.country) else None
                ),
            )
            for row in vector.holdings
        ],
        metrics=weights.metrics(vector.holdings),
        warnings=vector.warnings,
    )
    # The fund's own filed size, published for the directory's order — no vendor AUM
    # and no second data source: the release already parses this number to weight
    # every holding it shows.
    document = _with_net_assets(document, _net_assets_usd(filing.net_assets))
    payload = artifact.canonical_bytes(document)

    # Gate 3 — the size budget the plan promises the browser.
    if len(payload) > MAX_FUND_BYTES:
        raise GateError(
            f"{ref.ticker}: artifact is {len(payload):,} bytes, over the "
            f"{MAX_FUND_BYTES:,}-byte budget"
        )

    _countries, _invalid_country_rows = company_countries.fund_votes(vector.holdings)
    stats = {
        "collateral_usd": collateral.usd,
        # Cash a filing reported on top of a book that already is the fund. Excluded
        # from ``asset_cats`` as well, so the two numbers always agree.
        "cash_excess_usd": excess.usd,
        "rungs": dict(vector.rung_counts),
        "asset_cats": dict(vector.asset_cat_counts),
        "total_bp": vector.total_bp,
        # One number, one implementation: the summary and the flatten read the value
        # the document publishes, not a second conversion of the parsed float.
        "net_assets": document["net_assets"],
        "as_of": found.report_date,
        "name": document["name"],
        "issuer": document["issuer"],
        "coverage_pct": document["coverage_pct"],
        # Provisional ETF label (ADR-0007 C3): a name test, recorded in the
        # manifest as such. It selects nothing and gates nothing — a reviewer
        # needs the split to see the universe, and naming the test is how the
        # pre-ADR [open] stays visible instead of looking settled.
        "etf": is_etf,
        "seconds": round(time.monotonic() - started, 3),
    }
    return FundBuild(
        ticker=ref.ticker,
        document=document,
        payload=payload,
        stats=stats,
        ref_symbols=ref.symbols,
        evidence=evidence,
        vector=vector,
        series_lei=filing.series_lei,
        countries=_countries,
        invalid_country_rows=_invalid_country_rows,
    )


def _attempt(
    ref: universe.FundRef,
    index: CompanyIndex,
    *,
    identity: IdentityTable | None = None,
    collect_evidence: bool = False,
    issuers: gleif.IssuerIndex | None = None,
    fund_leis: Mapping[str, str] | None = None,
    security_map: identifiers.SecurityMap | None = None,
) -> tuple[FundBuild | None, str | None]:
    try:
        return (
            build_fund(
                ref,
                index,
                identity=identity,
                collect_evidence=collect_evidence,
                issuers=issuers,
                fund_leis=fund_leis,
                security_map=security_map,
            ),
            None,
        )
    except Exception as error:  # noqa: BLE001 — a universe walk records and continues
        # Deliberately broad: one malformed filing, one EDGAR hiccup after its own
        # retries, one unexpected shape must not throw away 12,000 built funds. The
        # failure is recorded with its type and counted, and `--on-error fail`
        # (which publishing uses) still refuses to write a release with holes.
        return None, f"{type(error).__name__}: {error}"


def resolve_universe(
    spec: str,
    *,
    limit: int | None = None,
    top: int | None = None,
    from_summary: Path | None = None,
) -> list[universe.FundRef]:
    """Turn ``--universe`` / ``--tickers`` into a deterministic list of funds.

    ``all`` is the SEC fund file's series, ``tickers:VOO,QQQ`` the reviewed list,
    and ``--top N --from-summary`` ranks a previous walk's funds by N-PORT net
    assets — which is how a publishable subset is chosen without a second
    universe sweep and without a hand-maintained list.
    """
    if spec == universe.UNIVERSE_ALL:
        refs = universe.all_series()
        if top is not None:
            if from_summary is None:
                raise GateError("--top needs --from-summary from an earlier walk")
            summary = json.loads(from_summary.read_text())
            ranked = sorted(
                (row for row in summary.get("funds", []) if row.get("net_assets")),
                key=lambda row: (-float(row["net_assets"]), row["ticker"]),
            )
            wanted = {row["ticker"]: float(row["net_assets"]) for row in ranked[:top]}
            refs = [ref for ref in refs if ref.ticker in wanted]
            refs.sort(key=lambda ref: (-wanted[ref.ticker], ref.ticker))
            missing = sorted(set(wanted) - {ref.ticker for ref in refs})
            if missing:
                raise GateError(
                    f"--top: {len(missing)} funds are not in the universe: {missing[:5]}"
                )
        if limit is not None:
            refs = refs[:limit]
        return refs
    if spec.startswith("tickers:"):
        wanted = [t.strip().upper() for t in spec.split(":", 1)[1].split(",") if t.strip()]
        refs = [universe.resolve(ticker) for ticker in wanted]
        if limit is not None:
            refs = refs[:limit]
        return refs
    raise GateError(f"unknown universe spec {spec!r} — use 'all' or 'tickers:VOO,QQQ'")


def _walk(
    refs: list[universe.FundRef],
    index: CompanyIndex,
    *,
    workers: int,
    identity: IdentityTable | None,
    log: int,
    on_error: str,
    started: float,
    merge_evidence: IdentityEvidence | None = None,
    issuers: gleif.IssuerIndex | None = None,
    fund_leis: Mapping[str, str] | None = None,
    series_out: dict[str, str] | None = None,
    votes: company_countries.Tally | None = None,
    security_map: identifiers.SecurityMap | None = None,
    sizes_tally: sizes.PriceTally | None = None,
) -> tuple[list[FundBuild], list[dict[str, str]]]:
    """Build every fund once, collecting the artifacts and the failures.

    ``merge_evidence`` turns this into the evidence pass: each fund's sightings are
    folded into the caller's collector as it lands (the fold runs on the consumer
    thread, so the counter updates are not racing), and no artifact is kept — pass
    1 would otherwise hold two releases' worth of bytes at once.

    ``series_out`` is how ADR-0016 gets its fund-position key set for free: the
    evidence pass already parses every filing, so it also records ``seriesLei`` →
    ticker there, and pass 2 receives it as ``fund_leis``. A second indexing pass
    would re-read the whole corpus to learn something pass 1 had in hand.
    """
    builds: list[FundBuild] = []
    failures: list[dict[str, str]] = []
    done = 0

    def record(result: tuple[FundBuild | None, str | None], ref: universe.FundRef) -> None:
        nonlocal done
        build, problem = result
        done += 1
        if build is None:
            failures.append({"ticker": ref.ticker, "cik": ref.cik, "error": problem or ""})
            if log:
                _log(f"  !! {ref.ticker}: {problem}")
        elif merge_evidence is not None:
            if build.evidence is not None:
                merge_evidence.merge(build.evidence)
            if series_out is not None and build.series_lei:
                series_out[build.series_lei] = build.ticker
        else:
            # The evidence pass sets ``votes=None``: it sees every filing twice over two
            # passes, and a fund counted in both would double its own vote.
            if votes is not None and build.countries:
                votes.add_fund(
                    build.countries, build.stats.get("net_assets"), build.invalid_country_rows
                )
                build.countries = {}
            # The size lane's evidence, folded and dropped the same way: the fund's own
            # filed value and share balance per company, which become the implied price
            # the release multiplies by a ``dei`` share count.
            if sizes_tally is not None and build.vector is not None:
                sizes_tally.add_fund(build.vector, build.stats.get("as_of", ""))
            builds.append(build)
        if log and done % log == 0:
            elapsed = time.monotonic() - started
            rate = done / elapsed if elapsed else 0
            _log(
                f"  … {done:,}/{len(refs):,} funds, {len(failures)} failed, "
                f"{rate:.1f} funds/s, {elapsed / 60:.1f} min elapsed"
            )

    collect = merge_evidence is not None
    if workers <= 1:
        for ref in refs:
            record(
                _attempt(
                    ref,
                    index,
                    identity=identity,
                    collect_evidence=collect,
                    issuers=issuers,
                    fund_leis=fund_leis,
                    security_map=security_map,
                ),
                ref,
            )
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [
                (
                    ref,
                    pool.submit(
                        _attempt,
                        ref,
                        index,
                        identity=identity,
                        collect_evidence=collect,
                        issuers=issuers,
                        fund_leis=fund_leis,
                        security_map=security_map,
                    ),
                )
                for ref in refs
            ]
            for ref, future in futures:
                record(future.result(), ref)
    return builds, failures


def _edgar_sample(decided: Mapping[str, str], size: int) -> list[str]:
    """A fixed sample of already-decided CIK companies, for the fallback's own gate.

    Deterministic and unbiased: sorted by the digest of the company id, so it does
    not sample one state, one industry or one fund's holdings, and a rebuild asks
    EDGAR about exactly the same companies. Without it the agreement rate would have
    no comparison set — the build only *needs* EDGAR for the undecided.
    """
    ciks = [company_id for company_id in decided if company_countries.cik_of(company_id)]
    ordered = sorted(ciks, key=lambda company_id: hashlib.sha256(company_id.encode()).digest())
    return ordered[:size]


def _gleif_jurisdictions(
    issuers: "gleif.IssuerIndex | None",
    decided: Mapping[str, str],
    undecided: list[str],
) -> dict[str, str] | None:
    """``company_id -> GLEIF jurisdiction`` for the companies this build asks about.

    The index holds **3.5 million** entities, so the map is filtered as it is built
    rather than after: a dict over the whole golden copy would be ~650 MB of string
    keys on a build that already holds every ``Entity``, and only the companies in
    this release are ever looked up. The ids that must be present are the undecided
    ``l_`` companies (whose country the fallback is deciding) *and* the decided
    ``l_`` ones (which the agreement rate is measured on) — without the second half
    the published rate would be a zero over an empty comparison set.

    Hashing every LEI is the price of the lookup and it is paid once: 3.5 million
    sha256 calls, a few seconds, against a build measured in minutes.
    """
    if issuers is None:
        return None
    wanted = {
        company_id
        for company_id in [*undecided, *decided]
        if company_id.startswith(gleif.ID_PREFIX)
    }
    if not wanted:
        return {}
    jurisdictions: dict[str, str] = {}
    for entity in issuers.entities.values():
        company_id = entity.company_id
        if company_id in wanted and entity.jurisdiction:
            jurisdictions[company_id] = entity.jurisdiction
    return jurisdictions


def _identity_namespaces(
    issuers: "gleif.IssuerIndex | None", rung_totals: dict[str, int]
) -> dict[str, dict]:
    """The published contract for both id namespaces, and who was in each.

    ``company_id`` is one field with two kinds of value, and a consumer that reads
    ``c_`` as "a CIK" and ``l_`` as "a CIK" would be wrong in a way no shape check
    catches. The manifest therefore states both: what each prefix means, and — for
    the namespace that needs it — which GLEIF file the release was resolved against.
    """
    namespaces: dict[str, dict] = {
        "c_": {"kind": "sec_operating_company", "key": "cik", "source": "EDGAR"},
    }
    if issuers is not None:
        namespaces["l_"] = {
            "kind": "gleif_legal_entity",
            "key": f"sha256(lei)[:{gleif.ID_HEX_DIGITS}]",
            "source": issuers.source,
            "cache_date": issuers.cache_date,
            "entities": len(issuers.entities),
            "isin_map": len(issuers.isin_to_lei),
            "categories": sorted(weights.ISSUER_CATEGORIES),
            "refusals": dict(sorted(issuers.refusals.items())),
            # Rows whose LEI named an entity EDGAR already knows resolve to a
            # ``c_`` id (see weights.build_vector), so they are counted apart from
            # the rows that actually landed in this namespace.
            "bridged_to_sec": dict(sorted(issuers.bridges.items())),
            "rows": {
                "lei_issuer": int(rung_totals.get(gleif.RUNG_LEI, 0))
                - int(issuers.bridges.get(gleif.RUNG_LEI, 0)),
                "isin_lei_issuer": int(rung_totals.get(gleif.RUNG_ISIN_LEI, 0))
                - int(issuers.bridges.get(gleif.RUNG_ISIN_LEI, 0)),
            },
        }
    return namespaces


def _flatten_fund_of_funds(
    builds: list["FundBuild"], aliases: dict[str, str]
) -> dict:
    """Replace every wrapper's filed vector with the companies it ultimately owns.

    Runs after the walk, never inside it: a parent's sleeves must all exist before any
    parent can be flattened, and the walk builds funds in an arbitrary order. No filing
    is re-read — this is a join over vectors the run already holds (ADR-0013).

    Two things are published per fund and they are different questions:

    * ``components`` — the sleeves, with weight and each sleeve's own coverage. A small
      fund-of-funds gets this even when its vector is not flattened: "what funds does
      this hold" is answerable from the filing and costs a handful of rows.
    * ``lookthrough`` + a flattened ``holdings`` — for a fund that is materially a
      wrapper, the weighted sum itself, so the one ``holdings`` field every consumer
      reads is already the answer and no second implementation of the weight exists.
    """
    inputs = {
        build.ticker: fund_lookthrough.FundInput(
            ticker=build.ticker,
            as_of=build.document["as_of"],
            holdings=tuple(build.vector.holdings) if build.vector else (),
            series_lei=build.series_lei,
            name=build.document["name"],
        )
        for build in builds
    }
    composer = fund_lookthrough.Composer(
        inputs, fund_lookthrough.EdgeIndex.build(inputs, aliases)
    )
    stats: dict = {
        "fund_of_funds": 0,
        "flattened": 0,
        "components_only": 0,
        "skipped_immaterial": 0,
        "skipped_too_large": 0,
        "edges": 0,
        "edges_resolved": 0,
        "edges_by_series_lei": 0,
        "edges_by_symbol": 0,
        "refusals": {},
        "flattened_bytes": 0,
        "filed_bytes": 0,
    }
    for build in builds:
        composed = composer.compose(build.ticker)
        if not composed.fund_bp:
            continue
        stats["fund_of_funds"] += 1
        for _edge, target, rung in composer.edges(build.ticker):
            stats["edges"] += 1
            if target is None:
                continue
            stats["edges_resolved"] += 1
            if rung == fund_lookthrough.RUNG_LEI:
                stats["edges_by_series_lei"] += 1
            elif rung == fund_lookthrough.RUNG_SYMBOL:
                stats["edges_by_symbol"] += 1
        stats["filed_bytes"] += len(build.payload)

        warnings = set(build.document["warnings"])
        if composed.unresolved_fund_bp >= MIN_UNRESOLVED_BP:
            warnings.add("fund_of_funds_unresolved")

        skip = composer.skip_reason(composed)
        if skip is None:
            stats["flattened"] += 1
            document = artifact.attach_fund_of_funds(
                build.document,
                holdings=composed.holdings,
                coverage_pct=composed.coverage_pct,
                metrics=composed.metrics,
                components=composed.components,
                lookthrough=composed.as_lookthrough(),
                warnings=sorted(warnings),
            )
        else:
            stats["components_only"] += 1
            stats["skipped_" + skip] = stats.get("skipped_" + skip, 0) + 1
            document = artifact.attach_fund_of_funds(
                build.document,
                holdings=build.document["holdings"],
                coverage_pct=build.document["coverage_pct"],
                metrics=build.document["metrics"],
                components=composed.components,
                warnings=sorted(warnings),
            )

        # ``attach_fund_of_funds`` rebuilds the document field by field, so the size
        # the filing gave is re-attached here rather than taught to the flattener: the
        # figure is a property of the filing, not of the composition. Read from the
        # document it was published in, so the flatten cannot state a different number.
        document = _with_net_assets(document, build.document.get("net_assets"))
        payload = artifact.canonical_bytes(document)
        if len(payload) > MAX_FUND_BYTES:
            raise GateError(
                f"{build.ticker}: flattened artifact is {len(payload):,} bytes, over the "
                f"{MAX_FUND_BYTES:,}-byte budget"
            )
        build.document = document
        build.payload = payload
        # The catalogue and the manifest histogram read the document, but the build
        # summary reads the stats — one number, updated where it lives.
        build.stats["coverage_pct"] = document["coverage_pct"]
        build.stats["flattened"] = "lookthrough" in document
        stats["flattened_bytes"] += len(payload)

    for name, count in composer.counts.items():
        stats["refusals"][name] = int(count)
    # Every edge that reached the cap or a cycle is a sleeve a reader cannot see
    # through, and the release says how many there were instead of leaving it to be
    # inferred from a coverage number that moved.
    stats["flattened_bytes"] -= stats["filed_bytes"]
    return stats


def build_release(
    refs: list[universe.FundRef],
    *,
    out_dir: Path,
    release_id: str | None = None,
    generated_at: str | None = None,
    workers: int = 1,
    on_error: str = "fail",
    label: str = "tickers",
    progress_every: int = 0,
    identity: bool = True,
    issuer_namespace: bool = True,
    country_fallback: bool = True,
    securities_source: dict | None = None,
    security_identity: bool = True,
    security_map: identifiers.SecurityMap | None = None,
    layer_dir: Path | None = None,
    size_buckets: bool = True,
    size_cover_limit: int | None = None,
) -> Path:
    started = time.monotonic()
    index = CompanyIndex.load()
    _log(f"company index: {len(index.by_ticker):,} tickers, {len(index.by_name):,} unique names")

    # The foreign-issuer namespace (``l_`` ids) is a second, parallel identity keyed
    # by LEI. It is loaded before the walk and never mixed with the CIK index: a row
    # the CIK ladder cannot name may resolve here, and a row it can name never does.
    issuers: gleif.IssuerIndex | None = None
    if issuer_namespace:
        issuers = gleif.IssuerIndex.load()
        if issuers is None:
            raise GateError(
                "the foreign-issuer namespace is on but data/cache/gleif is empty — "
                "run `python -m pipeline.gleif --refresh` (GLEIF golden copy, CC0), "
                "or build with --no-issuers to publish without it"
            )
        _log(
            f"issuer namespace: {len(issuers.entities):,} GLEIF entities, "
            f"{len(issuers.isin_to_lei):,} ISIN→LEI pairs "
            f"(golden copy {issuers.cache_date})"
        )
    else:
        _log("issuer namespace: disabled (--no-issuers)")

    # The identified level's lookup (``identifiers.SecurityMap``), loaded **once** for
    # the whole run and never re-read per fund: it is one immutable object over the
    # newest identifier layer, and the walk hands the same instance to every fund. It
    # answers one question per filing row — can this row's own identifier name a
    # security even though the company ladder could not name its issuer — which is the
    # difference between ``coverage_pct`` and ``identified_pct``.
    #
    # ``security_identity=False`` (``--no-security-identity``) or a missing layer leaves
    # it ``None``, and identification then equals attribution by construction: that is
    # the determinism control, and why a release built without the layer reproduces the
    # numbers it published before this column existed.
    if not security_identity:
        security_map = None
        _log("security map: disabled (--no-security-identity)")
    elif security_map is None:
        security_map = identifiers.load_security_map(layer_dir)
        if security_map is None:
            _log(
                "security map: no layer on disk — identified will equal attributed "
                "(harvest one, or pass --no-security-identity to say so explicitly)"
            )
        else:
            _log(
                f"security map: {len(security_map.figi_by_key):,} identifiers to a FIGI, "
                f"{len(security_map.figis):,} FIGIs known (layer {security_map.release})"
            )
    else:
        _log(
            f"security map: {len(security_map.figi_by_key):,} identifiers to a FIGI "
            f"(layer {security_map.release}, supplied by the caller)"
        )

    release = release_id or time.strftime("%Y-%m-%d", time.gmtime()) + ".1"
    release_dir = out_dir / "releases" / release
    funds_dir = release_dir / "funds"
    funds_dir.mkdir(parents=True, exist_ok=True)

    _log(f"building release {release} → {release_dir} ({len(refs):,} funds, {label})")

    # Resolve every registrant's series→filing index up front. This is the whole
    # reason a 12,000-fund run is affordable: fetching inside the build loop made
    # a trust's filing history be re-read once per series (O(n²) per trust).
    started_prefetch = time.monotonic()
    indexed = filings.prefetch(
        refs, workers=workers, progress=_log if progress_every else None
    )
    _log(
        f"indexed {indexed['documents']:,} N-PORT documents across "
        f"{indexed['registrants']:,} registrants (largest {indexed['largest']:,} series) "
        f"in {time.monotonic() - started_prefetch:.1f}s"
    )

    # The identity table is built from what the ladder proved, then the funds are
    # rebuilt once with it. Two passes rather than one because the evidence is
    # cross-fund: a security this fund cannot name is often named correctly by
    # three others. Pass 1 keeps no artifacts and no failures — it exists only to
    # collect evidence — so a fund that fails here is reported by pass 2, with the
    # same error, exactly once.
    table = IdentityTable.empty()
    # ADR-0016: the evidence pass also yields the set of series LEIs this release
    # publishes, which is what makes a filed row a *fund position* by identity rather
    # than by the filer's label. Free here — the pass already parses every filing.
    fund_leis: dict[str, str] = {}
    if identity:
        started_evidence = time.monotonic()
        evidence = IdentityEvidence()
        _, pass_one_failures = _walk(
            refs,
            index,
            workers=workers,
            identity=None,
            log=progress_every,
            on_error="skip",
            started=started,
            merge_evidence=evidence,
            series_out=fund_leis,
            security_map=security_map,
        )
        table = evidence.table()
        _log(
            f"identity pass: {len(table.by_isin):,} ISINs + {len(table.by_lei):,} LEIs "
            f"corroborated from {len(refs) - len(pass_one_failures):,} funds "
            f"({table.contested.get('isin', 0)}/{table.contested.get('lei', 0)} keys "
            f"contested, {table.thin.get('isin', 0)}/{table.thin.get('lei', 0)} seen "
            f"once) in {time.monotonic() - started_evidence:.1f}s"
        )
    else:
        _log("identity pass: disabled (--no-identity)")

    if fund_leis:
        _log(
            f"fund-position model: {len(fund_leis):,} series LEIs identify a fund "
            "position in any filing, whatever the filer labelled it (ADR-0016)"
        )
    else:
        _log(
            "fund-position model: off — a --no-identity build has no series-LEI set, "
            "so a row is a fund position only when its filer says so"
        )

    # One tally for the release-wide country vote (``company_countries``): every
    # fund's mapped rows arrive on this thread as it lands, so the votes are folded in
    # a single deterministic order and no per-fund map is retained.
    country_tally = company_countries.Tally()
    # The size lane's tally: folded per fund on this thread, so a full-universe build
    # holds one dict of (value, balance) sums per company rather than 9,327 vectors.
    size_tally = sizes.PriceTally() if size_buckets else None
    builds, failures = _walk(
        refs,
        index,
        workers=workers,
        identity=table if identity else None,
        log=progress_every,
        on_error=on_error,
        started=started,
        issuers=issuers,
        fund_leis=fund_leis or None,
        votes=country_tally,
        security_map=security_map,
        sizes_tally=size_tally,
    )

    if failures and on_error == "fail":
        preview = "; ".join(f"{row['ticker']}: {row['error']}" for row in failures[:5])
        raise GateError(
            f"{len(failures):,} of {len(refs):,} funds failed — refusing the release "
            f"({preview}{' …' if len(failures) > 5 else ''})"
        )

    builds.sort(key=lambda build: build.ticker)
    aliases = _alias_map(builds)
    if builds:
        started_flatten = time.monotonic()
        lookthrough_stats = _flatten_fund_of_funds(builds, aliases)
        _log(
            f"fund-of-funds: {lookthrough_stats['fund_of_funds']:,} funds hold funds, "
            f"{lookthrough_stats['flattened']:,} flattened "
            f"({lookthrough_stats['components_only']:,} sleeves-only), "
            f"{lookthrough_stats['edges_resolved']:,}/{lookthrough_stats['edges']:,} edges "
            f"resolved ({lookthrough_stats['edges_by_series_lei']:,} by series LEI), "
            f"refusals={lookthrough_stats['refusals'] or '{}'} in "
            f"{time.monotonic() - started_flatten:.1f}s"
        )
    else:
        lookthrough_stats = {}
    files: list[dict] = []
    rung_totals: dict[str, int] = {}
    cat_totals: dict[str, int] = {}
    documents: list[dict] = []
    summary_funds: list[dict] = []
    for build in builds:
        rel_path = f"funds/{build.ticker}.json"
        (release_dir / rel_path).write_bytes(build.payload)
        documents.append(build.document)
        files.append(manifest_mod.file_entry(rel_path, build.payload))
        for rung, count in build.stats["rungs"].items():
            rung_totals[rung] = rung_totals.get(rung, 0) + count
        for category, count in build.stats["asset_cats"].items():
            cat_totals[category] = cat_totals.get(category, 0) + count
        summary_funds.append(
            {
                "ticker": build.ticker,
                "name": build.stats["name"],
                "issuer": build.stats["issuer"],
                "as_of": build.stats["as_of"],
                "net_assets": build.stats["net_assets"],
                "coverage_pct": build.stats["coverage_pct"],
                "bytes": len(build.payload),
                "total_bp": build.stats["total_bp"],
                "etf": build.stats["etf"],
                "seconds": build.stats["seconds"],
            }
        )

    # --- the company→country decision, and the fallback for what it could not do.
    # The vote has been final since the last fund landed, so this is the one place
    # the map is decided; both the company shards and companies/countries.json are
    # written from it (below), which is what keeps them the same fact.
    countries, country_stats = company_countries.decide(country_tally)
    # The map describes the release, so it may only name companies the release
    # publishes: the vote's tally is built from every holding the build read, while the
    # shards are built from the documents that survived the per-fund gates, and a
    # country on a company with no shard is an extra key the projection gate refuses
    # (it failed the 2026-11-02 19:37 refresh on three of them). Projecting here makes
    # the map a projection by construction, and the fallback below is asked about the
    # same set, so the two cannot drift.
    release_company_set = company_countries.release_companies(documents)
    countries = company_countries.project(countries, release_company_set)
    # The override table runs in front of the vote, and in front of the fallback: a
    # company whose registered office is a haven and whose business is elsewhere is
    # placed by the table, and the fallback is then never asked about it. The table is
    # hand-maintained, so it is loaded and validated here rather than at import time —
    # a malformed row must stop the build, not the test suite.
    override_stats: dict | None = None
    overrides = company_countries.load_overrides()
    if overrides:
        countries, override_stats = company_countries.apply_overrides(
            countries,
            overrides,
            companies=release_company_set,
            log=_log,
        )
        _log(
            f"country overrides: {override_stats['applied']:,} applied "
            f"({override_stats['changed']:,} changed, {override_stats['supplied']:,} supplied), "
            f"{override_stats['redundant']:,} redundant, "
            f"{override_stats['unmatched']:,} unmatched"
        )
    fallback_stats: dict | None = None
    country_fallback_manifest: dict | None = None
    # A release that decided nothing publishes no map, so it publishes no fallback
    # either: the block describes the map, and there is none to describe.
    if countries and country_fallback:
        undecided = sorted(release_company_set - set(countries))
        jurisdictions = _gleif_jurisdictions(issuers, countries, undecided)
        # EDGAR is asked about the companies that need it — every undecided CIK
        # company — plus a fixed sample of decided ones, because the agreement gate
        # cannot compare against an answer nobody fetched.
        wanted = [company_id for company_id in undecided if company_countries.cik_of(company_id)]
        sample = _edgar_sample(countries, company_countries.EDGAR_AGREEMENT_SAMPLE)
        asked = [*wanted, *sample]
        codes = company_countries.edgar_incorporations(asked, log=_log)
        # The cover page is asked about the same set, and only about the companies the
        # summary field left blank: for a foreign private issuer that field is an empty
        # string, while its own annual report states the jurisdiction. Asking the same
        # set keeps the agreement rate comparable to the other two sources.
        cover_codes = company_countries.cover_page_incorporations(asked, log=_log)
        countries, fallback_stats = company_countries.apply_fallback(
            countries,
            companies=release_company_set,
            gleif_jurisdictions=jurisdictions,
            edgar_codes=codes,
            cover_page_codes=cover_codes,
        )
        country_fallback_manifest = {
            **fallback_stats,
            "rule": company_countries.FALLBACK_RULE,
            "edgar_cache": {
                # Relative when the pipeline ran from the repo (the normal case);
                # a CI cache outside the tree contributes only its name, because an
                # absolute build path is nobody's business in a public artifact.
                "dir": str(sec.CACHE_DIR if not sec.CACHE_DIR.is_absolute() else sec.CACHE_DIR.name),
                "max_age_days": company_countries.EDGAR_MAX_AGE_S // 86_400,
                "asked": len(asked),
                "answered": len(codes),
            },
            "cover_page": {
                "asked": len(asked),
                "answered": len(cover_codes),
                "forms": list(company_countries.COVER_PAGE_FORMS),
            },
        }
        _log(
            f"country fallback: {fallback_stats['sources']['gleif']:,} by GLEIF "
            f"jurisdiction, {fallback_stats['sources']['edgar']:,} by EDGAR "
            f"incorporation, {fallback_stats['sources']['cover_page']:,} by annual-report "
            f"cover page, {fallback_stats['sources']['nport']:,} by the vote "
            f"(EDGAR asked {len(asked):,}, answered {len(codes):,}; cover page answered "
            f"{len(cover_codes):,}; agreement gleif={fallback_stats['agreement']['gleif_bp']:,}bp/"
            f"{fallback_stats['agreement']['gleif_compared']:,}, "
            f"edgar={fallback_stats['agreement']['edgar_bp']:,}bp/"
            f"{fallback_stats['agreement']['edgar_compared']:,}, "
            f"cover_page={fallback_stats['agreement']['cover_page_bp']:,}bp/"
            f"{fallback_stats['agreement']['cover_page_compared']:,})"
        )

    # The Markets bar has to place every position, and a company the vote and the
    # fallback both refused is still weight. A second, weaker answer — the country
    # holding the largest share of the money in it — is published *beside* the map and
    # never merged into it: the company tag keeps "we decline to place it", and the bar
    # gets a bucket. Computed after the fallback so it only covers what is still
    # undecided, and projected to the release's companies for the same reason the map
    # is (a country on a company with no shard is an extra key the gate refuses).
    contested_countries: dict[str, str] | None = None
    if countries:
        contested_countries = company_countries.contested(
            country_tally, release_company_set - set(countries)
        )
        _log(
            f"contested countries: {len(contested_countries):,} of "
            f"{len(release_company_set) - len(countries):,} undecided company(ies) "
            f"placed by their largest share"
        )

    document = manifest_mod.build_manifest(
        release_id=release,
        funds=documents,
        files=files,
        rung_counts={name: int(rung_totals.get(name, 0)) for name in RUNG_NAMES},
        asset_cat_counts=dict(sorted(cat_totals.items())),
        identity_namespaces=_identity_namespaces(issuers, rung_totals),
        country_fallback=country_fallback_manifest,
        generated_at=generated_at,
    )
    payload = artifact.canonical_bytes(document)
    (release_dir / "manifest.json").write_bytes(payload)

    # What a browser actually reads. The manifest above is the inventory (8,533
    # entries at day-4 scale, 0.42 MB gzipped, on nobody's critical path); these
    # are the catalogue, the per-letter hash shards, and the reverse X-Ray shards.
    new_aliases = aliases
    _log(
        f"country: {len(countries):,} of "
        f"{len(release_company_set) or country_tally.companies():,} companies placed "
        f"({country_stats['below_floor']:,} below the vote's floor, "
        f"{country_tally.invalid_rows:,} row(s) with an unusable invCountry)"
    )
    browser_objects = catalogue.write_release_objects(
        release_dir,
        release=release,
        documents=documents,
        files=files,
        header=document,
        manifest_payload=payload,
        aliases=new_aliases,
        etf_classifier=classify.ETF_CLASSIFIER,
        securities_source=securities_source,
        countries=countries,
        invalid_country_rows=country_tally.invalid_rows,
        countries_fallback=fallback_stats,
        countries_contested=contested_countries,
        countries_overrides=override_stats,
    )
    # The size table is a browser object by presence, like the country map: it is
    # written beside the catalogue, uploaded with the release (every file in the
    # release directory is published), and a release without it simply has no size
    # bar. It is deliberately *not* a manifest entry: the manifest's ``files`` is the
    # fund set, which the validator checks as an exact set.
    size_summary: dict | None = None
    if size_tally is not None and len(size_tally):
        started_sizes = time.monotonic()
        sized = sizes.build(
            size_tally.observations(),
            release=release,
            log=_log,
            **({"cover_limit": size_cover_limit} if size_cover_limit else {}),
        )
        _, size_body = sizes.write(sized, release_dir)
        counts = sized.counts
        size_summary = {
            "bytes": len(size_body),
            "sha256": artifact.sha256_hex(size_body),
            **counts,
        }
        _log(
            f"size table: {counts['placed']:,} companies placed of "
            f"{counts['companies']:,} ({counts['frame']:,} by frame, "
            f"{counts['cover']:,} by cover page), {len(size_body):,}B in "
            f"{time.monotonic() - started_sizes:.0f}s"
        )
    else:
        _log("size table: skipped (no equity price observations)")

    elapsed = time.monotonic() - started
    _log(
        f"manifest: {len(documents):,} funds, {document['company_count']:,} companies, "
        f"{len(payload):,}B, etf={document['etf_count']:,}, "
        f"coverage={document['coverage_histogram']}"
    )
    _log(f"browser objects: {browser_objects['summary']}")

    summary = {
        "release": release,
        "release_dir": str(release_dir),
        "universe": label,
        "funds": summary_funds,
        "fund_count": len(documents),
        "attempted": len(refs),
        "failed": sorted(failures, key=lambda row: row["ticker"]),
        "company_count": document["company_count"],
        "etf_count": document["etf_count"],
        "etf_classifier": document["etf_classifier"],
        "rungs": document["mapping_rungs"],
        "identity_namespaces": document.get("identity_namespaces"),
        "coverage_histogram": document["coverage_histogram"],
        "lookthrough": lookthrough_stats,
        "manifest_bytes": len(payload),
        "manifest_sha256": artifact.sha256_hex(payload),
        "release_object_bytes": browser_objects["release_bytes"],
        "release_object_sha256": browser_objects["release_sha256"],
        "browser_objects": browser_objects["sizes"],
        "size_buckets": size_summary,
        "elapsed_seconds": round(elapsed, 1),
        "workers": workers,
        "generated_at": document["generated_at"],
    }
    (release_dir / "build-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n"
    )
    _log(
        f"done in {elapsed:.1f}s — {len(documents):,} funds, {len(failures):,} failed, "
        f"{sum(row['bytes'] for row in summary_funds) / 1e6:.1f} MB of fund files"
    )
    return release_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.build", description=__doc__)
    parser.add_argument(
        "--tickers",
        default=None,
        help="comma-separated tickers (the day-1 slice; same as --universe tickers:…)",
    )
    parser.add_argument(
        "--universe",
        default=None,
        help="'all' for every SEC fund series, or 'tickers:VOO,QQQ' (default: VOO)",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=None,
        help="with --universe all and --from-summary: keep the N largest funds by N-PORT net assets",
    )
    parser.add_argument(
        "--from-summary",
        type=Path,
        default=None,
        help="a previous release's build-summary.json, used by --top",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="first N funds of the resolved universe (a deterministic sample)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=REPO_ROOT / "artifacts",
        help="output root (default: artifacts/)",
    )
    parser.add_argument(
        "--release-id",
        default=None,
        help="release id, YYYY-MM-DD[.N]; default is today's UTC date with .1",
    )
    parser.add_argument(
        "--generated-at",
        default=None,
        help="override generated_at (ISO 8601) — use with SOURCE_DATE_EPOCH for "
        "byte-identical rebuilds",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="funds built concurrently (default 1; SEC requests stay throttled to 8/s)",
    )
    parser.add_argument(
        "--on-error",
        choices=("fail", "skip"),
        default=None,
        help="fail on the first unusable fund (default for tickers) or record it and "
        "continue (default for --universe all)",
    )
    parser.add_argument(
        "--no-identity",
        action="store_true",
        help="skip the corroborated ISIN/LEI identity pass (one build instead of two); "
        "the control for measuring what the pass is worth",
    )
    parser.add_argument(
        "--layer",
        type=Path,
        default=None,
        help="identifier layer to read instead of the newest under "
        "data/identifier-layer (so a release can name the layer it was built "
        "against, and a half-written layer beside it cannot be chosen by accident)",
    )
    parser.add_argument(
        "--no-security-identity",
        action="store_true",
        help="skip the security map (identifier → FIGI) and publish identification "
        "equal to attribution; the control for measuring what the OpenFIGI layer is "
        "worth, with identity frozen",
    )
    parser.add_argument(
        "--no-issuers",
        action="store_true",
        help="skip the foreign-issuer (GLEIF) namespace; the control build for "
        "measuring what the namespace is worth, with identity frozen",
    )
    parser.add_argument(
        "--no-country-fallback",
        action="store_true",
        help="place only what the N-PORT vote decides; the control build for "
        "measuring what GLEIF jurisdiction and EDGAR incorporation are worth",
    )
    parser.add_argument(
        "--size-cover-limit",
        type=int,
        default=None,
        help="how many companies the cover-page lane may visit (default 600, ranked by "
        "value); a smaller number is how a smoke build stays fast",
    )
    parser.add_argument(
        "--no-size-buckets",
        action="store_true",
        help="skip the size table (implied price × dei share count); the control build "
        "for measuring what the two lanes place",
    )
    parser.add_argument(
        "--no-securities",
        action="store_true",
        help="skip the typed-symbol object (securities/), so a release without it can "
        "be built — the app then refuses a stock ticker with 'not in this release'",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=0,
        help="print a progress line every N funds (0 = only the final summary)",
    )
    args = parser.parse_args(argv)

    if args.universe:
        spec = args.universe
    else:
        spec = f"tickers:{args.tickers or 'VOO'}"
    label = spec if args.top is None and args.limit is None else (
        f"{spec} top={args.top} limit={args.limit}"
    )
    on_error = args.on_error or ("fail" if spec.startswith("tickers:") else "skip")

    securities_source = None
    if not args.no_securities:
        # One request, 1.0 MB, cached for the same six hours as the other index
        # files. It is the only thing a typed stock ticker needs (ADR-0014).
        try:
            securities_source = securities.fetch_document()
        except (sec.SecError, ValueError) as error:
            _log(f"securities: unavailable ({error}); the release will not carry a symbol object")
    try:
        refs = resolve_universe(
            spec, limit=args.limit, top=args.top, from_summary=args.from_summary
        )
        build_release(
            refs,
            out_dir=args.out,
            release_id=args.release_id,
            generated_at=args.generated_at,
            workers=max(1, args.workers),
            on_error=on_error,
            label=label,
            progress_every=max(0, args.progress_every),
            identity=not args.no_identity,
            issuer_namespace=not args.no_issuers,
            country_fallback=not args.no_country_fallback,
            securities_source=securities_source,
            security_identity=not args.no_security_identity,
            layer_dir=args.layer,
            size_buckets=not args.no_size_buckets,
            size_cover_limit=args.size_cover_limit,
        )
    except (
        GateError,
        company_countries.CountryFallbackError,
        NportParseError,
        LookupError,
        filings.NoFilingError,
    ) as error:
        _log(f"FAILED: {type(error).__name__}: {error}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
