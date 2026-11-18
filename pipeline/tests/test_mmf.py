"""AU-2: the money-market alias list, and the gates that keep it honest.

Every case here seeds the error the code must catch — a ticker borrowed from another
series, a class that appears twice, an alias that is also a published fund. Fixtures are
namespace-correct N-MFP XML, because the two forms use different default namespaces and a
parser keyed to one would pass a test that only ever fed it the other.
"""

from __future__ import annotations

import json

from pipeline import mmf
from pipeline.validate import Report, _check_mmf_aliases

NMFP3 = b"""<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/nmfp3">
  <headerData><submissionType>N-MFP3</submissionType></headerData>
  <formData><generalInfo>
    <registrantFullName>Vanguard Money Market Reserves</registrantFullName>
    <nameOfSeries>Vanguard Cash Reserves Federal Money Market Fund</nameOfSeries>
    <seriesId>S000004462</seriesId>
    <totalShareClassesInSeries>1</totalShareClassesInSeries>
  </generalInfo></formData>
</edgarSubmission>
"""

NMFP2 = b"""<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/nmfp2">
  <headerData><submissionType>N-MFP2</submissionType></headerData>
  <formData><generalInfo>
    <nameOfSeries>Fidelity Government Money Market Fund</nameOfSeries>
    <seriesId>S000000123</seriesId>
  </generalInfo></formData>
</edgarSubmission>
"""

CLASSES = {
    "VMFXX": ("0000106830", "S000004462", "C000012238"),
    "VMRXX": ("0000106830", "S000004462", "C000012240"),
    "SBAXX": ("000000456", "S000000999", "C000000999"),
}
SYMBOLS = {
    "S000004462": ("VMFXX", "VMRXX"),
    "S000000999": ("SBAXX",),
}


def test_parse_reads_series_and_name_from_either_namespace():
    assert mmf.parse_filing(NMFP3) == {
        "series_id": "S000004462",
        "name": "Vanguard Cash Reserves Federal Money Market Fund",
    }
    assert mmf.parse_filing(NMFP2) == {
        "series_id": "S000000123",
        "name": "Fidelity Government Money Market Fund",
    }


def test_entries_are_one_row_per_ticker_of_that_series():
    entries = mmf.entries_for("S000004462", "A Fund", "N-MFP3", SYMBOLS, CLASSES)
    assert [entry["ticker"] for entry in entries] == ["VMFXX", "VMRXX"]
    assert entries[0]["class_id"] == "C000012238"
    assert entries[0]["latest_form"] == "N-MFP3"
    assert entries[0]["name"] == "A Fund"


def test_a_ticker_listed_under_another_series_is_never_borrowed():
    # SBAXX is filed under S000000999, so it cannot appear on S000004462's rows even if
    # the symbol map were wrong about the series.
    entries = mmf.entries_for("S000004462", "A Fund", "N-MFP2", {"S000004462": ("SBAXX",)}, CLASSES)
    assert entries == []


def test_merge_is_a_sorted_union_and_the_newer_form_wins():
    old = [{"ticker": "VMFXX", "series_id": "S000004462", "class_id": "C1", "name": "Old", "latest_form": "N-MFP2"}]
    new = [{"ticker": "VMFXX", "series_id": "S000004462", "class_id": "C1", "name": "New", "latest_form": "N-MFP3"},
           {"ticker": "FZFXX", "series_id": "S000000777", "class_id": "C9", "name": "Treasury", "latest_form": "N-MFP2"}]
    merged = mmf.merge(old, new)
    assert [entry["ticker"] for entry in merged] == ["FZFXX", "VMFXX"]
    assert merged[1]["name"] == "New"


def test_published_nport_tickers_are_never_published_as_aliases(tmp_path, monkeypatch):
    monkeypatch.setattr(mmf, "ENABLED", True)
    monkeypatch.setattr(mmf, "SEED", tmp_path / "seed.json")
    monkeypatch.setattr(mmf.sec, "CACHE_DIR", tmp_path)
    (tmp_path / "mmf").mkdir()
    (tmp_path / "mmf" / "aliases.json").write_text(
        json.dumps({"aliases": [{"ticker": "SPAXX", "series_id": "S000000123", "class_id": "C2",
                                 "name": "Fidelity Government", "latest_form": "N-MFP2"}]})
    )
    assert [entry["ticker"] for entry in mmf.for_release()] == ["SPAXX"]
    assert mmf.for_release(published=["SPAXX"]) == []


def test_the_queue_is_idempotent_by_accession(tmp_path, monkeypatch):
    monkeypatch.setattr(mmf.sec, "CACHE_DIR", tmp_path)
    row = {"cik": "0000106830", "accession": "0001410368-26-111035", "form": "N-MFP3", "filed": "2026-11-06"}
    assert mmf.queue_pending([row]) == 1
    assert mmf.queue_pending([row]) == 0
    assert json.loads((tmp_path / "mmf" / "pending.json").read_text())["rows"] == [row]


def _release(tmp_path, entries):
    (tmp_path / "mmf_aliases.json").write_text(json.dumps({"schema_version": 1, "aliases": entries}))
    return tmp_path


def test_validator_accepts_a_disjoint_list(tmp_path):
    report = Report()
    _check_mmf_aliases(
        _release(tmp_path, [{"ticker": "VMFXX", "series_id": "S000004462", "class_id": "C1",
                             "name": "Vanguard Federal Money Market", "latest_form": "N-MFP3"}]),
        [{"ticker": "VTI"}],
        report,
    )
    assert report.failures == 0


def test_validator_fails_an_alias_that_is_also_a_published_fund(tmp_path):
    report = Report()
    _check_mmf_aliases(
        _release(tmp_path, [{"ticker": "VTI", "series_id": "S000004462", "class_id": "C1",
                             "name": "Collision", "latest_form": "N-MFP3"}]),
        [{"ticker": "VTI"}],
        report,
    )
    assert report.failures == 1


def test_validator_fails_a_duplicate_or_unknown_form(tmp_path):
    report = Report()
    entry = {"ticker": "VMFXX", "series_id": "S000004462", "class_id": "C1",
             "name": "Fund", "latest_form": "N-MFP3"}
    _check_mmf_aliases(_release(tmp_path, [entry, dict(entry)]), [], report)
    assert report.failures == 1

    report = Report()
    _check_mmf_aliases(
        _release(tmp_path, [{**entry, "latest_form": "N-MFP1"}]),
        [],
        report,
    )
    assert report.failures == 1


def test_save_then_load_round_trips(tmp_path, monkeypatch):
    """A cache that cannot round-trip loses a night's work — caught by 682 rows once."""
    monkeypatch.setattr(mmf.sec, "CACHE_DIR", tmp_path)
    entry = {"ticker": "VMFXX", "series_id": "S000004462", "class_id": "C1",
             "name": "Fund", "latest_form": "N-MFP3"}
    mmf.save_cache([entry])
    assert mmf.load_cache() == [entry]
