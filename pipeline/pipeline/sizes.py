"""Market-capitalisation size classes for a fund's holdings, from SEC filings only.

**Why this exists.** A reader looking at a fund's holdings can see what it owns but not
how big those companies are. The size mix is the one fact about a portfolio that a
professional asks for first ("is this a large-cap fund or a small-cap fund?") and the
one the page could not answer. Every input is already fetched by the build: an N-PORT
row carries ``valUSD`` and ``balance``, so ``ΣvalUSD / Σbalance`` across the funds that
hold a security is its quarter-end price per share; a ``dei`` share count turns that
price into a market capitalisation. No vendor, no new source, no scraper.

**The two lanes, and why both exist.**

1. **Frames** — SEC's XBRL frames API publishes
   ``dei:EntityCommonStockSharesOutstanding`` for every filer, one JSON per quarter
   (about 0.4 MB each). Four quarters place 73% of CIK-form companies in one request per
   quarter and are the fast path.
2. **Cover page** — a company that files several share classes (Alphabet, Meta,
   Berkshire, Visa, Mastercard) publishes one fact *per class* on the cover of its
   10-K/10-Q, and the frames endpoint carries the class-dimensioned facts in a shape we
   cannot sum from one row. ``cover_shares`` reads the filing itself and sums the
   classes, with the subtotal trap handled. This lane is bounded to the companies whose
   absence actually costs coverage; it is not a second full pass over the market.

**What the numbers are not.** The cap is the *filer's own* share count times a price
implied by institutional quarter-end marks, so it is a market value at the fund's report
date, not a live quote. It is published with both dates, rounded, and bucketed by lines
that are ours (``BANDS``) — a reader can recompute every band from the numbers shown.

**Company identity is never a ticker.** ``company_id`` is ``c_<CIK>`` for a US filer and
``l_<LEI>`` for a foreign issuer. Only the CIK prefix has a cover page, so only it can
be placed by either lane; an ``l_`` company is reported as unplaced rather than guessed.
"""

from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping

from . import sec

#: The published lines, descending. Ours, not a vendor's: a fixed dollar line is
#: auditable and does not rebalance, whereas a percentile band silently moves under the
#: reader. Morningstar's familiar names are in the same family; its top band is "giant"
#: and its lines are percentiles, so the two are not interchangeable and the page does
#: not claim they are.
BANDS: tuple[tuple[str, float], ...] = (
    ("mega", 200e9),
    ("large", 10e9),
    ("mid", 2e9),
    ("small", 300e6),
    ("micro", 0.0),
)

BAND_ORDER: tuple[str, ...] = tuple(key for key, _ in BANDS)

BAND_LABELS: dict[str, str] = {
    "mega": "Mega",
    "large": "Large",
    "mid": "Mid",
    "small": "Small",
    "micro": "Micro",
}

#: The share-count concept every cover page carries (dei namespace, all years).
SHARE_CONCEPT = "EntityCommonStockSharesOutstanding"

#: A share fact older than this, relative to the price date, is not a current share
#: count: splits and issuance move it. Thirteen months rather than the plan's first
#: 180 days because a foreign private issuer files one 20-F a year: its only share fact
#: is up to twelve months old (HSBC, Novartis, TSMC, ASML — measured 2026-11-07, the
#: 180-day window placed 1.4% of an international fund's equity weight, this places a
#: quarter of it). The fact's date is published beside every cap, and the band is
#: coarse enough that a few percent of issuance drift does not move it.
MAX_SHARE_AGE_DAYS = 400

#: How many companies the cover-page lane may visit in one build. Ranked by the value
#: they represent, so the lane spends its requests where the coverage is. That bound is
#: what keeps a daily build honest: an unbounded lane is ~1,500 filings a day to recover
#: names the frames never had, and the cache is what makes the second build cheap.
COVER_LANE_LIMIT = 600

CIK_ID = re.compile(r"^c_(\d{10})$")

FRAME_URL = (
    "https://data.sec.gov/api/xbrl/frames/dei/"
    "{concept}/shares/CY{year}Q{quarter}I.json"
)


def band_for(cap_usd: float | None) -> str | None:
    """The band a market capitalisation falls in, or ``None`` without a cap."""
    if cap_usd is None or not math.isfinite(cap_usd) or cap_usd <= 0:
        return None
    for key, floor in BANDS:
        if cap_usd >= floor:
            return key
    return "micro"


