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


# --- Partial rebuilds: only the funds that changed -------------------------------
#
# Regenerating every page is 4.6 s, so the reason to rebuild a subset is not the
# generator — it is the upload. The deploy ships `web/out` and Cloudflare skips
# assets whose bytes it already has, which only works while the untouched pages
# stay byte-identical. These tests pin that: a partial run writes the requested
# pages, leaves every other file alone, and a page is the same bytes whether it
# was written in a full run or a partial one.


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
    assert "AVUV holdings" in (out / "f" / "AVUV" / "index.html").read_text()
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
    assert "91.1% of weight" in (out / "f" / "AVLV" / "index.html").read_text()
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
