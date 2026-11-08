"""The size table: the zone placement, the published object, and the mandate rules.

The lane that used to live here computed a market capitalisation — an implied price times
a filed share count — and three things could make it lie: a stale share count, one class of
a multi-class issuer, and a boundary read one dollar the wrong way. All three are gone with
the dollars: a band is now a position in a zone, which cannot go stale and cannot be
mispriced. What remains to test is that the placement follows the rule, that the object
says which rule it is, and that a company with no zone is left out rather than defaulted.

The zone tables are built here from plain dicts through ``size_zones.build``, because the
published rows are the shape a measurement also passes.
"""

from __future__ import annotations

import json
import re

import pytest

from pipeline import size_zones, sizes

RELEASE = "2026-11-07.4"


def rows(weights: dict[str, int]) -> list[dict]:
    return [
        {"company_id": company_id, "asset_cat": "equity", "weight_bp": weight}
        for company_id, weight in weights.items()
    ]


def zones_for(
    *,
    vti: dict[str, int] | None = None,
    vxus: dict[str, int] | None = None,
    countries: dict[str, str] | None = None,
):
    return size_zones.build(
        vti_rows=rows(vti if vti is not None else {"c_0000000001": 1_000}),
        vxus_rows=rows(vxus or {}),
        countries=countries or {"c_0000000001": "US"},
        vti_date="2026-06-30",
        vxus_date="2026-07-31",
    )


# -- the published object -----------------------------------------------------


def test_the_object_names_its_rule_and_its_lines():
    result = sizes.build(zones=zones_for(), countries={"c_0000000001": "US"}, release=RELEASE)
    document = result.payload
    assert document["schema_version"] == sizes.SCHEMA_VERSION == 2
    assert document["kind"] == "sizes"
    assert document["method"] == sizes.METHOD == "zone_percentile"
    assert document["as_of"] == RELEASE
    # A v1 consumer read ``thresholds``; a v2 object has none, which is why the version
    # moved rather than why it is cosmetic.
    assert "thresholds" not in document
    assert document["bands"] == ["giant", "large", "mid", "small", "micro"]
    assert document["band_starts"] == {
        "giant": 0.0,
        "large": 0.4,
        "mid": 0.7,
        "small": 0.9,
        "micro": 0.97,
    }
    assert document["band_labels"]["giant"] == "Giant"


def test_a_ranked_company_carries_its_zone_its_band_and_its_percentile():
    countries = {"c_0000000001": "US", "c_0000000002": "US"}
    zones = zones_for(vti={"c_0000000001": 6_000, "c_0000000002": 4_000})
    result = sizes.build(zones=zones, countries=countries, release=RELEASE)
    caps = result.payload["caps"]
    assert caps["c_0000000001"] == {"zone": "us", "band": "giant", "basis": "ranked", "pct": 0.0}
    assert caps["c_0000000002"]["band"] == "large"
    assert caps["c_0000000002"]["pct"] == pytest.approx(0.6)


def test_a_zoned_company_outside_the_index_is_micro_and_says_so():
    # A company the zone's index does not hold has no percentile to publish, so it takes
    # micro and carries the basis that says why — never an invented rank.
    zones = zones_for(vti={"c_0000000001": 1_000})
    result = sizes.build(
        zones=zones,
        countries={"c_0000000001": "US", "c_0000000002": "JP"},
        release=RELEASE,
    )
    assert result.payload["caps"]["c_0000000002"] == {
        "zone": "japan",
        "band": "micro",
        "basis": "below_index",
    }


def test_a_company_with_no_zone_is_absent_rather_than_defaulted():
    # The measured set: 734 companies file from the Cayman Islands, Bermuda, the British
    # Virgin Islands or the Marshall Islands, which belong to no market. Absent from
    # ``caps`` is a published answer — the page says "not placed" — where micro would be
    # an invented claim about a company we know nothing about.
    zones = zones_for(vti={"c_0000000001": 1_000})
    result = sizes.build(
        zones=zones,
        countries={"c_0000000001": "US", "c_0000000002": "KY"},
        release=RELEASE,
    )
    assert "c_0000000002" not in result.payload["caps"]
    assert result.payload["counts"]["no_zone"] == 1


