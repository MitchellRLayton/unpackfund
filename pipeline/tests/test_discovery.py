"""Series discovery: the universe the SEC ticker file does not carry.

The defect these tests were written for: on 2026-11-11 the site had no page for
Roundhill Memory ETF (Cboe: DRAM) or Roundhill HALO ETF, both live funds that had
been filing N-PORT for two quarters. Neither appears in `company_tickers_mf.json`,
and that file was the only universe a wide build walked — so neither was ever
fetched, and nothing anywhere recorded that they existed. `universe.py`'s own
docstring said the file is "a resolution input, never a universe" while
`all_series()` used it as one.

These tests pin the repair at its three joints: the scan reads a series out of a
filing, the cover read turns a series into a symbol only when it can corroborate
it, and the universe unions the result without disturbing what the file already
resolves.
"""

from __future__ import annotations

import io
import json
import zipfile
from datetime import date

import pytest

from pipeline import discovery, sec, universe

#: A daily index in EDGAR's space-aligned shape: header, separator, then rows.
INDEX = """Description:           Daily Index of EDGAR Dissemination Feed
Last Data Received:    November 10, 2026
Form Type   Company Name                          CIK         Date Filed  File Name
-------------------------------------------------------------------------------
NPORT-P     Roundhill ETF Trust                   1976517     2026-08-26  edgar/data/1976517/0000894189-26-023623.txt
NPORT-P     Some Other Trust                      999999      2026-08-26  edgar/data/999999/0000894189-26-099999.txt
10-K        Not A Fund Corp                       123456      2026-08-26  edgar/data/123456/0000894189-26-012345.txt
"""

#: The two fields discovery reads out of an N-PORT, in the shape EDGAR serves them.
PRIMARY_DOC = b"""<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission>
  <headerData><submissionType>NPORT-P</submissionType></headerData>
  <formData>
    <genInfo>
      <seriesId>S000102337</seriesId>
      <classId>C000272806</classId>
      <seriesName>Roundhill Memory ETF</seriesName>
    </genInfo>
  </formData>
</edgarSubmission>
"""

#: A summary prospectus cover, as the fund files it: the name, then the exchange line.
COVER = """<html><body><p>SUMMARY PROSPECTUS</p>
<p>Roundhill Memory ETF (Cboe &ndash; DRAM)</p>
<p>April 1, 2026</p></body></html>"""


#: The three tables the data set path reads, in the SEC's own column spelling.
DATASET_TABLES = {
    "SUBMISSION.tsv": "ACCESSION_NUMBER\tFILING_DATE\tSUB_TYPE\n"
    "0000894189-26-023623\t26-AUG-2026\tNPORT-P\n",
    "REGISTRANT.tsv": "ACCESSION_NUMBER\tCIK\tREGISTRANT_NAME\n"
    "0000894189-26-023623\t0001976517\tRoundhill ETF Trust\n",
    "FUND_REPORTED_INFO.tsv": "ACCESSION_NUMBER\tSERIES_ID\tSERIES_NAME\tNET_ASSETS\n"
    "0000894189-26-023623\tS000102337\tRoundhill Memory ETF\t25910762039\n",
}


def _dataset_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, body in DATASET_TABLES.items():
            archive.writestr(name, body)
        archive.writestr("OTHER.tsv", "unread\n")
    return buffer.getvalue()


def _edgar(url: str, **kwargs) -> bytes:
    """EDGAR answered from literals: a data set, an index, or a filing."""
    if "form-n-port-data-sets" in url:
        return _dataset_zip()
    return PRIMARY_DOC if "primary_doc" in url else INDEX.encode("latin-1")


