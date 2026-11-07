"""The size block on a fund page: the computed bar, and the honest callout.

The page must not draw a five-band bar for a fund it can see a quarter of, and it must
not present an inferred mandate as a computed split. These tests pin both states, the
tag that distinguishes them for a machine as well as a reader, and the coverage note that
has to be present whenever weight is missing.
"""

from __future__ import annotations

import re

import pytest

from pipeline import fund_pages


def cap(band: str, usd: int = 1_000_000_000, basis: str = "frame") -> dict:
    return {
        "usd": usd,
        "shares": 1_000_000,
        "share_date": "2026-07-17",
        "price": 10.0,
        "report_date": "2026-06-30",
        "basis": basis,
        "band": band,
    }


def table(caps: dict[str, dict]) -> dict:
    return {
        "schema_version": 1,
        "bands": ["mega", "large", "mid", "small", "micro"],
        "caps": caps,
        "counts": {"placed": len(caps)},
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
        # 90 of 100 in three sized companies, 8 in a priced company with no share
        # count, 2 in cash — so the bar has every segment it can draw.
        "holdings": holdings
        or [
            {"company_id": "c_0000000001", "name": "Mega Co", "asset_cat": "equity",
             "weight_bp": 5_000},
            {"company_id": "c_0000000002", "name": "Large Co", "asset_cat": "equity",
             "weight_bp": 3_000},
            {"company_id": "c_0000000003", "name": "Small Co", "asset_cat": "equity",
             "weight_bp": 1_000},
            {"company_id": "c_0000000009", "name": "Unsized Co", "asset_cat": "equity",
             "weight_bp": 800},
            {"company_id": None, "name": "Cash sweep", "asset_cat": "cash",
             "weight_bp": 200},
        ],
        "metrics": {"hhi": 0.0123, "effective_n": 81.3, "top10_pct": 22.11},
    }


def render(document: dict, size_table: dict | None) -> str:
    return fund_pages.render_page(
        document, issuer_funds=[], size_table=size_table
    )


def section(page: str) -> str:
    start = page.index('<section aria-labelledby="size-heading"')
    return page[start : page.index("</section>", start) + len("</section>")]


