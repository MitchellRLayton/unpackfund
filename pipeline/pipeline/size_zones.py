"""The seven Morningstar style zones, and the percentile lines that define a size band.

**Why a percentile, and not a dollar line.** The first version of this feature published
five fixed dollar lines (mega at USD 200bn, large at 10bn, mid at 2bn, small at 300m).
Measured against Morningstar on 2026-11-07 those lines were 4-13x away from every line
the market actually trades at, and the error was not random: a dollar line cannot track a
market whose total capitalisation triples. DFA's US Micro Cap fund was published as 68.8%
*mid* cap while Morningstar — and the fund's own $2.7bn average holding — say micro. The
labels were wrong; the caps were right (our simple average USD 2.61bn against
Morningstar's 2.69bn, weighted 3.25bn against 3.36bn).

**The lines are Morningstar's, and they are cumulative shares of a zone's cap.** Sort a
zone's companies by market capitalisation, largest first, and accumulate their share of
the zone's total. The companies that together make the top 40% are *giant*, the next 30%
*large*, the next 20% *mid*, the next 7% *small*, and the remainder *micro*. That is the
breakpoint set in Morningstar's Style Box methodology (the 40/70/90/97 method: "the stock
that causes cumulative capitalization to equal or exceed 40% ... the final one assigned to
the giant-cap group"; 70% large, 90% mid, 97% small, remainder micro), and it is why a
fund's mix here can be compared with the same fund's Morningstar page at all.

**Seven zones, not one world.** A Japanese small cap is compared with other Japanese
companies, not with the world: Morningstar groups stocks into the United States, Latin
America, Canada, Europe, Japan, Asia ex-Japan and Australia/New Zealand, with African
stocks scored as European and Middle Eastern stocks as Asia ex-Japan. A single global
percentile would call almost every non-US company "small" simply because the US is half
the world's market value.

**What ranks a zone: the zone's own index fund, not our cap table.** Each zone is ranked
by the reported holdings of a fund built to cover exactly that zone — VTI for the United
States, VXUS split by each company's country for the other six. Three reasons:

1. **Completeness.** VTI holds the US market down to a few million dollars of capitalisation
   and VXUS holds 5,486 non-US companies; our own cap lane places 4,425 companies in total
   and only 24% of an ex-US fund's weight, because a foreign private issuer files no US
   share count. Ranking by our own caps would leave three quarters of the non-US market
   missing from its own zone.
2. **One basis for all seven zones.** A zone ranked by an index weight is ranked the same
   way in every zone, which is the whole point of having zones.
3. **No dependence on a number we cannot fully verify.** The published lines are
   *percentiles*, so the reader needs no dollar figure to check a bucket; only the order
   of the companies matters, and that order is the index's own.

The trade-off is a measured one, recorded here rather than hidden: index weights are
float-adjusted, while Morningstar's published breakpoints are total market capitalisation.
Float weighting puts less weight on insider-heavy mega caps and more on the smallest
companies, so the *micro* line lands higher than Morningstar's. Tested on DFA US Micro Cap
on 2026-11-07, this method puts 76% of the fund in micro against Morningstar's 63.9%; the
same test against a total-cap ranking of our own caps lands within three points, but that
ranking has no coverage outside the US and 3.7% of the US market (Palantir, Dell, Comcast,
Accenture) has no filed share count at all. Consistency across the seven zones, and a
basis that cannot be wrong for a quarter of the market, beat a closer match on one fund.

**Membership is the zone fund's, not the country map's.** A company in VTI is ranked in the
United States zone whatever its country of domicile, because VTI *is* the US market: an
Irish-domiciled company listed in New York belongs to the market that prices it. A company
in VXUS is ranked in the zone of its country. A company in neither — a US micro cap below
the index's inclusion line, a recent listing — is placed as ``micro`` and marked
``below_index``, which is what "not in the zone's index" means: smaller than every company
the index ranks. A company with no country at all, or with an offshore filing address
(Cayman, Bermuda, the Marshall Islands), is not placed; the page says so instead of
guessing.

**Company identity is never a ticker.** ``company_id`` is ``c_<CIK>`` or ``l_<LEI>``; the
zone table keys on it, so a dual listing is one company and never two.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

#: The Morningstar style zones, in the order the methodology lists them. "Europe"
#: includes every African country and "Asia ex-Japan" includes the Middle East, so the
#: seven names cover the whole world except the offshore filing addresses below.
ZONE_ORDER: tuple[str, ...] = (
    "us",
    "canada",
    "latin_america",
    "europe",
    "japan",
    "asia_x_japan",
    "australia_nz",
)

ZONE_LABELS: dict[str, str] = {
    "us": "United States",
    "canada": "Canada",
    "latin_america": "Latin America",
    "europe": "Europe",
    "japan": "Japan",
    "asia_x_japan": "Asia ex-Japan",
    "australia_nz": "Australia/New Zealand",
}

#: The published bands, largest first. "Giant" is Morningstar's word for the top band and
#: is used here for the same reason its lines are: so a reader can put this page beside
#: that one. The old top band was called "mega"; the name changed with the method.
BAND_ORDER: tuple[str, ...] = ("giant", "large", "mid", "small", "micro")

BAND_LABELS: dict[str, str] = {
    "giant": "Giant",
    "large": "Large",
    "mid": "Mid",
    "small": "Small",
    "micro": "Micro",
}

#: Where each band *starts*, as a cumulative share of the zone's total capitalisation.
#: One owner for the four numbers: the band test, the page's table, and the validator all
#: read this.
BAND_STARTS: dict[str, float] = {
    "giant": 0.0,
    "large": 0.40,
    "mid": 0.70,
    "small": 0.90,
    "micro": 0.97,
}

#: Which fund ranks each zone. The United States has its own total-market fund; the other
#: six are a split of one ex-US fund, so they share a reporting date and a weight basis.
ZONE_SOURCES: dict[str, str] = {zone: ("VTI" if zone == "us" else "VXUS") for zone in ZONE_ORDER}

#: Countries whose only role is a filing address: a company incorporated in one of these is
#: not placed, because the address says nothing about which market prices it. Measured
#: 2026-11-07: 734 companies, 2.0% of an ex-US fund's weight, mostly Cayman-domiciled
#: Chinese issuers and Bermuda-domiciled shipping and insurance companies.
_OFFSHORE: frozenset[str] = frozenset({"KY", "BM", "VG", "MH"})

#: Country code to zone. Morningstar's Appendix C is the source for the shape of each list;
#: the codes are the ones this pipeline's country map actually emits (89 at 2026-11-07),
#: so a code with no zone here is a deliberate "not placed", not an oversight.
_COUNTRIES: dict[str, str] = {}


def _add(zone: str, codes: str) -> None:
    for code in codes.split():
        _COUNTRIES[code] = zone


_add("us", "US PR")
_add("canada", "CA")
_add("latin_america", "MX BR AR CL CO PE PA BS")
# Europe carries every African country, by the methodology's own rule.
_add(
    "europe",
    "GB IE DE FR IT ES NL BE LU CH AT PT GR SE NO DK FI IS PL CZ HU RO BG HR SI SK EE "
    "LV LT MT CY RU TR UA RS BA MK AL ME MD BY GI FO MC LI JE GG IM "
    "ZA EG NG KE MA MU TN BW GH",
)
_add("japan", "JP")
_add("australia_nz", "AU NZ PG")
_add(
    "asia_x_japan",
    "CN HK IN ID MY PH SG KR TW TH VN BD LK PK MO BN KH LA MM MN NP KZ UZ "
    "IL SA AE QA KW BH JO OM LB",
)


def zone_for_country(code: str | None) -> str | None:
    """The style zone a country code belongs to, or ``None`` when it has none.

    ``None`` is a real answer: it means the company is not placed in a zone, which the
    page renders as "not placed" rather than spreading it over the other bands.
    """
    if not code:
        return None
    return _COUNTRIES.get(code.strip().upper())


def band_at(percentile: float) -> str:
    """The band of a company that starts at ``percentile`` of its zone's capitalisation.

    The boundary is tested on the share represented by the companies *larger* than this
    one, so the company that straddles a line is assigned by where it starts: the largest
    company whose cheaper peers do not yet fill the top 40% is the last giant.
    """
    current = BAND_ORDER[0]
    for band in BAND_ORDER[1:]:
        if percentile < BAND_STARTS[band]:
            return current
        current = band
    return BAND_ORDER[-1]


#: Which row of Morningstar's three-row style box a band belongs to. The style box has
#: three rows, not five: giant and large share the top row, mid the middle, and small and
#: micro the bottom. That coarse assignment is the one the industry compares funds on, so
#: it is the one the label uses; the bar keeps the five bands above it.
ROW_OF: dict[str, int] = {"giant": 1, "large": 1, "mid": 2, "small": 3, "micro": 3}

ROW_TEXT: dict[int, str] = {1: "large", 2: "mid", 3: "small"}

LABEL_TEXT: dict[str, str] = {
    "large": "large-cap",
    "mid": "mid-cap",
    "small": "small-cap",
    "micro": "micro-cap",
    "large_small": "large- and small-cap blend",
}

#: How much of a fund's weight has to sit in one row before that row is the answer, and
#: how much has to sit at each end before a fund is a blend rather than an average. Both
#: are published here rather than in the page so the rule has one home.
MAJORITY = 0.50
BARBELL_END = 0.20


def label_for(band_bp: Mapping[str, int], placed_bp: int) -> str:
    """The fund's size label: the row that holds half its weight, or the blend it is.

    A mean over the three rows was the first attempt and it is wrong in both directions.
    It reads a fund that is 55% large and 30% mid as mid, because the bottom row's 3
    pulls the mean harder than the top row's 1 does; and it reads a fund split 50/50
    between giant and micro as mid, which is not a size any holding in it has. Three
    published rules instead:

    1. **A blend**, when at least a fifth of the weight sits at each end and the middle
       row holds under half: the two ends are the portfolio, and no single word describes
       it.
    2. **The row with half the weight**, in the order large, mid, small. Half is a
       verdict a reader can check against the bar above the label.
    3. **micro** only when nine tenths of the weight is micro. The style box has no micro
       row — it would call that fund small, and "small-cap" is the word a reader compares
       against — so the finer word has to be emphatic before it replaces the coarse one.
    """
    if placed_bp <= 0:
        return ""
    share = {band: band_bp.get(band, 0) / placed_bp for band in BAND_ORDER}
    large = share["giant"] + share["large"]
    small = share["small"] + share["micro"]
    if min(large, small) >= BARBELL_END and share["mid"] < MAJORITY:
        return "large_small"
    if large >= MAJORITY:
        return "large"
    if share["mid"] >= MAJORITY:
        return "mid"
    if small >= MAJORITY:
        return "micro" if share["micro"] >= 0.9 else "small"
    # No row holds half and it is not a barbell: name the largest row, because the bar
    # does have a largest row even when the answer is not clean.
    winner = max(BAND_ORDER, key=lambda band: (share[band], -BAND_ORDER.index(band)))
    return ROW_TEXT[ROW_OF[winner]]


@dataclass(frozen=True)
class Zone:
    """One zone's ranking: which fund ranked it, when, and what the ranking produced."""

    key: str
    label: str
    source: str
    as_of: str
    companies: int
    weight_bp: int
    counts: dict[str, int]

    def as_json(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "source": self.source,
            "as_of": self.as_of,
            "companies": self.companies,
            "weight_bp": self.weight_bp,
            "counts": dict(self.counts),
        }


