"""The fund page: a document of the design system, not a route.

The page has to carry the same numbers as the ledger, in the app's own words, and
state its own limits. These tests pin the things that would make it lie: a metric
shown for a fund we cannot see most of, a market bar that invents a tier, a weight
formatted differently from the app, an escaped name, an identifier we must not
publish, a link the app cannot decode, and a script the page depends on.
"""

from __future__ import annotations

import base64
import json
import shutil
import re
from pathlib import Path

import pytest

from pipeline import artifact, fund_pages, paths

# Domiciles for the fixture's companies. US twice (a company and a cash row), one
# developed, one emerging, one in neither list — so one page exercises every state
# the bar and the row edge have.
COUNTRIES = {
    "c_0001045810": "US",
    "c_0000000002": "US",
    "c_0000000003": "CH",
    "c_0000000004": "TW",
    "c_0000000005": "BM",
}


def fund(**overrides) -> dict:
    document = {
        "schema_version": 1,
        "ticker": "AVUV",
        "fund_id": "S000055567",
        "name": "Avantis U.S. Small Cap Value ETF",
        "issuer": "EA Series Trust",
        "etf": True,
        "as_of": "2026-05-31",
        "filed_at": "2026-07-29",
        "lag_days": 59,
        "source": "SEC N-PORT",
        "source_url": "https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml",
        "coverage_pct": 97.7,
        "holdings": [
            {"company_id": "c_0001045810", "name": "NVIDIA Corp", "ticker": "NVDA",
             "asset_cat": "equity", "weight_bp": 120},
            {"company_id": None, "name": "Samsung Electronics Co Ltd", "ticker": None,
             "asset_cat": "equity", "weight_bp": 80},
            {"company_id": "c_0000000002", "name": "Cash sweep", "ticker": None,
             "asset_cat": "cash", "weight_bp": 20},
        ],
        "metrics": {"hhi": 0.0123, "effective_n": 81.3, "top10_pct": 22.11},
        "warnings": ["unmapped_holding"],
    }
    document.update(overrides)
    return document


def tiered() -> dict:
    """One fund in all five market states: US, developed, emerging, untiered, unknown."""
    return fund(
        name="Avantis All World Fund",
        coverage_pct=97.0,
        holdings=[
            {"company_id": "c_0001045810", "name": "NVIDIA Corp", "ticker": "NVDA",
             "asset_cat": "equity", "weight_bp": 400},
            {"company_id": "c_0000000003", "name": "Novartis AG", "ticker": "NVS",
             "asset_cat": "equity", "weight_bp": 250},
            {"company_id": "c_0000000004", "name": "Taiwan Semiconductor Manufacturing",
             "ticker": "TSM", "asset_cat": "equity", "weight_bp": 150},
            {"company_id": "c_0000000005", "name": "A Bermuda Insurer Ltd", "ticker": None,
             "asset_cat": "equity", "weight_bp": 100},
            {"company_id": "c_0000009999", "name": "Mystery Co", "ticker": None,
             "asset_cat": "equity", "weight_bp": 60},
            {"company_id": None, "name": "Samsung Electronics Co Ltd", "ticker": None,
             "asset_cat": "equity", "weight_bp": 30},
            {"company_id": "c_0000000002", "name": "Cash sweep", "ticker": None,
             "asset_cat": "cash", "weight_bp": 10},
        ],
    )


def render(document: dict, **kwargs) -> str:
    kwargs.setdefault("issuer_funds", [])
    return fund_pages.render_page(document, **kwargs)


def panel(page: str, heading: str) -> str:
    """The markup of one `.panel`, found by its visible heading."""
    start = page.index(f'<h2 class="panel__title">{heading}</h2>')
    return page[start : page.index("</section>", start) + len("</section>")]


def hrefs(markup: str, prefix: str) -> list[str]:
    return re.findall(rf'href="({re.escape(prefix)}[^"]*)"', markup)


def flat(page: str) -> str:
    """Prose wrapped across source lines is still one sentence on the page."""
    return " ".join(page.split())


# --- What the page says --------------------------------------------------------


def test_the_page_states_the_filings_three_dates_and_its_source():
    page = render(fund())
    # The title is the question a visitor typed, in the app's own voice.
    assert "<title>AVUV holdings — what Avantis U.S. Small Cap Value ETF owns</title>" in page
    # Three dates, because a filing has three: the period it describes, the day the
    # SEC received it, and the gap between them.
    assert "Period end" in page and "2026-05-31" in page
    assert "Filed with the SEC" in page and "2026-07-29" in page
    assert "Filing lag" in page and "59 days" in page
    # ...and the same facts in the answer's own note, in the app's long-date form.
    assert (
        "Coverage <strong>97.7%</strong> · reporting period <strong>May 31, 2026</strong>"
        " · filed <strong>Jul 29, 2026</strong> · 59 days later." in page
    )
    # The source is the fund's own filing, linked, not the form's name alone.
    url = "https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml"
    assert f'href="{url}" rel="nofollow noopener"' in page
    assert "Form N-PORT on SEC EDGAR" in page


def test_a_pasted_link_shows_a_card_with_the_pages_own_title_and_description():
    page = render(fund())
    # The card repeats the page's title and description rather than inventing a
    # second summary, so a preview cannot promise something the page does not say.
    title = "AVUV holdings — what Avantis U.S. Small Cap Value ETF owns"
    assert f'<meta property="og:title" content="{title}">' in page
    assert f'<meta name="twitter:title" content="{title}">' in page
    description = re.search(r'<meta name="description" content="([^"]+)">', page).group(1)
    assert f'<meta property="og:description" content="{description}">' in page
    assert f'<meta name="twitter:description" content="{description}">' in page
    # The URL the card names is the page's own canonical URL, not the site root.
    assert '<meta property="og:url" content="https://unpackfund.com/f/AVUV/">' in page
    assert '<link rel="canonical" href="https://unpackfund.com/f/AVUV/">' in page


def test_the_card_image_is_absolute_and_declares_its_size():
    page = render(fund())
    # A relative image URL is silently dropped by every crawler, and a card without
    # its dimensions is laid out at the wrong ratio before the image arrives.
    assert '<meta property="og:image" content="https://unpackfund.com/og.png">' in page
    assert '<meta property="og:image:width" content="1200">' in page
    assert '<meta property="og:image:height" content="630">' in page
    assert '<meta property="og:image:alt" content="UnpackFund — see the companies behind your funds">' in page
    assert '<meta name="twitter:card" content="summary_large_image">' in page
    assert '<meta name="twitter:image" content="https://unpackfund.com/og.png">' in page


def test_the_card_image_the_pages_name_is_the_file_the_site_ships():
    # One image, one path: the generator and the app's metadata module must agree,
    # and the file must exist in the export's public directory.
    assert fund_pages.OG_IMAGE == "/og.png"
    assert (paths.REPO_ROOT / "web" / "public" / "og.png").is_file()
    app_metadata = (paths.REPO_ROOT / "web" / "lib" / "metadata.ts").read_text()
    assert f'path: "{fund_pages.OG_IMAGE}"' in app_metadata
    assert f"width: {fund_pages.OG_IMAGE_WIDTH}" in app_metadata
    assert f"height: {fund_pages.OG_IMAGE_HEIGHT}" in app_metadata


def test_the_generator_and_the_app_agree_on_the_origin_and_the_alt_text():
    # The site URL and the image's alt text exist in two languages — `SITE` here and
    # `SITE_URL` in `web/lib/metadata.ts` — because the fund pages are generated by
    # Python and the app routes by Next. Nothing else holds them together, and a card
    # whose `og:url` names a different origin than its canonical is the exact failure
    # this change exists to prevent, so the pair is asserted rather than commented.
    app_metadata = (paths.REPO_ROOT / "web" / "lib" / "metadata.ts").read_text()
    assert f'SITE_URL = "{fund_pages.SITE}"' in app_metadata
    assert f'alt: "{fund_pages.OG_IMAGE_ALT}"' in app_metadata


def test_a_fund_name_cannot_inject_markup_through_the_card():
    page = render(fund(name='Evil "><script>alert(1)</script>'))
    assert "<script>alert(1)</script>" not in page
    assert "&quot;&gt;&lt;script&gt;" in page


def test_the_answer_says_how_many_companies_and_the_largest_weight():
    page = render(
        fund(
            coverage_pct=100.0,
            holdings=[
                {"company_id": "c_0001045810", "name": "NVIDIA Corp", "ticker": "NVDA",
                 "asset_cat": "equity", "weight_bp": 635},
                {"company_id": "c_0000000003", "name": "Novartis AG", "ticker": "NVS",
                 "asset_cat": "equity", "weight_bp": 365},
            ],
        ),
        countries=COUNTRIES,
    )
    assert (
        "AVUV holds <strong>2 companies</strong>; the largest is <strong>NVIDIA Corp</strong>"
        " at <strong>6.35%</strong> of the fund." in page
    )


def test_a_fund_we_can_only_partly_map_says_how_many_companies_it_named():
    page = render(fund(), countries=COUNTRIES)
    assert (
        "AVUV files <strong>3 positions</strong>, <strong>2 companies</strong> of them"
        " companies we can name; the largest is <strong>NVIDIA Corp</strong>"
        " at <strong>1.20%</strong> of the fund." in page
    )


def test_a_fund_with_no_mapped_row_says_so_instead_of_naming_a_company():
    page = render(fund(coverage_pct=0.0, holdings=[
        {"company_id": None, "name": "Some Trust", "ticker": None,
         "asset_cat": "equity", "weight_bp": 100},
    ]))
    assert "AVUV files <strong>1 position</strong>, and none of them maps to a company" in page


def test_weights_print_two_decimals_like_the_app():
    """`formatWeightBp`: basis points to percent, always two decimals."""
    assert fund_pages.pct(635) == "6.35%"
    assert fund_pages.pct(1200) == "12.00%"
    assert fund_pages.pct(5) == "0.05%"
    assert fund_pages.pct(10000) == "100.00%"
    page = render(fund())
    assert '<td class="num">1.20%</td>' in page


def test_coverage_is_the_filings_number_and_is_not_recomputed_from_the_rows():
    # The rows here add to 100% of the fund; the artifact says 91.1%. The page prints
    # the artifact's number, because that is the number the app prints.
    page = render(fund(coverage_pct=91.1))
    assert "Coverage <strong>91.1%</strong>" in page
    assert "97.7%" not in page