def text(markup: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", markup)).strip()


SIZED = table(
    {
        "c_0000000001": cap("mega"),
        "c_0000000002": cap("large"),
        "c_0000000003": cap("small"),
    }
)


def test_no_section_when_the_release_publishes_no_size_table():
    assert 'aria-labelledby="size-heading"' not in render(fund(), None)
    assert "Company size" not in render(fund(), {})


def test_a_well_covered_fund_gets_the_computed_bar():
    markup = section(render(fund(), SIZED))
    assert 'data-size-basis="computed"' in markup
    # Five bands, in draw order, each with its share of the fund.
    assert "Mega" in text(markup) and "Small" in text(markup)
    assert "50.00%" in text(markup)  # Mega Co: 5000bp of 10,000bp gross
    assert "30.00%" in text(markup)  # Large Co
    assert "10.00%" in text(markup)  # Small Co
    assert "8.00%" in text(markup)  # Unsized Co: priced, no share count
    assert "2.00%" in text(markup)  # cash
    # The bar's denominator is the whole fund, so the gap is a drawn segment too.
    assert "Not placed" in text(markup)
    assert "Not equity" in text(markup)
    # Every band is one fill: the band is printed, never carried by a colour.
    assert markup.count('class="bar__seg bar__seg--size"') == 3
    assert "Inferred" not in text(markup)


def test_the_computed_bar_prints_its_own_thresholds_and_dates():
    body = text(section(render(fund(), SIZED)))
    assert "USD 200bn and over" in body
    assert "mega is USD 200bn and over" in body
    # The contract: a cap is published with the date of the share count behind it.
    assert "date of the share count" in body
    assert "reporting period 30 June 2026" not in body  # the page's own note, not this one


def test_a_company_with_no_cap_is_counted_in_the_gap_not_guessed():
    markup = section(render(fund(), SIZED))
    body = text(markup)
    # 8% of the fund is priced but unsized; it is drawn and named as not placed and no
    # band is ever inferred for one company.
    assert "Not placed" in body
    assert "8.00%" in body
    assert "Unsized Co" not in body


def test_a_quarter_covered_international_fund_gets_the_callout_not_a_bar():
    holdings = [
        {"company_id": "c_0000000001", "name": "Mega Co", "asset_cat": "equity",
         "weight_bp": 1_000},
        {"company_id": "l_5493000J7GF2VJYQ8F684", "name": "Nestle SA",
         "asset_cat": "equity", "weight_bp": 6_000},
        {"company_id": None, "name": "Some Holding", "asset_cat": "equity",
         "weight_bp": 1_000},
        {"company_id": "c_0000000009", "name": "No Share Co", "asset_cat": "equity",
         "weight_bp": 1_500},
        {"company_id": None, "name": "Cash", "asset_cat": "cash", "weight_bp": 500},
    ]
    # placed 1,000bp of 9,500bp equity = 10.5%, comfortably under the gate.
    markup = section(
        render(fund(name="iShares MSCI EAFE ETF", holdings=holdings), SIZED)
    )
    body = text(markup)
    assert 'data-size-basis="inferred"' in markup
    assert 'data-size-mandate="large_mid"' in markup
    assert "No computed size split for this fund" in body
    assert "Inferred" in body
    assert "large- and mid-cap mandate" in body
    assert 'class="bar bar--tall"' not in markup  # no bar under 80% coverage
    # The missing-coverage note names each reason, as a share of the *equity* weight the
    # sentence says it is the rest of — so the three reasons add up to the gap the same
    # paragraph states. Divided by gross they printed 60.0 + 10.0 + 15.0 = 85.0 against a
    # stated 89.5% gap (equity 9,500bp of 10,000bp gross), which is what the live IEFA page
    # said on 2026-11-07 before this assertion existed.
    assert "63.2% is in companies that file no US share count" in body  # 6000/9500
    assert "10.5% is in positions this release cannot identify" in body  # 1000/9500
    assert "15.8% is in companies whose US filings carry no share count" in body  # 1500/9500
    assert abs((63.2 + 10.5 + 15.8) - (100.0 - 10.5)) < 0.2


def test_a_quarter_covered_fund_with_no_mandate_is_tagged_callout_only():
    holdings = [
        {"company_id": "c_0000000001", "name": "Mega Co", "asset_cat": "equity",
         "weight_bp": 1_000},
        {"company_id": "l_5493000J7GF2VJYQ8F684", "name": "Nestle SA",
         "asset_cat": "equity", "weight_bp": 9_000},
    ]
    markup = section(render(fund(name="Some Multi-Asset Fund", holdings=holdings), SIZED))
    assert 'data-size-basis="callout"' in markup
    assert "Inferred" not in text(markup)
    assert "No computed size split for this fund" in text(markup)


def test_the_inferred_panel_says_it_is_not_a_computed_split():
    holdings = [
        {"company_id": "c_0000000001", "name": "Mega Co", "asset_cat": "equity",
         "weight_bp": 1_000},
        {"company_id": "l_5493000J7GF2VJYQ8F684", "name": "Nestle SA",
         "asset_cat": "equity", "weight_bp": 9_000},
    ]
    body = text(
        section(
            render(
                fund(
                    name="Vanguard Total International Stock Index Fund",
                    holdings=holdings,
                ),
                SIZED,
            )
        )
    )
    assert "not a computed split of its holdings" in body
    assert "10th to 90th percentile" in body
    assert "nothing is estimated to fill it" in body


def test_a_fund_at_the_eighty_percent_line_gets_the_bar():
    # 79% placed is a callout, 80% is a bar: the gate is a published number, so the
    # boundary is tested rather than assumed.
    holdings = [
        {"company_id": "c_0000000001", "name": "Mega Co", "asset_cat": "equity",
         "weight_bp": 8_000},
        {"company_id": "c_0000000009", "name": "Unsized Co", "asset_cat": "equity",
         "weight_bp": 2_000},
    ]
    assert 'data-size-basis="computed"' in section(render(fund(holdings=holdings), SIZED))
    holdings[0]["weight_bp"] = 7_900
    holdings[1]["weight_bp"] = 2_100  # 79%
    assert 'data-size-basis="callout"' in section(
        render(fund(name="Some Multi-Asset Fund", holdings=holdings), SIZED)
    )


def test_the_section_is_deterministic():
    document = fund()
    assert section(render(document, SIZED)) == section(render(document, SIZED))
