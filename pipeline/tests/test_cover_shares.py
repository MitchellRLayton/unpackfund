"""The cover-page share count, on hand-written documents and one real excerpt.

Every fixture under ``fixtures/cover_shares/`` is a few dozen lines of XML shaped
like the document EDGAR actually serves, so the suite runs with no network, no cache
and no ``User-Agent``. The last fixture is a verbatim excerpt of Alphabet's real
10-Q instance, which is what pins the multi-class sum to a number observed on the
live filing rather than to a number this module invented.

The directory is ``cover_shares`` and not ``cover`` because the repo's
``.gitignore`` carries the standard Python ``cover/`` rule for coverage output,
which would silently keep every fixture out of git.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from pipeline import cover_shares

FIXTURES = Path(__file__).parent / "fixtures" / "cover_shares"


def parse(name: str):
    return cover_shares.parse_cover((FIXTURES / name).read_bytes())


# --- the two document shapes ------------------------------------------------


def test_single_class_instance():
    """One undimensioned fact is the whole answer, and it is one class."""
    assert parse("single_class_instance.xml") == (14_800_000_000.0, "2024-09-28", 1, "instance")


def test_dual_class_instance_sums_the_classes():
    """No undimensioned total, so the count is the sum of the two class facts."""
    assert parse("dual_class_instance.xml") == (1_500_000_000.0, "2024-09-28", 2, "instance")


def test_undimensioned_total_beats_the_class_breakdown():
    """A stated total wins outright; the breakdown is not summed on top of it."""
    assert parse("total_and_classes_instance.xml") == (
        2_000_000_000.0,
        "2024-09-28",
        1,
        "instance",
    )


def test_latest_undimensioned_fact_wins():
    """A stale fact from the prior period is ignored in favour of the current one."""
    assert parse("dated_instance.xml") == (1_100_000_000.0, "2024-10-25", 1, "instance")


def test_inline_xbrl_applies_scale_and_commas():
    """``1,234`` with ``scale="6"`` is 1,234,000,000, and the total beats the class."""
    assert parse("inline_cover.htm") == (1_234_000_000.0, "2024-06-30", 1, "inline")


# --- the subtotal trap ------------------------------------------------------


def test_subtotal_class_fact_is_dropped():
    """Visa's shape: a combined class fact beside the two classes it sums.

    300,000,000 + 30,000,000 = 330,000,000, so the combined fact is a subtotal.
    Summing all three would report 660,000,000 — twice the B shares.
    """
    assert parse("subtotal_instance.xml") == (330_000_000.0, "2024-10-25", 2, "instance")


def test_two_equal_classes_are_not_read_as_a_subtotal():
    """Neither of two equal facts is *greater* than the other, so neither is dropped."""
    document = b"""<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
            xmlns:dei="http://xbrl.sec.gov/dei/2024"
            xmlns:us-gaap="http://fasb.org/us-gaap/2024"
            xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
            xmlns:acme="http://www.acme.com/20240928">
  <xbrli:context id="C-a">
    <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">1</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2024-09-28</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">acme:CommonClassAMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:context id="C-b">
    <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">1</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2024-09-28</xbrli:instant></xbrli:period>
    <xbrli:scenario>
      <xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">acme:CommonClassBMember</xbrldi:explicitMember>
    </xbrli:scenario>
  </xbrli:context>
  <xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
  <dei:EntityCommonStockSharesOutstanding contextRef="C-a" unitRef="shares" decimals="0">1000000000</dei:EntityCommonStockSharesOutstanding>
  <dei:EntityCommonStockSharesOutstanding contextRef="C-b" unitRef="shares" decimals="0">1000000000</dei:EntityCommonStockSharesOutstanding>
</xbrli:xbrl>
"""
    assert cover_shares.parse_cover(document) == (2_000_000_000.0, "2024-09-28", 2, "instance")


# --- refusals ---------------------------------------------------------------


def test_no_dei_fact_returns_none():
    """A well-formed instance that states no cover-page count is not an error."""
    assert parse("no_dei_instance.xml") is None


def test_malformed_xml_returns_none():
    assert cover_shares.parse_cover(b"<xbrli:xbrl><context id='C1'>") is None
    assert cover_shares.parse_cover(b"") is None


def test_implausible_count_is_refused():
    """A count below the sanity floor is a parse defect, not a company."""
    document = b"""<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
            xmlns:dei="http://xbrl.sec.gov/dei/2024">
  <xbrli:context id="C1">
    <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">1</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2024-09-28</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
  <dei:EntityCommonStockSharesOutstanding contextRef="C1" unitRef="shares" decimals="0">42</dei:EntityCommonStockSharesOutstanding>