def test_a_date_the_page_cannot_read_is_shown_as_filed_never_reformatted():
    page = render(fund(as_of="not-a-date", filed_at="2026-2-3"))
    assert "not-a-date" in page
    assert "2026-2-3" in page


# --- Coverage: the gate that decides whether a number is shown ------------------


@pytest.mark.parametrize(
    "coverage, key, chip, label, metrics",
    [
        (70.0, "full", "70.0% covered", "70.0% of weight covered", True),
        (69.9, "partial", "partial 69.9%", "partial — 69.9% of weight", True),
        (60.0, "partial", "partial 60.0%", "partial — 60.0% of weight", True),
        (59.9, "none", "59.9% not covered", "not covered", False),
        (0.0, "none", "0.0% not covered", "not covered", False),
    ],
)
def test_coverage_bands_break_exactly_at_the_contracts_gates(
    coverage, key, chip, label, metrics
):
    band = fund_pages.coverage_band(coverage)
    assert band.key == key
    assert band.chip == chip
    assert band.label == label
    assert band.show_metrics is metrics


def test_no_coverage_figure_contradicts_the_band_it_is_printed_with():
    """The artifact publishes one decimal, so the printed number is the gate's input."""
    for tenth in range(1001):
        coverage = tenth / 10
        band = fund_pages.coverage_band(coverage)
        shown = float(re.search(r"([\d.]+)%", band.chip).group(1))
        if band.key == "full":
            assert shown >= 70.0
        elif band.key == "partial":
            assert 60.0 <= shown < 70.0
        else:
            assert shown < 60.0


def test_a_full_band_fund_shows_its_concentration_numbers():
    page = render(fund())
    assert "Same-size companies" in page
    assert "81.3" in page
    assert "0.0123" in page
    assert "22.11%" in page
    assert "Concentration figures are withheld" not in page


def test_metrics_are_absent_not_merely_unlabelled_below_sixty_percent():
    page = render(fund(coverage_pct=59.9))
    assert "<strong>Concentration figures are withheld.</strong>" in page
    assert "below 60% a concentration number computed from the mapped part" in flat(page)
    # The values themselves must not reach the page at all.
    assert "81.3" not in page
    assert "0.0123" not in page
    assert "22.11" not in page
    # And the page says whose limit this is.
    assert "The gap is ours, not the fund's" in flat(page)


def test_the_partial_band_keeps_the_numbers_and_names_the_band():
    page = render(fund(coverage_pct=64.2))
    assert '<span class="chip chip--partial">partial 64.2%</span>' in page
    assert "Same-size companies" in page
    assert "81.3" in page
    assert "figures above are a floor on what the fund holds" in flat(page)


def test_a_release_with_no_metrics_does_not_invent_them():
    page = render(fund(metrics=None, coverage_pct=99.0))
    assert "<strong>No concentration figures in this release.</strong>" in page
    assert "not disclosed" not in page
    assert "Same-size companies" not in page


# --- The holdings table: one row per position, its edge and its code ------------


def test_a_mapped_holding_links_to_the_company_page_and_prints_its_code():
    page = render(fund(), countries=COUNTRIES)
    assert '<a href="/c/#c_0001045810">NVIDIA Corp</a>' in page
    assert '<span class="mono tiny muted">NVDA</span>' in page
    assert (
        '<span class="country-tag"><span aria-hidden="true">🇺🇸</span> US</span>' in page
    )


def test_an_unmapped_holding_is_listed_but_not_linked_and_claims_no_country():
    page = render(fund(), countries=COUNTRIES)
    assert "Samsung Electronics Co Ltd" in page
    assert '<span class="chip">unmapped</span>' in page
    assert 'href="/c/#None"' not in page
    # It has no company, so it has no tier and no country: the cell says so.
    row = re.search(r'<tr><td class="num">2</td>.*?</tr>', page).group(0)
    assert "data-tier" not in row
    assert "data-country" not in row
    assert '<span class="muted">—</span>' in row


def test_a_company_with_no_published_domicile_carries_the_missing_country_flag():
    """The app's contract for that row: `data-country-missing`, no guessed tier."""
    page = render(tiered(), countries=COUNTRIES)
    row = re.search(r'<tr data-country-missing="true">.*?</tr>', page).group(0)
    assert "Mystery Co" in row
    assert "data-tier" not in row
    assert '<span class="muted">Unknown</span>' in row


def test_every_tier_gets_its_own_row_edge_and_country_code():
    page = render(tiered(), countries=COUNTRIES)
    # Bermuda is an offshore holding domicile: the United States, not a fourth tier.
    for country, tier in (("US", "US"), ("CH", "DM"), ("TW", "EM"), ("BM", "US")):
        assert f'<tr data-country="{country}" data-tier="{tier}">' in page
    for flag, code in (("🇨🇭", "CH"), ("🇹🇼", "TW"), ("🇧🇲", "BM")):
        assert f'<span aria-hidden="true">{flag}</span> {code}' in page


def test_names_are_escaped_so_a_fund_cannot_inject_markup():
    page = render(
        fund(
            name='AT&T "Growth" <script>alert(1)</script>',
            holdings=[
                {"company_id": "c_0001045810", "name": "<b>Bold</b> & Co",
                 "ticker": "X", "asset_cat": "equity", "weight_bp": 100},
            ],
        )
    )
    assert "<script>alert(1)</script>" not in page
    assert "&lt;script&gt;" in page
    assert "AT&amp;T" in page
    assert "&lt;b&gt;Bold&lt;/b&gt; &amp; Co" in page


def test_a_non_equity_row_is_labelled_beside_its_name_too():
    """The type travels with the name, because a phone hides a narrow column."""
    page = render(fund(), countries=COUNTRIES)
    assert 'Cash sweep</a> <span class="chip">cash</span>' in page
    assert '>NVIDIA Corp</a> <span class="chip">' not in page


def test_no_identifier_we_may_not_publish_appears():
    """CUSIP/ISIN never reach a page — the artifact does not carry them, and nor does this."""
    page = render(fund(), countries=COUNTRIES)
    assert "cusip" not in page.lower()
    assert "isin" not in page.lower()


def test_the_table_caption_prints_the_colour_key_the_bar_uses():
    page = render(fund(), countries=COUNTRIES)
    assert "The row's left edge is the company's market tier" in page
    assert "ochre international developed ex-US" in page
    assert "an offshore holding domicile" in page
    assert fund_pages.TIER_CONVENTION in page
    assert fund_pages.TIER_AS_OF in page


# --- The market bar: never a tier the release did not publish -------------------


def test_the_bar_and_its_table_are_the_same_numbers_with_the_codes_in_text():
    page = render(tiered(), countries=COUNTRIES)
    # 910 bp placed: 400 US + 100 BM (offshore → US) + 10 cash that maps to a US
    # company = 510 US; 250 CH; 150 TW. The 60 bp company with no country and the
    # 30 bp position with no company and no filed country are outside the bar.
    expected = {"United States": 56.04, "International Developed ex-US": 27.47,
                "Emerging Markets": 16.48}
    rows = re.findall(
        r'<tr><td>([^<]+)</td><td class="mono">([^<]*)</td><td class="num">([\d.]+)%</td></tr>',
        page,
    )
    assert {label: float(share) for label, _codes, share in rows} == expected
    # Every printed share is in the bar's spoken label, and a drawn segment rounds
    # to it: the bar is the table, in colour, to the precision it prints.
    bar = re.search(r'<div class="bar bar--tall".*?</div>', page, re.S).group(0)
    widths = [float(width) for width in re.findall(r'style="width:([\d.]+)%"', bar)]
    assert len(widths) == len(expected)
    assert abs(sum(widths) - 100.0) < 0.01
    for label, share in expected.items():
        assert f"{label} {share:.2f}%" in page
        assert any(round(width, 2) == share for width in widths), (label, widths)
    # The codes are text, not only colours. Bermuda is printed under the United
    # States, which is the whole point of the offshore rule: the code is not hidden,
    # it is filed under the market its shares trade in.
    codes = {label: codes for label, codes, _share in rows}
    assert codes["United States"] == "BM, US"
    assert codes["International Developed ex-US"] == "CH"
    assert codes["Emerging Markets"] == "TW"


def test_the_short_answer_names_the_three_buckets_the_way_the_bar_does():
    """The sentence a reader meets first, in the same three words as the bar.

    It said "in US companies" and "in other developed markets" — a fourth and a
    fifth name for two of the three buckets, on the same page as the bar. The
    operator asked for one set of names; this is the test that holds it.
    """
    page = render(tiered(), countries=COUNTRIES)
    sentence = re.search(r'<p class="answer__sentence">Of the .*?</p>', page, re.S).group(0)
    # The lead names the base the shares are a share *of*: the weight the bar draws,
    # not the narrower share that maps to a company.
    assert "9.1%</strong> of the fund the release can place in a market" in sentence
    assert "<strong>56.04%</strong> is in the United States" in sentence
    assert "in international developed markets outside it" in sentence
    assert "in emerging markets" in sentence
    assert "other developed markets" not in page
    assert "US companies" not in page


def test_a_company_the_vote_could_not_decide_is_placed_by_the_contested_map():
    """The decided map wins; the contested map is the second answer, never merged."""
    page = render(tiered(), countries=COUNTRIES, contested={"c_0000009999": "JP"})
    rows = re.findall(
        r'<tr><td>([^<]+)</td><td class="mono">([^<]*)</td><td class="num">([\d.]+)%</td></tr>',
        page,
    )
    shares = {label: float(share) for label, _codes, share in rows}
    # 970 bp placed now: the 60 bp company joins developed ex-US.
    assert shares == {"United States": 52.58, "International Developed ex-US": 31.96,
                      "Emerging Markets": 15.46}
    # The row is placed by the plurality too, so the table and the bar agree.
    assert '<tr data-country="JP" data-tier="DM">' in page


