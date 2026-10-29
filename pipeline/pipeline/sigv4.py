"""AWS Signature Version 4, standard library only.

R2 exposes an S3 API that requires SigV4; the alternative is boto3, a ~40 MB
dependency for four HTTP verbs. This module is the whole algorithm in the order
the specification defines it, so the release step stays a stdlib script that
runs in CI with nothing installed.

Spec compliance is proven end to end rather than by a copied test vector: a
wrong signature makes R2 answer 403 `SignatureDoesNotMatch`, and the release
command fails on the first object it uploads. `tests/test_sigv4.py` pins the
canonical request and the derived key so an accidental edit is caught offline.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit

ALGORITHM = "AWS4-HMAC-SHA256"
EMPTY_PAYLOAD_SHA256 = hashlib.sha256(b"").hexdigest()


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret_access_key: str, datestamp: str, region: str, service: str) -> bytes:
    """The four-step key derivation: secret -> date -> region -> service -> aws4_request."""
    key = ("AWS4" + secret_access_key).encode("utf-8")
    for part in (datestamp, region, service, "aws4_request"):
        key = _hmac(key, part)
    return key


def canonical_uri(path: str) -> str:
    """Encode each segment, keep the slashes: an R2 key is a path, not an opaque string."""
    if not path or path == "/":
        return "/"
    return "/".join(quote(segment, safe="-_.~") for segment in path.split("/"))


def canonical_query(query: str) -> str:
    """Sort by key then value, percent-encoded, `=` kept even for an empty value."""
    if not query:
        return ""
    pairs = []
    for item in query.split("&"):
        if not item:
            continue
        key, _, value = item.partition("=")
        pairs.append((quote(key, safe="-_.~"), quote(value, safe="-_.~")))
    return "&".join(f"{key}={value}" for key, value in sorted(pairs))


def canonical_request(
    method: str,
    path: str,
    query: str,
    headers: dict[str, str],
    payload_hash: str,
    signed_headers: list[str],
) -> str:
    """The six-line canonical request. `headers` keys must already be lowercase."""
    lines = [
        method.upper(),
        canonical_uri(path),
        canonical_query(query),
        "".join(f"{name}:{' '.join(headers[name].split())}\n" for name in signed_headers),
        ";".join(signed_headers),
        payload_hash,
    ]
    return "\n".join(lines)


def string_to_sign(amz_date: str, scope: str, request_hash: str) -> str:
    return "\n".join([ALGORITHM, amz_date, scope, request_hash])


def sign(
    method: str,
    url: str,
    *,
    access_key_id: str,
    secret_access_key: str,
    body: bytes = b"",
    region: str = "auto",
    service: str = "s3",
    now: datetime | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, str]:
    """Return the headers to send: `Authorization` plus every signed header.

    `Host` is signed but not returned — the HTTP client sets it from the URL, and
    a client that overrides it must pass it in `headers` so the signature matches.
    """
    moment = now or datetime.now(UTC)
    amz_date = moment.strftime("%Y%m%dT%H%M%SZ")
    datestamp = moment.strftime("%Y%m%d")
    parts = urlsplit(url)
    payload_hash = hashlib.sha256(body).hexdigest()

    to_sign_headers = {
        "host": parts.netloc,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    to_sign_headers.update({name.lower(): value for name, value in (headers or {}).items()})
    signed_names = sorted(to_sign_headers)

    scope = f"{datestamp}/{region}/{service}/aws4_request"
    request = canonical_request(method, parts.path, parts.query, to_sign_headers, payload_hash, signed_names)
    signature = hmac.new(
        signing_key(secret_access_key, datestamp, region, service),
        string_to_sign(amz_date, scope, hashlib.sha256(request.encode("utf-8")).hexdigest()).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    out = {name: value for name, value in to_sign_headers.items() if name != "host"}
    out["authorization"] = (
        f"{ALGORITHM} Credential={access_key_id}/{scope}, "
        f"SignedHeaders={';'.join(signed_names)}, Signature={signature}"
    )
    return out
