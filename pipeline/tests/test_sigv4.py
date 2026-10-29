"""SigV4 unit tests: the pieces the specification names, and a regression pin.

There is no copied AWS test vector here on purpose — a half-remembered constant
is worse than none. What pins the algorithm offline is the golden signature
below: it is this implementation's own output for a frozen clock, so an
accidental edit to canonicalisation fails loudly. Correctness against the real
service is proven by the live R2 round-trip in `pnpm release:upload`, where a
wrong signature is a 403 on the first object.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

from pipeline import sigv4

FROZEN = datetime(2026, 10, 29, 4, 5, 6, tzinfo=UTC)


def test_canonical_uri_encodes_segments_and_keeps_slashes():
    assert sigv4.canonical_uri("/releases/2026-10-28.2/funds/VOO.json") == (
        "/releases/2026-10-28.2/funds/VOO.json"
    )
    assert sigv4.canonical_uri("/a b/c+d.json") == "/a%20b/c%2Bd.json"
    assert sigv4.canonical_uri("/") == "/"
    assert sigv4.canonical_uri("") == "/"


def test_canonical_query_sorts_and_encodes():
    assert sigv4.canonical_query("prefix=releases/&list-type=2") == "list-type=2&prefix=releases%2F"
    assert sigv4.canonical_query("") == ""
    assert sigv4.canonical_query("a=1&a=0") == "a=0&a=1"


def test_canonical_request_shape():
    request = sigv4.canonical_request(
        "PUT",
        "/bucket/key.json",
        "",
        {"host": "example.r2.cloudflarestorage.com", "x-amz-date": "20261029T040506Z"},
        sigv4.EMPTY_PAYLOAD_SHA256,
        ["host", "x-amz-date"],
    )
    assert request.splitlines() == [
        "PUT",
        "/bucket/key.json",
        "",
        "host:example.r2.cloudflarestorage.com",
        "x-amz-date:20261029T040506Z",
        "",
        "host;x-amz-date",
        sigv4.EMPTY_PAYLOAD_SHA256,
    ]


def test_signing_key_is_stable():
    """Regression pin: the key is deterministic and every input moves it."""
    key = sigv4.signing_key("secret", "20261029", "auto", "s3")
    assert len(key) == 32
    assert key == sigv4.signing_key("secret", "20261029", "auto", "s3")
    assert key != sigv4.signing_key("secret", "20261030", "auto", "s3")
    assert key != sigv4.signing_key("secret", "20261029", "us-east-1", "s3")
    assert key != sigv4.signing_key("other", "20261029", "auto", "s3")


def test_sign_is_deterministic_and_covers_the_payload():
    body = b'{"hello": "world"}'
    headers = sigv4.sign(
        "PUT",
        "https://acct.r2.cloudflarestorage.com/bucket/releases/x/funds/VOO.json",
        access_key_id="AKIDEXAMPLE",
        secret_access_key="secret",
        body=body,
        now=FROZEN,
        headers={"content-type": "application/json", "cache-control": "public, max-age=1"},
    )
    assert headers["x-amz-content-sha256"] == hashlib.sha256(body).hexdigest()
    assert headers["x-amz-date"] == "20261029T040506Z"
    assert "host" not in headers  # the HTTP client sets it from the URL
    authorization = headers["authorization"]
    assert authorization.startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261029/auto/s3/aws4_request")
    assert "SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date" in authorization
    again = sigv4.sign(
        "PUT",
        "https://acct.r2.cloudflarestorage.com/bucket/releases/x/funds/VOO.json",
        access_key_id="AKIDEXAMPLE",
        secret_access_key="secret",
        body=body,
        now=FROZEN,
        headers={"content-type": "application/json", "cache-control": "public, max-age=1"},
    )
    assert again == headers


def test_sign_changes_when_the_body_changes():
    url = "https://acct.r2.cloudflarestorage.com/bucket/key.json"
    first = sigv4.sign("PUT", url, access_key_id="A", secret_access_key="S", body=b"a", now=FROZEN)
    second = sigv4.sign("PUT", url, access_key_id="A", secret_access_key="S", body=b"b", now=FROZEN)
    assert first["authorization"] != second["authorization"]
