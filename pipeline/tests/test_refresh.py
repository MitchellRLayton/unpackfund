"""The refresh trigger: read a filing-day index and say what arrived.

The index format is the one thing here that can silently rot — EDGAR could change a
column and a naive parser would return zero rows, which reads exactly like "no new
filings". So the parser tests use the shapes the real files actually contain
(prose header, separator line, space-aligned rows, a trust name with single
spaces), and the detection tests assert the counts a scheduler acts on.
"""

from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import pytest

from pipeline import refresh, sec

#: Shaped like a real `form.idx`: prose header, column header, separator, rows.
INDEX_TEXT = """Description:           Daily Index of EDGAR Dissemination Feed
Last Data Received:    October 29, 2026
Anonymous FTP:         ftp://ftp.sec.gov/edgar/



Form Type   Company Name                                                  CIK         Date Filed  File Name
------------------------------------------------------------------------------------------------------------------------
NPORT-P          Vanguard Scottsdale Funds                                        0001057961  2026-10-29  edgar/data/1057961/0001057961-26-024311.txt
NPORT-P          SPDR S&P 500 ETF Trust                                           0000884394  2026-10-29  edgar/data/884394/0000884394-26-000123.txt
NPORT-P/A        iShares Trust                                                    0001100663  2026-10-29  edgar/data/1100663/0001100663-26-004411.txt
N-CSR            Some Other Trust                                                 0001234567  2026-10-29  edgar/data/1234567/0001234567-26-000001.txt
485BPOS          Another Trust                                                    0007654321  2026-10-29  edgar/data/7654321/0007654321-26-000002.txt
NPORT-EX         Vanguard Scottsdale Funds                                        0001057961  2026-10-29  edgar/data/1057961/0001057961-26-024399.txt
NOT A ROW
"""


def test_index_url_carries_year_and_calendar_quarter():
    assert refresh.index_url(date(2026, 1, 5)) == (
        "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR1/form.20260105.idx"
    )
    assert refresh.index_url(date(2026, 3, 31)).endswith("/2026/QTR1/form.20260331.idx")
    assert refresh.index_url(date(2026, 4, 1)).endswith("/2026/QTR2/form.20260401.idx")
    assert refresh.index_url(date(2026, 12, 31)).endswith("/2026/QTR4/form.20261231.idx")


def test_parse_index_reads_rows_and_normalises_the_cik():
    rows = refresh.parse_index(INDEX_TEXT)
    assert len(rows) == 6, "header, separator and prose lines are not rows"
    first = rows[0]
    assert first.form == "NPORT-P"
    assert first.name == "Vanguard Scottsdale Funds", "single spaces inside a name survive"
    assert first.cik == "0001057961", "CIK is zero-padded to EDGAR's 10 digits"
    assert first.filed == "2026-10-29"
    assert first.accession == "0001057961-26-024311"


def test_nport_filings_take_amendments_and_leave_other_forms():
    forms = [filing.form for filing in refresh.nport_filings(refresh.parse_index(INDEX_TEXT))]
    assert forms == ["NPORT-P", "NPORT-P", "NPORT-P/A"], "NPORT-EX is an exhibit, not a filing"


def test_parse_index_returns_nothing_for_a_non_index_body():
    assert refresh.parse_index("<html>403 Forbidden</html>") == []


def test_days_back_is_oldest_first_and_excludes_today():
    assert refresh.days_back(date(2026, 10, 30), 1) == [date(2026, 10, 29)]
    assert refresh.days_back(date(2026, 11, 2), 3) == [
        date(2026, 10, 30),
        date(2026, 10, 31),
        date(2026, 11, 1),
    ]


def _fake_index(monkeypatch, text: str = INDEX_TEXT, missing: set[str] = frozenset()) -> list[str]:
    fetched: list[str] = []

    def fake_fetch(url: str, **_kwargs):
        fetched.append(url)
        if any(day in url for day in missing):
            raise sec.SecError(f"HTTP 404 for {url}")
        return text.encode()

    monkeypatch.setattr(refresh.sec, "fetch", fake_fetch)
    return fetched