def test_the_counts_partition_the_known_universe():
    zones = zones_for(vti={"c_0000000001": 700, "c_0000000002": 300})
    result = sizes.build(
        zones=zones,
        countries={
            "c_0000000001": "US",  # ranked
            "c_0000000002": "US",  # ranked
            "c_0000000003": "DE",  # zoned, below the index
            "c_0000000004": "KY",  # no zone
        },
        release=RELEASE,
    )
    counts = result.payload["counts"]
    assert counts["companies"] == 3
    assert counts["ranked"] == 2
    assert counts["below_index"] == 1
    assert counts["ranked"] + counts["below_index"] == counts["companies"]
    assert counts["zone_companies"] == {
        "us": 2,
        "canada": 0,
        "latin_america": 0,
        "europe": 1,
        "japan": 0,
        "asia_x_japan": 0,
        "australia_nz": 0,
    }
    # zone_companies counts every placed company in the zone, ranked or not, so it sums
    # to the caps the release publishes — the number a page would call "in this zone".
    assert sum(counts["zone_companies"].values()) == counts["companies"]
    # no_zone counts the map, not the release's caps: it is how many of the companies we
    # know of could never be placed, which is the number that explains a page's gap.
    assert counts["no_zone"] == 1
    # 700 of 1,000 bp starts at percentile 0.0 (giant); 300 starts at 0.70 (mid); the
    # company below the index takes micro.
    assert result.payload["band_counts"] == {
        "giant": 1,
        "large": 0,
        "mid": 1,
        "small": 0,
        "micro": 1,
    }


def test_the_lookup_answers_the_page_without_the_payload():
    zones = zones_for(vti={"c_0000000001": 1_000})
    result = sizes.build(
        zones=zones,
        countries={"c_0000000001": "US", "c_0000000002": "JP"},
        release=RELEASE,
    )
    assert result.band_of("c_0000000001") == ("us", "giant")
    assert result.band_of("c_0000000002") == ("japan", "micro")
    assert result.band_of("c_0000000003") is None
    assert result.band_of(None) is None
    assert result.band_of("") is None


# -- the artefact -------------------------------------------------------------


def test_the_artefact_is_written_at_the_published_path_and_is_byte_stable(tmp_path):
    zones = zones_for(vti={"c_0000000001": 600, "c_0000000002": 400})
    countries = {"c_0000000001": "US", "c_0000000002": "US"}
    first = sizes.write(sizes.build(zones=zones, countries=countries, release=RELEASE), tmp_path / "a")
    second = sizes.write(sizes.build(zones=zones, countries=countries, release=RELEASE), tmp_path / "b")
    assert first[0] == tmp_path / "a" / "companies" / "sizes.json"
    assert first[1] == second[1]
    assert json.loads(first[1])["as_of"] == RELEASE


def test_the_artefact_publishes_no_identifier(tmp_path):
    zones = zones_for(vti={"c_0000000001": 1_000})
    path, body = sizes.write(
        sizes.build(zones=zones, countries={"c_0000000001": "US"}, release=RELEASE), tmp_path
    )
    text = body.decode()
    assert "cusip" not in text.lower()
    assert "isin" not in text.lower()
    assert re.search(r"\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b", text) is None
    for company_id in json.loads(path.read_text())["caps"]:
        assert re.fullmatch(r"c_\d{10}", company_id), company_id