@dataclass
class ZoneTable:
    """The seven rankings and the company-to-band answer they produce."""

    zones: dict[str, Zone] = field(default_factory=dict)
    #: company_id → (zone, band, percentile or ``None`` when the company is below the
    #: zone's index and was placed as micro by that fact alone).
    members: dict[str, tuple[str, str, float | None]] = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.members)

    def as_json(self) -> dict:
        return {zone.key: zone.as_json() for zone in self.zones.values()}


def _field(row, name: str, default=None):
    """One field of a holdings row, whether it is an object or a dict.

    The build hands this module :class:`pipeline.weights.FundHolding` objects and a test
    or a measurement hands it the published JSON rows, so the reader has to accept both
    rather than forcing a second row type on every caller.
    """
    if isinstance(row, Mapping):
        return row.get(name, default)
    return getattr(row, name, default)


def _weights(rows: Iterable) -> tuple[dict[str, float], float]:
    """``company_id → weight`` for a fund's equity rows, and the fund's own total.

    **The basis.** A build's rows carry the dollars behind each weight (``value_usd``),
    while ``weight_bp`` is an integer that floors a holding of 0.4 basis points to zero.
    That rounding is invisible at the top of a fund and total at the bottom: 2,227 of
    VTI's 3,494 rows are under one basis point, which is 0.2% of VTI's weight but half
    the US market by count and the entire bottom of the size distribution. A zone ranked
    on rounded weights would call a company "outside the index" merely because VTI holds
    it in the third decimal place. So the sample uses the dollars when they are present,
    and the published JSON — which has only basis points — is the fallback the page's own
    inputs need.

    A company held through two share classes (Alphabet A and C) is one company and its
    two rows are added: a zone's cumulative share is a share of a market, not of a
    security list. A short position is read at its size, because a short does not remove
    a company from the market.
    """
    rows = list(rows)
    use_value = any((_field(row, "value_usd") or 0) > 0 for row in rows)
    weights: dict[str, float] = {}
    for row in rows:
        if _field(row, "asset_cat", "equity") != "equity":
            continue
        company_id = _field(row, "company_id")
        if not company_id:
            continue
        if use_value:
            weight = abs(float(_field(row, "value_usd") or 0.0))
        else:
            weight = abs(float(int(_field(row, "weight_bp", 0) or 0)))
        if not weight:
            continue
        weights[company_id] = weights.get(company_id, 0.0) + weight
    return weights, sum(weights.values())