def test_detect_narrows_to_the_published_universe(monkeypatch):
    fetched = _fake_index(monkeypatch)
    summary = refresh.detect([date(2026, 10, 29)], universe_ciks={"0001057961", "0001100663"})
    assert fetched == [refresh.index_url(date(2026, 10, 29))]
    assert summary["nport_filings"] == 3
    assert summary["universe"]["filings"] == 2
    assert summary["universe"]["registrants_with_filings"] == 2
    assert summary["change"] == {"new_filings": 2, "build": True}
    assert [row["accession"] for row in summary["accessions"]] == [
        "0001057961-26-024311",
        "0001100663-26-004411",
    ]


def test_detect_with_no_published_filings_says_do_not_build(monkeypatch):
    _fake_index(monkeypatch)
    summary = refresh.detect([date(2026, 10, 29)], universe_ciks={"0009999999"})
    assert summary["change"] == {"new_filings": 0, "build": False}
    assert summary["universe"]["registrants"] == 1


def test_detect_reports_a_day_whose_index_does_not_exist_yet(monkeypatch):
    _fake_index(monkeypatch, missing={"20261030"})
    summary = refresh.detect([date(2026, 10, 29), date(2026, 10, 30)], universe_ciks=None)
    assert summary["index"]["files"] == 1
    assert len(summary["index"]["missing"]) == 1
    assert "2026-10-30" in summary["index"]["missing"][0]
    assert summary["change"]["new_filings"] == 3, "a missing day does not erase the day that exists"


def test_detect_without_peek_does_not_fetch_filings(monkeypatch):
    fetched = _fake_index(monkeypatch)
    refresh.detect([date(2026, 10, 29)], universe_ciks={"0001057961"})
    assert len(fetched) == 1, "only the index file; a build is what reads documents"


def test_detect_peek_maps_published_series_against_the_previous_release(
    monkeypatch, tmp_path: Path
):
    monkeypatch.setattr(
        refresh.sec, "fetch", _fake_index_with_documents(monkeypatch, series={"S000002839"})
    )
    release = tmp_path / "2026-10-30.1"
    (release / "funds").mkdir(parents=True)
    (release / "funds" / "VOO.json").write_text(
        json.dumps(
            {
                "ticker": "VOO",
                "fund_id": "S000002839",
                "source_url": "https://www.sec.gov/Archives/edgar/data/36405/000003640526000001/primary_doc.xml",
            }
        )
    )
    summary = refresh.detect(
        [date(2026, 10, 29)], universe_ciks={"0001057961"}, peek=True, previous_release=release
    )
    assert summary["peek"]["published_funds_affected"] == 1, "a different accession supersedes it"
    assert summary["peek"]["already_current"] == 0
    assert summary["peek"]["series_not_in_release"] == 0
    assert summary["peek"]["release_series"] == 1


def _fake_index_with_documents(monkeypatch, *, series: set[str]):
    index_body = INDEX_TEXT.encode()
    document = ("<seriesId>%s</seriesId>" % sorted(series)[0]).encode() if series else b""

    def fake_fetch(url: str, **_kwargs):
        if url.endswith(".idx"):
            return index_body
        return document

    return fake_fetch


def test_cached_body_is_final_by_default_and_ages_out_when_given_a_max_age(tmp_path: Path):
    body, meta = tmp_path / "x.bin", tmp_path / "x.json"
    body.write_bytes(b"payload")
    meta.write_text(json.dumps({"retrieved_utc": "2026-10-01T00:00:00Z"}))
    assert sec._cached_body_is_usable(body, meta, None) is True, "immutable documents never expire"
    assert sec._cached_body_is_usable(body, meta, 0) is False, "max_age=0 always refetches"
    assert sec._cached_body_is_usable(body, meta, 24 * 3600) is False, "a month-old index is stale"
    fresh = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    meta.write_text(json.dumps({"retrieved_utc": fresh}))
    assert sec._cached_body_is_usable(body, meta, 60) is True


def test_cached_body_with_unreadable_metadata_is_stale(tmp_path: Path):
    body, meta = tmp_path / "x.bin", tmp_path / "x.json"
    body.write_bytes(b"payload")
    meta.write_text("not json")
    assert sec._cached_body_is_usable(body, meta, 60) is False
    assert sec._cached_body_is_usable(body, meta, None) is True


@pytest.mark.parametrize("days", [0, -1])
def test_detect_cli_rejects_a_non_positive_day_count(days: int):
    assert refresh.main(["detect", "--days", str(days)]) == 2
