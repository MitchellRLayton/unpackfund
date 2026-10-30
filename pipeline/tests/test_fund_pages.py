"""The fund page: a document, not a route.

The page has to carry the same numbers as the ledger and state its own limits. These
tests pin the four things that would make it lie: a metric shown for a fund we cannot
see most of, an escaped name, an identifier we must not publish, and a link into a
page that does not exist.
"""

from __future__ import annotations

import json
from pathlib import Path

from pipeline import fund_pages


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


def render(document: dict, **kwargs) -> str:
    return fund_pages.render_page(document, issuer_funds=[], **kwargs)


def test_page_states_the_filing_its_dates_and_its_source():
    page = render(fund())
    assert "<title>AVUV holdings" in page
    assert "Holdings as of <strong>2026-05-31</strong>, filed 2026-07-29" in page
    assert "59 days later" in page
    # The source line links the fund's own filing: naming the form alone left a reader
    # thinking a fund with foreign holdings was not an SEC filer at all.
    assert 'href="https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml"' in page
    assert "N-PORT filing on SEC EDGAR" in page
    assert "https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml" in page


def test_coverage_is_quoted_and_the_metrics_are_shown_when_it_is_full():
    page = render(fund())
    assert "97.7% of weight" in page
    assert "Same-size companies" in page
    assert "81.3" in page
    assert "how many equal-sized companies would be" in page
    assert "Concentration figures are withheld" not in page


def test_a_low_coverage_fund_gets_no_concentration_numbers():
    page = render(fund(coverage_pct=12.8))
    assert "not covered" in page
    assert "Concentration figures are withheld" in page
    # ...and says why coverage is low, and whose limit it is.
    assert "outside the U.S." in page
    assert "the gap is in" in page
    # The metric values themselves must be absent, not merely unlabelled.
    assert "81.3" not in page
    assert "0.0123" not in page


def test_the_partial_band_says_partial_and_still_shows_the_numbers():
    page = render(fund(coverage_pct=64.2))
    assert "partial — 64.2% of weight" in page
    assert "Same-size companies" in page


def test_an_unmapped_holding_is_listed_but_not_linked():
    page = render(fund())
    assert "Samsung Electronics Co Ltd" in page
    assert '<span class="tag">unmapped</span>' in page
    assert "not mapped to an issuer" in page


def test_mapped_holdings_link_to_the_company_page():
    page = render(fund())
    assert 'href="/c/#c_0001045810"' in page


def test_names_are_escaped_so_a_fund_cannot_inject_markup():
    page = render(fund(name='AT&T "Growth" <script>alert(1)</script>'))
    assert "<script>alert(1)</script>" not in page
    assert "&lt;script&gt;" in page
    assert "AT&amp;T" in page


def test_a_non_equity_row_is_labelled_beside_its_name_too():
    """The type column is hidden on a phone, so the label must travel with the name."""
    page = render(fund())
    assert 'Cash sweep</a> <span class="tag tag--plain">cash</span>' in page
    # An equity row gets no such tag.
    assert '>NVIDIA Corp</a> <span class="tag tag--plain">' not in page


def test_no_identifier_we_may_not_publish_appears():
    """CUSIP/ISIN never reach a page — the artifact does not carry them, and nor does this."""
    page = render(fund())
    assert "cusip" not in page.lower()
    assert "isin" not in page.lower()


def test_same_issuer_links_are_relative_and_never_self_referential():
    page = fund_pages.render_page(
        fund(), issuer_funds=[("AVLV", "Avantis U.S. Large Cap Value ETF")]
    )
    assert '<a href="/f/AVLV/">AVLV</a>' in page
    # The canonical URL is the page's own address; what must not appear is a link to it.
    assert '<li><a href="/f/AVUV/">' not in page


def test_the_fund_offers_a_prefilled_ledger_link_it_built_the_apps_way():
    import base64

    link = fund_pages.ledger_link("AVUV")
    assert link is not None and link.startswith("/x/#v1.")
    payload = base64.urlsafe_b64decode(link.split("v1.", 1)[1] + "==").decode()
    assert payload == '[["AVUV",10000]]'
    assert 'See all 3 holdings in the look-through ledger' in render(fund())


