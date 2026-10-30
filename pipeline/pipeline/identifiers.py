"""Identifiers: the licensed ones we must not publish, and the open ones we may.

Two jobs live here, and they are the same subject seen from both ends.

**Part 1 — the licence rule.** A CUSIP is licensed data: it may be used to compute
a result, and it may not be redistributed. The pipeline reads one from a filing's
``<cusip>`` element, uses it to resolve a company, and then has to make sure it
cannot reach a published artifact by a side door. It does: as-filed ``<ticker>``
values that are really CUSIPs, names that are nothing but a CUSIP, and — once — a
``metrics.effective_n`` of ``100000000.0``, which the release's own CUSIP check
flagged on two funds. One pattern, in one module, used by the artifact (to redact),
the ordering (so a rebuilt file sorts the way the validator expects) and the
validator (to check). Three copies of this rule would drift apart silently.

**Part 2 — the identifier layer.** ``harvest`` and ``build`` turn a published
release's unmapped holdings from "resolves to nothing" into "resolves to a named
security via FIGI", and measure per fund how much weight that recovers::

    python -m pipeline.identifiers harvest            # ISIN -> FIGI, cached, resumable
    python -m pipeline.identifiers build              # isin_map.json + the measurement

*Why the target is equity, debt and fund rows only.* A holding row is unmapped when
``company_id`` is null in ``funds/<TICKER>.json``. Cash, derivative and ``other``
rows are excluded on purpose, and the reason is not tidiness: **no identifier
resolves a swap.** OpenFIGI can name a swap's underlying, never the position; a cash
row has no security behind it at all. Asking about them would inflate a resolution
rate with weight that could never become a company or a fund. The measurement note
measured exactly that trap — 74.47% of cash rows resolve, and what resolves is
someone's money-market fund, not a holding (``2026-10-30-isin-coverage-measurement``
§3, §6).

*How the ISIN gets here at all.* The published artifact does not carry an ISIN —
identifiers are join keys and stay out of published objects. The ISINs are recovered
from the very N-PORT document that produced the row, by parsing the cached bytes at
``sha256(source_url)`` and joining a filing row to its published row on
``(public_name(name).upper(), category)``. A name that appears more than once in the
fund is ambiguous and is dropped rather than guessed; the run prints the weight
reconciliation against the artifact so a join that silently lost rows cannot pass as
an answer.

*The honest denominator, stated once, here and in the output.* **A resolved FIGI is
a named security, not a company.** Nobody may quote the resolution rate as company
coverage. The measured 400-ISIN slice of release ``2026-10-30.5`` shows why: of the
weight it resolved, 40.5% was ``Open-End Fund`` and 26.9% ``ETP`` — other funds'
shares — and 15.5% was ``Govt``, nearly all US Treasury paper. Only 6.8% was
``Common Stock``. A security was named in every one of those cases, and a *company*
in almost none of them. The layer needs the filing's LEI (or GLEIF's bulk ISIN→LEI
file) before "which company" has an answer, and that is not this module.

*What may be published.* FIGI identifiers are dedicated to the public domain by
OpenFIGI's terms; the ``name``/``ticker`` fields are "Related Security Descriptions"
under an as-is disclaimer with no public-domain grant (``2026-10-29-sources-beyond-edgar``
§2). Everything this module writes lands under ``data/`` — git-ignored, never
published — so the licence question is deferred, not answered, and the docstring of
``ISIN_MAP_FIELDS`` says so at the point of use.

*Cost.* $0. Without a key OpenFIGI allows 25 requests/minute and 10 jobs/request;
with the free key, 250/minute and 100 jobs/request. The key is read from
``OPENFIGI_API_KEY`` and is never printed, logged, cached or written — the only thing
this module ever says about it is the word "keyed" or "unauthenticated".
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from . import classify, nport, paths

# ---------------------------------------------------------------------------
# Part 1 — licensed identifiers
# ---------------------------------------------------------------------------

#: Three digits, five alphanumerics, a final digit, not glued to a longer token.
#: ``742718109`` and ``912810PT9`` match; ``100000000.0`` does not once a decimal
#: point is treated as part of a number rather than as a boundary.
LICENSED_ID_RE = re.compile(r"(?<![0-9A-Za-z.])([0-9]{3}[0-9A-Z]{5}[0-9])(?![0-9A-Za-z]|\.[0-9])")

#: What a row is called when its filed name was the identifier and nothing else.
UNNAMED_HOLDING = "Unnamed holding"


def public_name(name: str | None) -> str:
    """Return ``name`` with any licensed identifier removed."""
    cleaned = LICENSED_ID_RE.sub("", name or "").strip(" -,:;")
    return cleaned or UNNAMED_HOLDING


def is_licensed(value: str | None) -> bool:
    """True when ``value`` contains a licensed identifier."""
    return bool(value) and LICENSED_ID_RE.search(value) is not None


# ---------------------------------------------------------------------------
# Part 2 — the OpenFIGI identifier layer
#
# Endpoint facts (verified, `2026-10-29-sources-beyond-edgar` §2): POST
# https://api.openfigi.com/v3/mapping with a JSON array of jobs; the response is a
# JSON array of the same length, each entry either ``{"data": [records]}`` or
# ``{"error": "..."}``. 25 req/min and 10 jobs/request unauthenticated; 250 req/min
# and 100 jobs/request with a free key; a 429 carries ``retry-after``.
# ---------------------------------------------------------------------------

OPENFIGI_URL = "https://api.openfigi.com/v3/mapping"
USER_AGENT = "UnpackFund research data@unpackfund.com"

#: The key the free tier is registered under. Read once, never printed, never stored.
KEY_ENV = "OPENFIGI_API_KEY"

UNAUTHENTICATED_RPM = 25
KEYED_RPM = 250
UNAUTHENTICATED_JOBS = 10
KEYED_JOBS = 100

#: A batch gets three attempts in total — the first request plus two retries — before
#: it is recorded as failed and the run moves on. A failed batch must never stop a
#: 20-hour pass.
MAX_ATTEMPTS = 3
#: Pause after a 429 with no usable ``retry-after``, and after a 5xx.
FALLBACK_RETRY_S = 10.0
#: ``retry-after`` is obeyed but bounded: a header saying "wait an hour" is a reason
#: to stop and look, not to hold the process.
MAX_RETRY_SLEEP_S = 120.0
REQUEST_TIMEOUT_S = 30.0

#: The categories worth an identifier. See the module docstring: no identifier
#: resolves a swap, and a cash row has no security behind it.
TARGET_CATEGORIES = frozenset({classify.EQUITY, classify.DEBT, classify.FUND})

#: An ISO 6166 shape: two letters, nine alphanumerics, one check digit.
ISIN_RE = re.compile(r"\A[A-Z]{2}[A-Z0-9]{9}[0-9]\Z")

#: The response fields the layer keeps, and their OpenFIGI spellings. ``figi`` is
#: public domain; ``name`` is a "Related Security Description" with no public-domain
#: grant, so the map stays under ``data/`` until a licence review says otherwise.
ISIN_MAP_FIELDS = {
    "figi": "figi",
    "composite_figi": "compositeFIGI",
    "share_class_figi": "shareClassFIGI",
    "name": "name",
    "security_type": "securityType",
    "security_type_2": "securityType2",
    "market_sector": "marketSector",
    "exch_code": "exchCode",
}


class IdentifierError(RuntimeError):
    """A response or a file we cannot use."""


class OfflineMiss(IdentifierError):
    """``--no-network`` and this exact request was never made. Do not call."""


class KeyRequired(IdentifierError):
    """The API answered 401/403: it wants a key, and retrying will not help."""


class TransportError(IdentifierError):
    """The request never produced a status line (DNS, TLS, timeout, reset)."""


# --- ISIN validation -------------------------------------------------------


def _luhn_ok(text: str) -> bool:
    """Luhn over the ISO 6166 expansion: letters become two digits (A=10).

    This is the check that makes a validator failing earlier than OpenFIGI can. It is
    not a licence question — a well-formed ISIN for a security we cannot license is
    still refused downstream; this only refuses strings that are not ISINs at all.
    """
    digits = "".join(str(ord(ch) - 55) if ch.isalpha() else ch for ch in text)
    total = 0
    for position, ch in enumerate(reversed(digits)):
        digit = int(ch)
        if position % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def isin_check_digit(body: str) -> str:
    """The ISO 6166 check digit that completes an 11-character ISIN body."""
    for digit in "0123456789":
        if _luhn_ok(body + digit):
            return digit
    raise IdentifierError("an ISIN body has no valid check digit")


def valid_isin(value: str | None) -> bool:
    """True when ``value`` is a well-formed ISIN: shape **and** check digit.

    A blank, a truncated value, a CUSIP, an LEI, or a name with a digit in it is not
    an ISIN and never reaches the network.
    """
    text = (value or "").strip().upper()
    if len(text) != 12 or ISIN_RE.match(text) is None:
        return False
    return _luhn_ok(text)


# --- pacing and batching ---------------------------------------------------


def default_rpm(keyed: bool) -> float:
    """Requests per minute this run may use, from the endpoint's own published limits."""
    return KEYED_RPM if keyed else UNAUTHENTICATED_RPM