@dataclass(frozen=True)
class CompanyCap:
    """One company's cap and the two facts it is made of."""

    company_id: str
    usd: int
    shares: int
    share_date: str
    price: float
    report_date: str
    basis: str  # "frame" | "cover"

    @property
    def band(self) -> str:
        return band_for(self.usd) or "micro"

    def as_json(self) -> dict:
        return {
            "usd": self.usd,
            "shares": self.shares,
            "share_date": self.share_date,
            "price": round(self.price, 2),
            "report_date": self.report_date,
            "basis": self.basis,
            "band": self.band,
        }


@dataclass
class BuildResult:
    payload: dict
    caps: dict[str, CompanyCap]
    counts: dict[str, int] = field(default_factory=dict)


class PriceTally:
    """The release-wide accumulator of per-fund price observations.

    Folded on the walk's consumer thread as each fund lands (the same pattern as the
    country vote), so a full-universe build holds one dict of sums, not 9,327 vectors.
    A company's *latest* report date wins; older dates stay only as a fallback when the
    latest one has no share fact.
    """

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, list[float]]] = {}

    def add_fund(self, vector, report_date: str) -> None:
        if not report_date:
            return
        for row in vector.holdings:
            if not row.company_id or row.asset_cat != "equity":
                continue
            if not row.value_usd or not row.balance:
                continue
            dated = self.rows.setdefault(row.company_id, {})
            slot = dated.setdefault(report_date, [0.0, 0.0, 0.0])
            slot[0] += row.value_usd
            slot[1] += row.balance
            slot[2] += 1

    def observations(self):
        for company_id, dated in self.rows.items():
            for report_date, (value, balance, rows) in dated.items():
                yield company_id, report_date, value, balance

    def __len__(self) -> int:
        return len(self.rows)


def _quarter(date: str) -> tuple[int, int]:
    year, month = int(date[:4]), int(date[5:7])
    return year, (month - 1) // 3 + 1


def _quarters_between(first: str, last: str) -> list[tuple[int, int]]:
    """Every calendar quarter from ``first`` to ``last`` (inclusive), oldest first."""
    fy, fq = _quarter(first)
    ly, lq = _quarter(last)
    quarters: list[tuple[int, int]] = []
    while (fy, fq) <= (ly, lq):
        quarters.append((fy, fq))
        fq += 1
        if fq > 4:
            fy, fq = fy + 1, 1
    return quarters


def fetch_frame_facts(
    dates: Iterable[str], *, max_age: float | None = 7 * 24 * 3600
) -> dict[str, list[tuple[str, float]]]:
    """``cik → [(end, shares), …]`` from the XBRL frames endpoint.

    One request per calendar quarter touched by the price dates (a few MB total), and
    the HTTP cache in ``sec`` makes a second build pay nothing. ``max_age`` is a week:
    a frame is a view of filings, not an immutable document, and a stale share count
    after a split is the one error this lane must not repeat.
    """
    dates = sorted(dates)
    if not dates:
        return {}
    # Reach back by the age window, not to the fund's own quarter: a foreign private
    # issuer's only share fact sits on its fiscal-year-end quarter (HSBC's is
    # 2025-12-31, seven months before a July fund report), and a one-quarter window
    # would silently miss every one of them.
    from datetime import timedelta

    window_start = (_parse_date(dates[0]) - timedelta(days=MAX_SHARE_AGE_DAYS)).isoformat()
    facts: dict[str, list[tuple[str, float]]] = {}
    for year, quarter in _quarters_between(window_start, dates[-1]):
        url = FRAME_URL.format(concept=SHARE_CONCEPT, year=year, quarter=quarter)
        try:
            document = sec.fetch_json(url, max_age=max_age)
        except sec.SecError:
            # A missing quarter is not fatal: the nearest-fact rule has other quarters
            # to work with, and a company it cannot date is published as unplaced.
            continue
        for row in document.get("data") or []:
            cik = row.get("cik")
            value = row.get("val")
            end = row.get("end")
            if not cik or not value or not end:
                continue
            # The frame's ``cik`` is an integer, ``company_id`` carries the zero-padded
            # ten-digit form; normalise on the way in or the join silently misses every
            # company (measured 2026-11-07: 0 of 9,070 placed).
            key = str(int(cik)).zfill(10)
            facts.setdefault(key, []).append((str(end), float(value)))
    for key in facts:
        facts[key].sort()
    return facts