def test_a_position_with_no_company_is_placed_by_the_country_its_own_filing_states():
    """The architectural change: a row with no company still has a country."""
    document = fund(coverage_pct=50.0, holdings=[
        {"company_id": "c_0001045810", "name": "NVIDIA Corp", "ticker": "NVDA",
         "asset_cat": "equity", "weight_bp": 500},
        {"company_id": None, "name": "Toyota Motor Corp", "ticker": None,
         "asset_cat": "equity", "weight_bp": 300, "filed_country": "JP"},
        {"company_id": None, "name": "Samsung Electronics Co Ltd", "ticker": None,
         "asset_cat": "equity", "weight_bp": 200, "filed_country": "KR"},
    ])
    page = render(document, countries=COUNTRIES)
    rows = re.findall(
        r'<tr><td>([^<]+)</td><td class="mono">([^<]*)</td><td class="num">([\d.]+)%</td></tr>',
        page,
    )
    # Japan is developed and Korea is emerging under MSCI, so the two unidentified rows
    # land in different segments — which is the point of reading the filing's own country
    # rather than dropping them.
    assert {label: float(share) for label, _codes, share in rows} == {
        "United States": 50.0, "International Developed ex-US": 30.0, "Emerging Markets": 20.0,
    }
    # The row prints the country it was placed by, and carries the tier edge.
    assert '<tr data-country="JP" data-tier="DM">' in page
    assert '<tr data-country="KR" data-tier="EM">' in page


def test_cash_and_derivatives_are_outside_the_bar_even_with_a_filed_country():
    """They have no market. A country on a cash line is a filing artifact, not a place."""
    document = fund(coverage_pct=50.0, holdings=[
        {"company_id": "c_0001045810", "name": "NVIDIA Corp", "ticker": "NVDA",
         "asset_cat": "equity", "weight_bp": 500},
        {"company_id": None, "name": "Cash sweep", "ticker": None,
         "asset_cat": "cash", "weight_bp": 300, "filed_country": "US"},
        {"company_id": None, "name": "S&P 500 future", "ticker": None,
         "asset_cat": "derivative", "weight_bp": 200, "filed_country": "US"},
    ])
    page = render(document, countries=COUNTRIES)
    rows = re.findall(
        r'<tr><td>([^<]+)</td><td class="mono">([^<]*)</td><td class="num">([\d.]+)%</td></tr>',
        page,
    )
    assert {label: float(share) for label, _codes, share in rows} == {"United States": 100.0}
    # Neither line is placed, so neither row carries a country tag.
    for name in ("Cash sweep", "S&amp;P 500 future"):
        row = re.search(rf"<tr[^>]*>(?:(?!</tr>).)*?{name}.*?</tr>", page, re.S).group(0)
        assert "data-country" not in row
        assert '<span class="muted">—</span>' in row


def test_the_bar_states_what_it_could_not_place_rather_than_drawing_a_fourth_segment():
    page = render(tiered(), countries=COUNTRIES)
    # 90 bp of 1,000: the 60 bp company with no country and the 30 bp position with
    # neither a company nor a filed country.
    assert "A further 0.90% of the fund is weight the release cannot place" in page
    assert "1 company with no country answer" in page
    assert "and it is not drawn" in page
    # Three segments, never four.
    bar = re.search(r'<div class="bar bar--tall".*?</div>', page, re.S).group(0)
    assert len(re.findall(r'class="bar__seg bar__seg--', bar)) == 3


def test_the_bar_says_not_traced_when_the_release_publishes_no_countries():
    page = render(fund())
    assert "<strong>Not traced.</strong>" in page
    assert "the market split is not shown rather than guessed" in flat(page)
    # No bar, no legend, no tier table: an empty chart is better than an invented one.
    assert 'class="bar bar--tall"' not in page
    assert "Market tier" not in page


def test_a_fund_with_no_mapped_weight_has_no_split_to_draw():
    page = render(fund(coverage_pct=0.0, holdings=[
        {"company_id": None, "name": "Some Trust", "ticker": None,
         "asset_cat": "equity", "weight_bp": 100},
    ]), countries=COUNTRIES)
    assert "None of this fund's weight can be placed in a market" in page
    assert 'class="bar bar--tall"' not in page


def test_the_tier_table_matches_the_apps_own_convention():
    """One classification, not two. Both modules are generated from the same JSON.

    The page used to restate the app's table and a test parsed the TypeScript to hold
    them equal. That worked while there was one provider; with two it would have meant
    parsing a generated module out of a generated module. The table now lives in
    `classification/classification.json` and both languages are emitted from it, so
    this test checks the thing that can still go wrong — a generator that emits the
    two modules differently — rather than a hand edit that cannot happen.
    """
    from pipeline import classification_generated

    assert fund_pages.TIER_AS_OF == classification_generated.TIER_AS_OF
    assert fund_pages.TIER_CONVENTION == classification_generated.PROVIDER_LABELS["MSCI"]
    assert classification_generated.DEFAULT_PROVIDER == "MSCI"
    # The page prints one convention and says which; it does not offer a toggle.
    assert "MSCI" in fund_pages.TIER_CONVENTION
    # The three segments are the app's three segments, in the same order.
    assert [key for key, _label in fund_pages.TIERS] == ["US", "DM", "EM"]
    assert set(fund_pages.TIER_CLASS) == {"US", "DM", "EM"}


def test_an_unlisted_domicile_is_placed_by_one_of_the_three_rules():
    """Three buckets and no fourth: every code lands in one, and only "no code" is None."""
    assert fund_pages.tier_of("US") == "US"
    assert fund_pages.tier_of("CH") == "DM"
    assert fund_pages.tier_of("TW") == "EM"
    # Offshore holding domiciles are the United States, because that is where they trade.
    for code in ("BM", "KY", "VG", "GG", "JE", "IM", "PA", "MH", "BS", "GI", "MC"):
        assert fund_pages.tier_of(code) == "US"
    # A United States territory is the United States.
    assert fund_pages.tier_of("PR") == "US"
    # MSCI calls Korea, Poland and Greece emerging; FTSE calls them developed. The page
    # follows MSCI, which is what the funds it looks through benchmark to.
    for code in ("KR", "PL", "GR"):
        assert fund_pages.tier_of(code) == "EM"
    # Frontier and standalone fold into emerging, because a third bucket has no fourth
    # place. The European frontier is the visible case: FTSE says developed, MSCI says
    # frontier, and the provider's answer is the one that ships.
    for code in ("KZ", "AR", "PE", "MA", "NG", "MU", "KE", "RU", "FO", "LI"):
        assert fund_pages.tier_of(code) == "EM"
    for code in ("BG", "CY", "EE", "HR", "LT", "LV", "MT", "SI", "SK"):
        assert fund_pages.tier_of(code) == "EM"
    # `None` is "the release has no country", which is a different statement.
    assert fund_pages.tier_of(None) is None
    assert fund_pages.tier_of("") is None
    # The residue rule is total, so a lower-case code must not fall through to emerging.
    # Korea is the case that shows it: emerging under MSCI, and "kr" must agree with "KR".
    assert fund_pages.tier_of("kr") == "EM"
    assert fund_pages.tier_of("ch") == "DM"
    assert fund_pages.tier_of(" ky ") == "US"


# --- The links: the app's fragment grammar, or nothing --------------------------


def test_the_fund_offers_a_portfolio_link_the_app_can_decode():
    fragment = fund_pages.fund_fragment("AVUV")
    assert fragment is not None
    assert fragment.startswith("v3.")
    payload = fragment.split(".", 1)[1]
    decoded = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert decoded == ["bp", [["f", "AVUV", 10000]]]
    # A complete allocation: one fund at 10,000 bp, which is what the builder asks for.
    assert len(fragment) < 60


def test_the_page_links_all_three_surfaces_with_the_same_fragment():
    page = render(fund())
    fragment = fund_pages.fund_fragment("AVUV")
    assert f'href="/#{fragment}"' in page
    assert f'href="/compare/#{fragment}"' in page
    assert f'href="/x/#{fragment}"' in page
    assert "Add this fund to a portfolio" in page
    assert "Compare" in page
    assert "See it in your portfolio" in page
    assert "Browse all funds" in page


def test_every_action_is_a_real_anchor_so_the_page_works_without_its_script():
    page = render(fund())
    actions = re.search(
        r'<section aria-labelledby="actions-heading".*?</section>', page, re.S
    ).group(0)
    anchors = re.findall(r"<a [^>]*>", actions)
    assert len(anchors) == 4
    assert all('href="/' in anchor for anchor in anchors)
    # The script hooks these three; it is not the only way to the fragment.
    assert len(re.findall(r'data-fragment href="/', actions)) == 3


def test_the_one_script_is_inline_tiny_and_does_no_work_the_page_needs():
    page = render(fund())
    scripts = re.findall(r"<script>(.*?)</script>", page, re.S)
    assert len(scripts) == 1
    script = scripts[0]
    assert page.count("<script") == 1
    assert " src=" not in script
    # Under fifteen lines, and none of the things a static page must never ship.
    assert len([line for line in script.splitlines() if line.strip()]) <= 15
    for banned in ("eval", "innerHTML", "document.write", "localStorage",
                   "sessionStorage", "fetch(", "XMLHttpRequest", "import"):
        assert banned not in script, banned
    # It runs at the end of the document, after the content it acts on.
    assert page.rindex("<script>") > page.rindex('class="site-footer"')


def test_a_ticker_the_ledger_would_refuse_gets_no_prefill_and_no_script():
    """The app's fragment grammar is the gate: a 100% link must decode, not fall back."""
    assert fund_pages.ledger_link("BRK.B") is not None
    assert fund_pages.ledger_link("avuv") is None
    assert fund_pages.ledger_link("TOO-LONG-TICKER") is None
    assert fund_pages.portfolio_link("avuv") is None
    assert fund_pages.compare_link("avuv") is None
    page = render(fund(ticker="avuv", name="lower case ticker"))
    assert "#v3." not in page
    assert "<script" not in page
    assert "data-fragment" not in page
    assert 'href="/compare/#' not in page
    assert '<a class="btn btn--primary" href="/funds/">Browse all funds</a>' in page


# --- The page as a document ----------------------------------------------------


