"""The size zones: the seven markets, the four cumulative lines, and the label.

The whole method is four numbers — 40%, 70%, 90%, 97% of a zone's own market value — so
the tests that matter are the ones that would let a release draw a band the rule does not
give:

* a zone assigned to the wrong country (which would put a Japanese company in a global
  ranking, where it is small by definition);
* a weight taken from the rounded basis points rather than the dollars behind them, which
  drops the bottom of a total-market fund out of its own ranking;
* a boundary read one side the wrong way;
* a share class counted as a second company, which moves a company's percentile.

Every input is a plain dict with the fields the published rows carry, because that is
also the shape a measurement passes: the module reads rows through ``_field`` for exactly
this reason.
"""

from __future__ import annotations

import pytest

from pipeline import size_zones


def row(company_id: str, weight_bp: int = 0, *, value_usd: float | None = None,
        asset_cat: str = "equity") -> dict:
    out = {"company_id": company_id, "asset_cat": asset_cat, "weight_bp": weight_bp}
    if value_usd is not None:
        out["value_usd"] = value_usd
    return out


def build(vti=(("c_0000000001", 100),), vxus=(), countries=None, **kwargs):
    return size_zones.build(
        vti_rows=[row(cid, bp) for cid, bp in vti],
        vxus_rows=[row(cid, bp) for cid, bp in vxus],
        countries=countries or {},
        **kwargs,
    )


# -- the zones ----------------------------------------------------------------


@pytest.mark.parametrize(
    "code,zone",
    [
        ("US", "us"),
        ("PR", "us"),
        ("CA", "canada"),
        ("MX", "latin_america"),
        ("BR", "latin_america"),
        ("GB", "europe"),
        ("DE", "europe"),
        ("CH", "europe"),
        ("ZA", "europe"),  # every African country is a European zone
        ("NG", "europe"),
        ("RU", "europe"),
        ("TR", "europe"),
        ("JP", "japan"),
        ("CN", "asia_x_japan"),
        ("IN", "asia_x_japan"),
        ("IL", "asia_x_japan"),  # the Middle East is Asia ex-Japan
        ("SA", "asia_x_japan"),
        ("AU", "australia_nz"),
        ("NZ", "australia_nz"),
    ],
)
def test_each_country_belongs_to_the_published_zone(code, zone):
    assert size_zones.zone_for_country(code) == zone


@pytest.mark.parametrize("code", ["KY", "BM", "VG", "MH", "ZZ", "", None])
def test_an_offshore_or_unknown_address_has_no_zone(code):
    # The measured set: 734 of 12,820 companies (5.73% of the map) file from an offshore
    # address that belongs to no market. "No zone" is a published answer, not a default.
    assert size_zones.zone_for_country(code) is None


def test_every_zone_key_has_a_label_a_source_and_a_place_in_the_order():
    assert set(size_zones.ZONE_LABELS) == set(size_zones.ZONE_ORDER)
    assert set(size_zones.ZONE_SOURCES) == set(size_zones.ZONE_ORDER)
    assert len(size_zones.ZONE_ORDER) == 7
    assert all(isinstance(label, str) and label for label in size_zones.ZONE_LABELS.values())


# -- the four lines -----------------------------------------------------------


@pytest.mark.parametrize(
    "percentile,band",
    [
        (0.0, "giant"),
        (0.3999, "giant"),
        (0.40, "large"),  # the line is inclusive at the bottom band, exclusive above
        (0.6999, "large"),
        (0.70, "mid"),
        (0.8999, "mid"),
        (0.90, "small"),
        (0.9699, "small"),
        (0.97, "micro"),
        (1.0, "micro"),
    ],
)
def test_a_percentile_falls_in_the_band_the_lines_give(percentile, band):
    assert size_zones.band_at(percentile) == band


def test_the_lines_are_the_published_ones():
    assert size_zones.BAND_STARTS == {
        "giant": 0.0,
        "large": 0.40,
        "mid": 0.70,
        "small": 0.90,
        "micro": 0.97,
    }
    assert size_zones.BAND_ORDER == ("giant", "large", "mid", "small", "micro")
    # The lines partition the whole distribution: every percentile has exactly one band,
    # and the bands in order cover 0 to 1 with no hole.
    starts = [size_zones.BAND_STARTS[key] for key in size_zones.BAND_ORDER]
    assert starts[0] == 0.0 and starts == sorted(starts)


# -- the ranking --------------------------------------------------------------


def test_a_zone_of_equal_companies_splits_at_the_lines():
    # Ten equal companies: 4 giant, 3 large, 2 mid, 1 small — and no micro, because ten
    # equal holdings cannot express 3%. The bands hold *counts* that the weights imply,
    # which is the point: 90% of the value is in four names.
    zones = build(vti=tuple((f"c_{i:010d}", 100) for i in range(1, 11)))
    counts = zones.zones["us"].counts
    assert counts == {"giant": 4, "large": 3, "mid": 2, "small": 1, "micro": 0}
    assert zones.zones["us"].companies == 10
    assert zones.zones["us"].weight_bp == 10_000


