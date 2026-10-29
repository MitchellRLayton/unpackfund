"""The parser's job: never silently return nothing from a document that has rows."""

from __future__ import annotations

import pytest

from pipeline.nport import NportParseError, parse

from .conftest import FIXTURES


def test_parses_form_metadata(filing):
    assert filing.series_id == "S000000001"
    assert filing.class_ids == ["C000000011"]
    assert filing.report_date == "2026-06-30"
    assert filing.net_assets == 100_000_000.0
    assert filing.submission_type == "NPORT-P"


def test_parses_every_row(filing):
    assert len(filing.holdings) == 7


def test_identity_fields(filing):
    apple = filing.holdings[0]
    assert apple.name == "Apple Inc"
    assert apple.cusip == "037833100"
    assert apple.isin == "US0378331005"
    assert apple.ticker == "AAPL"
    assert apple.asset_cat == "EC"
    assert apple.issuer_cat == "CORP"


def test_identifiers_come_from_attributes_not_text(filing):
    """``<isin value="…"/>`` carries its value in an attribute; a text read gets None."""
    assert filing.holdings[0].isin is not None


def test_placeholder_cusip_becomes_null(filing):
    """'N/A' is not an identifier, and it must not reach a join key."""
    vw = next(row for row in filing.holdings if row.name.startswith("Vanguard Total"))
    assert vw.cusip is None


def test_derivative_detected_from_derivative_info(filing):
    future = next(row for row in filing.holdings if row.asset_cat == "DE")
    assert future.is_derivative is True
    assert future.val_usd == pytest.approx(-400_000.0)


def test_zero_row_filing_parses_but_is_empty():
    xml = b"""<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
      <headerData><submissionType>NPORT-P</submissionType></headerData>
      <formData><genInfo><repPdDate>2026-06-30</repPdDate></genInfo></formData>
    </edgarSubmission>"""
    filing = parse(xml)
    assert filing.holdings == []
    assert filing.net_assets is None


def test_missing_report_date_is_an_error():
    xml = b"<edgarSubmission><headerData/><formData><genInfo/></formData></edgarSubmission>"
    with pytest.raises(NportParseError):
        parse(xml)


def test_malformed_xml_is_an_error():
    with pytest.raises(NportParseError):
        parse(b"<edgarSubmission>")


def test_not_an_nport_document_is_an_error():
    """A 10-K served in place of the N-PORT must fail, not parse to zero holdings."""
    with pytest.raises(NportParseError):
        parse(b"<edgarSubmission><x/></edgarSubmission>")


def test_parses_without_namespace():
    """Elements are matched by local name, so a namespace change cannot empty the parse."""
    xml = (FIXTURES / "nport_sample.xml").read_bytes()
    stripped = xml.replace(b' xmlns="http://www.sec.gov/edgar/nport"', b"")
    filing = parse(stripped)
    assert len(filing.holdings) == 7