def _rank(
    key: str, source: str, as_of: str, weights: Mapping[str, float], fund_total: float
) -> tuple[Zone, dict[str, tuple[str, str, float]]]:
    """Rank one zone and return its published record plus every member's band.

    Ties are broken by company id so the same release always produces the same bands: two
    companies of identical weight straddling a line must not switch places when the
    holdings are folded in a different thread order.
    """
    total = sum(weights.values())
    ordered = sorted(weights.items(), key=lambda pair: (-pair[1], pair[0]))
    counts = {band: 0 for band in BAND_ORDER}
    members: dict[str, tuple[str, str, float]] = {}
    cumulative = 0.0
    for company_id, weight in ordered:
        percentile = cumulative / total
        band = band_at(percentile)
        members[company_id] = (key, band, percentile)
        counts[band] += 1
        cumulative += weight
    zone = Zone(
        key=key,
        label=ZONE_LABELS[key],
        source=source,
        as_of=as_of,
        companies=len(ordered),
        weight_bp=round(10_000.0 * total / fund_total) if fund_total else 0,
        counts=counts,
    )
    return zone, members


def build(
    *,
    vti_rows: Iterable,
    vxus_rows: Iterable,
    countries: Mapping[str, str],
    vti_date: str = "",
    vxus_date: str = "",
) -> ZoneTable:
    """Rank every zone from the two zone funds and return the company-to-band table.

    ``vti_rows``/``vxus_rows`` are the holdings rows of the two funds (anything with
    ``company_id``, ``weight_bp`` and ``asset_cat``); ``countries`` is the release's
    country map. A missing fund is not an error — it is a zone with no ranking, and the
    caller can say so — but a build with neither produces an empty table and no size
    section, which is the honest answer for a release that has no market to rank against.
    """
    zones: dict[str, Zone] = {}
    members: dict[str, tuple[str, str, float]] = {}

    vti, vti_total = _weights(vti_rows)
    if vti:
        zone, ranked = _rank("us", ZONE_SOURCES["us"], vti_date, vti, vti_total)
        zones[zone.key] = zone
        # Every VTI holding is the US market, whatever its filing address: an
        # Irish-domiciled company listed in New York is priced by New York.
        members.update(ranked)

    vxus, vxus_total = _weights(vxus_rows)
    by_zone: dict[str, dict[str, float]] = {key: {} for key in ZONE_ORDER if key != "us"}
    for company_id, weight in vxus.items():
        if company_id in members:
            # A security in both funds is one company; the US market ranked it already.
            continue
        zone_key = zone_for_country(countries.get(company_id))
        if zone_key is None or zone_key == "us":
            # No zone, or a US country inside an ex-US fund: not this lane's to rank.
            continue
        by_zone[zone_key][company_id] = weight
    for zone_key in ZONE_ORDER:
        weights = by_zone.get(zone_key)
        if not weights:
            continue
        zone, ranked = _rank(
            zone_key, ZONE_SOURCES[zone_key], vxus_date, weights, vxus_total
        )
        zones[zone_key] = zone
        members.update(ranked)

    return ZoneTable(zones=zones, members=members)
