"""EDGAR throttling must slow a build down, never silently shrink it.

A GitHub-hosted runner shares its egress IP with every other job on that host, so a
wide build sees 429s it did not cause. Two behaviours are load-bearing:

* the client honours ``Retry-After`` and keeps trying, so a transient throttle is a
  slower request rather than a failed one;
* a series peek that still fails is skipped, not fatal — but past a small budget the
  universe is refused, because publishing a release with whole registrants missing is
  worse than not publishing.
"""

from __future__ import annotations

import email.utils
import io
import urllib.error
from pathlib import Path

import pytest

from pipeline import filings, sec, universe


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    slept: list[float] = []
    monkeypatch.setattr(sec.time, "sleep", lambda seconds: slept.append(seconds))
    yield slept


@pytest.fixture(autouse=True)
def _clean_index(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(filings, "_SERIES_INDEX", {})
    monkeypatch.setattr(filings, "_ACCESSION_SERIES", {})
    monkeypatch.setattr(sec, "CACHE_DIR", tmp_path / "cache")
    filings.reset_throttled_lookups()
    yield
    filings.reset_throttled_lookups()


def _throttle(headers: dict[str, str] | None = None) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        "https://www.sec.gov/x", 429, "Too Many Requests", headers or {}, io.BytesIO(b"")
    )


def _ok(body: bytes = b'<?xml version="1.0"?><x/>'):
    class Response(io.BytesIO):
        headers = {"Content-Type": "text/xml"}

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    return Response(body)


class TestRetryAfter:
    def test_delta_seconds_is_honoured(self):
        assert sec.retry_after_seconds({"Retry-After": "7"}) == 7.0

    def test_an_http_date_becomes_a_delay(self):
        when = email.utils.formatdate(sec.time.time() + 12, usegmt=True)
        delay = sec.retry_after_seconds({"Retry-After": when})
        assert delay is not None and 10 <= delay <= 12.5

    def test_it_is_clamped_and_ignored_when_unreadable(self):
        assert sec.retry_after_seconds({"Retry-After": "9999"}) == sec.MAX_RETRY_AFTER_S
        assert sec.retry_after_seconds({"Retry-After": "soon"}) is None
        assert sec.retry_after_seconds(None) is None

    def test_backoff_is_capped(self):
        assert sec.backoff_seconds(0) < 1.0
        assert sec.backoff_seconds(20) <= sec.BACKOFF_CAP_S + 0.5


class TestFetch:
    def test_a_throttle_with_retry_after_is_retried_then_succeeds(self, monkeypatch, _no_real_sleep):
        calls = {"n": 0}

        def fake_urlopen(request, timeout=0):
            calls["n"] += 1
            if calls["n"] == 1:
                raise _throttle({"Retry-After": "4"})
            return _ok()

        monkeypatch.setattr(sec.urllib.request, "urlopen", fake_urlopen)
        assert sec.fetch("https://www.sec.gov/x") == b'<?xml version="1.0"?><x/>'
        assert calls["n"] == 2
        # The server's own number, not an exponential guess. It may not be the first
        # sleep in the list: the global rate limiter sleeps too.
        assert 4.0 in _no_real_sleep

    def test_it_gives_up_after_its_attempts(self, monkeypatch):
        def always_throttled(request, timeout=0):
            raise _throttle()

        monkeypatch.setattr(sec.urllib.request, "urlopen", always_throttled)
        with pytest.raises(sec.SecError, match="HTTP 429"):
            sec.fetch("https://www.sec.gov/y")

    def test_a_throttle_is_no_longer_given_four_tries(self):
        assert sec.DEFAULT_TRIES > 4


def _ref(cik: str, series: str) -> universe.FundRef:
    return universe.FundRef(
        ticker="AAA", cik=cik, series_id=series, resolved_by="test"
    )


class TestSeriesPeekSurvivesAThrottle:
    def test_a_throttled_peek_is_skipped_not_remembered(self, monkeypatch):
        monkeypatch.setattr(
            filings,
            "candidates",
            lambda cik: [{"accessionNumber": "0001-26-000001", "filingDate": "2026-08-01",
                          "reportDate": "2026-06-30"}],
        )

        def throttled(url, **kwargs):
            raise sec.SecError("HTTP 429 for https://www.sec.gov/p.xml")

        monkeypatch.setattr(sec, "fetch", throttled)
        assert filings.index_registrant("1", [_ref("1", "S000000001")]) == 0
        # Not remembered: the accession may name a wanted series later.
        assert filings._ACCESSION_SERIES == {}
        assert filings.throttled_lookups() == 1

    def test_too_many_throttled_lookups_refuses_the_universe(self, monkeypatch):
        monkeypatch.setattr(filings, "THROTTLE_BUDGET", 2)
        filings._throttled["count"] = 3

        def no_rows(cik):
            return []

        monkeypatch.setattr(filings, "candidates", no_rows)
        with pytest.raises(sec.SecError, match="rate-limited 3 series lookups"):
            filings.prefetch([_ref("1", "S000000001")])

    def test_a_clean_walk_is_unchanged(self, monkeypatch):
        monkeypatch.setattr(
            filings,
            "candidates",
            lambda cik: [{"accessionNumber": "0001-26-000002", "filingDate": "2026-08-02",
                          "reportDate": "2026-06-30"}],
        )
        monkeypatch.setattr(sec, "fetch", lambda url, **kwargs: b"<x/>")
        monkeypatch.setattr(filings, "peek_series_id", lambda body: "S000000001")
        counts = filings.prefetch([_ref("1", "S000000001")])
        assert counts["documents"] == 1
        assert counts["skipped"] == 0
