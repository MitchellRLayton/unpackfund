"""R2 transport: the S3 verbs the release and retention steps need, and a public reader.

Nothing here knows about funds or manifests. It knows how to sign a request, how
to turn an HTTP status into a sentence a human can act on, and how to read back
what it wrote. The release command composes it; the retention command lists,
deletes and batches; the tests substitute it.

Credentials are passed in, never read from the environment here, and never
logged: `R2Error` carries a status and a response body, and R2's error bodies
name the operation and the key, not the key material.
"""

from __future__ import annotations

import base64
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Mapping, Sequence

from .sigv4 import EMPTY_PAYLOAD_SHA256, sign

JSON_CONTENT_TYPE = "application/json"
XML_CONTENT_TYPE = "application/xml"

#: S3's ceiling on one DeleteObjects request. 14,239 objects take 15 requests at
#: this size instead of 14,239 — and a delete is free either way, so the only
#: thing batching buys is time.
DELETE_BATCH_LIMIT = 1000

#: Real R2 XML carries this default namespace; a hand-written fixture usually does
#: not. The two helpers below accept both shapes rather than one, so a test can
#: state a listing in the smallest form that is still the same document.
S3_NAMESPACE = "{http://s3.amazonaws.com/doc/2006-03-01/}"


def _findtext(node, name: str) -> str | None:
    value = node.findtext(f"{S3_NAMESPACE}{name}")
    return node.findtext(name) if value is None else value


def _findall(node, name: str) -> list:
    found = node.findall(f"{S3_NAMESPACE}{name}")
    return found if found else node.findall(name)


def delete_request_body(keys: Sequence[str]) -> bytes:
    """The `DeleteObjects` XML: one `<Object><Key>` per key, in the S3 namespace."""
    root = ET.Element("Delete", {"xmlns": "http://s3.amazonaws.com/doc/2006-03-01/"})
    for key in keys:
        ET.SubElement(ET.SubElement(root, "Object"), "Key").text = key
    return ET.tostring(root, encoding="utf-8")

# The data host sits behind Cloudflare, which answers 403 to a bare
# `Python-urllib/3.x` User-Agent (measured 2026-10-29: curl, python-requests and a
# named crawler UA all get 200). This reader exists to see what a browser sees, so
# it presents a named crawler identity rather than a library default — the failure
# it must detect is a missing object or header, not an edge rule.
PUBLIC_USER_AGENT = "Mozilla/5.0 (compatible; UnpackFund/0.1; +https://unpackfund.com)"
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


def lower_headers(headers) -> dict[str, str]:
    """Header names arrive capitalised (`Content-Length`, `ETag`), so normalise them
    once: every caller here looks a header up by its lowercase name."""
    return {name.lower(): value for name, value in headers.items()}


@dataclass(frozen=True)
class ObjectHead:
    key: str
    size: int
    etag: str
    content_type: str | None
    cache_control: str | None


