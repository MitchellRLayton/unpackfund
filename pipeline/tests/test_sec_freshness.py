"""Which cached documents may be reused, and which must be re-read.

The daily loop now keeps fetched documents between runs (a CDC-style cache), which is
only safe because the two kinds of URL have different lifetimes. An N-PORT document is
accession-addressed and immutable: a hit is final. `submissions/CIK….json` and
`company_tickers_mf.json` are rewritten in place, so a hit from yesterday would resolve
every fund to its *previous* filing — quietly a quarter behind, and no gate would notice.
"""

from __future__ import annotations

import json
import time

import pytest

from pipeline import filings, sec, universe


@pytest.fixture(autouse=True)
def _tmp_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(sec, "CACHE_DIR", tmp_path / "cache")
    yield tmp_path


def _write_cache(sec_module, url: str, body: bytes, *, age_seconds: float) -> None:
    body_path, meta_path = sec_module._cache_paths(url)
    body_path.parent.mkdir(parents=True, exist_ok=True)
    body_path.write_bytes(body)
    meta_path.write_text(
        json.dumps(
            {
                "url": url,
                "retrieved_utc": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - age_seconds)
                ),
                "bytes": len(body),
                "sha256": "0" * 64,
                "content_type": "application/json",
            }
        )
    )


class TestTheTwoLifetimes:
    def test_an_immutable_document_is_reused_however_old(self, monkeypatch):
        url = "https://www.sec.gov/Archives/edgar/data/1/0001-26-000001/primary_doc.xml"
        _write_cache(sec, url, b"<filing/>", age_seconds=90 * 24 * 3600)
        monkeypatch.setattr(
            sec.urllib.request, "urlopen", lambda *a, **k: pytest.fail("refetched a final document")
        )
        assert sec.fetch(url) == b"<filing/>"

    def test_a_stale_index_is_refetched(self, monkeypatch):
        url = sec.submissions_url("1")
        _write_cache(sec, url, b'{"old": true}', age_seconds=sec.INDEX_MAX_AGE_S + 600)
        calls: list[str] = []

        class Response:
            headers = {"Content-Type": "application/json"}

            def read(self):
                return b'{"old": false}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(request, timeout=0):
            calls.append(request.full_url)
            return Response()

        monkeypatch.setattr(sec.urllib.request, "urlopen", fake_urlopen)
        assert sec.fetch(url, max_age=sec.INDEX_MAX_AGE_S) == b'{"old": false}'
        assert calls == [url]

    def test_a_fresh_index_is_reused(self, monkeypatch):
        url = sec.submissions_url("1")
        _write_cache(sec, url, b'{"old": false}', age_seconds=600)
        monkeypatch.setattr(
            sec.urllib.request, "urlopen", lambda *a, **k: pytest.fail("refetched a fresh index")
        )
        assert sec.fetch(url, max_age=sec.INDEX_MAX_AGE_S) == b'{"old": false}'

    def test_the_window_is_shorter_than_a_daily_run(self):
        assert sec.INDEX_MAX_AGE_S < 24 * 3600


class TestCallersDeclareIt:
    def test_submissions_are_read_with_a_window(self, monkeypatch):
        seen: list[dict] = []

        def fake(url, **kwargs):
            seen.append(kwargs)
            return {"filings": {"recent": {"form": ["NPORT-P"], "accessionNumber": ["a"],
                                           "filingDate": ["2026-08-01"],
                                           "reportDate": ["2026-06-30"]}}}

        monkeypatch.setattr(sec, "fetch_json", fake)
        filings._submission_rows_cached.cache_clear()
        try:
            filings.candidates("1")
        finally:
            filings._submission_rows_cached.cache_clear()
        assert seen and seen[0].get("max_age") == sec.INDEX_MAX_AGE_S

    def test_the_fund_ticker_file_is_read_with_a_window(self, monkeypatch):
        seen: list[dict] = []

        def fake(url, **kwargs):
            seen.append(kwargs)
            return {"fields": ["cik", "seriesId", "classId", "symbol"], "data": []}

        monkeypatch.setattr(sec, "fetch_json", fake)
        universe._clear_caches()
        universe._mf_map()
        assert seen and seen[0].get("max_age") == sec.INDEX_MAX_AGE_S
