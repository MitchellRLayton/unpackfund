"""R2 transport: the four S3 verbs the release step needs, and a public reader.

Nothing here knows about funds or manifests. It knows how to sign a request, how
to turn an HTTP status into a sentence a human can act on, and how to read back
what it wrote. The release command composes it; the tests substitute it.

Credentials are passed in, never read from the environment here, and never
logged: `R2Error` carries a status and a response body, and R2's error bodies
name the operation and the key, not the key material.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Mapping

from .sigv4 import EMPTY_PAYLOAD_SHA256, sign

JSON_CONTENT_TYPE = "application/json"
IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"


@dataclass(frozen=True)
class Credentials:
    access_key_id: str
    secret_access_key: str

    def __repr__(self) -> str:  # never let a traceback print the secret
        return f"Credentials(access_key_id={self.access_key_id[:4]}…, secret=***)"


class R2Error(RuntimeError):
    def __init__(self, operation: str, status: int, body: str, key: str | None = None):
        self.operation = operation
        self.status = status
        self.body = body
        self.key = key
        where = f" on {key}" if key else ""
        super().__init__(f"{operation}{where} failed: HTTP {status}: {body[:300]}")


@dataclass(frozen=True)
class ObjectHead:
    key: str
    size: int
    etag: str
    content_type: str | None
    cache_control: str | None


class R2Client:
    """Path-style S3 client against one bucket. Region is always `auto` on R2."""

    def __init__(
        self,
        endpoint: str,
        bucket: str,
        credentials: Credentials,
        *,
        timeout: float = 30.0,
        opener=None,
    ):
        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.credentials = credentials
        self.timeout = timeout
        self._opener = opener or urllib.request.urlopen

    # -- URLs and signing ---------------------------------------------------
    def object_url(self, key: str) -> str:
        return f"{self.endpoint}/{self.bucket}/{urllib.parse.quote(key, safe='/')}"

    def _send(
        self,
        method: str,
        url: str,
        *,
        body: bytes = b"",
        headers: Mapping[str, str] | None = None,
        signed_headers: Mapping[str, str] | None = None,
        key: str | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        request_headers = dict(headers or {})
        request_headers.update(
            sign(
                method,
                url,
                access_key_id=self.credentials.access_key_id,
                secret_access_key=self.credentials.secret_access_key,
                body=body,
                headers=dict(signed_headers or {}),
            )
        )
        request = urllib.request.Request(url, data=body if body else None, method=method, headers=request_headers)
        try:
            with self._opener(request, timeout=self.timeout) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise R2Error(method, error.code, detail, key) from error
        except urllib.error.URLError as error:
            raise R2Error(method, 0, f"transport error: {error.reason}", key) from error

    # -- verbs --------------------------------------------------------------
    def put(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = JSON_CONTENT_TYPE,
        cache_control: str = IMMUTABLE,
    ) -> str:
        """Upload one object; returns the ETag R2 reports."""
        metadata = {"content-type": content_type, "cache-control": cache_control}
        _, headers, _ = self._send(
            "PUT", self.object_url(key), body=body, headers=metadata, signed_headers=metadata, key=key
        )
        return headers.get("etag", "").strip('"')

    def head(self, key: str) -> ObjectHead | None:
        try:
            _, headers, _ = self._send(
                "HEAD",
                self.object_url(key),
                signed_headers={"x-amz-content-sha256": EMPTY_PAYLOAD_SHA256},
                key=key,
            )
        except R2Error as error:
            if error.status == 404:
                return None
            raise
        return ObjectHead(
            key=key,
            size=int(headers.get("content-length") or 0),
            etag=headers.get("etag", "").strip('"'),
            content_type=headers.get("content-type"),
            cache_control=headers.get("cache-control"),
        )

    def get(self, key: str) -> bytes:
        _, _, body = self._send("GET", self.object_url(key), key=key)
        return body

    def list_keys(self, prefix: str = "") -> list[str]:
        """One page is enough for a release (tens of objects); `truncated` is reported."""
        query = urllib.parse.urlencode({"list-type": "2", "prefix": prefix, "max-keys": "1000"})
        url = f"{self.endpoint}/{self.bucket}?{query}"
        _, _, body = self._send("GET", url, key=prefix or None)
        text = body.decode("utf-8", "replace")
        keys = []
        for chunk in text.split("<Key>")[1:]:
            keys.append(chunk.split("</Key>", 1)[0])
        return keys


@dataclass(frozen=True)
class PublicResponse:
    url: str
    status: int
    headers: Mapping[str, str]
    body: bytes

    @property
    def allow_origin(self) -> str | None:
        for name, value in self.headers.items():
            if name.lower() == "access-control-allow-origin":
                return value
        return None

    def header(self, name: str) -> str | None:
        for key, value in self.headers.items():
            if key.lower() == name.lower():
                return value
        return None


class PublicReader:
    """Fetch what a browser would fetch, from the public data host.

    The release step verifies against this, not against the S3 endpoint: an object
    can be stored correctly and still be unreachable, uncached, or CORS-blocked,
    and those are the failures that reach a user.
    """

    def __init__(self, base_url: str, *, timeout: float = 30.0, opener=None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._opener = opener or urllib.request.urlopen

    def fetch(self, key: str, *, origin: str | None = None) -> PublicResponse:
        url = f"{self.base_url}/{urllib.parse.quote(key, safe='/')}"
        headers = {"Origin": origin} if origin else {}
        # Ask intermediaries for a fresh copy: a cached 404 from before the upload
        # would otherwise be indistinguishable from a failed upload.
        headers["Cache-Control"] = "no-cache"
        request = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with self._opener(request, timeout=self.timeout) as response:
                return PublicResponse(url, response.status, dict(response.headers), response.read())
        except urllib.error.HTTPError as error:
            return PublicResponse(url, error.code, dict(error.headers or {}), error.read())
        except urllib.error.URLError as error:
            raise R2Error("GET", 0, f"transport error: {error.reason}", key) from error

    def fetch_json(self, key: str, *, origin: str | None = None) -> dict:
        response = self.fetch(key, origin=origin)
        if response.status != 200:
            raise R2Error("GET", response.status, response.body.decode("utf-8", "replace"), key)
        return json.loads(response.body)