def default_jobs_per_request(keyed: bool) -> int:
    """Jobs bundled into one request: 100 with a key, 10 without."""
    return KEYED_JOBS if keyed else UNAUTHENTICATED_JOBS


def interval_seconds(rpm: float) -> float:
    """The gap between two requests at ``rpm`` requests per minute.

    25/min → 2.4 s, 250/min → 0.24 s. The gap runs from one request to the next, so
    the first request is immediate and an unauthenticated batch of 40 requests costs
    39 × 2.4 ≈ 94 s of sleeping.
    """
    if rpm <= 0:
        raise ValueError("rpm must be positive")
    return 60.0 / float(rpm)


def batch(items: Iterable[str], size: int) -> list[list[str]]:
    """Split ``items`` into consecutive lists of at most ``size``.

    Batching is over the *prefix* of the harvest order, so a ``--limit 400`` run forms
    exactly the batches a full run's first 400 ISINs would: resuming a slice into a
    full pass reuses every cached batch instead of refetching it.
    """
    if size <= 0:
        raise ValueError("batch size must be positive")
    ordered = list(items)
    return [ordered[index : index + size] for index in range(0, len(ordered), size)]


def harvest_order(isins: Iterable[str]) -> list[str]:
    """The order ISINs are asked about: a hash of the ISIN, not the ISIN.

    Two reasons, and the second is the load-bearing one. It is deterministic, so a
    resumed pass continues where it stopped; and it is **not** ordered by country
    prefix or by fund size, so a ``--limit`` slice is a pseudo-random sample of the
    corpus rather than "every US security first". The measurement note's sample used
    the same trick for the same reason (§3): a country-ordered prefix would report
    the US resolution rate and call it the corpus.
    """
    return sorted(set(isins), key=lambda value: hashlib.sha256(value.encode()).hexdigest())


# --- the request cache -----------------------------------------------------


def cache_key(body: bytes) -> str:
    """The cache key for one request: ``sha256(request body + request path)``.

    The path is part of the digest so a future endpoint cannot collide with this one,
    and the body is in it so each batch has its own file. Nothing else enters — not
    the key header, not the time — so the same batch fetches the same body whether the
    request was keyed or not.

    What that does **not** buy: gaining a key changes the batch size (10 → 100), which
    changes the request, so a pass resumed in the other mode re-batches and misses the
    cache. Resuming a 20-hour unauthenticated pass with a key is therefore a restart,
    not a continuation, unless ``--jobs`` is pinned to the size the pass started with.
    """
    path = urllib.parse.urlparse(OPENFIGI_URL).path.encode()
    return hashlib.sha256(body + path).hexdigest()


def cache_path(cache_dir: Path, key: str) -> Path:
    """``<cache>/<first two hex>/<key>.json``, gzipped. Never a path with an ISIN."""
    return cache_dir / key[:2] / f"{key}.json"


def read_cached_body(cache_dir: Path, key: str) -> Any | None:
    """The cached response for ``key``, or ``None`` when it was never fetched."""
    path = cache_path(cache_dir, key)
    try:
        return json.loads(gzip.decompress(path.read_bytes()))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise IdentifierError(f"unreadable cached response {path.name}") from error


def write_cached_body(cache_dir: Path, key: str, payload: bytes) -> Path:
    """Store a response body gzipped, with a zeroed mtime so the bytes are stable."""
    path = cache_path(cache_dir, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(payload, mtime=0))
    return path


def retry_after_seconds(headers: Any) -> float:
    """The pause a 429 asks for, bounded; the fallback when it does not say."""
    for name in ("retry-after", "Retry-After"):
        raw = headers.get(name) if headers is not None else None
        if not raw:
            continue
        try:
            value = float(str(raw).strip())
        except ValueError:
            continue
        if value > 0:
            return min(value, MAX_RETRY_SLEEP_S)
    return FALLBACK_RETRY_S