def _days_between(first: str, second: str) -> int:
    return abs(
        int(
            (
                _parse_date(second).toordinal() - _parse_date(first).toordinal()
            )
        )
    )


def _parse_date(value: str):
    from datetime import date

    return date(int(value[:4]), int(value[5:7]), int(value[8:10]))


def nearest_share(
    facts: list[tuple[str, float]], report_date: str
) -> tuple[float, str] | None:
    """The share fact closest to ``report_date``, never older than the gate allows."""
    if not facts:
        return None
    best: tuple[int, str, float] | None = None
    for end, value in facts:
        age = _days_between(end, report_date)
        if age > MAX_SHARE_AGE_DAYS:
            continue
        if best is None or age < best[0]:
            best = (age, end, value)
    if best is None:
        return None
    return best[2], best[1]


def _cover_shares(cik: str):
    """Lazy import so the module is testable before the cover lane exists."""
    from . import cover_shares

    return cover_shares.latest_cover_shares(int(cik))


def build(
    observations: Iterable[tuple[str, str, float, float]],
    *,
    release: str,
    cover_lane: bool = True,
    cover_limit: int = COVER_LANE_LIMIT,
    log=None,
) -> BuildResult:
    """Turn per-fund price observations into one published size table.

    ``observations`` is ``(company_id, report_date, value_usd, balance)`` per fund row.
    Aggregation is per company and per report date — the *latest* date wins, so a
    company priced on 2026-06-30 by one fund and 2026-07-31 by another uses the later
    filing, not a blend of the two.
    """
    by_company: dict[str, dict[str, list[float]]] = {}
    for company_id, report_date, value, balance in observations:
        if not company_id or not report_date:
            continue
        if not value or not balance or balance <= 0 or value <= 0:
            continue
        dated = by_company.setdefault(company_id, {})
        slot = dated.setdefault(report_date, [0.0, 0.0, 0.0])
        slot[0] += value
        slot[1] += balance
        slot[2] += 1

    caps: dict[str, CompanyCap] = {}
    price_dates: list[str] = []
    prices: dict[str, tuple[str, float, float, int]] = {}
    for company_id, dated in by_company.items():
        report_date = max(dated)
        value, balance, rows = dated[report_date]
        if balance <= 0 or value <= 0:
            continue
        prices[company_id] = (report_date, value / balance, value, int(rows or 1))
        price_dates.append(report_date)

    frame_facts = fetch_frame_facts(price_dates)
    for company_id, (report_date, price, value, rows) in prices.items():
        match = CIK_ID.match(company_id)
        if match is None:
            continue
        cik = match.group(1)
        fact = nearest_share(frame_facts.get(cik, []), report_date)
        if fact is None:
            continue
        shares, share_date = fact
        caps[company_id] = CompanyCap(
            company_id=company_id,
            usd=int(round(price * shares)),
            shares=int(round(shares)),
            share_date=share_date,
            price=price,
            report_date=report_date,
            basis="frame",
        )

    # The cover lane, in two passes and both ranked by the value the company represents.
    #
    # The first pass is the companies the frames lane could **not** place: that is the
    # coverage the lane exists to recover, so it goes first and a limited budget cannot
    # be spent on companies that already have a cap. The second pass visits companies
    # the frame lane *did* place, because the frames endpoint publishes one fact per
    # filer and for a multi-class issuer that fact is often one class (Alphabet's Class A
    # alone, not A+C+D), so a frame count and a cover total can disagree by a factor.
    # Agreement within 10% keeps the cheaper lane; disagreement is decided by the cover
    # page, because summing the classes is the thing the frame cannot do.
    ranked = [
        (company_id, prices[company_id][1], prices[company_id][2], company_id not in caps)
        for company_id in prices
        if CIK_ID.match(company_id)
    ]
    ranked.sort(key=lambda row: (not row[3], -row[2]))
    if log is not None and ranked:
        unplaced_in_lane = sum(1 for row in ranked[:cover_limit] if row[3])
        log(
            f"size lane: {unplaced_in_lane} of {sum(1 for row in ranked if row[3])} "
            f"unplaced company(ies) inside the {cover_limit}-lookup budget"
        )
    overrides = 0
    visited = 0
    if cover_lane and ranked:
        started = time.monotonic()
        for company_id, price, _value, _was_unplaced in ranked[:cover_limit]:
            matter = CIK_ID.match(company_id)
            if matter is None:
                continue
            report_date = prices[company_id][0]
            try:
                covers = _cover_shares(matter.group(1))
            except Exception:  # noqa: BLE001 - one bad filing must not fail a release
                continue
            if covers is None:
                continue
            if _days_between(covers.as_of, report_date) > MAX_SHARE_AGE_DAYS:
                continue
            visited += 1
            existing = caps.get(company_id)
            if existing is not None and existing.shares:
                ratio = covers.shares / existing.shares
                if 0.9 <= ratio <= 1.1:
                    continue
                overrides += 1
            caps[company_id] = CompanyCap(
                company_id=company_id,
                usd=int(round(price * covers.shares)),
                shares=int(round(covers.shares)),
                share_date=covers.as_of,
                price=price,
                report_date=report_date,
                basis="cover",
            )
        if log is not None:
            log(
                f"size lane: {visited} cover-page lookups in "
                f"{time.monotonic() - started:.0f}s ({overrides} replaced a frame count, "
                f"{len(ranked) - min(len(ranked), cover_limit)} company(ies) beyond the lane)"
            )

    by_basis = {"frame": 0, "cover": 0}
    for cap in caps.values():
        by_basis[cap.basis] += 1

    band_counts = {key: 0 for key in BAND_ORDER}
    for cap in caps.values():
        band_counts[cap.band] += 1

    payload = {
        "schema_version": 1,
        "as_of": release,
        "kind": "sizes",
        "thresholds": {f"{key}cap": threshold for key, threshold in BANDS},
        "bands": list(BAND_ORDER),
        "price_basis": "nport_implied",
        "counts": {
            "companies": len(by_company),
            "priced": len(prices),
            "placed": len(caps),
            "frame": by_basis["frame"],
            "cover": by_basis["cover"],
            "cover_overrides": overrides,
            "no_shares": len(prices) - len(caps),
            "no_price": len(by_company) - len(prices),
        },
        "band_counts": band_counts,
        "caps": {company_id: cap.as_json() for company_id, cap in sorted(caps.items())},
    }
    return BuildResult(payload=payload, caps=caps, counts=payload["counts"])


