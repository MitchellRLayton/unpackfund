"""The size block on a fund page: the computed bar, the callout, and the old release.

Three states, and each is a different promise:

* **computed** — every band is a percentile of the company's own zone, drawn against the
  whole fund, with the zone mix and the sample it was ranked on named;
* **callout** — under 80% of equity weight placed, no bar at all, the gap explained;
* **legacy** — a release built before schema 2 still carries dollar bands, and the page
  renders them as what they are rather than blanking every fund page in the window
  between the site deploy and the data release.

The page must not draw a five-band bar for a fund it can see a quarter of, and it must not
present an inferred mandate as a computed split.
"""

from __future__ import annotations

import re

import pytest

from pipeline import fund_pages, sizes


def cap(zone: str = "us", band: str = "giant", pct: float | None = 0.01,
        basis: str = "ranked") -> dict:
    out = {"zone": zone, "band": band, "basis": basis}
    if pct is not None:
        out["pct"] = pct
    return out


def zone(key: str, label: str, source: str, companies: int = 1_000) -> dict:
    counts = {"giant": companies // 4, "large": companies // 4, "mid": companies // 4,
              "small": companies // 4, "micro": companies - 3 * (companies // 4)}
    return {
        "key": key,
        "label": label,
        "source": source,
        "as_of": "2026-06-30",
        "companies": companies,
        "weight_bp": 10_000,
        "counts": counts,
    }


def table(caps: dict[str, dict], zones: dict[str, dict] | None = None) -> dict:
    return {
        "schema_version": 2,
        "kind": "sizes",
        "as_of": "2026-11-07.4",
        "method": sizes.METHOD,
        "bands": list(sizes.BAND_ORDER),
        "band_starts": dict(sizes.BAND_STARTS),
        "band_labels": dict(sizes.BAND_LABELS),
        "zones": zones or {"us": zone("us", "United States", "VTI")},
        "counts": {"companies": len(caps), "ranked": len(caps), "below_index": 0,
                   "no_zone": 0, "zone_companies": {"us": len(caps)}},
        "band_counts": {band: 0 for band in sizes.BAND_ORDER},
        "caps": caps,
    }


def legacy_table(caps: dict[str, dict]) -> dict:
    """A release built before schema 2: dollar bands, no zones."""
    return {
        "schema_version": 1,
        "bands": ["mega", "large", "mid", "small", "micro"],
        "thresholds": {"megacap": 200e9, "largecap": 10e9, "midcap": 2e9,
                       "smallcap": 300e6, "microcap": 0.0},
        "caps": caps,
        "counts": {"placed": len(caps)},
    }


def legacy_cap(band: str) -> dict:
    return {
        "usd": 1_000_000_000,
        "shares": 1_000_000,
        "share_date": "2026-07-17",
        "price": 10.0,
        "report_date": "2026-06-30",
        "basis": "frame",
        "band": band,
    }


def fund(name: str = "Avantis U.S. Small Cap Value ETF", holdings=None) -> dict:
    return {
        "schema_version": 1,
        "ticker": "AVUV",
        "fund_id": "S000055567",
        "name": name,
        "issuer": "EA Series Trust",
        "etf": True,
        "as_of": "2026-06-30",
        "filed_at": "2026-08-28",
        "lag_days": 59,
        "source": "SEC N-PORT",
        "source_url": "https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml",
        "coverage_pct": 97.7,
        # 90 of 100 bp in three placed companies, 8 in a company with no zone, 2 in cash
        # — so the bar has every segment it can draw.
        "holdings": holdings
        or [
            {"company_id": "c_0000000001", "name": "Giant Co", "asset_cat": "equity",
             "weight_bp": 5_000},
            {"company_id": "c_0000000002", "name": "Mid Co", "asset_cat": "equity",
             "weight_bp": 3_000},
            {"company_id": "c_0000000003", "name": "Micro Co", "asset_cat": "equity",
             "weight_bp": 1_000},
            {"company_id": "c_0000000009", "name": "Offshore Co", "asset_cat": "equity",
             "weight_bp": 800},
            {"company_id": None, "name": "Cash sweep", "asset_cat": "cash",
             "weight_bp": 200},
        ],
        "metrics": {"hhi": 0.0123, "effective_n": 81.3, "top10_pct": 22.11},
    }


def render(document: dict, size_table: dict | None) -> str:
    return fund_pages.render_page(document, issuer_funds=[], size_table=size_table)


def section(page: str) -> str:
    start = page.index('<section aria-labelledby="size-heading"')
    return page[start : page.index("</section>", start) + len("</section>")]


def text(markup: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", markup)).strip()


SIZED = table(
    {
        "c_0000000001": cap("us", "giant", 0.0),
        "c_0000000002": cap("us", "mid", 0.72),
        "c_0000000003": cap("us", "micro", 0.98),
    }
)


# -- no table -----------------------------------------------------------------


def test_no_section_when_the_release_publishes_no_size_table():
    assert 'aria-labelledby="size-heading"' not in render(fund(), None)
    assert "Company size" not in render(fund(), {})


def test_a_table_with_no_caps_draws_nothing():
    assert "Company size" not in render(fund(), table({}))


# -- the computed bar ---------------------------------------------------------


def test_a_well_covered_fund_gets_the_computed_bar():
    markup = section(render(fund(), SIZED))
    assert 'data-size-basis="computed"' in markup
    assert 'data-size-zones="us"' in markup
    assert 'data-size-label="large"' in markup
    body = text(markup)
    assert "Giant" in body and "Micro" in body
    assert "50.00%" in body  # Giant Co: 5000bp of 10,000bp gross
    assert "30.00%" in body  # Mid Co
    assert "10.00%" in body  # Micro Co
    assert "8.00%" in body  # the company with no zone
    assert "2.00%" in body  # cash
    # The bar's denominator is the whole fund, so the gaps are drawn segments too.
    assert "Not placed" in body
    assert "Not equity" in body
    # Each band draws its own hue from the design system's band ramp, and the legend's
    # swatch reuses the same class, so the colour a reader sees in the bar is the one
    # beside the name and the number. The band is still printed, so the hue only has to
    # make the segments tell apart — it never carries the band on its own.
    for band in ("giant", "mid", "micro"):
        assert f'class="bar__seg bar__seg--band-{band}"' in markup
        assert f'class="legend__swatch bar__seg--band-{band}"' in markup
    assert "bar__seg--band-large" not in markup  # no large-cap company in this fund
    assert "bar__seg--size" not in markup  # the single grey fill is gone
    assert markup.count('class="bar__seg bar__seg--unplaced"') == 1
    assert markup.count('class="bar__seg bar__seg--none"') == 1
    assert "Inferred" not in body


def test_the_computed_bar_prints_the_lines_the_zone_and_the_sample():
    body = text(section(render(fund(), SIZED)))
    # The four lines, in words a reader can check against the bar.
    assert "largest 40% of its market value are giant" in body
    assert "the next 30% are large, the next 20% mid, the next 7% small" in body
    # Which zone the holdings were ranked in, and by which fund.
    assert "United States 100.0%" in body
    assert "own holdings of VTI (Jun 30, 2026)" in body
    # Every band's column says where the company sits, not a dollar figure.
    assert "Largest 40% of its zone's value" in body
    assert "The smallest 3% of its zone" in body


def test_the_sample_sentence_names_only_the_zones_this_fund_holds():
    # The table's rankings come from VTI and VXUS; a US-only fund was ranked by VTI alone,
    # so naming VXUS in its caption was true of the table and misleading about the fund.
    two = table(
        {"c_0000000001": cap("us", "giant")},
        zones={
            "us": zone("us", "United States", "VTI"),
            "europe": zone("europe", "Europe", "VXUS"),
        },
    )
    holdings = [{"company_id": "c_0000000001", "asset_cat": "equity", "weight_bp": 10_000}]
    body = text(section(render(fund(holdings=holdings), two)))
    assert "own holdings of VTI (Jun 30, 2026)" in body
    assert "VXUS" not in body


def test_the_asset_weighted_label_is_printed_with_its_scale():
    body = text(section(render(fund(), SIZED)))
    assert "Asset-weighted size: large-cap" in body
    assert "Morningstar's three-row scale" in body


def test_a_barbell_fund_is_not_called_mid_cap():
    # 45% in a giant and 45% in a micro company: every average says mid, and the fund
    # holds the two ends. The label has to say the blend instead.
    holdings = [
        {"company_id": "c_0000000001", "asset_cat": "equity", "weight_bp": 4_500},
        {"company_id": "c_0000000003", "asset_cat": "equity", "weight_bp": 4_500},
        {"company_id": "c_0000000002", "asset_cat": "equity", "weight_bp": 1_000},
    ]
    markup = section(render(fund(holdings=holdings), SIZED))
    assert 'data-size-label="large_small"' in markup
    assert "large- and small-cap blend" in text(markup)


def test_a_company_outside_the_index_is_counted_in_micro_and_explained():
    sized = table(
        {
            "c_0000000001": cap("us", "giant", 0.0),
            "c_0000000002": cap("us", "micro", None, basis="below_index"),
            "c_0000000003": cap("us", "micro", 0.98),
        }
    )
    body = text(section(render(fund(), sized)))
    assert "counted in micro" in body
    # The sentence names the edge case rather than claiming the company is small: a
    # company that listed after the index's report date lands in the same band.
    assert "listed after the index's report date" in body


def test_a_company_with_no_zone_is_named_as_the_gap_and_never_guessed():
    body = text(section(render(fund(), SIZED)))
    # 8% of the fund is in a company with no style zone; it is drawn and named as not
    # placed, and no band is ever inferred for one company.
    assert "Not placed" in body
    assert "8.00%" in body
    assert "Offshore Co" not in body
    assert "cannot place" in body


# -- the callout --------------------------------------------------------------


def test_a_quarter_covered_international_fund_gets_the_callout_not_a_bar():
    holdings = [
        {"company_id": "c_0000000001", "asset_cat": "equity", "weight_bp": 1_000},
        {"company_id": "c_0000000009", "asset_cat": "equity", "weight_bp": 6_000},
        {"company_id": "c_0000000008", "asset_cat": "equity", "weight_bp": 1_000},
        {"company_id": "c_0000000007", "asset_cat": "equity", "weight_bp": 1_500},
        {"company_id": None, "asset_cat": "cash", "weight_bp": 500},
    ]
    # One of 9,500bp equity placed = 10.5%, comfortably under the gate.
    markup = section(render(fund(name="Acme Core Fund", holdings=holdings), SIZED))
    body = text(markup)
    assert 'data-size-basis="callout"' in markup
    assert "No computed size split for this fund" in body
    assert "10.5% of its equity weight" in body
    assert "below the 80% this page needs" in body
    assert 'class="bar bar--tall"' not in markup  # no bar under 80% coverage
    assert "nothing is estimated to fill it" in body
    assert "Inferred" not in body  # no stated mandate in the name, no inference


def test_a_quarter_covered_fund_with_a_stated_mandate_adds_the_labelled_inference():
    # The ranges are measured on the zone bands now, so a fund whose name states a
    # mandate gets the labelled prediction for the weight we could not place — and the
    # page says in the same breath what it is not.
    holdings = [
        {"company_id": "c_0000000001", "asset_cat": "equity", "weight_bp": 1_000},
        {"company_id": "c_0000000009", "asset_cat": "equity", "weight_bp": 9_000},
    ]
    markup = section(render(fund(name="iShares MSCI EAFE ETF", holdings=holdings), SIZED))
    body = text(markup)
    assert 'data-size-basis="inferred"' in markup
    assert 'data-size-mandate="large_mid"' in markup
    assert "No computed size split for this fund" in body
    assert "Inferred" in body
    assert "large- and mid-cap mandate" in body
    assert "giant 34–52%" in body
    assert "10th to 90th percentile" in body
    assert "not a computed split of its holdings" in body
    assert 'class="bar bar--tall"' not in markup


def test_an_uncatalogued_mandate_still_gets_no_invented_range(monkeypatch):
    # The table is the only thing between a name and a number: with no calibration
    # measured for a mandate, the page prints the callout and nothing else.
    monkeypatch.setattr(sizes, "MANDATE_MIX", {})
    holdings = [
        {"company_id": "c_0000000001", "asset_cat": "equity", "weight_bp": 1_000},
        {"company_id": "c_0000000009", "asset_cat": "equity", "weight_bp": 9_000},
    ]
    markup = section(render(fund(name="iShares MSCI EAFE ETF", holdings=holdings), SIZED))
    assert 'data-size-basis="callout"' in markup
    assert "data-size-mandate" not in markup
    assert "Inferred" not in text(markup)


def test_a_bar_with_a_gap_keeps_its_inference_beside_it():
    # 82% placed: above the bar's gate, below the 85% that would make the bar the whole
    # answer. The reader gets both — the bar, and the range the name predicts for the
    # 18% the bar cannot show.
    holdings = [
        {"company_id": "c_0000000001", "asset_cat": "equity", "weight_bp": 8_200},
        {"company_id": "c_0000000009", "asset_cat": "equity", "weight_bp": 1_800},
    ]
    markup = section(render(fund(name="iShares MSCI EAFE ETF", holdings=holdings), SIZED))
    body = text(markup)
    # Above the gate the bar is drawn, so the basis stays "computed"; the inference is
    # still printed beside it, because the bar has a gap the reader can see.
    assert 'data-size-basis="computed"' in markup
    assert 'class="bar bar--tall"' in markup
    assert "Inferred" in body


def test_the_eighty_percent_line_is_the_gate():
    # 79% placed is a callout, 80% is a bar: the gate is a published number, so the
    # boundary is tested rather than assumed. The name states no mandate, so the gate is
    # the only thing deciding.
    holdings = [
        {"company_id": "c_0000000001", "asset_cat": "equity", "weight_bp": 8_000},
        {"company_id": "c_0000000009", "asset_cat": "equity", "weight_bp": 2_000},
    ]
    assert 'data-size-basis="computed"' in section(render(fund(name="Acme Core Fund", holdings=holdings), SIZED))
    holdings[0]["weight_bp"] = 7_900
    holdings[1]["weight_bp"] = 2_100  # 79%
    assert 'data-size-basis="callout"' in section(render(fund(name="Acme Core Fund", holdings=holdings), SIZED))


# -- the release before schema 2 ---------------------------------------------


def test_a_schema_one_release_still_renders_its_dollar_bands():
    old = legacy_table(
        {
            "c_0000000001": legacy_cap("mega"),
            "c_0000000002": legacy_cap("mid"),
            "c_0000000003": legacy_cap("small"),
        }
    )
    markup = section(render(fund(), old))
    body = text(markup)
    assert 'data-size-basis="computed"' in markup
    assert 'data-size-bands="dollars"' in markup
    assert "predates the zone-percentile bands" in body
    assert "USD 200bn and over" in body
    assert "USD 2bn to 10bn" in body
    # "Mega" and "giant" are the same step of the palette's ramp, so a legacy object
    # paints in the same colours as a current one.
    assert 'bar__seg--band-giant' in markup
    assert 'bar__seg--band-mega' not in markup
    assert sizes.BAND_LABELS["giant"] == "Giant"


def test_a_schema_one_release_under_the_gate_gets_its_coverage_note():
    old = legacy_table({"c_0000000001": legacy_cap("mega")})
    holdings = [
        {"company_id": "c_0000000001", "asset_cat": "equity", "weight_bp": 1_000},
        {"company_id": "l_5493000J7GF2VJYQ8F684", "asset_cat": "equity", "weight_bp": 9_000},
    ]
    body = text(section(render(fund(holdings=holdings), old)))
    assert "built before the size bands became zone percentiles" in body
    assert "foreign issuers with no US share count" in body
    assert "zone bands arrive with the next data release" in body


def test_the_section_is_deterministic():
    document = fund()
    assert section(render(document, SIZED)) == section(render(document, SIZED))