def test_a_fund_page_is_a_single_document_with_its_css_linked():
    page = render(fund())
    assert page.startswith("<!doctype html>")
    assert '<link rel="stylesheet" href="/fund-page.css">' in page
    # Four links, and each one is named: the canonical URL, the two faces a first
    # screen needs (preloaded, because a document that waits for its stylesheet to
    # discover its fonts paints twice), and the stylesheet itself.
    hrefs = re.findall(r'<link[^>]+href="([^"]+)"', page)
    assert sorted(href for href in hrefs if href.startswith("/")) == [
        "/fonts/fraunces.woff2",
        "/fonts/plus-jakarta-sans.woff2",
        "/fund-page.css",
    ]
    assert [href for href in hrefs if href.startswith("https://")] == [
        f"https://unpackfund.com/f/{fund()['ticker']}/"
    ]
    assert page.count("<link") == 4
    assert "noindex" in page
    assert "noindex" not in render(fund(), indexable=True)


def test_the_page_requests_nothing_from_a_third_party():
    """Fully static: the only hosts a page names are its own and the SEC's."""
    page = render(tiered(), countries=COUNTRIES)
    assert sorted(set(re.findall(r'(?:href|src)="https?://([^/"]+)', page))) == [
        "unpackfund.com",
        "www.sec.gov",
    ]
    # Nothing the browser would fetch from this document but the one stylesheet and
    # the two self-hosted faces it preloads. Both are first-party paths under
    # `/fonts/`; a font CDN would appear in the host assertion above.
    fetched = set(re.findall(r'(?:src|srcset)="([^"]+)"', page))
    fetched |= set(re.findall(r'<link[^>]+href="([^"]+)"', page))
    assert {value for value in fetched if value.startswith("/")} == {
        "/fund-page.css",
        "/fonts/fraunces.woff2",
        "/fonts/plus-jakarta-sans.woff2",
    }


def test_the_page_links_no_fund_route_that_is_not_a_generated_page():
    """`/f/` is the static output of this build; every link is a catalogued ticker."""
    page = render(fund(), issuer_funds=[("AVLV", "Avantis U.S. Large Cap Value ETF")])
    for target in re.findall(r'href="/f/([^/"]+)/"', page):
        assert re.fullmatch(r"[A-Z0-9][A-Z0-9.-]{0,9}", target), target


def test_the_page_carries_the_not_advice_line_and_the_sec_attribution():
    page = render(fund())
    text = flat(page)
    assert "<strong>Not investment advice.</strong>" in page
    assert "It is not a recommendation to buy, hold or sell anything" in text
    assert "not a registered investment adviser" in text
    assert '<a href="/disclaimer/">Read the full disclaimer</a>' in page
    assert "60 to 150 days" in text
    assert "Verify anything that matters" in text
    assert "Source: SEC EDGAR (Form N-PORT)" in text
    assert "No SEC seal or logo is used" in text
    assert "not affiliated with any fund issuer" in text
    for href in ("/methodology/", "/about/", "/glossary/", "/disclaimer/",
                 "/privacy/", "/terms/"):
        assert f'href="{href}"' in page


def _nav_structure(page: str) -> list[dict]:
    """The nav's content, in the shape `web/components/shell/nav-contract.json` holds.

    Deliberately not a markup comparison: the two renderers emit different attribute
    order and different self-closing forms, and neither is the contract. What must not
    drift is the groups, their order, the labels, the hrefs, which entry is current,
    and whether each entry has an icon.
    """
    nav = re.search(r'<nav class="app-nav" aria-label="Sections">(.*?)</nav>', page, re.S)
    assert nav, "the page has no Sections nav"
    groups = []
    for group in re.finditer(
        r'<div class="app-nav__group"><p class="app-nav__label">(.*?)</p><ul>(.*?)</ul></div>',
        nav.group(1),
        re.S,
    ):
        items = []
        for item in re.finditer(
            r'<a class="app-nav__link" href="([^"]*)"( aria-current="page")?>(.*?)</a>',
            group.group(2),
            re.S,
        ):
            inner = item.group(3)
            items.append(
                {
                    "label": re.sub(r"<[^>]+>", "", inner).strip(),
                    "href": item.group(1),
                    "current": bool(item.group(2)),
                    "icon": "<svg" in inner,
                }
            )
        groups.append({"group": group.group(1), "items": items})
    return groups


def test_the_nav_matches_the_contract_the_react_shell_is_held_to():
    """The drift gate between the two renderers.

    `web/components/shell/nav.test.tsx` extracts the same structure from the React
    sidebar and compares it to the same file. A change to one renderer that the other
    does not follow fails one of the two tests, which is what the hand-maintained
    copies never did.
    """
    contract = json.loads(
        (fund_pages.REPO_ROOT / "web" / "components" / "shell" / "nav-contract.json").read_text()
    )
    assert _nav_structure(render(fund())) == contract["nav"]


def test_the_nav_comes_from_the_shared_model():
    """The fund pages are generated HTML, so they carry their own copy of the nav.

    The operator renamed the sections on 2026-11-02 ("Builder, Ledger" → "Portfolio",
    "X-Ray") and again on 2026-11-03, when the redesign made `/` and `/x/` one
    workspace and added "How it works". A generated page is the easiest place for a
    rename to be missed: it is not a React component, so no shared nav renders it.

    Since 2026-11-17 the nav is not a hand-written list here at all: it is
    `web/nav.json`, which the React shell reads too. This test asserts the page
    against that file rather than against a second copy of the words, so a rename in
    the model reaches both renderers or fails here.
    """
    model = fund_pages.nav_model()
    page = render(fund())

    for group in model["groups"]:
        assert f'<p class="app-nav__label">{group["label"]}</p>' in page
        for item in group["items"]:
            assert f'href="{item["href"]}"' in page
            assert f'<span class="app-nav__text">{item["label"]}</span>' in page

    # Exactly one entry is current, and on a fund page it is Funds.
    assert page.count('aria-current="page"') == 1
    assert 'href="/funds/" aria-current="page"' in page

    # The words the operator retired stay retired.
    assert ">Builder<" not in page
    assert ">Ledger<" not in page
    assert ">X-Ray<" not in page


def test_the_page_offers_no_figure_a_fund_page_must_not_publish():
    """No returns, prices, yields, ratings, rankings or recommendations.

    Expense ratios are allowed since ADR-0030 (the operator's D1, 2026-11-24): the page shows the
    ratio each prospectus states, with its date, and still none of the rest.
    """
    for page in (
        render(fund(), countries=COUNTRIES),
        render(fund(fees=FEES_BLOCK), countries=COUNTRIES, fees_read=True),
    ):
        body = page.lower()
        for word in ("total return", "yield", "nav per share", "star rating",
                     "ranked", "we recommend", "should buy", "top pick", "price target"):
            assert word not in body, word


def test_same_issuer_links_are_relative_and_never_self_referential():
    page = fund_pages.render_page(
        fund(), issuer_funds=[("AVLV", "Avantis U.S. Large Cap Value ETF")]
    )
    more = panel(page, "More from EA Series Trust")
    assert '<a href="/f/AVLV/">Avantis U.S. Large Cap Value ETF</a>' in more
    # The canonical URL is the page's own address; what must not appear is a link to it.
    assert not hrefs(more, "/f/AVUV/")


def test_similar_funds_name_their_bucket_and_do_not_claim_to_advise():
    from pipeline.style import classify

    style = classify("Avantis U.S. Small Cap Value ETF")
    page = fund_pages.render_page(
        fund(),
        issuer_funds=[("ZZZZ", "Some Unrelated Fund")],
        style=style,
        similar=[("AVUV", "Avantis U.S. Small Cap Value ETF"),
                 ("IJS", "iShares S&P Small-Cap 600 Value ETF")],
    )
    similar = panel(page, "Similar U.S. small cap value funds")
    assert "The same style bucket, most-covered first." in flat(similar)
    assert "A bucket, not a recommendation." in flat(similar)
    assert '<a href="/f/IJS/">iShares S&amp;P Small-Cap 600 Value ETF</a>' in similar
    assert not hrefs(similar, "/f/AVUV/")
    # The issuer list is a different question, so both are shown.
    assert "More from" in page


def test_similar_links_are_capped_and_never_link_to_the_fund_itself():
    from pipeline.style import classify

    style = classify("Avantis U.S. Small Cap Value ETF")
    others = [(f"T{n:03d}", f"Fund {n}") for n in range(30)]
    page = fund_pages.render_page(
        fund(ticker="AVUV"),
        issuer_funds=[],
        style=style,
        similar=[("AVUV", "This Fund")] + others,
    )
    similar = panel(page, "Similar U.S. small cap value funds")
    assert len(hrefs(similar, "/f/")) == fund_pages.SIMILAR_FUND_LINKS
    assert not hrefs(similar, "/f/AVUV/")


def test_without_a_bucket_the_similar_panel_is_absent():
    page = fund_pages.render_page(
        fund(), issuer_funds=[("ZZZZ", "Some Unrelated Fund")], style=None, similar=[]
    )
    assert "More from" in page
    assert "Similar" not in page


def test_issuer_links_are_capped_too():
    funds = [(f"T{n:03d}", f"Fund {n}") for n in range(40)]
    page = fund_pages.render_page(fund(), issuer_funds=funds)
    more = panel(page, "More from EA Series Trust")
    assert len(hrefs(more, "/f/")) == fund_pages.SAME_ISSUER_LINKS


def test_every_class_the_page_uses_is_defined_in_the_stylesheet_it_ships():
    """The page cannot carry a second stylesheet, so a class it invents renders bare."""
    page = render(tiered(), countries=COUNTRIES)
    css = fund_pages.stylesheet()
    defined = set(re.findall(r"\.([A-Za-z][A-Za-z0-9_-]*)", css))
    used: set[str] = set()
    for attribute in re.findall(r'class="([^"]+)"', page):
        used.update(attribute.split())
    assert not used - defined, sorted(used - defined)
    # And the document rules this module adds are all in use, panels included.
    assert {"doc-grid", "doc-value", "doc-note"} <= used
    with_panels = render(
        fund(), issuer_funds=[("AVLV", "Avantis U.S. Large Cap Value ETF")]
    )
    assert "doc-links" in with_panels


def test_the_stylesheet_is_the_apps_stylesheet_verbatim():
    """One design system: the page copies globals.css rather than paraphrasing it."""
    globals_css = Path(__file__).resolve().parents[2] / "web" / "app" / "globals.css"
    source = globals_css.read_text()
    css = fund_pages.stylesheet()
    assert source in css
    assert css.startswith("/*")
    # The tokens the page leans on, all from the app's own file.
    for token in ("--tier-us:", "--tier-dm:", "--tier-em:", "--tier-none:",
                  "prefers-color-scheme: dark", "@font-face", ".tier-edge",
                  ".country-tag", ".bar__seg--unplaced", ".chip--partial"):
        assert token in css, token


