"""SEC EDGAR HTTP client.

Rules this module exists to enforce, not suggest (SEC developer resources):

* every request declares a real contact in ``User-Agent`` — no UA is a 403;
* ≤8 requests/second process-wide, under SEC's stated 10 req/s cap;
* gzip in, gzip out, and a byte cache keyed by URL so a rerun never refetches.

The cache is content-addressed: ``data/cache/<sha256(url)>.bin`` plus a ``.json``
sidecar recording what was fetched and when. Reruns read the cache, so a release
built twice from the same inputs is reproducible and EDGAR is hit once.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from threading import Lock

USER_AGENT_ENV = "SEC_USER_AGENT"
DEFAULT_USER_AGENT = "UnpackFund research data@unpackfund.com"
MIN_INTERVAL_S = 1 / 8
CACHE_DIR = Path(os.environ.get("UNPACKFUND_CACHE", "data/cache"))

_last_request = 0.0
_throttle_lock = Lock()


class SecError(RuntimeError):
    """A fetch that failed after retries, or a response we refuse to parse."""


def user_agent() -> str:
    ua = os.environ.get(USER_AGENT_ENV, DEFAULT_USER_AGENT).strip()
    if "@" not in ua:
        raise SecError(
            f"{USER_AGENT_ENV} must contain a contact address; SEC returns 403 without one"
        )
    return ua


def _throttle() -> None:
    global _last_request
    with _throttle_lock:
        wait = MIN_INTERVAL_S - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.monotonic()


def _cache_paths(url: str) -> tuple[Path, Path]:
    digest = hashlib.sha256(url.encode()).hexdigest()
    stem = CACHE_DIR / digest[:2] / digest
    return stem.with_suffix(".bin"), stem.with_suffix(".json")


def fetch(
    url: str,
    *,
    timeout: float = 45.0,
    tries: int = 4,
    use_cache: bool = True,
) -> bytes:
    """Return the body for ``url``, from cache when present."""
    body_path, meta_path = _cache_paths(url)
    if use_cache and body_path.exists():
        return body_path.read_bytes()

    last_error: Exception | None = None
    for attempt in range(tries):
        _throttle()
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": user_agent(),
                "Accept-Encoding": "gzip, deflate",
                "Accept": "application/json, text/xml, */*",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                encoding = response.headers.get("Content-Encoding")
                content_type = response.headers.get("Content-Type", "")
                if encoding == "gzip":
                    body = gzip.decompress(body)
            if body_path.parent.exists() or use_cache:
                body_path.parent.mkdir(parents=True, exist_ok=True)
                body_path.write_bytes(body)
                meta_path.write_text(
                    json.dumps(
                        {
                            "url": url,
                            "retrieved_utc": time.strftime(
                                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                            ),
                            "bytes": len(body),
                            "sha256": hashlib.sha256(body).hexdigest(),
                            "content_type": content_type,
                        },
                        indent=2,
                    )
                    + "\n"
                )
            return body
        except urllib.error.HTTPError as error:  # noqa: PERF203 - retry is the point
            last_error = error
            # 403 is EDGAR's shape/rate policing as well as a UA problem; back off
            # rather than concluding the URL is wrong.
            if error.code not in (403, 429, 500, 502, 503, 504) or attempt == tries - 1:
                raise SecError(f"HTTP {error.code} for {url}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            if attempt == tries - 1:
                raise SecError(f"{type(error).__name__} for {url}") from error
        time.sleep(2**attempt * 0.5 + random.random() * 0.5)

    raise SecError(f"exhausted retries for {url}: {last_error}")


def fetch_json(url: str, **kwargs) -> dict:
    try:
        return json.loads(fetch(url, **kwargs))
    except json.JSONDecodeError as error:
        raise SecError(f"not JSON: {url}") from error


def submissions_url(cik: str | int) -> str:
    return f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json"


def primary_doc_url(cik: str | int, accession: str) -> str:
    return (
        f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
        f"{accession.replace('-', '')}/primary_doc.xml"
    )


def filing_dir_url(cik: str | int, accession: str) -> str:
    return (
        f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
        f"{accession.replace('-', '')}/"
    )


def is_sec_host(url: str) -> bool:
    host = urllib.parse.urlsplit(url).hostname or ""
    return host == "sec.gov" or host.endswith(".sec.gov")
