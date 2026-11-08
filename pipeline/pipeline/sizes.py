"""The size-band answer for every company a fund can hold, published as one small object.

**What this builds now.** ``companies/sizes.json`` used to be a market-capitalisation
table: an implied price from N-PORT marks times a filed share count, bucketed by five
fixed dollar lines. Measured against the market on 2026-11-07 every one of the five sat
23-66x below the line it stood in for, so DFA's US Micro Cap fund was published as 68.8%
*mid* cap against Morningstar's 63.9% micro — a dollar line cannot track a market whose
total capitalisation triples. The bands are now percentiles of each company's own style zone,
computed from the reported holdings of the index fund that covers the zone
(:mod:`pipeline.size_zones`), and this module is the join: it takes the zone answer and
the release's country map and writes the company → band object the fund page reads.

**Why the caps are no longer here.** A cap needs a share count, and a foreign private
issuer files none: 24% of an ex-US fund's weight was sized under the old method against
99% of VTI's. A percentile needs no cap at all — only the order of the companies, which
the index's own weight gives — so the whole lane that fetched share counts, read cover
pages and repaired split-drift is retired. The evidence for that decision, including the
fund that exposed it, is ADR-0025.

**What a company's entry means.** ``{"zone": "us", "band": "giant", "basis": "ranked",
"pct": 0.0021}`` is one company: the zone it was ranked in, the band that rank put it in,
the basis of the answer, and the cumulative share of its zone's capitalisation that sat
above it. A company with ``basis: "below_index"`` and no ``pct`` is outside the zone's
index — either smaller than everything the index ranks or listed after its report date —
and is banded ``micro`` by that fact alone; the page says which case it is rather than
claiming the company is small. A company with no entry at all is *unplaced*: its
country has no style zone (an offshore filing address), and the page says so rather than
spreading it over the other bands.

**Coverage is the reason this works.** Measured on the live release 2026-11-07.3: VTI
scores 99.99% of its equity weight placed, VXUS 92.50%, where the retired dollar lane
placed 24.4% of VXUS — a cap needs a share count and a foreign private issuer files none.
Ranked in the same run: 12,094 companies across seven zones (us 4,001, europe 2,612,
asia_x_japan 3,410, japan 760, canada 707, australia_nz 381, latin_america 223), banded
giant 111 / large 445 / mid 1,235 / small 1,136 / micro 9,167. That is the change the
operator asked for: the size bar stops being a US-only fact.

**Company identity is never a ticker.** ``company_id`` is ``c_<CIK>`` for a US filer and
``l_<LEI>`` for a foreign issuer, and the zone table keys on it, so a dual listing is one
company and never two.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .size_zones import (
    BAND_LABELS,
    BAND_ORDER,
    BAND_STARTS,
    LABEL_TEXT,
    ROW_OF,
    ROW_TEXT,
    ZONE_LABELS,
    ZONE_ORDER,
    ZoneTable,
    band_at,
    label_for,
    zone_for_country,
)

__all__ = [
    "BAND_LABELS",
    "BAND_ORDER",
    "BAND_STARTS",
    "LABEL_TEXT",
    "ROW_OF",
    "ROW_TEXT",
    "ZONE_LABELS",
    "ZONE_ORDER",
    "BuildResult",
    "MANDATE_LABELS",
    "MANDATE_MIX",
    "Mandate",
    "ZoneTable",
    "build",
    "label_for",
    "mandate_for",
    "band_at",
    "METHOD",
    "mix_ranges",
    "write",
    "zone_for_country",
]

#: Schema 2 replaced the fixed dollar line with a zone percentile. The version moved
#: because a v1 consumer would read ``thresholds`` (dollars) and a v2 object has none: a
#: reader that cannot tell the two apart would silently mislabel every company.
SCHEMA_VERSION = 2

#: How a company got its band. ``ranked`` is a position in its zone's index; the other
#: two are the two ways of being placed without one, and they are published so a reader
#: can see what the index does not cover.
BASES: tuple[str, ...] = ("ranked", "below_index")

#: The name of the rule, published beside the lines it draws. A consumer that reads
#: ``caps`` has to know which rule produced the bands before it can describe them, and a
#: release that changed the rule without changing this string would let a page print the
#: old description over new numbers.
METHOD = "zone_percentile"

CIK_ID = re.compile(r"^c_(\d{10})$")


@dataclass(frozen=True)
class BuildResult:
    """The published object, the counts behind it, and a per-company lookup."""

    payload: dict
    #: company_id → (zone, band) — what the page needs for a holding, without the payload.
    placed: Mapping[str, tuple[str, str]]
    counts: dict

    def band_of(self, company_id: str | None) -> tuple[str, str] | None:
        if not company_id:
            return None
        return self.placed.get(company_id)


def _place(
    zones: ZoneTable,
    countries: Mapping[str, str],
) -> tuple[dict[str, dict], dict[str, tuple[str, str]]]:
    """Company → published entry, and the same answer as a compact lookup.

    A company in the zone table is ranked. A company the table does not have, but whose
    country has a zone, is below the index that ranks that zone and therefore smaller
    than every company the index ranks: it is placed as ``micro`` and marked as such. A
    company whose country has no zone is not placed at all.
    """
    entries: dict[str, dict] = {}
    lookup: dict[str, tuple[str, str]] = {}
    for company_id, (zone, band, percentile) in zones.members.items():
        if percentile is None:
            entries[company_id] = {"zone": zone, "band": band, "basis": "below_index"}
        else:
            entries[company_id] = {
                "zone": zone,
                "band": band,
                "pct": round(percentile, 6),
                "basis": "ranked",
            }
        lookup[company_id] = (zone, band)
    for company_id, code in countries.items():
        if company_id in entries:
            continue
        zone = zone_for_country(code)
        if zone is None:
            continue
        entries[company_id] = {"zone": zone, "band": "micro", "basis": "below_index"}
        lookup[company_id] = (zone, "micro")
    return entries, lookup


def build(
    *,
    zones: ZoneTable,
    countries: Mapping[str, str],
    release: str,
) -> BuildResult:
    """Join the zone table to the release's country map and produce the published object.

    ``countries`` is ``companies/countries.json`` as the release publishes it (only
    companies the release has a shard for), so every company a page can name is in here
    and the join cannot produce an entry for a company a reader cannot look up.
    """
    entries, lookup = _place(zones, countries)

    basis_counts = {basis: 0 for basis in BASES}
    band_counts = {band: 0 for band in BAND_ORDER}
    zone_counts = {zone: 0 for zone in ZONE_ORDER}
    for entry in entries.values():
        basis_counts[entry["basis"]] += 1
        band_counts[entry["band"]] += 1
        zone_counts[entry["zone"]] += 1

    payload = {
        "schema_version": SCHEMA_VERSION,
        "kind": "sizes",
        "as_of": release,
        "method": METHOD,
        "bands": list(BAND_ORDER),
        "band_starts": {band: BAND_STARTS[band] for band in BAND_ORDER},
        "band_labels": {band: BAND_LABELS[band] for band in BAND_ORDER},
        "zones": zones.as_json(),
        "counts": {
            "companies": len(entries),
            "ranked": basis_counts["ranked"],
            "below_index": basis_counts["below_index"],
            "no_zone": sum(1 for code in countries.values() if zone_for_country(code) is None),
            "zone_companies": {zone: zone_counts[zone] for zone in ZONE_ORDER},
        },
        "band_counts": band_counts,
        "caps": {company_id: entry for company_id, entry in sorted(entries.items())},
    }
    return BuildResult(payload=payload, placed=lookup, counts=payload["counts"])


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
# The fallback lane: what a fund's own name says about its size mandate.
#
# This is inference, and it is labelled as inference everywhere it is rendered. It is
# fund-level only — a company is never given an inferred bucket from the names of the
# funds that hold it (measured 2026-11-06: top-1 agreement 46-48%, "small" precision
# 54-69%, so the company-level version was rejected).
#
# It is a *fallback* now rather than the main answer: with percentile bands a fund needs
# 80% of its equity in named, country-mapped holdings to draw a bar, and most funds clear
# that. The ranges exist for the ones that do not.
# --------------------------------------------------------------------------------------

#: The band names the ranges below were measured on. If the published bands change and
#: these are not re-measured, ``mix_ranges`` returns nothing rather than a range from a
#: different band definition — the failure mode that put a stale dollar line on the page
#: in the first place.
MANDATE_BANDS: tuple[str, ...] = ("giant", "large", "mid", "small", "micro")

#: Share of *placed* equity weight in each band, as (p10, p50, p90) across funds that
#: state the mandate in their registered name.
#:
#: Re-measured 2026-11-07 for the zone bands, because the retired table was measured on
#: dollar bands whose top band was called ``large`` — which is now the *second* band. The
#: sample is release 2026-11-07.3: every one of its 9,332 funds whose name states a size
#: mandate, largest 24 per mandate by net assets, 111 funds measured (a fund under 1%
#: placed is skipped, because its mix is a coincidence rather than a mix). Each fund's
#: holdings were scored with the same zone table this module publishes, built from that
#: release's own VTI and VXUS objects and its country map.
#:
#: Read the number as a prediction interval, not a definition: an S&P 500 fund puts
#: 19-68% of its placed weight in giant companies, because a large-cap mandate does not
#: fix how much of the market it holds. The ranges overlap on purpose — that overlap is
#: why this is an inference the page labels as one.
MANDATE_MIX: dict[str, dict[str, tuple[int, int, int]]] = {
    "large": {
        "giant": (19, 46, 68),
        "large": (24, 32, 43),
        "mid": (7, 19, 33),
        "small": (0, 2, 10),
        "micro": (0, 0, 2),
    },
    "large_mid": {
        "giant": (34, 43, 52),
        "large": (24, 29, 35),
        "mid": (12, 17, 20),
        "small": (1, 4, 7),
        "micro": (2, 5, 12),
    },
    "mid": {
        "giant": (0, 0, 1),
        "large": (0, 3, 7),
        "mid": (22, 60, 87),
        "small": (3, 27, 56),
        "micro": (0, 10, 27),
    },
    "small": {
        "giant": (0, 0, 0),
        "large": (0, 0, 2),
        "mid": (0, 2, 27),
        "small": (28, 37, 55),
        "micro": (26, 51, 72),
    },
    "micro": {
        "giant": (0, 0, 0),
        "large": (0, 0, 1),
        "mid": (0, 0, 3),
        "small": (0, 8, 32),
        "micro": (64, 91, 100),
    },
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
    """The p10-p90 ranges for one mandate, in band order, dropping empty bands.

    Empty when the ranges were measured on a different set of bands than the one
    published now: a range from another band definition is a wrong number, and the page
    must fall back to the stated mandate rather than print it.
    """
    if MANDATE_BANDS != BAND_ORDER:
        return {}
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