def write(objects: BuildResult, release_dir: Path) -> tuple[Path, bytes]:
    """Write ``companies/sizes.json`` into a release and return its path and bytes."""
    target = Path(release_dir) / "companies" / "sizes.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(
        objects.payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()
    target.write_bytes(body)
    return target, body


# --------------------------------------------------------------------------------------
# The international lane: what a fund's own name says about its size mandate.
#
# This is inference, and it is labelled as inference everywhere it is rendered. It is
# fund-level only — a company is never given an inferred bucket from the names of the
# funds that hold it (measured 2026-11-06: top-1 agreement 46-48%, "small" precision
# 54-69%, so the company-level version was rejected).
# --------------------------------------------------------------------------------------

#: Fraction of *sized* equity weight in each band, measured on US funds with a stated
#: mandate (p10 / p50 / p90 across funds, release 2026-11-06.2). A mandate predicts the
#: fund-level mix strongly enough to band it — a "large cap" fund is about 98%
#: mega-or-large — but it does not reproduce a five-band bar, and the band names do not
#: map onto our lines (a "small cap" fund is mostly our *mid*). Hence ranges, not points.
MANDATE_MIX: dict[str, dict[str, tuple[int, int, int]]] = {
    "large": {"mega": (16, 57, 76), "large": (24, 41, 81), "mid": (0, 0, 5)},
    "mid": {"large": (41, 75, 93), "mid": (6, 22, 50), "small": (0, 0, 7)},
    "small": {
        "large": (1, 12, 38),
        "mid": (47, 65, 82),
        "small": (4, 15, 36),
        "micro": (0, 0, 2),
    },
    "micro": {"mid": (3, 27, 66), "small": (26, 58, 74), "micro": (0, 5, 27)},
    "large_mid": {"mega": (10, 55, 68), "large": (32, 45, 82), "mid": (0, 0, 13)},
}

MANDATE_LABELS: dict[str, str] = {
    "large": "large-cap mandate",
    "mid": "mid-cap mandate",
    "small": "small-cap mandate",
    "micro": "micro-cap mandate",
    "large_mid": "large- and mid-cap mandate",
}

LARGE_MID = "large_mid"