def test_a_zone_of_equal_companies_puts_the_boundary_company_in_the_lower_band():
    # With ten equal weights the fifth company starts at percentile 0.4, so it is large
    # and not giant: the boundary belongs to the band above it, not to both.
    zones = build(vti=tuple((f"c_{i:010d}", 100) for i in range(1, 11)))
    members = zones.members
    assert members["c_0000000004"][1] == "giant"  # starts at 0.30
    assert members["c_0000000005"][1] == "large"  # starts at 0.40
    assert members["c_0000000007"][1] == "large"  # starts at 0.60, the line is at 0.70
    assert members["c_0000000008"][1] == "mid"  # starts at 0.70 → mid
    assert members["c_0000000010"][1] == "small"  # starts at 0.90 → small


def test_a_company_held_through_two_rows_is_one_company():
    # Alphabet A and C are two rows and one company; a zone's cumulative share is a share
    # of a market, so the rows are added before the sort.
    zones = build(
        vti=[("c_0000000001", 4_000), ("c_0000000002", 3_000),
             ("c_0000000002", 3_000)]
    )
    assert zones.zones["us"].companies == 2
    # 6,000 of 10,000 is the top company; 4,000 starts at the 60th percentile, which is
    # large, not giant — the two rows were added rather than ranked separately.
    assert zones.members["c_0000000002"] == ("us", "giant", 0.0)
    assert zones.members["c_0000000001"][1] == "large"
    assert zones.zones["us"].counts == {"giant": 1, "large": 1, "mid": 0, "small": 0, "micro": 0}


def test_a_short_position_is_read_at_its_size_not_its_sign():
    zones = build(vti=[("c_0000000001", -9_000), ("c_0000000002", 1_000)])
    assert zones.zones["us"].companies == 2
    assert abs(zones.members["c_0000000001"][2]) < 1e-9  # the short is the largest by size
    assert zones.members["c_0000000001"][1] == "giant"


def test_ties_break_on_the_company_id_so_a_release_is_deterministic():
    # Two companies of identical weight straddling a line must not swap bands when the
    # holdings are folded in a different order.
    forward = build(vti=[("c_0000000002", 500), ("c_0000000001", 500),
                         ("c_0000000003", 500)])
    backward = build(vti=[("c_0000000001", 500), ("c_0000000002", 500),
                          ("c_0000000003", 500)])
    assert forward.members == backward.members


def test_the_dollars_behind_the_weight_are_the_sample_when_they_are_there():
    # The measured reason: 2,227 of VTI's 3,494 rows are under one basis point, so a
    # sample ranked on weight_bp loses half the US market by count and the bottom of the
    # size distribution with it. With value_usd present, a sub-basis-point row counts.
    zones = size_zones.build(
        vti_rows=[
            {"company_id": "c_0000000001", "asset_cat": "equity", "weight_bp": 0,
             "value_usd": 1.0},
            {"company_id": "c_0000000002", "asset_cat": "equity", "weight_bp": 0,
             "value_usd": 2.0},
            {"company_id": "c_0000000003", "asset_cat": "equity", "weight_bp": 0,
             "value_usd": 3.0},
        ],
        vxus_rows=[],
        countries={},
    )
    assert zones.zones["us"].companies == 3
    assert zones.members["c_0000000003"][1] == "giant"  # 3 of 6 = the top half


def test_a_row_that_is_not_equity_and_a_row_with_no_company_are_not_in_the_sample():
    zones = size_zones.build(
        vti_rows=[
            row("c_0000000001", 100),
            row("c_0000000002", 100, asset_cat="cash"),
            row("", 100),
            {"asset_cat": "equity", "weight_bp": 100},  # no company_id at all
        ],
        vxus_rows=[],
        countries={},
    )
    assert zones.zones["us"].companies == 1


# -- the two source funds -----------------------------------------------------


def test_a_vti_row_is_us_whatever_its_country_map_says():
    # VTI *is* the US market: a company in it is ranked with the United States even if
    # its country resolves to a tax haven, or the US zone would be short of its own tail.
    zones = build(
        vti=[("c_0000000001", 700), ("c_0000000002", 300)],
        countries={"c_0000000001": "KY", "c_0000000002": "US"},
    )
    assert set(zones.members) == {"c_0000000001", "c_0000000002"}
    assert zones.members["c_0000000001"][0] == "us"
    assert "ky" not in zones.zones  # no offshore zone exists


def test_a_vxus_company_is_ranked_in_its_own_zone_and_the_zones_do_not_mix():
    zones = build(
        vti=[("c_0000000001", 1_000)],
        vxus=[("c_0000000002", 800), ("c_0000000003", 200),
              ("c_0000000004", 500), ("c_0000000005", 500)],
        countries={"c_0000000002": "JP", "c_0000000003": "JP",
                   "c_0000000004": "DE", "c_0000000005": "FR"},
    )
    assert zones.zones["japan"].companies == 2
    assert zones.zones["europe"].companies == 2
    # Japan's top company is giant at home, and so is Europe's: a percentile is a
    # position inside a zone, never inside the world.
    assert zones.members["c_0000000002"] == ("japan", "giant", 0.0)
    assert zones.members["c_0000000004"] == ("europe", "giant", 0.0)