class Throttle:
    """Keep requests ``interval`` seconds apart, measured request-start to start."""

    def __init__(
        self,
        interval: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.interval = interval
        self.clock = clock
        self.sleep = sleep
        self._last: float | None = None

    def wait(self) -> float:
        """Sleep the remainder of the gap if the previous request is too recent."""
        now = self.clock()
        waited = 0.0
        if self._last is not None:
            remaining = self.interval - (now - self._last)
            if remaining > 0:
                self.sleep(remaining)
                waited = remaining
        self._last = self.clock()
        return waited


# --- transport -------------------------------------------------------------


def http_transport(body: bytes, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
    """POST ``body`` to OpenFIGI and return ``(status, headers, payload)``.

    An HTTP error status is *returned*, not raised: 429 and 5xx are part of the
    protocol the retry loop implements, and a caller that had to catch them separately
    from a network failure would end up with two different retry paths.
    """
    request = urllib.request.Request(OPENFIGI_URL, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        try:
            payload = error.read() or b""
        except Exception:  # noqa: BLE001 - a body we cannot read is still an error status
            payload = b""
        return error.code, dict(error.headers or {}), payload
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise TransportError(f"openfigi unreachable: {type(error).__name__}") from error


Transport = Callable[[bytes, dict[str, str]], tuple[int, dict[str, str], bytes]]


# --- the ISIN index: which ISINs matter, and how much weight each carries ---


@dataclass
class FundTargets:
    """One fund's unmapped target-category holdings, before and after the join."""

    ticker: str
    #: Published unmapped weight in the target categories (integer bp, as published).
    unmapped_bp: float
    #: Of which, per published category.
    by_category: dict[str, float]
    #: ``(isin, category, bp)`` attributed from the filing; bp is the filed fraction.
    rows: list[tuple[str, str, float]]


@dataclass
class IsinIndex:
    """The distinct ISINs that matter, with the weight each carries across the release."""

    release: str
    as_of: str
    fingerprint: dict[str, Any]
    totals: dict[str, float]
    funds: dict[str, FundTargets]
    errors: list[str] = field(default_factory=list)
    #: Derived, never stored: total bp per ISIN and per (ISIN, category).
    isin_bp: dict[str, float] = field(default_factory=dict)
    isin_category_bp: dict[str, dict[str, float]] = field(default_factory=dict)

    def finalise(self) -> "IsinIndex":
        """Build the per-ISIN aggregates from the per-fund rows."""
        weights: dict[str, float] = {}
        by_category: dict[str, dict[str, float]] = {}
        for targets in self.funds.values():
            for isin, category, bp in targets.rows:
                weights[isin] = weights.get(isin, 0.0) + bp
                bucket = by_category.setdefault(isin, {})
                bucket[category] = bucket.get(category, 0.0) + bp
        self.isin_bp = weights
        self.isin_category_bp = by_category
        return self

    @property
    def distinct_isins(self) -> int:
        return len(self.isin_bp)

    def to_document(self) -> dict[str, Any]:
        """A deterministic JSON document. ISINs appear as keys — under ``data/`` only."""
        return {
            "release": self.release,
            "as_of": self.as_of,
            "fingerprint": self.fingerprint,
            "totals": {key: round(value, 2) for key, value in sorted(self.totals.items())},
            "errors": sorted(self.errors),
            "funds": {
                ticker: {
                    "unmapped_bp": round(targets.unmapped_bp, 2),
                    "by_category": {
                        key: round(value, 2)
                        for key, value in sorted(targets.by_category.items())
                    },
                    "rows": [
                        [isin, category, round(bp, 2)]
                        for isin, category, bp in sorted(targets.rows)
                    ],
                }
                for ticker, targets in sorted(self.funds.items())
            },
        }

    @classmethod
    def from_document(cls, document: dict[str, Any]) -> "IsinIndex":
        funds: dict[str, FundTargets] = {}
        for ticker, payload in (document.get("funds") or {}).items():
            funds[ticker] = FundTargets(
                ticker=ticker,
                unmapped_bp=float(payload.get("unmapped_bp") or 0.0),
                by_category={
                    str(key): float(value)
                    for key, value in (payload.get("by_category") or {}).items()
                },
                rows=[
                    (str(isin), str(category), float(bp))
                    for isin, category, bp in (payload.get("rows") or [])
                ],
            )
        return cls(
            release=str(document.get("release") or ""),
            as_of=str(document.get("as_of") or ""),
            fingerprint=dict(document.get("fingerprint") or {}),
            totals={str(key): float(value) for key, value in (document.get("totals") or {}).items()},
            funds=funds,
            errors=[str(value) for value in (document.get("errors") or [])],
        ).finalise()


# --- building the index from a release -------------------------------------


def default_filing_cache() -> Path:
    """Where the build's N-PORT cache lives, resolved the way ``sec`` resolves it.

    ``sec.CACHE_DIR`` is ``data/cache`` relative to the process's working directory,
    and the pipeline commands run from ``pipeline/`` while the cache the release was
    built from sits at the repo root. Binding it to the repo root here is the same
    rebinding the coverage probe makes, and it makes the module work from either cwd.
    """
    configured = os.environ.get("UNPACKFUND_CACHE") or "data/cache"
    path = Path(configured)
    return path if path.is_absolute() else paths.REPO_ROOT / path


def filing_path(cache_dir: Path, source_url: str) -> Path:
    """The cached N-PORT bytes for a filing, keyed by ``sha256(source_url)``.

    Identical to ``sec._cache_paths`` so a document the build already downloaded is
    read, not fetched.
    """
    digest = hashlib.sha256(source_url.encode()).hexdigest()
    return cache_dir / digest[:2] / f"{digest}.bin"


def load_nport_filing(source_url: str, cache_dir: Path) -> nport.NportFiling:
    """Parse the cached filing behind ``source_url``."""
    try:
        return nport.parse(filing_path(cache_dir, source_url).read_bytes())
    except FileNotFoundError as error:
        raise OfflineMiss("filing not in the N-PORT cache") from error


FilingLoader = Callable[[str, Path], nport.NportFiling]


def _target_rows(
    document: dict[str, Any],
    filing: nport.NportFiling,
    totals: dict[str, float],
) -> list[tuple[str, str, float]]:
    """Attribute each unmapped published row in a fund to the filing row's ISIN.

    The join key is ``(public_name(name).upper(), category)`` rather than a row index,
    because ``weights.build_vector`` merges filing rows that share a name and category
    and the published row is that merged group. A name appearing once in the fund can
    still be attributed when the category moved (the merged group keeps its largest
    row's category); anything genuinely ambiguous is counted and dropped.
    """
    from .weights import _fraction  # local: weights imports this module at load time

    keys: set[tuple[str, str]] = set()
    names: dict[str, int] = {}
    mapped_names: set[str] = set()
    for row in document.get("holdings") or []:
        if row.get("company_id"):
            # A row that already has a company is not part of the gap. Its name is
            # remembered so the uniqueness fallback below cannot re-attribute it and
            # quietly inflate the denominator this module is measuring.
            mapped_names.add(public_name(row.get("name")).upper())
            continue
        category = str(row.get("asset_cat") or classify.OTHER)
        if category not in TARGET_CATEGORIES:
            continue
        name = public_name(row.get("name")).upper()
        keys.add((name, category))
        names[name] = names.get(name, 0) + 1
    if not keys:
        return []

    attributed: list[tuple[str, str, float]] = []
    for holding in filing.holdings:
        fraction = _fraction(holding, filing.net_assets)
        if fraction is None:
            continue
        classification = classify.classify(
            holding.asset_cat, holding.issuer_cat, holding.is_derivative
        )
        category = classification.category
        if category not in TARGET_CATEGORIES:
            continue
        name = public_name(holding.name).upper()
        if (name, category) not in keys:
            if names.get(name) != 1 or name in mapped_names:
                totals["ambiguous_rows"] += 1
                continue
            totals["category_moved_rows"] += 1
        bp = abs(fraction * 10_000.0)
        totals["computed_bp"] += bp
        if not valid_isin(holding.isin):
            totals["no_isin_bp"] += bp
            totals["no_isin_rows"] += 1
            continue
        attributed.append((str(holding.isin).strip().upper(), category, bp))
    return attributed


def build_isin_index(
    release: Path,
    *,
    filing_cache: Path | None = None,
    load_filing: FilingLoader | None = None,
    progress: Callable[[str], None] | None = None,
) -> IsinIndex:
    """Enumerate the distinct ISINs that matter, and the weight each one carries.

    Reads every ``funds/*.json`` in the release in ticker order (so the result is
    deterministic), keeps the rows with no ``company_id`` in the target categories,
    and recovers their ISINs from the cached filing. A fund whose filing is missing or
    malformed is recorded in ``errors`` and its published weight still counts in the
    totals — an unreadable filing must not make the gap look smaller than it is.
    """
    load = load_filing or load_nport_filing
    cache_dir = filing_cache or default_filing_cache()
    fund_files = sorted((release / "funds").glob("*.json"))
    if not fund_files:
        raise IdentifierError(f"no fund documents under {release / 'funds'}")

    totals: dict[str, float] = {
        "funds": 0.0,
        "funds_with_targets": 0.0,
        "published_target_bp": 0.0,
        "published_rows": 0.0,
        "computed_bp": 0.0,
        "no_isin_bp": 0.0,
        "no_isin_rows": 0.0,
        "ambiguous_rows": 0.0,
        "category_moved_rows": 0.0,
        "attributed_rows": 0.0,
    }
    funds: dict[str, FundTargets] = {}
    errors: list[str] = []
    newest_mtime = 0.0

    for number, path in enumerate(fund_files, 1):
        newest_mtime = max(newest_mtime, path.stat().st_mtime)
        totals["funds"] += 1
        try:
            document = json.loads(path.read_text())
        except (OSError, ValueError) as error:
            errors.append(f"{path.stem}: {type(error).__name__}")
            continue

        unmapped_bp = 0.0
        by_category: dict[str, float] = {}
        for row in document.get("holdings") or []:
            if row.get("company_id"):
                continue
            category = str(row.get("asset_cat") or classify.OTHER)
            if category not in TARGET_CATEGORIES:
                continue
            weight = abs(int(row.get("weight_bp") or 0))
            unmapped_bp += weight
            by_category[category] = by_category.get(category, 0.0) + weight
            totals["published_target_bp"] += weight
            totals["published_rows"] += 1
        if not unmapped_bp:
            continue

        totals["funds_with_targets"] += 1
        source_url = str(document.get("source_url") or "")
        try:
            filing = load(source_url, cache_dir)
            rows = _target_rows(document, filing, totals)
        except (IdentifierError, nport.NportParseError) as error:
            errors.append(f"{path.stem}: {type(error).__name__}")
            rows = []
        totals["attributed_rows"] += len(rows)
        funds[path.stem] = FundTargets(
            ticker=path.stem,
            unmapped_bp=unmapped_bp,
            by_category=by_category,
            rows=rows,
        )
        if progress is not None and (number % 500 == 0 or number == len(fund_files)):
            progress(
                f"index: {number}/{len(fund_files)} funds, "
                f"{sum(len(f.rows) for f in funds.values())} rows attributed"
            )

    index = IsinIndex(
        release=release.name,
        as_of=release.name,
        fingerprint={
            "funds": len(fund_files),
            "newest_mtime": int(newest_mtime),
            "filing_cache": str(cache_dir),
        },
        totals=totals,
        funds=funds,
        errors=errors,
    )
    return index.finalise()


# --- the layer directory and the harvest record ----------------------------


def default_layer_dir(as_of: str) -> Path:
    """``data/identifier-layer/<as_of>/`` — git-ignored, beside the build's caches."""
    return paths.REPO_ROOT / "data" / "identifier-layer" / as_of


def default_openfigi_cache() -> Path:
    """``data/cache/openfigi/`` — request-hash bodies, never a path with an ISIN."""
    return paths.REPO_ROOT / "data" / "cache" / "openfigi"


def index_path(layer_dir: Path) -> Path:
    return layer_dir / "isin_index.json.gz"


def harvest_path(layer_dir: Path) -> Path:
    return layer_dir / "harvest.json"


def isin_map_path(layer_dir: Path) -> Path:
    return layer_dir / "isin_map.json"


def measurement_path(layer_dir: Path) -> Path:
    return layer_dir / "measurement.json"


def _latest_layer_dir() -> Path | None:
    """The newest layer with an index on disk, so ``build`` needs no arguments."""
    root = paths.REPO_ROOT / "data" / "identifier-layer"
    candidates = sorted(
        path for path in root.glob("*") if index_path(path).exists()
    )
    return candidates[-1] if candidates else None


def _write_gzip_json(path: Path, document: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(document, indent=2, sort_keys=True) + "\n").encode()
    path.write_bytes(gzip.compress(payload, mtime=0))
    return path


def _read_gzip_json(path: Path) -> Any | None:
    try:
        return json.loads(gzip.decompress(path.read_bytes()))
    except FileNotFoundError:
        return None


def load_or_build_index(
    release: Path,
    layer_dir: Path,
    *,
    filing_cache: Path | None = None,
    load_filing: FilingLoader | None = None,
    refresh: bool = False,
    progress: Callable[[str], None] | None = None,
) -> IsinIndex:
    """Reuse the stored index for this release, or build and store it.

    The index costs a couple of minutes to derive from 8,983 filings, and a resumed
    harvest must not pay that twice for the same release. A fingerprint of the fund
    count, the newest fund mtime and the filing cache decides whether the stored copy
    still describes this release; ``--refresh-index`` overrides it.
    """
    if not refresh:
        stored = _read_gzip_json(index_path(layer_dir))
        if isinstance(stored, dict):
            index = IsinIndex.from_document(stored)
            fingerprint = index.fingerprint
            current = {
                "funds": len(list((release / "funds").glob("*.json"))),
                "filing_cache": str(filing_cache or default_filing_cache()),
            }
            newest = max(
                (path.stat().st_mtime for path in (release / "funds").glob("*.json")),
                default=0.0,
            )
            if (
                fingerprint.get("funds") == current["funds"]
                and fingerprint.get("filing_cache") == current["filing_cache"]
                and int(fingerprint.get("newest_mtime") or 0) == int(newest)
            ):
                return index
    index = build_isin_index(
        release,
        filing_cache=filing_cache,
        load_filing=load_filing,
        progress=progress,
    )
    _write_gzip_json(index_path(layer_dir), index.to_document())
    return index


@dataclass
class HarvestOutcome:
    """What one harvest run did, and why it stopped where it did."""

    as_of: str
    keyed: bool
    jobs_per_request: int
    rpm: float
    isins_in_index: int
    isins_selected: int
    batches_total: int
    batches_requested: int
    batches_cached: int
    batches_failed: int
    offline_misses: int
    requests: int
    isins_resolved: int
    seconds: float
    stopped: str | None = None


def _load_harvest_record(layer_dir: Path) -> dict[str, Any]:
    try:
        return json.loads(harvest_path(layer_dir).read_text())
    except FileNotFoundError:
        return {"batches": []}
    except (OSError, ValueError) as error:
        raise IdentifierError(f"unreadable harvest file under {layer_dir}") from error


def _write_harvest_record(layer_dir: Path, record: dict[str, Any]) -> None:
    """Deterministic: batches sorted by key, no timestamps, no clock."""
    record["batches"] = sorted(record.get("batches") or [], key=lambda item: item["key"])
    harvest_path(layer_dir).parent.mkdir(parents=True, exist_ok=True)
    harvest_path(layer_dir).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")


def resolved_isins(payload: Any, isins: list[str]) -> dict[str, dict[str, Any]]:
    """Map each ISIN whose job returned a record to the fields the layer keeps.

    A job with no ``data`` (or an ``error`` string) is *unresolved*: OpenFIGI answered,
    it just does not name that instrument. Only the first record is kept — one ISIN can
    list on several venues and the map is keyed by ISIN, so the primary record is the
    one the layer carries.
    """
    if not isinstance(payload, list) or len(payload) != len(isins):
        raise IdentifierError("malformed OpenFIGI response: length does not match jobs")
    resolved: dict[str, dict[str, Any]] = {}
    for isin, entry in zip(isins, payload):
        records = entry.get("data") if isinstance(entry, dict) else None
        if not isinstance(records, list) or not records:
            continue
        first = records[0] if isinstance(records[0], dict) else None
        if not first or not first.get("figi"):
            continue
        resolved[isin] = {
            field_name: (str(first.get(source)).strip() or None)
            if first.get(source) is not None
            else None
            for field_name, source in ISIN_MAP_FIELDS.items()
        }
    return resolved


def _request_body(isins: list[str]) -> bytes:
    """The JSON job array for one batch. Order is preserved; it is the response's key."""
    return json.dumps([{"idType": "ID_ISIN", "idValue": isin} for isin in isins]).encode()


def harvest(
    release: Path,
    *,
    layer_dir: Path | None = None,
    cache_dir: Path | None = None,
    filing_cache: Path | None = None,
    load_filing: FilingLoader | None = None,
    limit: int | None = None,
    rpm: float | None = None,
    jobs_per_request: int | None = None,
    no_network: bool = False,
    refresh_index: bool = False,
    transport: Transport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    progress: Callable[[str], None] | None = None,
) -> HarvestOutcome:
    """Resolve ISINs to FIGIs, caching every response and resuming where it stopped.

    The run is resumable three ways, which is what lets a 20-hour unauthenticated pass
    survive interruption: the harvest order is a fixed function of the ISIN set, the
    batch boundaries are fixed by that order and the batch size, and a batch whose
    request was already cached is skipped without a request. ``--no-network`` turns a
    cache miss into a reported miss instead of a request, so a warm rerun is provably
    free rather than merely assumed to be.

    A batch that cannot be fetched after :data:`MAX_ATTEMPTS` is recorded as failed and
    the run continues. A batch that hits 401/403 stops the run: that is a missing or
    rejected key and no amount of retrying fixes it.
    """
    as_of = release.name
    layer = layer_dir or default_layer_dir(as_of)
    cache = cache_dir or default_openfigi_cache()
    transport = transport or http_transport
    api_key = os.environ.get(KEY_ENV) or None
    keyed = bool(api_key)
    rate = float(rpm) if rpm is not None else default_rpm(keyed)
    size = int(jobs_per_request) if jobs_per_request else default_jobs_per_request(keyed)
    throttle = Throttle(interval_seconds(rate), clock=clock, sleep=sleep)

    index = load_or_build_index(
        release,
        layer,
        filing_cache=filing_cache,
        load_filing=load_filing,
        refresh=refresh_index,
        progress=progress,
    )
    order = harvest_order(index.isin_bp)
    selected = order[: int(limit)] if limit is not None else order
    batches = batch(selected, size)

    record = _load_harvest_record(layer)
    #: Keyed by request hash so a 31,039-batch pass updates in place instead of
    #: rebuilding the list per batch (which is quadratic and was measurable).
    known: dict[str, dict[str, Any]] = {
        str(entry["key"]): entry
        for entry in record.get("batches") or []
        if isinstance(entry, dict) and "key" in entry
    }
    record.update(
        {
            "as_of": as_of,
            "release": str(release),
            "url": OPENFIGI_URL,
            "jobs_per_request": size,
            "rpm": rate,
            "batch_size": size,
            "updated_by": "pipeline.identifiers harvest",
        }
    )

    outcome = HarvestOutcome(
        as_of=as_of,
        keyed=keyed,
        jobs_per_request=size,
        rpm=rate,
        isins_in_index=index.distinct_isins,
        isins_selected=len(selected),
        batches_total=len(batches),
        batches_requested=0,
        batches_cached=0,
        batches_failed=0,
        offline_misses=0,
        requests=0,
        isins_resolved=0,
        seconds=0.0,
    )
    started = time.time()
    attempted = 0

    for number, isins in enumerate(batches, 1):
        body = _request_body(isins)
        key = cache_key(body)
        cached = read_cached_body(cache, key)
        if cached is not None:
            outcome.batches_cached += 1
            known[key] = {"key": key, "isins": isins, "status": "cached", "attempts": 0}
            try:
                outcome.isins_resolved += len(resolved_isins(cached, isins))
            except IdentifierError:
                pass
            continue
        if no_network:
            outcome.offline_misses += 1
            continue

        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        }
        if api_key:
            headers["X-OPENFIGI-APIKEY"] = api_key

        attempts = 0
        status: int | None = None
        payload = b""
        stopped: str | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            attempts = attempt
            throttle.wait()
            outcome.requests += 1
            attempted += 1
            try:
                status, response_headers, payload = transport(body, headers)
            except TransportError as error:
                if attempt < MAX_ATTEMPTS:
                    sleep(FALLBACK_RETRY_S / 2)
                    continue
                outcome.batches_failed += 1
                known[key] = {
                    "key": key,
                    "isins": isins,
                    "status": "failed",
                    "attempts": attempts,
                    "reason": "transport error",
                }
                stopped = str(error)
                break
            if status in (401, 403):
                stopped = (
                    f"openfigi answered {status}: the key is missing, rejected or out of scope"
                )
                break
            if status == 429:
                pause = retry_after_seconds(response_headers)
                if attempt < MAX_ATTEMPTS:
                    sleep(pause)
                    continue
                outcome.batches_failed += 1
                known[key] = {
                    "key": key,
                    "isins": isins,
                    "status": "failed",
                    "attempts": attempts,
                    "reason": "429 after retries",
                }
                break
            if 500 <= status < 600:
                if attempt < MAX_ATTEMPTS:
                    sleep(FALLBACK_RETRY_S / 2)
                    continue
                outcome.batches_failed += 1
                known[key] = {
                    "key": key,
                    "isins": isins,
                    "status": "failed",
                    "attempts": attempts,
                    "reason": f"{status} after retries",
                }
                break
            if not 200 <= status < 300:
                stopped = f"openfigi answered {status} for a mapping request"
                break
            break

        if stopped is not None:
            outcome.stopped = stopped
            if progress is not None:
                progress(f"harvest: stopping — {stopped}")
            break
        if status is None or not 200 <= status < 300:
            continue

        write_cached_body(cache, key, payload)
        outcome.batches_requested += 1
        entry: dict[str, Any] = {
            "key": key,
            "isins": isins,
            "status": "requested",
            "attempts": attempts,
        }
        known[key] = entry
        try:
            outcome.isins_resolved += len(resolved_isins(json.loads(payload), isins))
        except (IdentifierError, ValueError) as error:
            outcome.batches_failed += 1
            entry["status"] = "malformed"
            entry["reason"] = type(error).__name__

        if progress is not None and (attempted % 5 == 0 or number == len(batches)):
            elapsed = max(time.time() - started, 1e-6)
            per_request = elapsed / max(outcome.requests, 1)
            remaining = len(batches) - number
            eta = remaining * per_request
            progress(
                f"harvest: {number}/{len(batches)} batches, "
                f"{outcome.isins_resolved:,} ISINs resolved, "
                f"{outcome.requests} requests, {elapsed:.0f}s elapsed, ETA {eta:.0f}s"
            )

    outcome.seconds = round(time.time() - started, 1)
    record["batches"] = list(known.values())
    #: What the whole layer cost, not what this run cost: a pass interrupted three
    #: times and resumed has spent three runs' worth of requests, and a report that
    #: quoted only the last one would understate the price of the map.
    previous = record.get("stats") or {}
    # `.get` with a fallback, not `or`: a record written before requests_total existed
    # still carries the spend in ``requests``, and an offline verification run must not
    # reset the pass's price to zero.
    previous_total = int(previous.get("requests_total", previous.get("requests", 0)) or 0)
    record["stats"] = {
        "batches_total": outcome.batches_total,
        "batches_requested": outcome.batches_requested,
        "batches_cached": outcome.batches_cached,
        "batches_failed": outcome.batches_failed,
        "offline_misses": outcome.offline_misses,
        "requests": outcome.requests,
        "requests_total": previous_total + outcome.requests,
        "isins_in_index": outcome.isins_in_index,
        "isins_selected": outcome.isins_selected,
        "isins_resolved": outcome.isins_resolved,
    }
    _write_harvest_record(layer, record)
    return outcome


# --- build: the map, and the measurement -----------------------------------


@dataclass
class BuildOutcome:
    """The measured result of the layer, ready to print and to store."""

    as_of: str
    isin_map: dict[str, dict[str, Any]]
    measurement: dict[str, Any]
    report: str


def collect_isin_map(
    layer_dir: Path,
    cache_dir: Path,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Join the harvest record's ISIN order to the cached response bodies.

    This is the only place a response is attributed to an ISIN, and it works from disk
    alone: the batch order is the record's, the records are the cache's. A batch whose
    body is missing is reported, never guessed.
    """
    record = _load_harvest_record(layer_dir)
    batches = record.get("batches") or []
    if not batches:
        raise IdentifierError(
            "no harvest record — run `python -m pipeline.identifiers harvest` first"
        )
    mapping: dict[str, dict[str, Any]] = {}
    #: Every ISIN sent to OpenFIGI for *this* layer, whether or not it resolved. The
    #: measurement needs it to state a rate instead of quoting a slice as a result:
    #: a batch that came back unresolved was still asked, and belongs in the
    #: denominator.
    asked_isins: set[str] = set()
    stats: dict[str, Any] = {
        "asked_isins": asked_isins,
        "batches": len(batches),
        "batches_missing": 0,
        "jobs_asked": 0,
        "jobs_resolved": 0,
        #: Cumulative network spend for this layer, not this run's share of it.
        "requests": int((record.get("stats") or {}).get("requests_total") or 0),
        "errors": {},
    }
    for entry in batches:
        isins = [str(value) for value in entry.get("isins") or []]
        asked_isins.update(isins)
        stats["jobs_asked"] += len(isins)
        payload = read_cached_body(cache_dir, entry["key"])
        if payload is None:
            stats["batches_missing"] += 1
            continue
        try:
            resolved = resolved_isins(payload, isins)
        except IdentifierError:
            stats["batches_missing"] += 1
            continue
        stats["jobs_resolved"] += len(resolved)
        mapping.update(resolved)
        for isin, entry_payload in zip(isins, payload if isinstance(payload, list) else []):
            if isin in resolved:
                continue
            error = entry_payload.get("error") if isinstance(entry_payload, dict) else None
            if error:
                key = str(error)
                stats["errors"][key] = stats["errors"].get(key, 0) + 1
    return mapping, stats


def measure(
    index: IsinIndex,
    mapping: dict[str, dict[str, Any]],
    stats: dict[str, Any],
    *,
    top: int = 20,
) -> dict[str, Any]:
    """The measurement: what the layer resolves, weighted, per fund and by security type.

    Every percentage here is a share of *weight* (basis points of fund NAV), never of
    holding counts — 4,000 tiny unresolved positions are not the same as 40% of a fund
    missing. Three denominators are reported side by side, and quoting one without the
    others is how a slice becomes a false claim:

    * ``asked_bp`` — the weight whose ISINs were actually sent to OpenFIGI. In a
      ``--limit`` slice this is a small share of the corpus, and it is the only
      denominator that can measure a *rate*.
    * ``covered_bp`` — the weight that carries an ISIN at all: the harvest target.
    * ``published_target_bp`` — the whole gap in the target categories.

    ``resolved_pct_of_asked`` is the measured rate and generalises; ``projected_bp``
    applies that rate to the whole target and is therefore an **estimate from a
    sample**, not a measurement of the corpus; ``resolved_pct_of_unmapped`` is a fact
    about how much of the gap is closed *so far* and says nothing about the rest.
    """
    asked = set(stats.get("asked_isins") or ())
    published = float(index.totals.get("published_target_bp") or 0.0)
    computed = float(index.totals.get("computed_bp") or 0.0)

    def weight(isins) -> float:
        return sum(index.isin_bp.get(isin, 0.0) for isin in isins)

    asked_bp = weight(asked)
    resolved_bp = weight(set(mapping) & asked)
    covered_bp = sum(index.isin_bp.values())
    rate = resolved_bp / asked_bp if asked_bp else 0.0
    projected_bp = covered_bp * rate

    by_category: dict[str, dict[str, float]] = {}
    for category in sorted(TARGET_CATEGORIES):
        category_asked = sum(
            index.isin_category_bp.get(isin, {}).get(category, 0.0) for isin in asked
        )
        category_resolved = sum(
            index.isin_category_bp.get(isin, {}).get(category, 0.0)
            for isin in mapping
            if isin in asked
        )
        by_category[category] = {
            "asked_bp": round(category_asked, 2),
            "resolved_bp": round(category_resolved, 2),
            "resolved_pct_of_asked": round(_share(category_resolved, category_asked), 2),
        }

    sector_bp: dict[str, float] = {}
    sector_isins: dict[str, int] = {}
    type_bp: dict[str, float] = {}
    type_isins: dict[str, int] = {}
    for isin, record in mapping.items():
        weight_bp = index.isin_bp.get(isin, 0.0)
        sector = str(record.get("market_sector") or "unknown")
        security_type = str(record.get("security_type") or "unknown")
        sector_bp[sector] = sector_bp.get(sector, 0.0) + weight_bp
        sector_isins[sector] = sector_isins.get(sector, 0) + 1
        type_bp[security_type] = type_bp.get(security_type, 0.0) + weight_bp
        type_isins[security_type] = type_isins.get(security_type, 0) + 1

    funds: list[dict[str, Any]] = []
    for ticker, targets in index.funds.items():
        fund_asked = sum(bp for isin, _c, bp in targets.rows if isin in asked)
        fund_resolved = sum(bp for isin, _c, bp in targets.rows if isin in mapping)
        fund_equity_asked = sum(
            bp for isin, c, bp in targets.rows if c == classify.EQUITY and isin in asked
        )
        fund_equity_resolved = sum(
            bp for isin, c, bp in targets.rows if c == classify.EQUITY and isin in mapping
        )
        funds.append(
            {
                "ticker": ticker,
                "unmapped_bp": round(targets.unmapped_bp, 2),
                "unmapped_equity_bp": round(
                    sum(bp for _i, c, bp in targets.rows if c == classify.EQUITY), 2
                ),
                "asked_bp": round(fund_asked, 2),
                "asked_equity_bp": round(fund_equity_asked, 2),
                "resolved_bp": round(fund_resolved, 2),
                "resolved_equity_bp": round(fund_equity_resolved, 2),
                # ``None`` when nothing was asked for this fund: an unasked fund is not
                # a 0% fund, and printing 0.0 would read as "this layer fails here".
                "resolved_pct_of_asked": (
                    round(_share(fund_resolved, fund_asked), 2) if fund_asked else None
                ),
                "resolved_pct_of_unmapped": round(
                    _share(fund_resolved, targets.unmapped_bp), 2
                ),
                # The brief's headline for a fund: equity weight now resolvable.
                "equity_resolved_pct_of_equity_asked": (
                    round(_share(fund_equity_resolved, fund_equity_asked), 2)
                    if fund_equity_asked
                    else None
                ),
            }
        )

    resolved_funds = [row for row in funds if row["resolved_bp"] > 0]
    asked_funds = [row for row in funds if row["asked_bp"] > 0]
    ranked = sorted(funds, key=lambda row: (-row["resolved_bp"], row["ticker"]))
    ranked_equity = sorted(
        (row for row in funds if row["resolved_equity_bp"] > 0),
        key=lambda row: (-row["resolved_equity_bp"], row["ticker"]),
    )
    no_isin = float(index.totals.get("no_isin_bp") or 0.0)
    measurement = {
        "as_of": index.as_of,
        "release": index.release,
        "distinct_isins": index.distinct_isins,
        "isins_in_map": len(mapping),
        "jobs_asked": stats.get("jobs_asked", 0),
        "jobs_resolved": stats.get("jobs_resolved", 0),
        "requests": int(stats.get("requests") or 0),
        "published_target_bp": round(published, 2),
        "computed_target_bp": round(computed, 2),
        "join_residual_bp": round(computed - published, 2),
        "reconciliation_pct": round(_share(computed - published, published), 3),
        "no_isin_bp": round(no_isin, 2),
        "attributed_bp": round(computed - no_isin, 2),
        "unattributed_published_bp": round(published - computed, 2),
        "covered_bp": round(covered_bp, 2),
        "covered_pct_of_gap": round(_share(covered_bp, published), 2),
        "asked_bp": round(asked_bp, 2),
        "asked_pct_of_gap": round(_share(asked_bp, published), 2),
        "resolved_bp": round(resolved_bp, 2),
        "resolved_pct_of_asked": round(_share(resolved_bp, asked_bp), 2),
        "resolved_pct_of_covered": round(_share(resolved_bp, covered_bp), 2),
        "resolved_pct_of_unmapped": round(_share(resolved_bp, published), 2),
        "projected_bp": round(projected_bp, 2),
        "projected_pct_of_gap": round(_share(projected_bp, published), 2),
        "funds": len(index.funds),
        "funds_measured": len(funds),
        "funds_asked": len(asked_funds),
        "funds_with_resolution": len(resolved_funds),
        "by_category": by_category,
        "by_market_sector": _ranked_weights(sector_bp, sector_isins, resolved_bp),
        "by_security_type": _ranked_weights(type_bp, type_isins, resolved_bp),
        "per_fund": sorted(funds, key=lambda row: row["ticker"]),
        "top_funds": ranked[: max(int(top), 0)],
        #: Ranked separately because the brief's per-fund headline is *equity* weight
        #: now resolvable, and a single ranking by total weight is dominated by bond
        #: funds whose equity share is zero.
        "top_funds_equity": ranked_equity[: max(int(top), 0)],
        "errors": dict(sorted((stats.get("errors") or {}).items())),
        "note": (
            "A resolved FIGI is a named security, not a company. The company layer "
            "needs the filing's LEI (or GLEIF's bulk ISIN->LEI file); until then these "
            "percentages must never be quoted as company coverage."
        ),
    }
    return measurement


def _share(numerator: float, denominator: float) -> float:
    return 100.0 * numerator / denominator if denominator else 0.0


def _signed_share(numerator: float, denominator: float) -> float:
    return 100.0 * numerator / denominator if denominator else 0.0


def _ranked_weights(
    weights: dict[str, float], counts: dict[str, int], total: float
) -> list[dict[str, Any]]:
    rows = [
        {
            "key": key,
            "bp": round(weight, 2),
            "pct_of_resolved": round(_share(weight, total), 2),
            "isins": counts.get(key, 0),
        }
        for key, weight in weights.items()
    ]
    return sorted(rows, key=lambda row: (-row["bp"], row["key"]))


def build(
    release: Path | None = None,
    *,
    layer_dir: Path | None = None,
    cache_dir: Path | None = None,
    top: int = 20,
) -> BuildOutcome:
    """Write ``isin_map.json`` from the cache, then measure what it bought.

    Deterministic by construction: the map is a function of the cached bodies and the
    harvest record, keys are sorted, and the bytes contain nothing from the clock — the
    same cache produces a byte-identical file.
    """
    layer = layer_dir
    if layer is None:
        layer = (
            default_layer_dir(release.name)
            if release is not None
            else _latest_layer_dir()
        )
    if layer is None:
        raise IdentifierError(
            "no identifier layer on disk — run `python -m pipeline.identifiers harvest` first"
        )
    stored = _read_gzip_json(index_path(layer))
    index = IsinIndex.from_document(stored) if isinstance(stored, dict) else None
    if index is None:
        raise IdentifierError(
            f"no ISIN index under {index_path(layer)} — run `harvest` first"
        )
    if release is not None and index.release != release.name:
        raise IdentifierError(
            f"the stored index describes release {index.release}, not {release.name}"
        )
    cache = cache_dir or default_openfigi_cache()
    mapping, stats = collect_isin_map(layer, cache)
    measurement = measure(index, mapping, stats, top=top)
    layer.mkdir(parents=True, exist_ok=True)
    isin_map_path(layer).write_text(
        json.dumps(mapping, indent=2, sort_keys=True) + "\n"
    )
    measurement["isin_map_path"] = str(isin_map_path(layer))
    measurement_path(layer).write_text(
        json.dumps(measurement, indent=2, sort_keys=True) + "\n"
    )
    report = render_measurement(measurement)
    return BuildOutcome(
        as_of=index.as_of, isin_map=mapping, measurement=measurement, report=report
    )


def _format_bp(value: float) -> str:
    return f"{value:,.0f}"


def _format_pct(value: float | None) -> str:
    """A missing denominator is a dash, never a zero that reads as a failure."""
    if value is None:
        return "—"
    return f"{value:.1f}%"


def render_measurement(measurement: dict[str, Any]) -> str:
    """The measurement as a plain-text block.

    No identifier ever appears here: no ISIN, no CUSIP, no LEI, no security name. The
    unit of the report is weight (bp) and category, because that is what can be
    published — the map with the names in it stays in the git-ignored layer.
    """
    lines: list[str] = []
    lines.append(
        f"OpenFIGI identifier layer — release {measurement['release']} "
        f"(as_of {measurement['as_of']})"
    )
    lines.append(
        f"  distinct ISINs in the unmapped set   {measurement['distinct_isins']:>12,}"
        f"   mapped to a FIGI {measurement['isins_in_map']:>12,}"
    )
    lines.append(
        f"  jobs asked / resolved                {measurement['jobs_asked']:>12,}"
        f"   / {measurement['jobs_resolved']:>12,}"
        f"   requests {measurement['requests']:>8,}"
    )
    lines.append("")
    lines.append(
        "UNMAPPED WEIGHT IN THE TARGET CATEGORIES (equity + debt + fund)."
    )
    lines.append(
        "  Cash, derivative and 'other' rows are excluded because no identifier resolves"
    )
    lines.append(
        "  a swap, and a cash row has no security behind it."
    )
    published = measurement["published_target_bp"]
    covered = measurement["covered_bp"]
    asked = measurement["asked_bp"]
    resolved = measurement["resolved_bp"]
    lines.append(
        f"  unclaimed company weight published    {_format_bp(published):>12} bp"
        f"   100.0%   (before)"
    )
    lines.append(
        f"  re-derived by joining the filings     {_format_bp(measurement['computed_target_bp']):>12} bp"
        f"   join residual {measurement['reconciliation_pct']:+.3f}%"
    )
    lines.append(
        f"  carrying an ISIN (the harvest target) {_format_bp(covered):>12} bp"
        f"   {_format_pct(measurement['covered_pct_of_gap']):>6} of the gap"
    )
    lines.append(
        f"  asked of OpenFIGI so far              {_format_bp(asked):>12} bp"
        f"   {_format_pct(measurement['asked_pct_of_gap']):>6} of the gap"
    )
    lines.append(
        f"  resolving to a named security         {_format_bp(resolved):>12} bp"
        f"   {_format_pct(measurement['resolved_pct_of_asked']):>6} of what was asked"
    )
    lines.append(
        f"  projected over the whole target       {_format_bp(measurement['projected_bp']):>12} bp"
        f"   {_format_pct(measurement['projected_pct_of_gap']):>6} of the gap"
        "   (estimate)"
    )
    lines.append("")
    lines.append(
        "  The resolved figure is a fact about what has been asked; the projected figure"
    )
    lines.append(
        "  is the measured rate applied to the target, so it is an estimate from a"
    )
    lines.append(
        "  sample and says nothing about the funds this sample did not touch. Neither"
    )
    lines.append("  is company coverage.")
    lines.append("")
    lines.append(
        "A RESOLVED FIGI IS A NAMED SECURITY, NOT A COMPANY."
    )
    lines.append(
        "  Nothing here is company coverage: government paper and other funds' shares"
    )
    lines.append(
        "  resolve too. The company claim needs the filing's LEI, which this layer does"
    )
    lines.append(
        "  not yet join."
    )
    lines.append("")
    lines.append("  By published category:")
    for category, row in measurement["by_category"].items():
        lines.append(
            f"    {category:<10} asked {_format_bp(row['asked_bp']):>12} bp"
            f"   resolved {_format_bp(row['resolved_bp']):>12} bp"
            f"   {_format_pct(row['resolved_pct_of_asked']):>6} of asked"
        )
    lines.append("")
    lines.append("  By market sector (share of resolved weight — the honesty check):")
    for row in measurement["by_market_sector"]:
        lines.append(
            f"    {row['key']:<18} {_format_bp(row['bp']):>12} bp"
            f"   {_format_pct(row['pct_of_resolved']):>6}   {row['isins']:>7,} ISINs"
        )
    lines.append("")
    lines.append("  By security type:")
    for row in measurement["by_security_type"]:
        lines.append(
            f"    {row['key']:<18} {_format_bp(row['bp']):>12} bp"
            f"   {_format_pct(row['pct_of_resolved']):>6}   {row['isins']:>7,} ISINs"
        )
    lines.append("")
    lines.append(
        f"PER FUND — {measurement['funds_with_resolution']:,} of"
        f" {measurement['funds_measured']:,} funds have weight this layer resolves;"
        f" {measurement['funds_asked']:,} have been asked about."
    )
    lines.append(
        "  bp columns are gross unmapped weight in the target categories; a fund with"
        " no asked ISIN shows a dash, because unasked is not 0%."
    )
    if measurement.get("top_funds_equity"):
        lines.append("")
        lines.append(
            f"  Top {len(measurement['top_funds_equity'])} by equity weight resolved"
            " — the brief's per-fund question:"
        )
        lines.append(
            f"  {'fund':<10}{'eq unmapped':>13}{'eq asked':>11}{'eq resolved':>13}"
            f"{'% equity':>10}{'all bp':>11}"
        )
        for row in measurement["top_funds_equity"]:
            lines.append(
                f"  {row['ticker']:<10}{_format_bp(row['unmapped_equity_bp']):>13}"
                f"{_format_bp(row['asked_equity_bp']):>11}"
                f"{_format_bp(row['resolved_equity_bp']):>13}"
                f"{_format_pct(row['equity_resolved_pct_of_equity_asked']):>10}"
                f"{_format_bp(row['resolved_bp']):>11}"
            )
        lines.append(
            f"  {len(measurement['per_fund']):,} funds measured;"
            f" {sum(1 for row in measurement['per_fund'] if row['resolved_equity_bp'] > 0):,}"
            " have any equity resolved at all."
        )
        lines.append("")
        lines.append(
            f"  Top {len(measurement['top_funds'])} by total weight resolved"
            " (bond-heavy funds dominate this one):"
        )
    header = (
        f"  {'fund':<10}{'unmapped':>11}{'equity':>11}"
        f"{'asked':>11}{'resolved':>11}{'% asked':>9}{'% equity':>10}"
    )
    lines.append(header)
    for row in measurement["top_funds"]:
        lines.append(
            f"  {row['ticker']:<10}{_format_bp(row['unmapped_bp']):>11}"
            f"{_format_bp(row['unmapped_equity_bp']):>11}"
            f"{_format_bp(row['asked_bp']):>11}{_format_bp(row['resolved_bp']):>11}"
            f"{_format_pct(row['resolved_pct_of_asked']):>9}"
            f"{_format_pct(row['equity_resolved_pct_of_equity_asked']):>10}"
        )
    lines.append(
        f"  top {len(measurement['top_funds'])} by resolvable weight; % equity is"
        " equity resolved ÷ equity asked. Every fund, and the"
        " resolved-share-of-gap column, is in the measurement file."
    )
    if measurement.get("errors"):
        lines.append("")
        lines.append("  Unresolved jobs, by OpenFIGI's own message:")
        for message, count in measurement["errors"].items():
            lines.append(f"    {message:<48} {count:>8,}")
    lines.append("")
    lines.append(
        f"  map: {measurement.get('isin_map_path', 'data/identifier-layer')}"
        "  (git-ignored: ISINs are join keys, and the returned names carry no"
        " public-domain grant)"
    )
    return "\n".join(lines)


# --- CLI -------------------------------------------------------------------


def find_release(target: str | None) -> Path:
    """Resolve ``--release`` (a path or an id) or take the newest release on disk."""
    if target:
        path = Path(target)
        if path.is_dir():
            return path
        matches = sorted(paths.REPO_ROOT.glob(f"artifacts/*/releases/{path.name}"))
        if matches:
            return matches[-1]
        raise IdentifierError(f"release not found: {target}")
    candidates = sorted(
        path
        for path in paths.REPO_ROOT.glob("artifacts/*/releases/*")
        if (path / "funds").is_dir()
    )
    if not candidates:
        raise IdentifierError("no release with fund documents under artifacts/")
    return candidates[-1]


def _progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _projection(index_size: int, *, unauth_jobs: int = UNAUTHENTICATED_JOBS) -> str:
    """Wall-clock floor for the whole corpus, both modes, from the pacing alone."""
    import math

    unauth_requests = math.ceil(index_size / unauth_jobs)
    keyed_requests = math.ceil(index_size / KEYED_JOBS)
    unauth_hours = unauth_requests * interval_seconds(UNAUTHENTICATED_RPM) / 3600.0
    keyed_minutes = keyed_requests * interval_seconds(KEYED_RPM) / 60.0
    return (
        f"  projection for {index_size:,} distinct ISINs: "
        f"{unauth_requests:,} requests unauthenticated ≈ {unauth_hours:.1f} h; "
        f"{keyed_requests:,} requests keyed ≈ {keyed_minutes:.1f} min"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.identifiers",
        description=(
            "Resolve a release's unmapped holdings to named securities via OpenFIGI, "
            "and measure the weight that recovers."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    harvest_parser = subparsers.add_parser(
        "harvest", help="resolve ISINs to FIGIs, caching every response"
    )
    harvest_parser.add_argument("--release", default=None, help="release id or directory")
    harvest_parser.add_argument(
        "--limit", type=int, default=None, help="only the first N ISINs of the harvest order"
    )
    harvest_parser.add_argument(
        "--rpm", type=float, default=None, help="override requests per minute"
    )
    harvest_parser.add_argument(
        "--jobs", type=int, default=None, help="override jobs bundled per request"
    )
    harvest_parser.add_argument(
        "--no-network",
        action="store_true",
        help="answer from the cache only; a miss is reported, never fetched",
    )
    harvest_parser.add_argument(
        "--refresh-index", action="store_true", help="rebuild the ISIN index from the release"
    )
    harvest_parser.add_argument("--layer-dir", default=None, help="override the layer directory")
    harvest_parser.add_argument("--cache-dir", default=None, help="override the response cache")

    build_parser = subparsers.add_parser(
        "build", help="write isin_map.json from the cache and print the measurement"
    )
    build_parser.add_argument("--release", default=None, help="release id or directory")
    build_parser.add_argument("--layer-dir", default=None, help="override the layer directory")
    build_parser.add_argument("--cache-dir", default=None, help="override the response cache")
    build_parser.add_argument(
        "--top", type=int, default=20, help="how many funds to print (all are in the file)"
    )

    arguments = parser.parse_args(argv)

    try:
        if arguments.command == "harvest":
            release = find_release(arguments.release)
            layer = Path(arguments.layer_dir) if arguments.layer_dir else None
            cache = Path(arguments.cache_dir) if arguments.cache_dir else None
            outcome = harvest(
                release,
                layer_dir=layer,
                cache_dir=cache,
                limit=arguments.limit,
                rpm=arguments.rpm,
                jobs_per_request=arguments.jobs,
                no_network=arguments.no_network,
                refresh_index=arguments.refresh_index,
                progress=_progress,
            )
            mode = "keyed" if outcome.keyed else "unauthenticated"
            print(
                f"harvest: {mode} ({outcome.rpm:g} req/min, "
                f"{outcome.jobs_per_request} jobs/request), release {outcome.as_of}"
            )
            print(
                f"  ISINs in index {outcome.isins_in_index:,}"
                f" · selected {outcome.isins_selected:,}"
                f" · batches {outcome.batches_total:,}"
            )
            print(
                f"  requested {outcome.batches_requested:,}"
                f" · cached {outcome.batches_cached:,}"
                f" · failed {outcome.batches_failed:,}"
                f" · offline misses {outcome.offline_misses:,}"
            )
            print(
                f"  {outcome.requests:,} requests, {outcome.isins_resolved:,} ISINs resolved,"
                f" {outcome.seconds:.1f} s"
            )
            print(_projection(outcome.isins_in_index))
            if outcome.stopped:
                print(f"  stopped: {outcome.stopped}", file=sys.stderr)
            if outcome.offline_misses:
                print(
                    f"  offline: {outcome.offline_misses:,} batches are not in the cache",
                    file=sys.stderr,
                )
                return 1
            if outcome.stopped:
                return 1
            return 0

        release = find_release(arguments.release) if arguments.release else None
        layer = Path(arguments.layer_dir) if arguments.layer_dir else None
        cache = Path(arguments.cache_dir) if arguments.cache_dir else None
        outcome = build(
            release, layer_dir=layer, cache_dir=cache, top=arguments.top
        )
        print(outcome.report)
        return 0
    except IdentifierError as error:
        print(f"identifiers: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover - exercised through `python -m`
    raise SystemExit(main())