#: Fund-name fragments that state a size mandate, checked in order. Index names are
#: included because the index *is* the mandate: an S&P 500 fund cannot hold small caps,
#: an MSCI EAFE fund is large and mid by construction. Fragments match the registered
#: name, uppercased, on word boundaries where it matters.
_NAME_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    # Unambiguous single words first.
    (re.compile(r"\bMICRO[- ]?CAP\b|\bMICROCAP\b"), "micro"),
    (re.compile(r"\bSMALL[- ]?CAP\b|\bSMALLCAP\b|\bSMALL[- ]COMPANY\b|\bSMALL[- ]COMPANIES\b"), "small"),
    (re.compile(r"\bMID[- ]?CAP\b|\bMIDCAP\b|\bMID[- ]COMPANY\b|\bMID[- ]COMPANIES\b"), "mid"),
    (re.compile(r"\bLARGE[- ]?CAP\b|\bLARGECAP\b|\bLARGE[- ]COMPANY\b|\bLARGE[- ]COMPANIES\b"), "large"),
    # A mega-cap name is a large-cap mandate with a higher floor, and the calibration's
    # "large" bucket is a US large-cap fund (98% mega-or-large) — there is no mega-only
    # fund in the samples to calibrate a separate mix against, so it is not invented.
    (re.compile(r"\bMEGA[- ]?CAP\b|\bMEGACAP\b"), "large"),
    # Index families. The order matters: a "small cap" index name must win over the
    # broad family it belongs to (Russell 2000 is small even though "Russell" appears
    # in the large-cap family too, and S&P 600 is small while S&P 500 is not).
    (re.compile(r"\bS&P 600\b|\bS&P SMALLCAP\b"), "small"),
    (re.compile(r"\bRUSSELL 2000\b"), "small"),
    (re.compile(r"\bRUSSELL MICROCAP\b|\bMICROCAP INDEX\b"), "micro"),
    (re.compile(r"\bS&P 400\b|\bS&P MIDCAP\b"), "mid"),
    (re.compile(r"\bRUSSELL MIDCAP\b|\bCRSP US MID\b"), "mid"),
    (re.compile(r"\bS&P 500\b|\bNASDAQ-100\b|\bRUSSELL 1000\b|\bCRSP US LARGE\b"), "large"),
    # International index mandates: large and mid by construction, and the biggest
    # international funds are exactly these names.
    (re.compile(r"\bEAFE\b|\bEUROPE,? AUSTRALASIA\b"), LARGE_MID),
    (re.compile(r"\bMSCI EM\b|\bEMERGING MARKETS\b|\bMSCI WORLD\b|\bWORLD EX[- ]US\b"), LARGE_MID),
    (re.compile(r"\bTOTAL INTERNATIONAL\b|\bINTERNATIONAL STOCK\b|\bINTERNATIONAL EQUITY\b"), LARGE_MID),
)

#: Names that explicitly mean "the whole market" — a size statement of the *absence* of
#: one. They are not inferred, and the page says so rather than guessing.
_ALL_CAP = re.compile(
    r"\bALL[- ]CAP\b|\bALL[- ]MARKET\b|\bTOTAL STOCK\b|\bBROAD MARKET\b|"
    r"\bWILSHIRE 5000\b|\bRUSSELL 3000\b|\bTOTAL MARKET\b|\bCOMPLETION\b|\bEXTENDED MARKET\b"
)


@dataclass(frozen=True)
class Mandate:
    """A size statement a fund's own name makes, and how it was read."""

    key: str  # large | mid | small | micro | large_mid
    label: str
    matched: str


def mandate_for(name: str) -> Mandate | None:
    """The size mandate stated by a fund's registered name, or ``None``.

    ``None`` covers both "says nothing" and "says all-cap": an all-cap name is a real
    statement, but it is the statement that there is no single size, so it is not an
    inference we render as a band.
    """
    if not name:
        return None
    upper = name.upper()
    if _ALL_CAP.search(upper):
        return None
    for pattern, key in _NAME_RULES:
        match = pattern.search(upper)
        if match is not None:
            return Mandate(key=key, label=MANDATE_LABELS[key], matched=match.group(0))
    return None


def mix_ranges(key: str) -> dict[str, tuple[int, int]]:
    """The p10-p90 ranges for one mandate, in band order, dropping empty bands."""
    mix = MANDATE_MIX.get(key) or {}
    answer: dict[str, tuple[int, int]] = {}
    for band in BAND_ORDER:
        row = mix.get(band)
        if row is None:
            continue
        low, _mid, high = row
        if low == 0 and high == 0:
            continue
        answer[band] = (low, high)
    return answer
