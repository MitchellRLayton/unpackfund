"""Mapping: exact rungs only, ambiguity refused, and the rung recorded."""

from __future__ import annotations

from pipeline.companies import CompanyIndex, company_id, name_tokens, names_agree, normalize_name


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


def test_normalize_keeps_an_apostrophe_inside_a_word():
    """``Lowe's`` must normalize to ``lowes``, not to ``lowe s``."""
    assert normalize_name("Lowe's Cos Inc") == "lowes cos"
    assert normalize_name("Lowe’s Companies, Inc.") == "lowes companies"
    assert names_agree("Lowe's Cos Inc", "LOWES COMPANIES INC")


def test_ticker_rung_needs_the_name_to_corroborate_it():
    """A bare symbol is not an identity: it is only unique within a market."""
    document = {
        "0": {"cik_str": 1750, "ticker": "AIR", "title": "AAR CORP"},
        "1": {"cik_str": 51143, "ticker": "IBM", "title": "INTERNATIONAL BUSINESS MACHINES CORP"},
        "2": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    }
    index = CompanyIndex.from_document(document)
    # Airbus SE trades as AIR in Paris; the filer wrote the bare symbol and the name
    # says otherwise, so the ticker is refused rather than merged into AAR Corp.
    assert index.resolve("AIR", "AIRBUS SE") == (None, "unmapped")
    assert index.resolve("AIR", "Air New Zealand Ltd") == (None, "unmapped")
    assert index.resolve("AIR", "AAR Corp.") == (company_id(1750), "ticker")
    # Initials and prefixes are how the same company gets written two ways.
    assert index.resolve("IBM", "IBM") == (company_id(51143), "ticker")
    assert index.resolve("AAPL", "Apple") == (company_id(320193), "ticker")
    # No name at all: the ticker is the only signal, so it stands.
    assert index.resolve("AAPL", None) == (company_id(320193), "ticker")
    assert index.resolve("AAPL", "") == (company_id(320193), "ticker")


def test_a_treasury_row_is_not_att_and_t():
    """The day-5 release had 9,939 bp of Treasuries mapped to AT&T, via ticker ``T``."""
    document = {"0": {"cik_str": 732717, "ticker": "T", "title": "AT&T INC."}}
    index = CompanyIndex.from_document(document)
    assert index.resolve("T", "UNITED STATES OF AMERICA - BUREAU OF THE PUBLIC DEBT") == (
        None,
        "unmapped",
    )
    assert index.resolve("T", "U.S. TREASURY") == (None, "unmapped")
    assert index.resolve("T", "AT&T Inc") == (company_id(732717), "ticker")


def test_name_tokens_drop_the_legal_form_only():
    assert name_tokens("International Business Machines Corp") == [
        "international",
        "business",
        "machines",
    ]
    assert name_tokens("Apple Inc.") == ["apple"]
    assert name_tokens("") == []


def test_names_agree_is_loose_about_form_and_strict_about_identity():
    assert names_agree("Exxon Mobil Corp", "ExxonMobil Holdings Corp")
    assert names_agree("TSMC", "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD")
    assert names_agree("F.N.B. CORP (PENNSYLVANIA)", "FNB CORP/PA/")
    assert not names_agree("SCHNEIDER ELECTRIC SE", "SUNCOR ENERGY INC")
    assert not names_agree("ALLIANZ SE", "AUTOLIV INC")
    assert not names_agree("VINCI SA", "DOLLAR GENERAL CORP")
    assert not names_agree("LVMH MOET HENNESSY LOUIS VUITTON SE", "Moelis & Co")