def test_the_stylesheet_fails_rather_than_ships_a_missing_app_file(tmp_path: Path):
    with pytest.raises(SystemExit):
        fund_pages.stylesheet(tmp_path / "nope.css")


# --- Fees: the expense ratio each prospectus states ----------------------------

_FILING = "https://www.sec.gov/Archives/edgar/data/1/000119312526000001/x_htm.xml"


def _fee(total, net=None, waiver=None, basis="no-waiver-stated", **extra) -> dict:
    row = {
        "class_id": None, "total": total, "net": net, "waiver": waiver, "basis": basis,
        "prospectus_date": "2026-04-29", "filed_at": "2026-04-30", "form": "485BPOS",
        "source_url": _FILING,
    }
    row.update(extra)
    return row


FEES_BLOCK = {
    "classes": {
        "AVUV": _fee(0.0025),
        "AVUVX": _fee(0.0053, net=0.0028, waiver=-0.0025, basis="stated-net"),
    }
}


def fees_section(page: str) -> str:
    start = page.index('<section aria-labelledby="fees-heading"')
    return page[start : page.index("</section>", start)]


@pytest.mark.parametrize(
    "value, shown",
    [(0.0004, "0.04%"), (0.0014, "0.14%"), (0.0085, "0.85%"), (0.000945, "0.0945%"),
     (0.0123, "1.23%"), (0.0, "0.00%"), (0.01, "1.00%"), (0.0528, "5.28%")],
)
def test_a_fee_prints_two_decimals_and_more_only_where_the_filing_gives_them(value, shown):
    assert fund_pages.fee_pct(value) == shown


def test_a_page_of_a_release_without_fees_has_no_fees_section():
    page = render(fund(fees=FEES_BLOCK), countries=COUNTRIES)
    assert "fees-heading" not in page and ">Fees<" not in page
    assert "prospectus filings" not in page and "Source: SEC EDGAR (Form N-PORT)" in page


def test_a_stated_net_is_the_headline_and_the_gross_sits_in_before_waivers():
    section = fees_section(render(fund(fees=FEES_BLOCK), countries=COUNTRIES, fees_read=True))
    own, other = section.split("<tbody>")[1].split("</tr>")[0:2]
    assert ">AVUV</th>" in own and "0.25%" in own and "no fee waiver stated" in own
    assert ">AVUVX</th>" in other
    # FCTDX-shaped: 0.53% gross, 0.28% net — the net leads, the gross is "before waivers".
    assert "<strong>0.28%</strong>" in other and "net of fee waivers" in other
    assert '<td class="num">0.53%</td>' in other
    assert '<td class="num">—</td>' in own
    assert "Apr 29, 2026" in other
    assert f'<a href="{_FILING}" rel="nofollow noopener">485BPOS on SEC EDGAR</a>' in other
    assert "Source: SEC EDGAR (Form N-PORT and prospectus filings)" in render(
        fund(fees=FEES_BLOCK), fees_read=True
    )


def test_a_waiver_without_a_net_is_labelled_before_waivers_never_net():
    for basis, words in (
        ("waiver-without-net", "the filing states a waiver but no net figure"),
        ("waiver-unresolved", "the filing&#x27;s waiver could not be read"),
    ):
        block = {"classes": {"AVUV": _fee(0.0090, waiver=-0.0020, basis=basis)}}
        row = fees_section(render(fund(fees=block), fees_read=True))
        assert "<strong>0.90%</strong>" in row and words in row
        assert "net of fee waivers" not in row and "no fee waiver stated" not in row


def test_a_recoupment_prints_the_net_above_the_gross_as_stated():
    block = {"classes": {"AVUV": _fee(0.0123, net=0.0125, waiver=0.0002, basis="stated-net")}}
    row = fees_section(render(fund(fees=block), fees_read=True))
    assert "<strong>1.25%</strong>" in row and '<td class="num">1.23%</td>' in row
    assert "includes a recoupment of earlier waivers" in row and "net of fee waivers" not in row


def test_the_pages_own_class_leads_and_a_missing_own_class_is_said():
    block = {"classes": {"ZZZ": _fee(0.0009), "AAA": _fee(0.0011), "AVUV": _fee(0.0025)}}
    section = fees_section(render(fund(fees=block), fees_read=True))
    assert [m for m in re.findall(r'<th scope="row" class="mono">(\w+)</th>', section)] == ["AVUV", "AAA", "ZZZ"]
    assert "could be read for AVUV itself" not in section
    other = {"classes": {"AVUVX": _fee(0.0053, net=0.0028, waiver=-0.0025, basis="stated-net")}}
    assert "No expense ratio could be read for AVUV itself" in fees_section(
        render(fund(fees=other), fees_read=True)
    )


def test_a_prospectus_with_no_date_shows_the_filing_date_instead():
    block = {"classes": {"AVUV": _fee(0.0025, prospectus_date=None, filed_at="2026-01-26")}}
    assert "filed Jan 26, 2026" in fees_section(render(fund(fees=block), fees_read=True))


def test_a_fund_with_no_stated_fee_in_a_fee_reading_release_says_so_and_estimates_nothing():
    section = fees_section(render(fund(), fees_read=True))
    assert "No expense ratio is stated for this fund in this release" in section
    assert "We do not estimate one" in section and "read the fund" not in section
    assert "<table" not in section and "%" not in section


def test_every_value_that_reaches_a_fee_row_is_escaped():
    """Each of these was untested: dropping the escape on any one left the suite green."""
    block = {
        "classes": {
            "X<b>1": _fee(0.0025, source_url='https://www.sec.gov/a"b<c', form="485<BPOS",
                          prospectus_date="<i>Apr</i>"),
        }
    }
    page = render(fund(name="Fees <u>Fund</u>", fees=block), fees_read=True)
    section = fees_section(page)
    for raw in ("X<b>1", "b<c", "485<BPOS", "<i>Apr</i>", "<u>Fund</u>"):
        assert raw not in section, raw
    for escaped in ("X&lt;b&gt;1", "b&lt;c", "a&quot;b", "485&lt;BPOS", "&lt;i&gt;Apr&lt;/i&gt;",
                    "&lt;u&gt;Fund&lt;/u&gt;"):
        assert escaped in section, escaped
    # The own-class note names the page's ticker, which is escaped too.
    odd = render(fund(ticker="A<B", fees=block), fees_read=True)
    assert "A<B itself" not in fees_section(odd) and "A&lt;B itself" in fees_section(odd)


def test_only_a_sec_https_url_becomes_a_link():
    for url in ("http://www.sec.gov/x", "https://example.com/x", "javascript:alert(1)", None):
        block = {"classes": {"AVUV": _fee(0.0025, source_url=url)}}
        section = fees_section(render(fund(fees=block), fees_read=True))
        assert "<a href" not in section and "485BPOS" in section, url


def test_a_net_that_equals_the_total_is_not_called_net_of_a_waiver():
    block = {"classes": {"AVUV": _fee(0.0103, net=0.0103, waiver=-0.0004, basis="stated-net")}}
    row = fees_section(render(fund(fees=block), fees_read=True))
    assert "<strong>1.03%</strong>" in row and "net expense ratio, as stated" in row
    assert "net of fee waivers" not in row and '<td class="num">—</td>' in row


def test_a_row_with_no_number_is_left_out_not_a_crash():
    """The build refuses such a row and the validator rejects it; a hand-built document must not
    take the whole page generation down."""
    block = {"classes": {"AVUV": _fee(None), "AVUVX": _fee(0.0053, net=0.0028, waiver=-0.0025, basis="stated-net")}}
    section = fees_section(render(fund(fees=block), fees_read=True))
    assert ">AVUVX</th>" in section and ">AVUV</th>" not in section
    only_bad = fees_section(render(fund(fees={"classes": {"AVUV": _fee(None)}}), fees_read=True))
    assert "<table" not in only_bad and "No expense ratio is stated for this fund" in only_bad


def test_a_qualifier_cannot_widen_the_fee_column():
    """At 375 px a 352 px column pushed the number off-screen: the note wraps in its own box."""
    page = render(fund(fees=FEES_BLOCK), fees_read=True)
    assert '<span class="fee-note muted tiny">' in fees_section(page)
    css = fund_pages.CSS_RULES
    rule = css[css.index(".fee-note {") : css.index("}", css.index(".fee-note {"))]
    assert "min-width: 9rem" in rule and "max-width: 12rem" in rule and "white-space: normal" in rule and "display: block" in rule
    assert '.table tbody th[scope="row"]' in css


def _release(root: Path, documents: dict[str, dict]) -> Path:
    release = root / "release"
    (release / "funds").mkdir(parents=True)
    catalogue = {"as_of": "2026-11-16.1", "etf_classifier": "name_rule_v1",
                 "funds": {ticker: [d["name"], d["issuer"], 1, d["coverage_pct"]] for ticker, d in documents.items()}}
    (release / "catalogue.json").write_text(json.dumps(catalogue))
    for ticker, document in documents.items():
        (release / "funds" / f"{ticker}.json").write_bytes(artifact.canonical_bytes(document))
    return release


def test_a_release_that_carries_fees_gives_every_page_a_fees_section(tmp_path: Path):
    release = _release(tmp_path, {"AVUV": fund(fees=FEES_BLOCK), "AVLV": fund(ticker="AVLV")})
    out = tmp_path / "out"
    stats = fund_pages.build(release, out)
    assert stats["fees_read"] is True
    assert "AVUVX" in fees_section((out / "f" / "AVUV" / "index.html").read_text())
    # The fund with no stated fee says so, in a release that did read them.
    assert "No expense ratio is stated for this fund" in fees_section((out / "f" / "AVLV" / "index.html").read_text())


def test_an_older_release_builds_pages_with_no_fees_section(tmp_path: Path):
    release = _release(tmp_path, {"AVUV": fund(), "AVLV": fund(ticker="AVLV")})
    out = tmp_path / "out"
    stats = fund_pages.build(release, out)
    assert stats["fees_read"] is False
    assert "fees-heading" not in (out / "f" / "AVUV" / "index.html").read_text()