def test_a_ticker_the_ledger_would_refuse_gets_no_prefill():
    """The app's fragment grammar is the gate: a 100% link must decode, not fall back."""
    assert fund_pages.ledger_link("BRK.B") is not None
    assert fund_pages.ledger_link("avuv") is None
    assert fund_pages.ledger_link("TOO-LONG-TICKER") is None
    page = render(fund(ticker="avuv", name="lower case ticker"))
    assert 'href="/x/#v1.' not in page
    assert '<a href="/x/">Look through a portfolio</a>' in page


def test_a_fund_page_is_a_single_document_with_its_css_linked():
    page = render(fund())
    assert page.startswith("<!doctype html>")
    assert '<link rel="stylesheet" href="/fund-page.css">' in page
    assert "<script" not in page.replace("&lt;script&gt;", "")
    assert "noindex" in page
    assert "noindex" not in render(fund(), indexable=True)


def test_constants_come_from_the_contracts_gates():
    assert fund_pages.FULL_COVERAGE == 70.0
    assert fund_pages.PARTIAL_COVERAGE == 60.0


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
    # Each page links sideways to its sibling, and to nothing that does not exist.
    page = (out / "f" / "AVUV" / "index.html").read_text()
    assert '<a href="/f/AVLV/">AVLV</a>' in page


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


def test_the_stylesheet_carries_the_apps_palette():
    """One palette: the tokens are read from globals.css, never copied by hand."""
    css = fund_pages.stylesheet()
    assert "--accent:" in css
    assert "prefers-color-scheme: dark" in css
    assert ".site-header" in css

def test_similar_funds_replace_the_issuer_list_and_name_their_bucket():
    """Same style box, not same trust: the heading says what the funds have in common."""
    from pipeline.style import classify

    style = classify("Avantis U.S. Small Cap Value ETF")
    page = fund_pages.render_page(
        fund(),
        issuer_funds=[("ZZZZ", "Some Unrelated Fund")],
        style=style,
        similar=[("AVUV", "Avantis U.S. Small Cap Value ETF"), ("IJS", "iShares S&P Small-Cap 600 Value ETF")],
    )
    assert "Similar U.S. small cap value funds" in page
    # The bucket wins over the issuer list; a reader asked for comparable funds.
    assert "More from" not in page
    assert '<a href="/f/IJS/">IJS</a>' in page
    # The heading claims a grouping, so the page says how it was made.
    assert "Names Rule" in page


def test_without_a_bucket_the_issuer_list_still_shows():
    page = fund_pages.render_page(
        fund(),
        issuer_funds=[("ZZZZ", "Some Unrelated Fund")],
        style=None,
        similar=[],
    )
    assert "More from" in page
    assert "Similar" not in page


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
    listed = page.count('<li><a href="/f/')
    assert listed == fund_pages.SIMILAR_FUND_LINKS
    assert '<li><a href="/f/AVUV/">' not in page


def test_build_groups_funds_by_style_not_by_issuer(tmp_path: Path):
    release = tmp_path / "release"
    (release / "funds").mkdir(parents=True)
    catalogue = {
        "as_of": "2026-10-30.5",
        "etf_classifier": "name_rule_v1",
        "funds": {
            # Same bucket, two different trusts.
            "AVUV": ["Avantis U.S. Small Cap Value ETF", "EA Series Trust", 1, 97.7],
            "IJS": ["iShares S&P Small-Cap 600 Value ETF", "iSHARES TRUST", 1, 99.0],
            # Same trust, different bucket.
            "AVLV": ["Avantis U.S. Large Cap Value ETF", "EA Series Trust", 1, 99.7],
        },
    }
    (release / "catalogue.json").write_text(json.dumps(catalogue))
    for ticker in catalogue["funds"]:
        (release / "funds" / f"{ticker}.json").write_text(json.dumps(fund(ticker=ticker)))
    out = tmp_path / "out"
    fund_pages.build(release, out)

    page = (out / "f" / "AVUV" / "index.html").read_text()
    assert '<a href="/f/IJS/">IJS</a>' in page
    assert '<a href="/f/AVLV/">AVLV</a>' not in page
