"""The universe module: which ticker a series is shown as, and which ones alias to it.

The defect these tests were written for: a release built from an explicit ticker list
(`--tickers VOO,VTI,…`) published **no aliases at all**, because `resolve()` returned a
`FundRef` with an empty `symbols` tuple and the alias map has nothing else to read. A
full universe walk was unaffected, so the gap only appeared on the path used to rebuild
the live universe — and it would have shipped a release where typing `VFIAX` says "not a
fund we publish" about a fund that is on the site.
"""

from __future__ import annotations

import pytest

from pipeline import sec, universe

#: A miniature `company_tickers_mf.json`: two series, three classes on the first.
DOCUMENT = {
    "fields": ["cik", "seriesId", "classId", "symbol"],
    "data": [
        [36405, "S000000999", "C000000001", "TSTA"],
        [36405, "S000000999", "C000000002", "TSTB"],
        [36405, "S000000999", "C000000003", "TSTC"],
        [36405, "S000001111", "C000000004", "TSTD"],
    ],
}


@pytest.fixture()
def ticker_file(monkeypatch):
    """The SEC fund ticker file, without a network call, and with caches cleared."""
    monkeypatch.setattr(sec, "fetch_json", lambda url, **kwargs: DOCUMENT)
    universe._clear_caches()
    yield
    universe._clear_caches()


def test_resolve_carries_every_share_class_of_the_series(ticker_file):
    """A resolved ref knows its series' symbols, so the alias map can publish them."""
    ref = universe.resolve("TSTB")
    assert ref.series_id == "S000000999"
    assert ref.symbols == ("TSTA", "TSTB", "TSTC")


def test_resolve_of_a_single_class_series_carries_just_that_symbol(ticker_file):
    assert universe.resolve("TSTD").symbols == ("TSTD",)


def test_resolve_still_refuses_an_unknown_ticker(ticker_file):
    with pytest.raises(LookupError, match="not in company_tickers_mf"):
        universe.resolve("NOPE")


def test_the_primary_symbol_is_shortest_then_alphabetical():
    """Two classes of the same length is a real case; the rule has to be total."""
    assert universe._primary_symbol(["VFIAX", "VOO", "VFINX"]) == "VOO"
    assert universe._primary_symbol(["BBBB", "AAAA"]) == "AAAA"


def test_a_symbol_the_browser_could_not_request_is_not_published():
    """`N/A` and parenthesised symbols are in the file; neither is a file name."""
    assert universe.clean_symbol("N/A") is None
    assert universe.clean_symbol("(ABCD)") == "ABCD"
    assert universe.clean_symbol("A B") is None