def test_a_partial_rebuild_decides_as_the_whole_release_does(tmp_path: Path):
    """Rebuilding only the fund with no fee must not read "the release has none"."""
    release = _release(tmp_path, {"AVUV": fund(fees=FEES_BLOCK), "AVLV": fund(ticker="AVLV")})
    out = tmp_path / "out"
    assert fund_pages.build(release, out, only={"AVLV"})["fees_read"] is True
    assert "No expense ratio is stated for this fund" in (out / "f" / "AVLV" / "index.html").read_text()


def test_a_company_named_fees_does_not_make_a_release_read_fees(tmp_path: Path):
    document = fund()
    document["holdings"][0]["name"] = '"fees": {"classes": {}}'
    release = _release(tmp_path, {"AVUV": document})
    assert fund_pages.release_reads_fees(release, ["AVUV"]) is False


# --- The build: one page per fund, deterministic, additive ---------------------


def test_constants_come_from_the_contracts_gates():
    assert fund_pages.FULL_COVERAGE == 70.0
    assert fund_pages.PARTIAL_COVERAGE == 60.0
    assert fund_pages.TOP_HOLDINGS > 0


def test_build_writes_one_page_per_catalogue_entry(tmp_path: Path):
    release = tmp_path / "release"
    (release / "funds").mkdir(parents=True)
    catalogue = {
        "as_of": "2026-10-30.5",
        "etf_classifier": "name_rule_v1",
        "funds": {
            "AVUV": ["Avantis U.S. Small Cap Value ETF", "EA Series Trust", 1, 97.7],
            "AVLV": ["Avantis U.S. Large Cap Value ETF", "EA Series Trust", 1, 99.7],
        },
    }
    (release / "catalogue.json").write_text(json.dumps(catalogue))
    for ticker, coverage in (("AVUV", 97.7), ("AVLV", 99.7)):
        (release / "funds" / f"{ticker}.json").write_text(
            json.dumps(fund(ticker=ticker, coverage_pct=coverage))
        )
    out = tmp_path / "out"
    stats = fund_pages.build(release, out)

    assert stats["pages"] == 2
    assert (out / "f" / "AVUV" / "index.html").exists()
    assert (out / "fund-page.css").exists()
    assert stats["bytes"] > 0 and stats["median_bytes"] > 0
    # Each page links sideways to its sibling, and to nothing that does not exist.
    page = (out / "f" / "AVUV" / "index.html").read_text()
    more = panel(page, "More from EA Series Trust")
    assert '<a href="/f/AVLV/">Avantis U.S. Large Cap Value ETF</a>' in more


def test_build_survives_a_ticker_with_no_fund_document(tmp_path: Path):
    release = tmp_path / "release"
    (release / "funds").mkdir(parents=True)
    (release / "catalogue.json").write_text(
        json.dumps({"as_of": "x", "funds": {"AVUV": ["n", "i", 1, 1.0], "GONE": ["n", "i", 1, 1.0]}})
    )
    (release / "funds" / "AVUV.json").write_text(json.dumps(fund()))
    stats = fund_pages.build(release, tmp_path / "out")
    assert stats["pages"] == 1
    assert stats["skipped"] == ["GONE"]


def test_build_reads_the_releases_country_map(tmp_path: Path):
    from tests.conftest import write_release

    release = write_release(
        tmp_path, [fund()], release_id="2026-10-30.5",
        countries={"c_0001045810": "US", "c_0000000002": "US"},
    )
    out = tmp_path / "out"
    stats = fund_pages.build(release, out)
    assert stats["countries"] == 2
    page = (out / "f" / "AVUV" / "index.html").read_text()
    assert 'data-country="US"' in page
    assert "<strong>Not traced.</strong>" not in page


def test_build_degrades_when_the_release_publishes_no_country_map(tmp_path: Path):
    from tests.conftest import write_release

    release = write_release(tmp_path, [fund()], release_id="2026-10-30.5")
    out = tmp_path / "out"
    stats = fund_pages.build(release, out)
    assert stats["countries"] == 0
    page = (out / "f" / "AVUV" / "index.html").read_text()
    assert "<strong>Not traced.</strong>" in page
    assert "data-tier" not in page


def test_the_release_contract_names_every_input_the_pages_read(tmp_path: Path):
    """`RELEASE_INPUTS` is what `pipeline.mirror` copies, so it must be the truth.

    The country map was read here for weeks while the mirror copied only the catalogue
    and the documents, and nothing failed: the pages simply said "Not traced" about
    geography. A declaration the mirror copies is only safe if a test holds it to the
    reads, which is what this does — each declared path is the file the page opens, and
    the one marked optional is optional in the page too.
    """
    from tests.conftest import write_release

    release = write_release(
        tmp_path, [fund()], release_id="2026-10-30.5", countries={"c_0001045810": "US"}
    )
    # The size table is optional by presence, so this release carries one; a release
    # built with --no-size-buckets simply has none, and that case is the last assertion.
    (release / "companies" / "sizes.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "kind": "sizes",
                "as_of": "2026-10-30.5",
                "price_basis": "nport_implied",
                "thresholds": {
                    "megacap": 200_000_000_000.0,
                    "largecap": 10_000_000_000.0,
                    "midcap": 2_000_000_000.0,
                    "smallcap": 300_000_000.0,
                    "microcap": 0.0,
                },
                "bands": ["mega", "large", "mid", "small", "micro"],
                "counts": {"companies": 1, "placed": 0, "frame": 0, "cover": 0},
                "band_counts": {"mega": 0, "large": 0, "mid": 0, "small": 0, "micro": 0},
                "caps": {},
            }
        ),
        encoding="utf-8",
    )
    assert fund_pages.CATALOGUE_FILE == "catalogue.json"
    assert fund_pages.FUNDS_FILE.format(ticker="AVUV") == "funds/AVUV.json"
    assert fund_pages.COUNTRIES_FILE == "companies/countries.json"
    assert fund_pages.SIZES_FILE == "companies/sizes.json"
    assert fund_pages.PENDING_FILE == "pending.json"
    # Absent by presence, like the size table: a release before the pending object has none.
    assert fund_pages.missing_release_inputs(release, ["AVUV"]) == {
        "required": [],
        "optional": ["pending.json"],
    }
    (release / fund_pages.PENDING_FILE).write_text(
        json.dumps({"kind": "pending_funds", "funds": {}}), encoding="utf-8"
    )
    assert fund_pages.missing_release_inputs(release, ["AVUV"]) == {"required": [], "optional": []}

    # The optional inputs are optional in the page: drop the country map and the page
    # still builds, saying "Not traced" rather than colouring a guess.
    (release / fund_pages.COUNTRIES_FILE).unlink()
    assert fund_pages.missing_release_inputs(release, ["AVUV"]) == {
        "required": [],
        "optional": ["companies/countries.json"],
    }
    out = tmp_path / "out"
    fund_pages.build(release, out)
    assert "<strong>Not traced.</strong>" in (out / "f" / "AVUV" / "index.html").read_text()

    # A required input that is absent is a page fewer, not a page that lies.
    (release / fund_pages.FUNDS_FILE.format(ticker="AVUV")).unlink()
    assert fund_pages.missing_release_inputs(release, ["AVUV"])["required"] == ["funds/AVUV.json"]


def test_a_broken_country_map_fails_the_build_rather_than_degrading(tmp_path: Path):
    from tests.conftest import write_release

    release = write_release(
        tmp_path, [fund()], release_id="2026-10-30.5", countries={"c_0001045810": "US"}
    )
    (release / "companies" / "countries.json").write_text("{not json")
    with pytest.raises(SystemExit):
        fund_pages.build(release, tmp_path / "out")


def test_build_is_deterministic(tmp_path: Path):
    """Same release, same bytes — including the stylesheet."""
    from tests.conftest import write_release

    release = write_release(
        tmp_path, [fund(), fund(ticker="AVLV")], release_id="2026-10-30.5",
        countries={"c_0001045810": "US"},
    )
    first, second = tmp_path / "first", tmp_path / "second"
    fund_pages.build(release, first)
    fund_pages.build(release, second)
    for path in sorted(first.rglob("*")):
        if path.is_file():
            assert (second / path.relative_to(first)).read_bytes() == path.read_bytes(), path


def test_the_release_id_comes_from_the_catalogue_not_the_directory_name(tmp_path: Path):
    """`deploy-site.yml` generates pages from a mirror directory called `live`.

    Reading `release_dir.name` printed "Release live" in the sidebar on production —
    found by looking at the deployed fund page, not by a test. The catalogue carries
    the release's own `as_of`, so that is what the page prints, and the directory name
    is only a fallback for a release directory with no catalogue.
    """
    from tests.conftest import write_release

    release = write_release(
        tmp_path, [fund()], release_id="2026-10-30.77", countries={"c_0001045810": "US"}
    )
    # Same bytes, a directory whose name is not a release id.
    mirror = tmp_path / "mirror-live"
    shutil.copytree(release, mirror)
    out = tmp_path / "out"
    fund_pages.build(mirror, out)
    page = (out / "f" / "AVUV" / "index.html").read_text()
    assert '<span class="app-sidebar__release-id">2026-10-30.77</span>' in page
    assert ">live<" not in page


def test_a_page_carries_the_release_it_was_built_from(tmp_path: Path):
    """The sidebar's footer names the release, and it is baked, not fetched.

    This reverses the rule this test used to hold ("a release identity in the page
    would rewrite 9,000 files on every release"). The operator's decision on
    2026-11-17 was to bake it: a fund page is regenerated with each release, so the
    value cannot go stale between a data change and a deploy, which is exactly why
    the React shell reads it at runtime instead.

    The cost is real and is recorded rather than hidden: on a release whose id
    changes, every generated page's bytes change, so the deploy re-uploads all 9,016
    documents instead of only the funds whose holdings moved. No workflow uses
    `build(only=…)` today, so nothing regresses yet — but wiring the incremental
    rebuild later would have to exclude the release id from the page.
    """
    from tests.conftest import write_release

    release = write_release(
        tmp_path, [fund()], release_id="2026-10-30.77",
        countries={"c_0001045810": "US"},
    )
    out = tmp_path / "out"
    fund_pages.build(release, out)
    page = (out / "f" / "AVUV" / "index.html").read_text()
    assert '<span class="app-sidebar__release-id">2026-10-30.77</span>' in page


