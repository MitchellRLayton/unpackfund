"""Mapping: exact rungs only, ambiguity refused, and the rung recorded."""

from __future__ import annotations

from pipeline.companies import CompanyIndex, company_id, normalize_name


def test_normalize_ignores_case_punctuation_and_legal_suffix():
    assert normalize_name("Apple Inc.") == normalize_name("APPLE INC")
    assert normalize_name("United Airlines Holdings Inc") == "united airlines"
    assert normalize_name("Huntington Bancshares Inc/OH") == "huntington bancshares oh"
    assert normalize_name("AT&T Inc") == normalize_name("AT and T")


def test_normalize_keeps_distinguishing_words():
    """Suffix stripping must not erase what makes two names different."""
    assert normalize_name("Digital Realty Trust Inc") != normalize_name("Digital Turbine Inc")


def test_ticker_rung_wins(index):
    cid, rung = index.resolve("AAPL", "Apple Inc")
    assert (cid, rung) == (company_id(320193), "ticker")


def test_name_rung_used_when_filer_omits_ticker(index):
    cid, rung = index.resolve(None, "Apple Inc.")
    assert (cid, rung) == (company_id(320193), "name_exact")


def test_unknown_is_unmapped(index):
    assert index.resolve("NOPE", "Nonexistent Widgets LLC") == (None, "unmapped")


def test_ambiguous_name_is_refused(monkeypatch):
    """Two CIKs, one normalised name: refuse rather than pick one."""
    document = {
        "0": {"cik_str": 1, "ticker": "AAA", "title": "Twin Corp"},
        "1": {"cik_str": 2, "ticker": "BBB", "title": "Twin Inc"},
    }
    index = CompanyIndex.from_document(document)
    assert index.resolve(None, "Twin Corp") == (None, "unmapped")


def test_company_id_is_padded_and_prefixed():
    assert company_id(320193) == "c_0000320193"
    assert company_id("36405") == "c_0000036405"


def test_symbol_falls_back_to_company_ticker(index):
    cid, _ = index.resolve(None, "Apple Inc.")
    assert index.symbol(cid) == "AAPL"
    assert index.symbol(None) is None
    assert index.symbol("c_9999999999") is None
