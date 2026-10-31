"""The last gate reads 14,000 objects from a CDN; two transient answers must not cost a build.

On 2026-10-30 run 4 uploaded every object of `2026-10-30.7`, then refused the staging pointer
because 2 of 14,256 read-backs came back HTTP 503 from the edge. The data was right and the
release was lost. These tests pin the retry that makes a moment of origin trouble survivable.
"""

from __future__ import annotations

import io
import urllib.error

import pytest

from pipeline import r2


class Response(io.BytesIO):
    def __init__(self, status: int, body: bytes, headers: dict[str, str] | None = None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    slept: list[float] = []
    monkeypatch.setattr(r2.time, "sleep", lambda s: slept.append(s))
    return slept


def _reader(responses):
    """A PublicReader whose opener returns the queued responses in order."""
    queue = list(responses)

    def opener(request, timeout=0):
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    return r2.PublicReader("https://data.example", opener=opener), queue


def test_a_transient_503_is_retried_not_fatal(_no_real_sleep):
    reader, queue = _reader([Response(503, b""), Response(200, b"ok")])
    assert reader.fetch("releases/x/index/A.json").body == b"ok"
    assert queue == []
    assert _no_real_sleep == [r2.PUBLIC_BACKOFF_S[0]]


def test_a_429_from_the_edge_is_retried_too(_no_real_sleep):
    reader, _ = _reader([Response(429, b""), Response(200, b"ok")])
    assert reader.fetch("releases/x/index/B.json").status == 200


def test_a_transport_failure_is_retried(_no_real_sleep):
    reader, _ = _reader([urllib.error.URLError("connection reset"), Response(200, b"ok")])
    assert reader.fetch("releases/x/index/C.json").body == b"ok"


def test_a_404_is_not_retried(_no_real_sleep):
    reader, queue = _reader([Response(404, b"missing"), Response(200, b"unused")])
    assert reader.fetch("releases/x/index/D.json").status == 404
    assert len(queue) == 1, "a real answer was treated as a transient one"
    assert _no_real_sleep == []


def test_it_gives_up_after_the_last_try_and_reports_what_it_saw(_no_real_sleep):
    reader, queue = _reader([Response(503, b"")] * r2.PUBLIC_TRIES)
    response = reader.fetch("releases/x/index/E.json")
    assert response.status == 503
    assert queue == []
    assert _no_real_sleep == list(r2.PUBLIC_BACKOFF_S[: r2.PUBLIC_TRIES - 1])


def test_a_persistent_transport_failure_still_raises(_no_real_sleep):
    reader, _ = _reader([urllib.error.URLError("down")] * r2.PUBLIC_TRIES)
    with pytest.raises(r2.R2Error, match="transport error"):
        reader.fetch("releases/x/index/F.json")


def test_the_cache_bust_survives_the_retry(_no_real_sleep):
    seen: list[str] = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(503, b"") if len(seen) == 1 else Response(200, b"ok")

    reader = r2.PublicReader("https://data.example", opener=opener)
    reader.fetch("releases/x/index/G.json", cache_bust="abc123")
    assert seen == [
        "https://data.example/releases/x/index/G.json?v=abc123",
        "https://data.example/releases/x/index/G.json?v=abc123",
    ]