</xbrli:xbrl>
"""
    assert cover_shares.parse_cover(document) is None


# --- the real filing --------------------------------------------------------


def test_alphabet_real_excerpt():
    """Alphabet's 10-Q for the period ended 2026-09-30, three classes summed.

    Observed on the live instance ``goog-20260930_htm.xml``: 5,888,000,000 class A
    + 827,000,000 class B + 5,579,000,000 class C = 12,294,000,000 as of 2026-10-21.
    """
    assert parse("alphabet_instance.xml") == (12_294_000_000.0, "2026-10-21", 3, "instance")


# --- picking the filing -----------------------------------------------------

SUBMISSIONS = {
    "filings": {
        "recent": {
            "form": ["10-K", "10-Q", "8-K"],
            "filingDate": ["2024-11-01", "2024-08-01", "2024-09-01"],
            "reportDate": ["2024-09-28", "2024-06-30", "2024-09-01"],
            "accessionNumber": [
                "0000000001-24-000003",
                "0000000001-24-000002",
                "0000000001-24-000001",
            ],
            "primaryDocument": ["acme-20240928.htm", "acme-20240630.htm", "acme-8k.htm"],
        }
    }
}

INDEX_WITH_INSTANCE = {
    "directory": {
        "name": "0000000001-24-000003",
        "item": [
            {"name": "acme-20240928.htm", "type": "10-K"},
            {"name": "acme-20240928_htm.xml", "type": "EX-101.INS"},
        ],
    }
}

INDEX_WITHOUT_INSTANCE = {
    "directory": {
        "name": "0000000001-24-000003",
        "item": [{"name": "acme-20240928.htm", "type": "10-K"}],
    }
}


def _stub(monkeypatch, *, submissions, index, documents):
    """Serve the three EDGAR documents from disk, and record what was asked for."""
    asked: list[str] = []

    def fake_fetch_json(url, **kwargs):
        asked.append(url)
        return index if url.endswith("index.json") else submissions

    def fake_fetch(url, **kwargs):
        asked.append(url)
        for suffix, body in documents.items():
            if url.endswith(suffix):
                return body
        raise AssertionError(f"unexpected fetch: {url}")

    monkeypatch.setattr(cover_shares.sec, "fetch_json", fake_fetch_json)
    monkeypatch.setattr(cover_shares.sec, "fetch", fake_fetch)
    return asked


def test_latest_cover_shares_reads_the_instance(monkeypatch):
    asked = _stub(
        monkeypatch,
        submissions=SUBMISSIONS,
        index=INDEX_WITH_INSTANCE,
        documents={"acme-20240928_htm.xml": (FIXTURES / "single_class_instance.xml").read_bytes()},
    )
    assert cover_shares.latest_cover_shares(1) == cover_shares.CoverShares(
        cik=1, shares=14_800_000_000.0, as_of="2024-09-28", classes=1, basis="instance"
    )
    assert any("000000000124000003" in url for url in asked)


def test_amended_cover_filing_is_skipped(monkeypatch):
    """A 10-K/A is newer than the 10-K and is still not the filing to read."""
    submissions = {
        "filings": {
            "recent": {
                "form": ["10-K/A", "10-K"],
                "filingDate": ["2024-12-01", "2024-11-01"],
                "reportDate": ["2024-09-28", "2024-09-28"],
                "accessionNumber": ["0000000001-24-000009", "0000000001-24-000003"],
                "primaryDocument": ["acme-20240928a.htm", "acme-20240928.htm"],
            }
        }
    }
    asked = _stub(
        monkeypatch,
        submissions=submissions,
        index=INDEX_WITH_INSTANCE,
        documents={"acme-20240928_htm.xml": (FIXTURES / "single_class_instance.xml").read_bytes()},
    )
    assert cover_shares.latest_cover_shares(1) is not None
    assert any("000000000124000003" in url for url in asked)
    assert not any("000000000124000009" in url for url in asked)


def test_inline_document_is_the_fallback_when_there_is_no_instance(monkeypatch):
    _stub(
        monkeypatch,
        submissions=SUBMISSIONS,
        index=INDEX_WITHOUT_INSTANCE,
        documents={"acme-20240928.htm": (FIXTURES / "inline_cover.htm").read_bytes()},
    )
    assert cover_shares.latest_cover_shares(1) == cover_shares.CoverShares(
        cik=1, shares=1_234_000_000.0, as_of="2024-06-30", classes=1, basis="inline"
    )


def test_a_filer_with_no_10_k_or_10_q_returns_none(monkeypatch):
    submissions = {
        "filings": {
            "recent": {
                "form": ["8-K", "S-1"],
                "filingDate": ["2024-11-01", "2024-08-01"],
                "accessionNumber": ["0000000001-24-000003", "0000000001-24-000002"],
                "primaryDocument": ["acme-8k.htm", "acme-s1.htm"],
            }
        }
    }
    _stub(monkeypatch, submissions=submissions, index=INDEX_WITH_INSTANCE, documents={})
    assert cover_shares.latest_cover_shares(1) is None


def test_a_filing_with_no_parseable_document_returns_none(monkeypatch):
    _stub(
        monkeypatch,
        submissions=SUBMISSIONS,
        index=INDEX_WITHOUT_INSTANCE,
        documents={"acme-20240928.htm": b"<html><body>not xbrl</body></html>"},
    )
    assert cover_shares.latest_cover_shares(1) is None


def test_cover_shares_is_frozen():
    """The result is a value: a caller cannot mutate the number it was given."""
    result = cover_shares.CoverShares(
        cik=1, shares=1.0, as_of="2024-09-28", classes=1, basis="instance"
    )
    with pytest.raises(FrozenInstanceError):
        result.shares = 2.0  # type: ignore[misc]