@dataclass(frozen=True)
class ObjectEntry:
    """One row of a bucket listing: what it is called and what it costs to store.

    `size` is what R2 says it holds, not what a download returned — the retention
    plan's byte totals are storage arithmetic, so it must come from the listing.
    """

    key: str
    size: int = 0


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
        sign_url: str | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        # `sign_url` exists because `sigv4.canonical_query` takes the query in its
        # *decoded* form (its own test pins `prefix=releases/` → `prefix=releases%2F`),
        # while the URL on the wire must be percent-encoded. Signing the wire URL
        # double-encodes every value — a `max-keys`-only listing happens to be
        # unaffected, so this only bites on `prefix` and `continuation-token`, where
        # it is a 403 `SignatureDoesNotMatch`. Measured against the real bucket
        # 2026-10-30: signing the decoded query lists all 57 pages.
        request_headers = dict(headers or {})
        request_headers.update(
            sign(
                method,
                sign_url or url,
                access_key_id=self.credentials.access_key_id,
                secret_access_key=self.credentials.secret_access_key,
                body=body,
                headers=dict(signed_headers or {}),
            )
        )
        request = urllib.request.Request(url, data=body if body else None, method=method, headers=request_headers)
        try:
            with self._opener(request, timeout=self.timeout) as response:
                return response.status, lower_headers(response.headers), response.read()
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

    def _list_page(
        self, prefix: str, token: str | None, page_size: int
    ) -> tuple[list[ObjectEntry], str | None]:
        """One `ListObjectsV2` page: the entries and the token for the next one."""
        params: list[tuple[str, str]] = [("list-type", "2"), ("max-keys", str(page_size))]
        if prefix:
            params.append(("prefix", prefix))
        if token:
            params.append(("continuation-token", token))
        encoded = "&".join(
            f"{urllib.parse.quote(name, safe='')}={urllib.parse.quote(value, safe='')}" for name, value in params
        )
        decoded = "&".join(f"{name}={value}" for name, value in params)
        _, _, body = self._send(
            "GET",
            f"{self.endpoint}/{self.bucket}?{encoded}",
            sign_url=f"{self.endpoint}/{self.bucket}?{decoded}",
            key=prefix or None,
        )
        try:
            root = ET.fromstring(body)
        except ET.ParseError as error:
            raise R2Error("ListObjectsV2", 0, f"unparseable listing: {error}", prefix or None) from error

        entries = [
            ObjectEntry(key=_findtext(contents, "Key") or "", size=int(_findtext(contents, "Size") or 0))
            for contents in _findall(root, "Contents")
        ]
        truncated = (_findtext(root, "IsTruncated") or "false").strip().lower() == "true"
        next_token = _findtext(root, "NextContinuationToken") if truncated else None
        if truncated and not next_token:
            # Silently returning page one would make a bucket look 1,000 objects
            # smaller than it is — which is exactly the state a mass-delete guard
            # must never see.
            raise R2Error("ListObjectsV2", 0, "truncated listing with no continuation token", prefix or None)
        return entries, next_token

    def list_objects(
        self, prefix: str = "", *, page_size: int = 1000, max_pages: int = 10_000
    ) -> list[ObjectEntry]:
        """Every object under `prefix`, following continuation tokens to the end.

        `list_keys` used to read one page with a string split; that is enough for a
        five-fund release and wrong for a bucket holding a month of 14,000-object
        releases, where the first page is 7% of the answer.
        """
        entries: list[ObjectEntry] = []
        token: str | None = None
        for _page in range(max_pages):
            page, token = self._list_page(prefix, token, page_size)
            entries.extend(page)
            if not token:
                return entries
        raise R2Error(
            "ListObjectsV2", 0, f"listing {prefix!r} still truncated after {max_pages} pages", prefix or None
        )

    def list_keys(self, prefix: str = "") -> list[str]:
        """The keys under `prefix`, every page of them."""
        return [entry.key for entry in self.list_objects(prefix)]

    def delete_object(self, key: str) -> None:
        """Delete one object. Missing is not an error: DELETE is idempotent on R2."""
        try:
            self._send("DELETE", self.object_url(key), key=key)
        except R2Error as error:
            if error.status == 404:
                return
            raise

    def delete_objects(self, keys: Sequence[str]) -> int:
        """Delete up to `DELETE_BATCH_LIMIT` objects in one request; returns how many.

        DeleteObject is free on R2, so a batch buys time only: the first real
        retention run removes ~40,000 objects, which is 41 requests this way and
        40,000 the other. A key that is already gone is reported as deleted by S3
        (that is the verb's contract) and is never an error here.
        """
        batch = list(keys)
        if not batch:
            return 0
        if len(batch) > DELETE_BATCH_LIMIT:
            raise ValueError(f"delete_objects takes at most {DELETE_BATCH_LIMIT} keys, got {len(batch)}")
        body = delete_request_body(batch)
        headers = {
            "content-type": XML_CONTENT_TYPE,
            "content-md5": base64.b64encode(hashlib.md5(body).digest()).decode("ascii"),
        }
        _, _, response = self._send(
            "POST",
            f"{self.endpoint}/{self.bucket}?delete",
            body=body,
            headers=headers,
            signed_headers=headers,
        )
        try:
            root = ET.fromstring(response)
        except ET.ParseError as error:
            raise R2Error("DeleteObjects", 0, f"unparseable delete response: {error}") from error

        deleted = len(_findall(root, "Deleted"))
        failed = _findall(root, "Error")
        # A key deleted twice, or deleted by an earlier interrupted run, comes back
        # as `NoSuchKey` on some S3 implementations — the verb's contract says that
        # is success, so it counts as deleted rather than aborting a clean-up.
        missing = [error for error in failed if (_findtext(error, "Code") or "") in ("NoSuchKey", "404")]
        hard = [error for error in failed if error not in missing]
        if hard:
            detail = "; ".join(f"{_findtext(error, 'Key')}: {_findtext(error, 'Code')}" for error in hard[:5])
            raise R2Error("DeleteObjects", 200, detail)
        if not deleted and not failed:
            # A 200 with no per-key entries is not a shape S3 produces; if it ever
            # does, the batch was accepted, so report it as confirmed rather than
            # turning it into a silent no-op the caller would read as "failed".
            return len(batch)
        return deleted + len(missing)


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
        headers = {"User-Agent": PUBLIC_USER_AGENT}
        if origin:
            headers["Origin"] = origin
        # Ask intermediaries for a fresh copy: a cached 404 from before the upload
        # would otherwise be indistinguishable from a failed upload.
        headers["Cache-Control"] = "no-cache"
        request = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with self._opener(request, timeout=self.timeout) as response:
                return PublicResponse(url, response.status, lower_headers(response.headers), response.read())
        except urllib.error.HTTPError as error:
            return PublicResponse(url, error.code, lower_headers(error.headers or {}), error.read())
        except urllib.error.URLError as error:
            raise R2Error("GET", 0, f"transport error: {error.reason}", key) from error
        except (TimeoutError, OSError) as error:
            # A socket timeout surfaces as a bare `TimeoutError` from the read, not as a
            # `URLError`, and `socket.timeout` *is* `TimeoutError` on 3.10+. Unwrapped, it
            # escapes every handler that knows what a transport failure is: on 2026-10-30
            # one 30 s read timeout aborted a 13,482-object upload after every object had
            # already landed.
            raise R2Error("GET", 0, f"transport error: {error!r}", key) from error

    def fetch_json(self, key: str, *, origin: str | None = None) -> dict:
        response = self.fetch(key, origin=origin)
        if response.status != 200:
            raise R2Error("GET", response.status, response.body.decode("utf-8", "replace"), key)
        return json.loads(response.body)
