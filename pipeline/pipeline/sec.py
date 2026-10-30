"""SEC EDGAR HTTP client.

Rules this module exists to enforce, not suggest (SEC developer resources):

* every request declares a real contact in ``User-Agent`` — no UA is a 403;
* ≤8 requests/second process-wide, under SEC's stated 10 req/s cap;
* gzip in, gzip out, and a byte cache keyed by URL so a rerun never refetches.

The cache is content-addressed: ``data/cache/<sha256(url)>.bin`` plus a ``.json``
sidecar recording what was fetched and when. Reruns read the cache, so a release
built twice from the same inputs is reproducible and EDGAR is hit once.

**Two kinds of URL, two lifetimes.** An accession-addressed document
(``Archives/edgar/data/…/primary_doc.xml``) is immutable once filed, so caching it
forever is both safe and the reason a rebuild is cheap. An *index* document
(``submissions/CIK…json``, ``company_tickers_mf.json``) is rewritten in place, so a
cache that never expires is how a scheduled refresh would answer "nothing changed"
every day forever. ``max_age`` is the caller's statement about which kind it is:

* ``max_age=None`` (default) — final, never refetch. Immutable documents.
* ``max_age=0`` — always refetch.
* ``max_age=<seconds>`` — refetch when the sidecar's ``retrieved_utc`` is older.
"""

from __future__ import annotations

import calendar
import email.utils
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
#: Seconds between requests, process-wide. 8/s keeps us under SEC's stated 10/s cap from
#: our own machine, which is what the number was measured against. On a CI runner the
#: cap is shared with every other job behind the same egress IP, so the workflow lowers
#: the rate rather than racing for it: ``SEC_REQUESTS_PER_SECOND=5``.
MIN_INTERVAL_S = 1 / float(os.environ.get("SEC_REQUESTS_PER_SECOND", "8"))
CACHE_DIR = Path(os.environ.get("UNPACKFUND_CACHE", "data/cache"))

# EDGAR answers 429 when an IP exceeds ~10 requests/second, and a CI runner shares its
# egress IP with every job on that host — so a wide build sees throttling it did not
# cause and cannot avoid by being polite itself. These are the knobs that turn that from
# a dead run into a slower one: more attempts, `Retry-After` honoured, and a backoff
# ceiling high enough to outlast a throttle window.
RETRY_STATUSES = (403, 429, 500, 502, 503, 504)
THROTTLE_STATUSES = (403, 429)
DEFAULT_TRIES = 6
BACKOFF_CAP_S = 20.0
MAX_RETRY_AFTER_S = 60.0

#: How long an *index* document may be reused before EDGAR is asked again.
#:
#: N-PORT documents are accession-addressed, so a cached copy is final. Index documents
#: are rewritten in place: `submissions/CIK….json` gains a row every time a fund files,
#: and `company_tickers_mf.json` gains a fund whenever one launches. A daily run that
#: restored yesterday's cache and treated those as final would resolve every fund to its
#: *previous* filing — correct-looking, silently a quarter behind — which is exactly the
#: failure the module docstring warns about and no caller used to declare. Six hours is
#: shorter than the run interval and long enough that one run reads each index once.
INDEX_MAX_AGE_S = 6 * 3600

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


def retry_after_seconds(headers) -> float | None:
    """The server's own instruction, when it sends one.

    `Retry-After` is either delta-seconds or an HTTP date. Honouring it is both more
    polite and more effective than guessing: EDGAR's throttle window is longer than an
    exponential backoff from 0.5 s reaches in four attempts.
    """
    value = headers.get("Retry-After") if headers else None
    if not value:
        return None
    text = str(value).strip()
    try:
        return min(MAX_RETRY_AFTER_S, max(0.0, float(text)))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    delta = when.timestamp() - time.time()
    return min(MAX_RETRY_AFTER_S, max(0.0, delta))


def backoff_seconds(attempt: int) -> float:
    """Exponential, capped, jittered: two workers must not resume together."""
    return min(BACKOFF_CAP_S, 2**attempt * 0.5) + random.random() * 0.5


def _cache_paths(url: str) -> tuple[Path, Path]:
    digest = hashlib.sha256(url.encode()).hexdigest()
    stem = CACHE_DIR / digest[:2] / digest
    return stem.with_suffix(".bin"), stem.with_suffix(".json")


def _cached_body_is_usable(body_path: Path, meta_path: Path, max_age: float | None) -> bool:
    """Is the cached body present, and (for a mutable document) young enough?

    A missing or unreadable sidecar counts as stale: the only thing worse than
    refetching is trusting a timestamp we cannot read.
    """
    if not body_path.exists():
        return False
    if max_age is None:
        return True
    if max_age <= 0:
        return False
    try:
        retrieved = json.loads(meta_path.read_text())["retrieved_utc"]
        when = calendar.timegm(time.strptime(retrieved, "%Y-%m-%dT%H:%M:%SZ"))
    except (OSError, KeyError, ValueError, TypeError):
        return False
    return time.time() - when <= max_age


def fetch(
    url: str,
    *,
    timeout: float = 45.0,
    tries: int = DEFAULT_TRIES,
    use_cache: bool = True,
    max_age: float | None = None,
) -> bytes:
    """Return the body for ``url``, from cache when present and still usable.

    ``max_age`` is the caller's promise about the document's mutability; see the
    module docstring. The default keeps the original contract (a cached body is
    final), so every existing caller is unchanged.
    """
    body_path, meta_path = _cache_paths(url)
    if use_cache and _cached_body_is_usable(body_path, meta_path, max_age):
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
            if error.code not in RETRY_STATUSES or attempt == tries - 1:
                raise SecError(f"HTTP {error.code} for {url}") from error
            if error.code in THROTTLE_STATUSES:
                wait = retry_after_seconds(error.headers)
                if wait is not None:
                    time.sleep(wait)
                    continue
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            if attempt == tries - 1:
                raise SecError(f"{type(error).__name__} for {url}") from error
        time.sleep(backoff_seconds(attempt))

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