# --- Sitemap, robots, and the indexable flag -----------------------------------


def test_sitemap_lists_every_page_and_nothing_invented():
    """The sitemap is the crawl surface, so it is exactly the published pages."""
    xml = fund_pages.sitemap_xml(["AVUV", "VTI"])
    assert xml.startswith('<?xml version="1.0" encoding="UTF-8"?>')
    assert xml.count("<url>") == len(fund_pages.APP_ROUTES) + 2
    assert "<loc>https://unpackfund.com/f/AVUV/</loc>" in xml
    assert "<loc>https://unpackfund.com/f/VTI/</loc>" in xml
    for route in fund_pages.APP_ROUTES:
        assert f"<loc>https://unpackfund.com{route}</loc>" in xml
    # No relative, invented or app-route-only URLs.
    assert "<loc>/" not in xml
    assert "/x/" not in xml


def test_robots_points_at_the_sitemap():
    robots = fund_pages.robots_txt()
    assert "User-agent: *" in robots
    assert "Allow: /" in robots
    assert "Sitemap: https://unpackfund.com/sitemap.xml" in robots


def test_the_indexable_flag_writes_all_three_parts_and_nothing_without_it(tmp_path: Path):
    from tests.conftest import write_release

    release = write_release(tmp_path, [fund()], release_id="2026-10-30.5")
    quiet = tmp_path / "quiet"
    stats = fund_pages.build(release, quiet)
    assert stats["sitemap"] is False and stats["robots"] is False
    assert not (quiet / "sitemap.xml").exists()
    assert not (quiet / "robots.txt").exists()
    assert (
        '<meta name="robots" content="noindex, follow">'
        in (quiet / "f/AVUV/index.html").read_text()
    )

    loud = tmp_path / "loud"
    stats = fund_pages.build(release, loud, indexable=True)
    assert stats["sitemap"] is True and stats["robots"] is True
    page = (loud / "f/AVUV/index.html").read_text()
    assert 'name="robots"' not in page
    assert (loud / "sitemap.xml").exists()
    assert (loud / "robots.txt").exists()


# --- Partial rebuilds: only the funds that changed -------------------------------
#
# Regenerating every page is a few seconds, so the reason to rebuild a subset is not
# the generator — it is the upload. The deploy ships `web/out` and Cloudflare skips
# assets whose bytes it already has, which only works while the untouched pages stay
# byte-identical. These tests pin that: a partial run writes the requested pages,
# leaves every other file alone, and a page is the same bytes whether it was written
# in a full run or a partial one.


def cli(argv: list[str]) -> int:
    """Run the CLI in-process; argparse reports usage errors by exiting."""
    try:
        return fund_pages.main(argv)
    except SystemExit as exit_code:  # argparse: 2 for a usage error, 0 for --help
        return exit_code.code if isinstance(exit_code.code, int) else 0


def write_fixture_release(root: Path, release_id: str, documents: list[dict]) -> Path:
    """A release the way `build.py` writes one: documents, manifest hashes, catalogue."""
    from tests.conftest import write_release

    return write_release(root, documents, release_id=release_id)


def two_fund_release(root: Path, release_id: str, **overrides) -> Path:
    """A two-fund release whose pages link sideways, so a page is not self-contained."""
    return write_fixture_release(
        root,
        release_id,
        [
            fund(ticker="AVUV", coverage_pct=97.7),
            fund(ticker="AVLV", coverage_pct=overrides.get("AVLV", 99.7)),
        ],
    )


def test_only_writes_exactly_the_requested_pages_and_deletes_nothing(tmp_path: Path):
    release = tmp_path / "release"
    (release / "funds").mkdir(parents=True)
    (release / "catalogue.json").write_text(
        json.dumps(
            {
                "as_of": "2026-10-30.5",
                "funds": {
                    "AVUV": ["Avantis U.S. Small Cap Value ETF", "EA Series Trust", 1, 97.7],
                    "AVLV": ["Avantis U.S. Large Cap Value ETF", "EA Series Trust", 1, 99.7],
                    "IJS": ["iShares S&P Small-Cap 600 Value ETF", "iSHARES TRUST", 1, 99.0],
                },
            }
        )
    )
    for ticker in ("AVUV", "AVLV", "IJS"):
        (release / "funds" / f"{ticker}.json").write_text(json.dumps(fund(ticker=ticker)))

    out = tmp_path / "out"
    fund_pages.build(release, out)  # the full build that shipped first
    untouched = out / "f" / "AVLV" / "index.html"
    untouched.write_text("sentinel — a page this run must not rewrite\n")
    shell = out / "funds" / "index.html"
    shell.parent.mkdir(parents=True, exist_ok=True)
    shell.write_text("<html>the directory page, built by Next</html>")

    stats = fund_pages.build(release, out, only={"avuv"})

    assert stats["pages"] == 1
    assert stats["requested"] == 1
    assert stats["unmatched"] == []
    assert stats["untouched"] == 2
    assert "<title>AVUV holdings" in (out / "f" / "AVUV" / "index.html").read_text()
    assert untouched.read_text().startswith("sentinel")
    assert (out / "f" / "IJS" / "index.html").exists()
    assert shell.read_text() == "<html>the directory page, built by Next</html>"
    # The stylesheet is always rewritten; it is shared by every page.
    assert (out / "fund-page.css").exists()


def test_a_partial_rebuild_leaves_every_page_as_a_full_rebuild_would(tmp_path: Path):
    """The untouched pages must stay byte-identical, or the upload carries them again."""
    import shutil

    release = two_fund_release(tmp_path, "2026-10-30.5")
    full = tmp_path / "full"
    fund_pages.build(release, full)
    partial = tmp_path / "partial"
    shutil.copytree(full, partial)  # what an existing `web/out` looks like

    stats = fund_pages.build(release, partial, only={"AVUV", "AVLV"})

    assert stats["pages"] == 2
    assert stats["untouched"] == 0
    for path in full.rglob("*"):
        if path.is_file():
            assert (partial / path.relative_to(full)).read_bytes() == path.read_bytes(), path


def test_a_partial_rebuild_writes_the_same_bytes_as_a_full_one(tmp_path: Path):
    """A page's bytes are a function of its fund, not of the run that wrote it."""
    import shutil

    release = two_fund_release(tmp_path, "2026-10-30.5")
    full = tmp_path / "full"
    fund_pages.build(release, full)
    partial = tmp_path / "partial"
    shutil.copytree(full, partial)
    (partial / "f" / "AVUV" / "index.html").unlink()

    fund_pages.build(release, partial, only={"AVUV"})

    assert (partial / "f/AVUV/index.html").read_bytes() == (
        full / "f/AVUV/index.html"
    ).read_bytes()


def test_only_ignores_a_ticker_this_release_does_not_publish(tmp_path: Path):
    release = two_fund_release(tmp_path, "2026-10-30.5")
    stats = fund_pages.build(release, tmp_path / "out", only={"AVUV", "NOPE"})
    assert stats["pages"] == 1
    assert stats["requested"] == 2
    assert stats["unmatched"] == ["NOPE"]
    assert not (tmp_path / "out" / "f" / "NOPE").exists()


def test_changed_tickers_reports_new_and_byte_different_funds(tmp_path: Path):
    parent = write_fixture_release(
        tmp_path, "2026-10-30.4", [fund(ticker="AVUV"), fund(ticker="AVLV")]
    )
    release = write_fixture_release(
        tmp_path,
        "2026-10-30.5",
        [
            fund(ticker="AVUV"),  # identical bytes
            fund(ticker="AVLV", coverage_pct=91.1),  # same fund, different document
            fund(ticker="IJS"),  # new
        ],
    )

    assert fund_pages.changed_tickers(release, parent) == {"AVLV", "IJS"}


def test_changed_tickers_is_empty_for_an_identical_release(tmp_path: Path):
    """Two releases of the same documents differ as releases, not as fund pages."""
    documents = [fund(ticker="AVUV"), fund(ticker="AVLV")]
    a = write_fixture_release(tmp_path, "a", documents)
    b = write_fixture_release(tmp_path, "b", documents)

    assert fund_pages.changed_tickers(b, a) == set()


def test_changed_tickers_hashes_the_documents_when_a_release_has_no_manifest(tmp_path: Path):
    """A release copied without its manifest still diffs: the bytes say what changed."""
    documents = [fund(ticker="AVUV")]
    parent = write_fixture_release(tmp_path, "parent", documents)
    release = write_fixture_release(
        tmp_path, "child", [fund(ticker="AVUV"), fund(ticker="AVLV")]
    )

    assert fund_pages.changed_tickers(release, parent) == {"AVLV"}
    (release / "manifest.json").unlink()
    (parent / "manifest.json").unlink()
    assert fund_pages.changed_tickers(release, parent) == {"AVLV"}


def test_changed_tickers_compares_the_manifest_hashes_not_whole_releases(tmp_path: Path):
    """The parent's manifest alone is enough — a stubbed parent need not keep bytes."""
    parent = write_fixture_release(
        tmp_path, "2026-10-30.4", [fund(ticker="AVUV"), fund(ticker="AVLV")]
    )
    release = write_fixture_release(
        tmp_path,
        "2026-10-30.5",
        [fund(ticker="AVUV"), fund(ticker="AVLV", coverage_pct=91.1), fund(ticker="IJS")],
    )
    for path in (parent / "funds").glob("*.json"):
        path.unlink()  # what `pipeline.retention` leaves behind in a quarterly stub

    assert fund_pages.changed_tickers(release, parent) == {"AVLV", "IJS"}


def test_only_file_parsing_ignores_comments_blanks_and_normalises_case(tmp_path: Path):
    listing = tmp_path / "only.txt"
    listing.write_text(
        "# funds the desk checked today\n"
        "\n"
        "avuv\n"
        "  AVLV  # sibling share class\n"
        "#IJS is a different bucket, not tonight\n"
        "IJS\n"
    )

    assert fund_pages.read_only_file(listing) == {"AVUV", "AVLV", "IJS"}


