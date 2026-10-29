"""R2 client tests: URLs, signing shape, error mapping — no network.

The transport is exercised against a fake opener so the tests stay offline and
can assert exactly what would be sent: a real upload is covered by
`pnpm release:upload`, which is where a signature error shows up as a 403.
"""

from __future__ import annotations

import hashlib
import io
import urllib.error

import pytest

from pipeline import r2
from pipeline.sigv4 import EMPTY_PAYLOAD_SHA256

CREDS = r2.Credentials(access_key_id="AKIDEXAMPLE", secret_access_key="s3cr3t")


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200, headers: dict | None = None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def make_client(captured: list, response: FakeResponse | None = None) -> r2.R2Client:
    def opener(request, timeout=None):
        captured.append(request)
        return response or FakeResponse(b"")

    return r2.R2Client("https://acct.r2.cloudflarestorage.com", "unpackfund-artifacts", CREDS, opener=opener)


def test_object_url_is_path_style_and_quoted():
    client = make_client([])
    assert client.object_url("releases/2026-10-28.2/funds/VOO.json") == (
        "https://acct.r2.cloudflarestorage.com/unpackfund-artifacts/releases/2026-10-28.2/funds/VOO.json"
    )
    assert client.object_url("staging/a b.json") == (
        "https://acct.r2.cloudflarestorage.com/unpackfund-artifacts/staging/a%20b.json"
    )


def test_put_signs_the_metadata_it_sends():
    captured: list = []
    client = make_client(captured, FakeResponse(b"", headers={"etag": '"abc123"'}))
    etag = client.put("releases/x/funds/VOO.json", b'{"a":1}', cache_control=r2.IMMUTABLE)
    assert etag == "abc123"

    request = captured[0]
    assert request.get_method() == "PUT"
    assert request.data == b'{"a":1}'
    headers = {key.lower(): value for key, value in request.header_items()}
    assert headers["cache-control"] == r2.IMMUTABLE
    assert headers["content-type"] == r2.JSON_CONTENT_TYPE
    assert headers["x-amz-content-sha256"] == hashlib.sha256(b'{"a":1}').hexdigest()
    assert headers["x-amz-date"]
    assert headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date" in headers["authorization"]


def test_head_reads_capitalised_headers():
    """R2 sends `Content-Length`/`ETag`; a lowercase lookup used to report 0 bytes."""
    headers = {
        "Content-Type": "application/json",
        "Content-Length": "1335",
        "Cache-Control": r2.IMMUTABLE,
        "ETag": '"fb9e89d74265eeb39633bda83508b8f3"',
    }
    client = make_client([], FakeResponse(b"", headers=headers))
    head = client.head("releases/x/manifest.json")
    assert head is not None
    assert head.size == 1335
    assert head.etag == "fb9e89d74265eeb39633bda83508b8f3"
    assert head.cache_control == r2.IMMUTABLE
    assert head.content_type == "application/json"


def test_head_returns_none_on_404():
    def opener(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b""))

    client = r2.R2Client("https://e", "b", CREDS, opener=opener)
    assert client.head("latest/manifest.json") is None


def test_get_raises_r2_error_with_status():
    def opener(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, io.BytesIO(b"<Error>SignatureDoesNotMatch</Error>"))

    client = r2.R2Client("https://e", "b", CREDS, opener=opener)
    with pytest.raises(r2.R2Error) as caught:
        client.get("releases/x/manifest.json")
    assert caught.value.status == 403
    assert "SignatureDoesNotMatch" in caught.value.body
    assert "releases/x/manifest.json" in str(caught.value)


def test_list_keys_parses_the_xml():
    body = (
        b"<ListBucketResult><Contents><Key>releases/a/manifest.json</Key></Contents>"
        b"<Contents><Key>releases/a/funds/VOO.json</Key></Contents></ListBucketResult>"
    )
    client = make_client([], FakeResponse(body))
    assert client.list_keys("releases/") == ["releases/a/manifest.json", "releases/a/funds/VOO.json"]


def test_list_query_is_signed_sorted():
    captured: list = []
    make_client(captured, FakeResponse(b"<ListBucketResult/>")).list_keys("releases/")
    assert "list-type=2" in captured[0].full_url
    assert "prefix=releases%2F" in captured[0].full_url


def test_credentials_repr_never_shows_the_secret():
    assert "s3cr3t" not in repr(CREDS)
    assert CREDS.access_key_id[:4] in repr(CREDS)


def test_public_reader_sends_a_user_agent_the_edge_does_not_block():
    captured: list = []

    def opener(request, timeout=None):
        captured.append(request)
        return FakeResponse(b"{}")

    reader = r2.PublicReader("https://data.example", opener=opener)
    reader.fetch("releases/x/manifest.json", origin="http://localhost:3000")
    headers = {key.lower(): value for key, value in captured[0].header_items()}
    assert headers["user-agent"] == r2.PUBLIC_USER_AGENT
    assert headers["origin"] == "http://localhost:3000"
    assert headers["cache-control"] == "no-cache"


def test_empty_payload_hash_is_the_constant():
    assert EMPTY_PAYLOAD_SHA256 == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