def test_a_build_with_no_zone_fund_publishes_an_empty_table(tmp_path):
    # A release whose universe holds neither zone fund still publishes the object, so a
    # consumer reads "no zones" rather than a missing file it might mistake for v1.
    zones = size_zones.build(vti_rows=[], vxus_rows=[], countries={})
    path, body = sizes.write(sizes.build(zones=zones, countries={}, release=RELEASE), tmp_path)
    document = json.loads(body)
    assert path.is_file()
    assert document["zones"] == {}
    assert document["caps"] == {}
    assert document["counts"]["companies"] == 0


# -- the mandate rules --------------------------------------------------------


@pytest.mark.parametrize(
    "name,expected",
    [
        # An international index mandate is large-and-mid by construction, and the
        # biggest international funds are exactly these names.
        ("iShares MSCI EAFE ETF", "large_mid"),
        ("Vanguard Total International Stock Index Fund", "large_mid"),
        ("iShares Core MSCI Emerging Markets ETF", "large_mid"),
        ("Vanguard Small-Cap Index Fund", "small"),
        ("iShares MSCI EAFE Small-Cap ETF", "small"),
        ("iShares Russell 2000 ETF", "small"),
        ("SPDR S&P 600 Small Cap ETF", "small"),
        ("Vanguard Mid-Cap Index Fund", "mid"),
        ("iShares Russell Mid-Cap ETF", "mid"),
        ("Vanguard Mega Cap Index Fund", "large"),  # a mega mandate calibrates as large
        ("Vanguard Large-Cap Index Fund", "large"),
        ("iShares S&P 500 Index Fund", "large"),
        ("Vanguard Micro Cap Index Fund", "micro"),
        ("Fidelity Large Cap Growth Fund", "large"),
        ("Invesco S&P 400 Midcap ETF", "mid"),
        ("Vanguard Nasdaq-100 Index Fund", "large"),
    ],
)
def test_a_stated_size_mandate_is_inferred(name, expected):
    mandate = sizes.mandate_for(name)
    assert mandate is not None, name
    assert mandate.key == expected


@pytest.mark.parametrize(
    "name",
    [
        "Vanguard Total World Stock Index Fund",
        "iShares Core S&P Total US Stock Market ETF",
        "Vanguard Extended Market Index Fund",
        "Fidelity 500 Index Fund",
        "Vanguard Balanced Index Fund",
        "iShares Core U.S. Aggregate Bond ETF",
    ],
)
def test_a_broad_or_absent_mandate_infers_nothing(name):
    # All-cap, whole-market, total-world and aggregate-bond names make no single size
    # statement. Inferring one from them would be the exact error this lane avoids.
    assert sizes.mandate_for(name) is None


def test_the_mandate_ranges_are_keyed_to_the_published_bands():
    # ``mix_ranges`` is guarded: it would rather publish nothing than publish ranges
    # measured on a band vocabulary that no longer exists. The old table named the top
    # band ``large``, which is now the *second* band, so reusing it would describe a
    # small-cap fund's mix with a large-cap fund's.
    assert sizes.MANDATE_BANDS == size_zones.BAND_ORDER
    for key in sizes.MANDATE_MIX:
        assert key in sizes.MANDATE_LABELS
        for band, (low, high) in sizes.mix_ranges(key).items():
            assert band in size_zones.BAND_ORDER
            assert 0 <= low <= high <= 100, (key, band, low, high)
        # Ranges are the 10th-to-90th percentile of a measured mix, so they overlap
        # rather than partition: that is the honest shape of a fund-level inference.
        assert sum(low for low, _ in sizes.mix_ranges(key).values()) <= 100


def test_a_mandate_with_no_calibration_publishes_no_range():
    assert sizes.mix_ranges("nonsense") == {}
    assert sizes.mix_ranges("") == {}


def test_the_guard_refuses_a_band_vocabulary_it_did_not_measure(monkeypatch):
    monkeypatch.setattr(sizes, "MANDATE_BANDS", ("mega", "large", "mid", "small", "micro"))
    assert sizes.mix_ranges("small") == {}