@pytest.fixture()
def offline(monkeypatch, tmp_path):
    """EDGAR answered from literals, and a cache directory of this test's own."""
    monkeypatch.setattr(sec, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(sec, "fetch", _edgar)
    yield tmp_path


def test_the_data_set_names_a_series_without_reading_a_filing(offline, monkeypatch):
    """A closed quarter costs one download and no document reads at all."""
    calls: list[str] = []

    def counting(url, **kwargs):
        calls.append(url)
        return _edgar(url)

    monkeypatch.setattr(sec, "fetch", counting)
    series = discovery.scan([date(2026, 8, 26)], {"1976517"})
    assert set(series) == {"S000102337"}
    row = series["S000102337"]
    assert row.name == "Roundhill Memory ETF"
    assert row.cik == "1976517"
    assert row.filed_at == "2026-08-26"
    assert row.symbol is None and not row.publishable
    assert not [url for url in calls if "primary_doc" in url], "the data set should need no filing"


def test_the_index_covers_the_quarter_no_data_set_describes(offline, monkeypatch):
    """The current quarter is filings the data set cannot know: read them from the index."""

    def no_dataset(url, **kwargs):
        if "form-n-port-data-sets" in url:
            raise sec.SecError("not published yet")
        return _edgar(url)

    monkeypatch.setattr(sec, "fetch", no_dataset)
    series = discovery.scan([date(2026, 11, 10)], {"1976517"}, use_index=True)
    assert set(series) == {"S000102337"}
    assert series["S000102337"].cik == "1976517"


def test_the_scan_ignores_registrants_we_do_not_publish(offline):
    """A trust outside the product is not a gap in the product."""
    assert discovery.scan([date(2026, 8, 26)], {"111111"}) == {}


def test_a_second_scan_does_not_reread_a_filing(offline, monkeypatch):
    """A known filing is not fetched again, so a daily run costs only what is new."""

    def no_dataset(url, **kwargs):
        if "form-n-port-data-sets" in url:
            raise sec.SecError("not published yet")
        return _edgar(url)

    calls: list[str] = []

    def counting(url, **kwargs):
        calls.append(url)
        return no_dataset(url)

    monkeypatch.setattr(sec, "fetch", counting)
    first = discovery.scan([date(2026, 11, 10)], {"1976517"}, use_index=True)
    documents_after_first = len([url for url in calls if "primary_doc" in url])
    discovery.scan([date(2026, 11, 10)], {"1976517"}, known=first, use_index=True)
    documents_after_second = len([url for url in calls if "primary_doc" in url])
    assert documents_after_first == 1
    assert documents_after_second == 1, "the second scan re-read a filing it already had"


def test_a_data_set_is_read_once_and_cached_as_a_compact_join(offline, monkeypatch):
    """The 462 MB zip is downloaded once a quarter and deleted; ~3 MB of JSON stays."""
    calls: list[str] = []

    def counting(url, **kwargs):
        calls.append(url)
        return _edgar(url)

    monkeypatch.setattr(sec, "fetch", counting)
    discovery.scan([date(2026, 8, 26)], {"1976517"})
    discovery.scan([date(2026, 8, 27)], {"1976517"})
    downloads = [url for url in calls if "form-n-port-data-sets" in url]
    assert len(downloads) == 1, "the data set was downloaded twice"
    cached = list((offline / "discovery").glob("nport-*.json"))
    assert cached, "no compact join was written"
    assert cached[0].stat().st_size > 0


def test_the_cover_gives_the_ticker_beside_the_funds_name():
    """`Roundhill Memory ETF (Cboe – DRAM)` is the fact, and it is corroborated."""
    symbol, note = discovery.symbol_from_cover(
        discovery._text(COVER), "Roundhill Memory ETF"
    )
    assert symbol == "DRAM"
    assert note == "cover"


def test_a_trading_symbol_field_is_read_when_the_cover_prints_one():
    text = "Roundhill HALO ETF Trading Symbol: HALO Exchange: Cboe"
    symbol, _ = discovery.symbol_from_cover(text, "Roundhill HALO ETF")
    assert symbol == "HALO"


def test_a_document_that_does_not_name_the_series_gives_no_symbol():
    """A ticker anywhere in a 600 kB prospectus is not identity."""
    symbol, note = discovery.symbol_from_cover(
        "Some Other Fund (Cboe – ZZZZ)", "Roundhill Memory ETF"
    )
    assert symbol is None
    assert "does not name this series" in note


def test_a_name_with_no_exchange_line_gives_no_symbol():
    symbol, note = discovery.symbol_from_cover(
        "Roundhill Memory ETF is a series of the Trust.", "Roundhill Memory ETF"
    )
    assert symbol is None
    assert "no exchange line" in note


def test_a_stopword_in_an_exchange_line_is_not_a_symbol():
    """`(the "Trust")` and `(Cboe – ETF)` are prose, not tickers."""
    symbol, _ = discovery.symbol_from_cover(
        'Roundhill Memory ETF (Cboe – ETF)', "Roundhill Memory ETF"
    )
    assert symbol is None


def test_the_cache_round_trips(offline):
    """What the scan found survives a save and a load, symbol work included."""
    row = discovery.Discovered(
        series_id="S000102337",
        cik="1976517",
        name="Roundhill Memory ETF",
        accession="0000894189-26-023623",
        filed_at="2026-08-26",
        symbol="DRAM",
        symbol_source="cover:0001398344-26-005952",
    )
    discovery.save({"S000102337": row}, offline)
    loaded = discovery.load(offline)
    assert loaded == {"S000102337": row}
    assert loaded["S000102337"].publishable


def test_a_corrupt_cache_is_empty_rather_than_fatal(offline):
    """A half-written cache must not take the build down with it."""
    path = discovery.cache_path(offline)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    assert discovery.load(offline) == {}


def test_the_cache_keeps_only_the_series_the_ticker_file_omits(offline, monkeypatch):
    """A copy of the whole universe would resolve a symbol for every fund on the site."""
    resolved: list[str] = []

    def counting_resolver(series_id, cik, name, **kwargs):
        resolved.append(series_id)
        return "DRAM", "cover:test", "cover"

    monkeypatch.setattr(discovery, "resolve_symbol", counting_resolver)
    series = discovery.refresh_cache(
        universe_ciks={"1976517"},
        known_series={"S000099970"},
        days=90,
        today=date(2026, 8, 26),
        root=offline,
    )
    assert set(series) == {"S000102337"}
    assert resolved == ["S000102337"], "a known series was resolved again"


def test_the_summary_counts_what_can_and_cannot_be_named():
    series = {
        "S1": discovery.Discovered("S1", "1", "A", "acc1", "2026-08-26", symbol="AAA"),
        "S2": discovery.Discovered("S2", "1", "B", "acc2", "2026-08-26", symbol_note="no cover"),
    }
    counts = discovery.summary(series)
    assert counts["series"] == 2
    assert counts["with_symbol"] == 1
    assert counts["without_symbol"] == 1
    assert counts["unnamed"] == ["S2"]


# --- the universe union -------------------------------------------------------

TICKER_FILE = {
    "fields": ["cik", "seriesId", "classId", "symbol"],
    "data": [[1976517, "S000099970", "C000000001", "AAPW"]],
}


@pytest.fixture()
def ticker_file(monkeypatch):
    monkeypatch.setattr(sec, "fetch_json", lambda url, **kwargs: TICKER_FILE)
    def no_overrides() -> dict:
        return {}

    no_overrides.cache_clear = lambda: None  # type: ignore[attr-defined]
    monkeypatch.setattr(universe, "_overrides", no_overrides)
    universe._clear_caches()
    yield
    universe._clear_caches()


def test_a_discovered_series_with_a_symbol_joins_the_universe(ticker_file):
    """The whole point: a fund the ticker file omits is still built."""
    discovered = {
        "S000102337": discovery.Discovered(
            "S000102337", "1976517", "Roundhill Memory ETF", "acc", "2026-08-26", symbol="DRAM"
        )
    }
    refs = {ref.ticker: ref for ref in universe.all_series(discovered)}
    assert "DRAM" in refs
    assert refs["DRAM"].series_id == "S000102337"
    assert refs["DRAM"].resolved_by == "discovery"
    assert "AAPW" in refs, "the ticker file's own series must survive the union"


def test_a_discovered_series_without_a_symbol_is_not_published(ticker_file):
    """No symbol, no page: the artifact is per ticker, and a guess is worse than a gap."""
    discovered = {
        "S000102337": discovery.Discovered(
            "S000102337", "1976517", "Roundhill Memory ETF", "acc", "2026-08-26",
            symbol_note="no exchange line",
        )
    }
    assert "DRAM" not in {ref.ticker for ref in universe.all_series(discovered)}


def test_a_series_the_ticker_file_already_has_is_not_duplicated(ticker_file):
    """Discovery adds; it never overrides a symbol the SEC file already resolved."""
    discovered = {
        "S000099970": discovery.Discovered(
            "S000099970", "1976517", "Roundhill AAPL WeeklyPay ETF", "acc", "2026-08-26",
            symbol="WRONG",
        )
    }
    refs = {ref.ticker: ref for ref in universe.all_series(discovered)}
    assert "WRONG" not in refs
    assert refs["AAPW"].resolved_by == "company_tickers_mf"


def test_the_universe_is_unchanged_when_nothing_was_discovered(ticker_file):
    """The default is the old behaviour, so a build without a cache is not a surprise."""
    assert [ref.ticker for ref in universe.all_series()] == ["AAPW"]
    assert [ref.ticker for ref in universe.all_series({})] == ["AAPW"]