def test_the_cli_rebuilds_the_tickers_in_only_file(tmp_path: Path, capsys):
    release = two_fund_release(tmp_path, "2026-10-30.5")
    listing = tmp_path / "only.txt"
    listing.write_text("# touched today\navuv\n")
    out = tmp_path / "out"
    fund_pages.build(release, out)
    stale = out / "f" / "AVLV" / "index.html"
    stale.write_text("sentinel\n")

    code = cli(["--release", str(release), "--out", str(out), "--only-file", str(listing)])

    assert code == 0
    assert "partial rebuild: 1 page(s) written, 1 left untouched" in capsys.readouterr().out
    assert "AVUV holdings" in (out / "f" / "AVUV" / "index.html").read_text()
    assert stale.read_text() == "sentinel\n"


def test_the_cli_rebuilds_only_the_funds_changed_since_the_parent(tmp_path: Path):
    parent = two_fund_release(tmp_path, "2026-10-30.4")
    release = write_fixture_release(
        tmp_path,
        "2026-10-30.5",
        [
            fund(ticker="AVUV", coverage_pct=97.7),
            fund(ticker="AVLV", coverage_pct=91.1),
            fund(ticker="IJS"),
        ],
    )
    out = tmp_path / "out"
    fund_pages.build(parent, out)  # the site as it stands before the refresh
    stale_avuv = (out / "f" / "AVUV" / "index.html").read_bytes()

    code = cli(
        ["--release", str(release), "--out", str(out), "--changed-from", str(parent)]
    )

    assert code == 0
    # AVUV's document is unchanged, so its page was not rewritten; AVLV changed and
    # IJS is new, so both exist with the new release's numbers.
    assert (out / "f" / "AVUV" / "index.html").read_bytes() == stale_avuv
    assert "91.1%" in (out / "f" / "AVLV" / "index.html").read_text()
    assert (out / "f" / "IJS" / "index.html").exists()


def test_only_file_and_changed_from_cannot_be_combined(tmp_path: Path):
    parent = two_fund_release(tmp_path, "2026-10-30.4")
    listing = tmp_path / "only.txt"
    listing.write_text("AVUV\n")

    code = cli(
        [
            "--release",
            str(parent),
            "--out",
            str(tmp_path / "out"),
            "--changed-from",
            str(parent),
            "--only-file",
            str(listing),
        ]
    )

    assert code == 2


def test_changed_from_without_a_release_is_a_usage_error(tmp_path: Path):
    parent = two_fund_release(tmp_path, "2026-10-30.4")
    assert cli(["--out", str(tmp_path / "out"), "--changed-from", str(parent)]) == 2


def test_changed_from_pointing_at_no_release_is_a_usage_error(tmp_path: Path):
    release = two_fund_release(tmp_path, "2026-10-30.5")
    code = cli(
        [
            "--release",
            str(release),
            "--out",
            str(tmp_path / "out"),
            "--changed-from",
            str(tmp_path / "not-a-release"),
        ]
    )
    assert code == 2


def test_a_partial_rebuild_with_nothing_to_do_warns_and_exits_zero(tmp_path: Path, capsys):
    """A quiet day is not a failure; a full run that writes nothing still is."""
    documents = [fund(ticker="AVUV"), fund(ticker="AVLV")]
    parent = write_fixture_release(tmp_path, "2026-10-30.4", documents)
    release = write_fixture_release(tmp_path, "2026-10-30.5", documents)
    out = tmp_path / "out"

    code = cli(
        ["--release", str(release), "--out", str(out), "--changed-from", str(parent)]
    )

    assert code == 0
    stderr = capsys.readouterr().err
    assert "no pages written" in stderr
    assert "nothing to rebuild" in stderr
    # The stylesheet is still refreshed, and no page was invented.
    assert (out / "fund-page.css").exists()
    assert not (out / "f").exists()


def test_a_full_rebuild_that_wrote_nothing_still_exits_nonzero(tmp_path: Path, capsys):
    """The existing behaviour of a broken `--release` path must not soften."""
    release = tmp_path / "release"
    release.mkdir()
    (release / "catalogue.json").write_text(
        json.dumps({"as_of": "x", "funds": {"GONE": ["n", "i", 1, 1.0]}})
    )
    assert cli(["--release", str(release), "--out", str(tmp_path / "out")]) == 1
    assert "no pages written" in capsys.readouterr().err


def test_the_cli_reports_the_coverage_bands_and_the_country_map(tmp_path: Path, capsys):
    from tests.conftest import write_release

    release = write_release(
        tmp_path,
        [fund(ticker="AVUV", coverage_pct=97.7),
         fund(ticker="AVLV", coverage_pct=64.2),
         fund(ticker="LOWC", coverage_pct=12.8, metrics=None)],
        release_id="2026-10-30.5",
        countries={"c_0001045810": "US"},
    )
    assert cli(["--release", str(release), "--out", str(tmp_path / "out")]) == 0
    output = capsys.readouterr()
    assert "coverage bands: 1 full, 1 partial, 1 not covered" in output.out
    assert "country map: 1 companies placed by the release" in output.out


def test_the_cli_warns_when_the_release_publishes_no_country_map(tmp_path: Path, capsys):
    release = two_fund_release(tmp_path, "2026-10-30.5")
    assert cli(["--release", str(release), "--out", str(tmp_path / "out")]) == 0
    assert "country map: none in this release" in capsys.readouterr().err


def test_the_cli_limits_a_full_rebuild(tmp_path: Path, capsys):
    release = two_fund_release(tmp_path, "2026-10-30.5")
    assert cli(["--release", str(release), "--out", str(tmp_path / "out"),
                "--limit", "1"]) == 0
    assert "1 fund page(s) of 2 in the catalogue" in capsys.readouterr().out


def test_the_design_system_is_found_when_the_package_is_not_in_the_checkout(tmp_path):
    """The installed layout that failed the 2026-11-03 production deploy.

    `pip install ./pipeline` puts this package in site-packages, so `parents[2]` is the
    Python installation's `lib` directory and `web/app/globals.css` does not exist under
    it. The generator then refused to write anything and the deploy stopped — correctly,
    because a fund page with no stylesheet is not a page, but the lookup was the bug. The
    repository is found by its marker file from the working directory instead.
    """
    checkout = tmp_path / "unpackfund"
    (checkout / "web" / "app").mkdir(parents=True)
    (checkout / "web" / "app" / "globals.css").write_text(":root { --paper: #fff; }\n")
    (checkout / "pnpm-workspace.yaml").write_text("packages:\n  - web\n")
    installed = tmp_path / "lib" / "python3.13" / "pipeline" / "paths.py"
    installed.parent.mkdir(parents=True)
    installed.write_text("")

    # In the deploy the working directory *is* the checkout; only the package moved.
    found = paths.find_repo_root(installed, cwd=checkout)

    assert found == checkout.resolve()


def test_the_repository_root_is_the_one_with_the_app_in_it():
    """And the real tree resolves, so the test above is not passing on a fiction."""
    root = paths.find_repo_root()

    assert (root / "web" / "app" / "globals.css").is_file()
    assert (root / "pnpm-workspace.yaml").is_file()


# --- pending funds: registered, no N-PORT yet ------------------------------------------

PENDING_MN = {
    "series_id": "S000108244",
    "name": "Corgi MANGOS ETF",
    "registrant": "Corgi ETF Trust I",
    "symbol_source": "sec_ticker_file:company_tickers_mf",
    "first_prospectus_filed": "2026-09-29",
    "latest_prospectus": {
        "form": "497",
        "filed_at": "2026-10-23",
        "accession": "0002078265-26-000459",
        "source_url": "https://www.sec.gov/Archives/edgar/data/2078265/000207826526000459/",
    },
    "fiscal_year_end": "1231",
    "first_report": {
        "earliest_period_end": "2026-09-30",
        "earliest_due_by": "2026-11-29",
        "latest_due_by": "2027-03-01",
    },
}


def _write_pending(release: Path, funds: dict) -> None:
    (release / fund_pages.PENDING_FILE).write_text(
        json.dumps({"schema_version": 1, "kind": "pending_funds", "funds": funds}),
        encoding="utf-8",
    )


def test_a_pending_fund_gets_a_page_that_says_what_the_filings_state_and_no_more(tmp_path: Path):
    from tests.conftest import write_release

    release = write_release(tmp_path, [fund()], release_id="2026-11-19.1")
    _write_pending(release, {"MN": PENDING_MN})
    out = tmp_path / "out"
    summary = fund_pages.build(release, out, indexable=True)
    page = (out / "f" / "MN" / "index.html").read_text()

    assert summary["pending_pages"] == 1 and summary["pages"] == 1
    assert "Corgi MANGOS ETF" in page and "S000108244" in page
    # The dates are the 60-day rule's, printed in the site's long form.
    assert "Nov 29, 2026" in page and "Mar 1, 2027" in page
    assert "does not say that MN is trading" in page
    # Nothing a filing has not stated: no weights table, no look-through action.
    assert "Largest holdings" not in page and "Look through this fund" not in page
    # A placeholder is never indexed, even when the site is: thin pages rank worse than none.
    assert '<meta name="robots" content="noindex, follow">' in page
    # And it is not advertised: the sitemap lists published funds only.
    assert "/f/MN/" not in (out / "sitemap.xml").read_text()


def test_a_published_ticker_beats_a_stale_pending_row(tmp_path: Path):
    from tests.conftest import write_release

    release = write_release(tmp_path, [fund()], release_id="2026-11-19.1")
    _write_pending(release, {"AVUV": {**PENDING_MN, "name": "Stale Pending Row"}})
    out = tmp_path / "out"
    summary = fund_pages.build(release, out)
    assert summary["pending_pages"] == 0
    assert "Stale Pending Row" not in (out / "f" / "AVUV" / "index.html").read_text()


def test_a_pending_document_of_another_kind_is_ignored(tmp_path: Path):
    from tests.conftest import write_release

    release = write_release(tmp_path, [fund()], release_id="2026-11-19.1")
    (release / fund_pages.PENDING_FILE).write_text(
        json.dumps({"kind": "something_else", "funds": {"MN": PENDING_MN}}), encoding="utf-8"
    )
    assert fund_pages.load_pending(release) == {}


def test_a_pending_ticker_that_is_not_a_path_segment_is_dropped(tmp_path: Path):
    from tests.conftest import write_release

    release = write_release(tmp_path, [fund()], release_id="2026-11-19.1")
    _write_pending(release, {"../evil": PENDING_MN, "MN": PENDING_MN})
    assert list(fund_pages.load_pending(release)) == ["MN"]