def test_a_vxus_company_that_is_also_in_vti_is_ranked_once():
    zones = build(
        vti=[("c_0000000001", 1_000)],
        vxus=[("c_0000000001", 900), ("c_0000000002", 100)],
        countries={"c_0000000001": "US", "c_0000000002": "US"},
    )
    assert zones.members["c_0000000001"][0] == "us"
    # The second company has a US country map entry but is not in VTI: VXUS does not
    # rank US companies, so it is not placed at all rather than ranked in a zone VXUS
    # does not cover.
    assert "c_0000000002" not in zones.members


def test_a_vxus_company_with_no_zone_is_left_out_and_counted_by_its_absence():
    zones = build(
        vti=[("c_0000000001", 1_000)],
        vxus=[("c_0000000002", 900), ("c_0000000003", 100)],
        countries={"c_0000000002": "KY", "c_0000000003": "JP"},
    )
    assert "c_0000000002" not in zones.members
    assert zones.zones["japan"].companies == 1


def test_a_zones_weight_is_a_share_of_its_own_fund_not_of_the_table():
    zones = build(
        vti=[("c_0000000001", 1_000)],
        vxus=[("c_0000000002", 300), ("c_0000000003", 700)],
        countries={"c_0000000002": "JP", "c_0000000003": "DE"},
    )
    assert zones.zones["japan"].weight_bp == 3_000  # 30% of VXUS
    assert zones.zones["europe"].weight_bp == 7_000
    assert zones.zones["us"].weight_bp == 10_000  # 100% of VTI


def test_the_table_serialises_every_zone_it_ranked():
    zones = build(vti=[("c_0000000001", 1_000)], countries={"c_0000000001": "US"})
    document = zones.as_json()
    assert list(document) == ["us"]
    zone = document["us"]
    assert zone["key"] == "us"
    assert zone["label"] == size_zones.ZONE_LABELS["us"]
    assert zone["source"] == "VTI"
    assert zone["companies"] == 1
    assert zone["counts"] == {"giant": 1, "large": 0, "mid": 0, "small": 0, "micro": 0}


def test_a_build_with_no_zone_fund_ranks_nothing():
    zones = size_zones.build(vti_rows=[], vxus_rows=[], countries={})
    assert len(zones) == 0
    assert zones.as_json() == {}


# -- the label ----------------------------------------------------------------


def test_the_label_is_a_majority_verdict_or_a_blend():
    assert size_zones.ROW_OF == {
        "giant": 1, "large": 1, "mid": 2, "small": 3, "micro": 3,
    }
    # A row is named only when half the weight is in it, so the label can be checked
    # against the bar above it.
    assert size_zones.MAJORITY == 0.5
    assert size_zones.BARBELL_END == 0.2


@pytest.mark.parametrize(
    "bands,expected",
    [
        ({"giant": 6_000, "large": 3_000, "mid": 1_000}, "large"),
        # 55% large, 30% mid, 10% micro: a mean over the three rows would call this mid,
        # because the bottom row's 3 pulls harder than the top row's 1. It is large.
        ({"giant": 5_000, "mid": 3_000, "micro": 1_000}, "large"),
        ({"mid": 8_000, "small": 1_000, "large": 1_000}, "mid"),
        ({"small": 7_000, "micro": 3_000}, "small"),
        ({"micro": 9_500, "small": 500}, "micro"),
        # A barbell: a fifth at each end and no middle. The mean would say mid, which no
        # holding in the fund has.
        ({"giant": 4_000, "mid": 1_000, "micro": 5_000}, "large_small"),
        ({"giant": 4_000, "mid": 1_000, "micro": 500, "small": 4_500}, "large_small"),
        # 30% large, 60% mid: the middle row holds half, so it wins over the barbell test.
        ({"giant": 3_000, "mid": 6_000, "small": 500, "micro": 500}, "mid"),
        # A total-market fund: 63% in the top row, a 9% tail. Not a barbell, and large.
        ({"giant": 3_627, "large": 2_659, "mid": 1_807, "small": 637, "micro": 288}, "large"),
        # A micro-cap fund is "small" until nine tenths of it is micro, because the style
        # box has no micro row and "small-cap" is the word a reader compares against.
        ({"small": 2_500, "micro": 6_750}, "small"),
        ({"micro": 9_200, "small": 800}, "micro"),
    ],
)
def test_the_label_says_what_the_weights_say(bands, expected):
    assert size_zones.label_for(bands, sum(bands.values())) == expected


def test_a_fund_with_no_placed_weight_has_no_label():
    assert size_zones.label_for({}, 0) == ""


def test_every_label_has_words():
    for key in ("large", "mid", "small", "micro", "large_small"):
        assert size_zones.LABEL_TEXT[key]
