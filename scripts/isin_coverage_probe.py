#!/usr/bin/env python3
"""How much of the published *unmapped* weight would an identifier source recover?

    python scripts/isin_coverage_probe.py                 # measure + query both APIs
    python scripts/isin_coverage_probe.py --no-network    # measure offline, read the cache only

The question this answers, in one sentence: if we sent the identifiers the N-PORT
filings already carry to OpenFIGI (ISIN → named security) and GLEIF (name → legal
entity), how much of the ~52% of published holding weight that resolves to no
company would become mappable?

It is a **measurement, not an integration**. It writes nothing into a release,
fetches nothing from SEC, needs no key and no account, and costs $0. Nothing it
learns can reach an artifact: the only published object is a Markdown note of
aggregates.

Four rules it keeps, because each one is a way a probe like this goes wrong:

* **No identifier is ever printed or written.** ISIN, CUSIP and LEI values are
  licensed or entity-level keys that stay internal (``compliance-licensing-guard``).
  They live in this process's memory as join keys and in the HTTP cache as request
  hashes — never in stdout, the summary JSON, or the note. Example rows use the
  masking helper (``_masked``), which returns a fixed dummy shape.
* **The artifact is the authority on what is unmapped.** A holding row is unmapped
  when ``company_id`` is null in ``funds/<TICKER>.json``; the identifiers are then
  recovered from the very N-PORT document that produced it, by parsing the cached
  bytes at ``sha256(source_url)``. The two are cross-checked by weight (the run
  prints the reconciliation), because a join that silently loses rows would
  produce a confident wrong answer.
* **Re-runnable and offline-safe.** Every response body is cached under
  ``data/cache/isin-probe/`` keyed by a hash of the request, so a second run spends
  no requests and ``--no-network`` answers from what is already there.
* **Unauthenticated rate limits are the real constraint.** OpenFIGI allows 25
  requests/minute and 10 jobs/request without a key; a 429 is obeyed via its
  ``retry-after`` header, and a 401/403 stops the run and reports that a key would
  be required rather than retrying in a loop. GLEIF gets one call per second.

The sample is systematic probability-proportional-to-size over the distinct ISINs
in the unmapped set, ordered by a hash of the ISIN (so no ordering — country
prefix, fund size — correlates with the selection). The estimator is therefore a
weighted ratio, and the run prints a bootstrap interval over the sampled units.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipeline"))

from pipeline import classify, identifiers, nport, sec  # noqa: E402
from pipeline.companies import name_tokens  # noqa: E402
from pipeline.weights import _fraction  # noqa: E402

#: The release the measurement is defined against. `--release` overrides it.
DEFAULT_RELEASE = REPO / "artifacts/universe-c/releases/2026-10-30.5"

#: Our own cache, beside the build's `data/cache/<sha256(url)>.bin` trees. Never
#: the same directory: `data/cache/isin-probe/` cannot collide with a 2-hex shard.
PROBE_CACHE = REPO / "data/cache/isin-probe"

OPENFIGI_URL = "https://api.openfigi.com/v3/mapping"
GLEIF_URL = "https://api.gleif.org/api/v1/lei-records"
USER_AGENT = "UnpackFund research data@unpackfund.com"

#: Verified on openfigi.com/api/documentation: 25 requests/minute + 10 jobs/request
#: unauthenticated. 2.6 s spacing keeps a margin under the window the response
#: itself reports (`ratelimit-policy: 25;w=60`).
JOBS_PER_REQUEST = 10
OPENFIGI_INTERVAL_S = 2.6
#: GLEIF publishes no unauthenticated limit to obey; one call a second is enough
#: for 25 lookups and is not a stream.
GLEIF_INTERVAL_S = 1.0

#: The pause after a 429 with no usable `retry-after`.
FALLBACK_RETRY_S = 10.0
MAX_TRIES = 3

REQUEST_TIMEOUT_S = 30.0


class KeyRequired(RuntimeError):
    """The API answered 401/403: it wants a key. Stop, do not retry."""


class ProbeError(RuntimeError):
    """A response we cannot use."""


class OfflineMiss(RuntimeError):
    """``--no-network`` and this exact request was never made. Stop, do not call."""


def log(message: str) -> None:
    """Progress goes to stderr so stdout stays the compact summary."""
    print(message, file=sys.stderr, flush=True)


def _masked(kind: str) -> str:
    """A fixed dummy of the right shape, for anything that must show a field.

    Never derived from a real value: a prefix of an identifier is still a partial
    identifier, and "US" plus a few characters is more than the rules allow to
    leak. The whole point of the mask is that it says nothing.
    """
    return "US" + "0" * 10 if kind == "isin" else "0" * 20


# ---------------------------------------------------------------------------
# HTTP, with a request-hash cache and the rate limits the API actually states
# ---------------------------------------------------------------------------


def _cache_paths(method: str, url: str, body: bytes | None) -> tuple[Path, Path]:
    """Cache keys are request hashes, so no identifier is written to disk.

    For a POST the body carries the ISINs; only its digest is used, which means a
    reader of the cache directory learns how many requests were made and against
    which endpoint, not which securities were asked about. For a GET the URL *is*
    the request, and the only GET here is a GLEIF legal-name lookup — a public name.
    """
    digest = hashlib.sha256()
    digest.update(method.encode())
    digest.update(b"\n")
    digest.update(url.encode())
    if body:
        digest.update(b"\n")
        digest.update(hashlib.sha256(body).digest())
    key = digest.hexdigest()
    stem = PROBE_CACHE / key[:2] / key
    return stem.with_suffix(".bin"), stem.with_suffix(".json")


_last_call: dict[str, float] = {}
_requests_made: Counter[str] = Counter()
_cache_hits: Counter[str] = Counter()
_rate_limited: Counter[str] = Counter()
_retry_after_seen: list[float] = []


def _throttle(host: str, interval: float) -> None:
    previous = _last_call.get(host)
    if previous is not None:
        wait = interval - (time.monotonic() - previous)
        if wait > 0:
            time.sleep(wait)
    _last_call[host] = time.monotonic()


def _retry_after(headers: Any) -> float:
    for name in ("retry-after", "x-ratelimit-reset", "ratelimit-reset"):
        raw = headers.get(name) if headers is not None else None
        if not raw:
            continue
        try:
            value = float(str(raw).strip())
        except ValueError:
            continue
        if value > 0:
            return min(value, 120.0)
    return FALLBACK_RETRY_S


def http_json(
    method: str,
    url: str,
    *,
    body: bytes | None = None,
    interval: float = OPENFIGI_INTERVAL_S,
    headers: dict[str, str] | None = None,
    allow_network: bool = True,
) -> Any:
    """Return a JSON response, from cache when the exact request was made before.

    ``allow_network=False`` turns a cache miss into :class:`OfflineMiss` rather than
    a request, which is what makes a second run provably free: it either answers
    from disk or says which request it would have made.
    """
    body_path, meta_path = _cache_paths(method, url, body)
    host = urllib.parse.urlparse(url).netloc
    if body_path.exists():
        _cache_hits[host] += 1
        return json.loads(body_path.read_bytes())
    if not allow_network:
        raise OfflineMiss(f"{host}: request not in the cache")

    request_headers = {
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
        **(headers or {}),
    }
    if body is not None:
        request_headers["Content-Type"] = "application/json"

    for attempt in range(MAX_TRIES):
        _throttle(host, interval)
        _requests_made[host] += 1
        request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
                status = response.status
                payload = response.read()
                response_headers = response.headers
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise KeyRequired(
                    f"{host} answered {error.code} — an API key would be required"
                ) from error
            if error.code == 429:
                pause = _retry_after(error.headers)
                _rate_limited[host] += 1
                _retry_after_seen.append(pause)
                log(f"  {host}: 429 rate-limited, honouring retry-after {pause:.0f}s")
                time.sleep(pause)
                continue
            if 500 <= error.code < 600 and attempt + 1 < MAX_TRIES:
                log(f"  {host}: {error.code}, retrying once")
                time.sleep(FALLBACK_RETRY_S / 2)
                continue
            raise ProbeError(f"{host} answered {error.code} for {method}") from error
        except urllib.error.URLError as error:
            if attempt + 1 < MAX_TRIES:
                log(f"  {host}: network error ({error.reason}), retrying once")
                time.sleep(FALLBACK_RETRY_S / 2)
                continue
            raise ProbeError(f"{host} unreachable: {error.reason}") from error

        # The unauthenticated window is small enough that the response's own
        # accounting is worth obeying when it says nothing is left.
        remaining = response_headers.get("ratelimit-remaining")
        if remaining is not None:
            try:
                if int(str(remaining).strip()) <= 0:
                    pause = _retry_after(response_headers)
                    log(f"  {host}: rate-limit window exhausted, resting {pause:.0f}s")
                    time.sleep(pause)
            except ValueError:
                pass

        body_path.parent.mkdir(parents=True, exist_ok=True)
        body_path.write_bytes(payload)
        meta_path.write_text(
            json.dumps(
                {
                    "method": method,
                    # A POST URL is constant; the body is recorded as a digest only.
                    "url": url if method == "GET" else url,
                    "request_body_bytes": len(body or b""),
                    "request_body_sha256": hashlib.sha256(body).hexdigest() if body else None,
                    "retrieved_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "status": status,
                    "bytes": len(payload),
                },
                indent=2,
            )
            + "\n"
        )
        return json.loads(payload)

    raise ProbeError(f"{host}: gave up after {MAX_TRIES} attempts")


# ---------------------------------------------------------------------------
# The unmapped set, and the identifiers the artifact does not carry
# ---------------------------------------------------------------------------


@dataclass
class IsinAgg:
    """One distinct ISIN in the unmapped set, aggregated across funds."""

    weight: float = 0.0  # gross unmapped bp carried by this ISIN
    signed: float = 0.0  # signed bp, for the reconciliation against the artifact
    lei_weight: float = 0.0  # gross bp of these rows whose filing also carries a LEI
    us: float = 0.0
    nonus: float = 0.0
    unknown_country: float = 0.0
    cats: dict[str, float] = field(default_factory=dict)

    def add(self, rows: Iterable[tuple[float, float, str, str, bool]]) -> None:
        for gross, signed, category, country, has_lei in rows:
            self.weight += gross
            self.signed += signed
            if has_lei:
                self.lei_weight += gross
            if country == "US":
                self.us += gross
            elif country:
                self.nonus += gross
            else:
                self.unknown_country += gross
            self.cats[category] = self.cats.get(category, 0.0) + gross

    @property
    def dominant_category(self) -> str:
        return max(self.cats.items(), key=lambda row: row[1])[0] if self.cats else "other"

    @property
    def country_group(self) -> str:
        if self.unknown_country > max(self.us, self.nonus):
            return "unknown"
        return "US" if self.us >= self.nonus else "non-US"


#: One unmapped *artifact* row is a group of filer rows merged on name + category
#: (``weights.build_vector``), so the recovery joins on that same key. Matching on
#: ``(public_name(name).upper(), category)`` rather than on a row index is what
#: makes the join survive the merge, the redaction and the sort.
UNMAPPED_BUCKETS = ("both", "isin_only", "lei_only", "neither")


def _published_bp(row: dict[str, Any]) -> tuple[int, float]:
    """The row as published: signed basis points, and their magnitude."""
    weight = int(row.get("weight_bp") or 0)
    return weight, abs(weight)


def _recover_fund(task: tuple[str, str]) -> dict[str, Any]:
    """Measure one fund: artifact side, then the filing's identifiers.

    Runs in a worker process, so it returns only aggregates and one tuple per
    distinct ISIN — never a parsed filing.
    """
    ticker, fund_path = task
    result: dict[str, Any] = {
        "ticker": ticker,
        "funds_error": None,
        "artifact_unmapped_signed": 0.0,
        "artifact_unmapped_gross": 0.0,
        "artifact_mapped_gross": 0.0,
        "artifact_gross": 0.0,
        "artifact_rows": 0,
        "unmapped_rows": 0,
        "unmapped_cat_gross": {},
        "mapped_cat_gross": {},
        "recovered_signed": 0.0,
        "recovered_rows": 0,
        "fallback_rows": 0,
        "buckets": dict.fromkeys(UNMAPPED_BUCKETS, 0.0),
        "buckets_company": dict.fromkeys(UNMAPPED_BUCKETS, 0.0),
        "buckets_by_cat": {},
        "recovered_cat_gross": {},
        "isins": [],
    }
    try:
        document = json.loads(Path(fund_path).read_text())
    except (OSError, ValueError) as error:
        result["funds_error"] = f"{type(error).__name__}: {error}"
        return result

    unmapped_keys: set[tuple[str, str]] = set()
    names: Counter[str] = Counter()
    for row in document.get("holdings") or []:
        weight, gross = _published_bp(row)
        category = str(row.get("asset_cat") or "other")
        result["artifact_rows"] += 1
        result["artifact_gross"] += gross
        if row.get("company_id"):
            result["artifact_mapped_gross"] += gross
            mapped = result["mapped_cat_gross"]
            mapped[category] = mapped.get(category, 0.0) + gross
            continue
        result["unmapped_rows"] += 1
        result["artifact_unmapped_signed"] += weight
        result["artifact_unmapped_gross"] += gross
        collapsed = result["unmapped_cat_gross"]
        collapsed[category] = collapsed.get(category, 0.0) + gross
        name = identifiers.public_name(row.get("name")).upper()
        unmapped_keys.add((name, category))
        names[name] += 1

    if not unmapped_keys:
        return result

    source_url = str(document.get("source_url") or "")
    filing_path = sec._cache_paths(source_url)[0]
    try:
        filing = nport.parse(filing_path.read_bytes())
    except (OSError, nport.NportParseError) as error:
        result["funds_error"] = f"{type(error).__name__}: {error}"
        return result

    per_isin: dict[str, list[tuple[float, float, str, str, bool]]] = {}
    for holding in filing.holdings:
        fraction = _fraction(holding, filing.net_assets)
        if fraction is None:
            continue
        classification = classify.classify(
            holding.asset_cat, holding.issuer_cat, holding.is_derivative
        )
        category = classification.category
        name = identifiers.public_name(holding.name).upper()
        if (name, category) not in unmapped_keys:
            # The published row keeps the category of its largest merged row, while
            # the group key uses the first one. A name present exactly once in the
            # fund can be attributed anyway; anything ambiguous is dropped and shows
            # up in the reconciliation rather than being guessed.
            if names.get(name) != 1:
                continue
            result["fallback_rows"] += 1
        signed = fraction * 10_000.0
        gross = abs(signed)
        result["recovered_signed"] += signed
        result["recovered_rows"] += 1
        collapsed = result["recovered_cat_gross"]
        collapsed[category] = collapsed.get(category, 0.0) + gross
        has_isin = bool(holding.isin and len(holding.isin) == 12)
        has_lei = bool(holding.lei and len(holding.lei) == 20)
        bucket = (
            "both"
            if has_isin and has_lei
            else "isin_only"
            if has_isin
            else "lei_only"
            if has_lei
            else "neither"
        )
        result["buckets"][bucket] += gross
        by_category = result["buckets_by_cat"].setdefault(
            category, dict.fromkeys(UNMAPPED_BUCKETS, 0.0)
        )
        by_category[bucket] += gross
        if classification.is_company_exposure:
            result["buckets_company"][bucket] += gross
        if not has_isin:
            continue
        country = (holding.inv_country or "").strip().upper()
        per_isin.setdefault(holding.isin, []).append(
            (gross, signed, category, country, has_lei)
        )

    result["isins"] = list(per_isin.items())
    return result


def _empty_totals(fund_count: int) -> dict[str, Any]:
    return {
        "funds": fund_count,
        "funds_with_unmapped": 0,
        "artifact_rows": 0,
        "unmapped_rows": 0,
        "artifact_gross": 0.0,
        "artifact_mapped_gross": 0.0,
        "artifact_unmapped_signed": 0.0,
        "artifact_unmapped_gross": 0.0,
        "unmapped_cat_gross": {},
        "mapped_cat_gross": {},
        "recovered_signed": 0.0,
        "recovered_rows": 0,
        "fallback_rows": 0,
        "buckets": dict.fromkeys(UNMAPPED_BUCKETS, 0.0),
        "buckets_company": dict.fromkeys(UNMAPPED_BUCKETS, 0.0),
        "buckets_by_cat": {},
        "recovered_cat_gross": {},
        "failures": [],
        "isins": {},
    }


_INTEGER_KEYS = ("artifact_rows", "unmapped_rows", "recovered_rows", "fallback_rows")
_WEIGHT_KEYS = (
    "artifact_gross",
    "artifact_mapped_gross",
    "artifact_unmapped_signed",
    "artifact_unmapped_gross",
    "recovered_signed",
)
_DICT_KEYS = ("unmapped_cat_gross", "mapped_cat_gross", "recovered_cat_gross")


def _absorb(totals: dict[str, Any], result: dict[str, Any]) -> None:
    """Fold one worker's aggregate into the run totals."""
    if result["funds_error"]:
        totals["failures"].append(f"{result['ticker']}: {result['funds_error']}")
        return
    for key in _INTEGER_KEYS + _WEIGHT_KEYS:
        totals[key] += result[key]
    for key in _DICT_KEYS:
        target = totals[key]
        for category, weight in result[key].items():
            target[category] = target.get(category, 0.0) + weight
    for key in ("buckets", "buckets_company"):
        for bucket, weight in result[key].items():
            totals[key][bucket] += weight
    for category, split in result["buckets_by_cat"].items():
        target = totals["buckets_by_cat"].setdefault(
            category, dict.fromkeys(UNMAPPED_BUCKETS, 0.0)
        )
        for bucket, weight in split.items():
            target[bucket] += weight
    if result["artifact_unmapped_gross"] > 0:
        totals["funds_with_unmapped"] += 1
    isins: dict[str, IsinAgg] = totals["isins"]
    for isin, rows in result["isins"]:
        aggregate = isins.get(isin)
        if aggregate is None:
            aggregate = isins[isin] = IsinAgg()
        aggregate.add(rows)


def measure(release: Path, workers: int) -> dict[str, Any]:
    """The artifact-side totals, the identifier split, and every unmapped ISIN."""
    fund_paths = sorted((release / "funds").glob("*.json"))
    if not fund_paths:
        raise SystemExit(f"no fund documents under {release / 'funds'}")

    totals = _empty_totals(len(fund_paths))
    tasks = [(path.stem, str(path)) for path in fund_paths]
    start = time.time()

    def report(index: int) -> None:
        if index % 1_000 == 0:
            log(f"  measured {index:,}/{len(tasks):,} funds ({time.time() - start:.0f}s)")

    def serial() -> None:
        for index, task in enumerate(tasks, 1):
            _absorb(totals, _recover_fund(task))
            report(index)

    if workers <= 1:
        serial()
    else:
        try:
            with ProcessPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(_recover_fund, task) for task in tasks]
                for index, future in enumerate(as_completed(futures), 1):
                    _absorb(totals, future.result())
                    report(index)
        except (OSError, RuntimeError, NotImplementedError) as error:
            # A pool that cannot start is an environment problem, not a data one.
            log(f"  process pool unavailable ({error}); measuring serially")
            totals = _empty_totals(len(fund_paths))
            serial()

    totals["seconds"] = round(time.time() - start, 1)
    return totals


# ---------------------------------------------------------------------------
# The sample: probability proportional to unmapped weight, deterministically
# ---------------------------------------------------------------------------


def pps_sample(isins: dict[str, IsinAgg], target: int) -> list[str]:
    """Systematic PPS sample of distinct ISINs, ordered by a hash of the ISIN.

    Ordering by hash rather than by value or weight is what keeps the systematic
    step from walking down a sorted list: ISIN values start with the issuer's
    country, so value order would sample one country at a time. Deterministic, so
    a second run asks exactly the same questions and hits the cache.
    """
    weighted = {
        isin: aggregate.weight for isin, aggregate in isins.items() if aggregate.weight > 0
    }
    if not weighted:
        return []
    order = sorted(weighted, key=lambda isin: hashlib.sha256(isin.encode()).hexdigest())
    total = sum(weighted.values())
    step = total / target
    chosen: list[str] = []
    cumulative = 0.0
    threshold = step
    for isin in order:
        cumulative += weighted[isin]
        while threshold <= cumulative and len(chosen) < target:
            chosen.append(isin)
            threshold += step
    return chosen


def bootstrap_interval(
    weights: list[float], resolved: list[float], *, draws: int = 2_000, seed: int = 7
) -> tuple[float, float]:
    """A ratio-estimator interval from resampling the sampled units.

    Honest about what it is: a bootstrap over the sample, not a design-based
    variance for systematic PPS. It answers "how much would this number move if the
    draw had been a little different", which is the question a reader actually has.
    """
    if not weights or sum(weights) <= 0:
        return (0.0, 0.0)
    randomizer = random.Random(seed)
    shares: list[float] = []
    for _ in range(draws):
        top = 0.0
        bottom = 0.0
        for _ in range(len(weights)):
            index = randomizer.randrange(len(weights))
            bottom += weights[index]
            top += resolved[index]
        if bottom > 0:
            shares.append(top / bottom)
    shares.sort()
    if not shares:
        return (0.0, 0.0)
    low = shares[int(0.025 * len(shares))]
    high = shares[int(0.975 * len(shares)) - 1]
    return (low, high)


# ---------------------------------------------------------------------------
# OpenFIGI, then GLEIF on the names it returns
# ---------------------------------------------------------------------------


def openfigi_map(
    isins: list[str], *, deadline: float, allow_network: bool = True
) -> dict[str, Any]:
    """One job per ISIN, ten jobs a request, paced under the 25/minute window."""
    batches = [
        isins[index : index + JOBS_PER_REQUEST]
        for index in range(0, len(isins), JOBS_PER_REQUEST)
    ]
    outcome: dict[str, Any] = {
        "requested": len(isins),
        "requests": 0,
        "cache_hits": 0,
        "resolved": {},
        "errors": Counter(),
        "stopped": None,
        "seconds": 0.0,
    }
    start = time.time()
    for number, batch in enumerate(batches, 1):
        if time.monotonic() > deadline:
            outcome["stopped"] = f"deadline after {number - 1} of {len(batches)} requests"
            log(f"  openfigi: {outcome['stopped']}")
            break
        jobs = [{"idType": "ID_ISIN", "idValue": isin} for isin in batch]
        body = json.dumps(jobs).encode()
        cached_before = _requests_made.get("api.openfigi.com", 0)
        try:
            payload = http_json(
                "POST", OPENFIGI_URL, body=body, allow_network=allow_network
            )
        except OfflineMiss:
            outcome["stopped"] = (
                f"offline: {number - 1} of {len(batches)} batches were cached"
            )
            log(f"  openfigi: {outcome['stopped']}")
            break
        except KeyRequired as error:
            outcome["stopped"] = str(error)
            log(f"  openfigi: {error} — stopping")
            break
        except ProbeError as error:
            outcome["stopped"] = str(error)
            log(f"  openfigi: {error} — stopping")
            break
        if _requests_made.get("api.openfigi.com", 0) > cached_before:
            outcome["requests"] += 1
        else:
            outcome["cache_hits"] += 1
        if not isinstance(payload, list) or len(payload) != len(batch):
            outcome["stopped"] = f"malformed response ({type(payload).__name__})"
            break
        for isin, entry in zip(batch, payload):
            records = entry.get("data") if isinstance(entry, dict) else None
            if isinstance(records, list) and records:
                first = records[0] if isinstance(records[0], dict) else {}
                outcome["resolved"][isin] = {
                    "name": str(first.get("name") or "").strip(),
                    "ticker": str(first.get("ticker") or "").strip() or None,
                    "securityType": first.get("securityType"),
                    "securityType2": first.get("securityType2"),
                    "marketSector": first.get("marketSector"),
                    "figi": bool(first.get("figi")),
                    "shareClassFIGI": bool(first.get("shareClassFIGI")),
                    "compositeFIGI": bool(first.get("compositeFIGI")),
                    "records": len(records),
                }
            else:
                error = entry.get("error") if isinstance(entry, dict) else None
                outcome["errors"][str(error or "empty result")] += 1
        if number % 5 == 0:
            log(
                f"  openfigi: {number}/{len(batches)} requests, "
                f"{len(outcome['resolved'])} resolved ({time.time() - start:.0f}s)"
            )
    outcome["seconds"] = round(time.time() - start, 1)
    return outcome


def gleif_lookup(
    names: list[str], *, deadline: float, allow_network: bool = True
) -> dict[str, Any]:
    """Does the entity layer close when we only have a security name?

    GLEIF's ``filter[entity.legalName]`` is a name filter, not a matcher: an
    abbreviated OpenFIGI security name will usually miss a legal name. That is
    exactly the weakness this measures, because the alternative — the ISIN→LEI
    relationship in the filing — needs no name at all.
    """
    found: dict[str, Any] = {}
    attempts = 0
    errors: Counter[str] = Counter()
    stopped = None
    start = time.time()
    for name in names:
        if time.monotonic() > deadline:
            stopped = "deadline"
            break
        query = urllib.parse.urlencode({"filter[entity.legalName]": name, "page[size]": "1"})
        url = f"{GLEIF_URL}?{query}"
        try:
            payload = http_json(
                "GET",
                url,
                interval=GLEIF_INTERVAL_S,
                headers={"Accept": "application/vnd.api+json"},
                allow_network=allow_network,
            )
        except OfflineMiss:
            stopped = f"offline: {attempts} of {len(names)} lookups were cached"
            log(f"  gleif: {stopped}")
            break
        except KeyRequired as error:
            stopped = str(error)
            log(f"  gleif: {error} — stopping")
            break
        except ProbeError as error:
            stopped = str(error)
            errors[str(error)] += 1
            continue
        attempts += 1
        records = payload.get("data") if isinstance(payload, dict) else None
        matched = bool(records)
        legal_name = ""
        if matched:
            entity = (records[0].get("attributes") or {}).get("entity") or {}
            legal_name = str((entity.get("legalName") or {}).get("name") or "")
        found[name] = {
            "matched": matched,
            # The legal name is CC0 and displayable; it is kept to show what a match
            # actually returned, not to identify the security.
            "legal_name": legal_name,
            "total": int(((payload.get("meta") or {}).get("pagination") or {}).get("total") or 0),
        }
    return {
        "requested": len(names),
        "attempted": attempts,
        "matched": sum(1 for row in found.values() if row["matched"]),
        "results": found,
        "errors": errors,
        "stopped": stopped,
        "seconds": round(time.time() - start, 1),
    }


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def _normalised(name: str) -> str:
    return " ".join(
        "".join(character if character.isalnum() else " " for character in name.upper()).split()
    )


def dedupe_against(companies: list[str], resolved_names: list[str]) -> dict[str, Any]:
    """How many of the resolved names would be a genuinely new company?

    Two tests, both name-only, because no identifier joins an OpenFIGI name to an
    EDGAR registrant: an exact match on the normalized name, and — for the ones
    that fail it — a token-set test where every identity-bearing word of the
    resolved name appears in some published company's name. The second test is
    generous, so "new" is an **upper bound**; a fuzzy or entity-keyed join would
    only shrink it.
    """
    published = [_normalised(name) for name in companies if name]
    exact = set(published)
    token_sets = {frozenset(name_tokens(name)) for name in companies if name}
    token_sets.discard(frozenset())
    exact_hits = 0
    token_hits = 0
    new: list[str] = []
    for name in resolved_names:
        key = _normalised(name)
        if key in exact:
            exact_hits += 1
            continue
        tokens = frozenset(token for token in name_tokens(name) if len(token) > 2)
        if tokens and any(tokens.issubset(theirs) for theirs in token_sets):
            token_hits += 1
            continue
        new.append(name)
    return {
        "distinct_names": len(resolved_names),
        "already_exact": exact_hits,
        "already_token": token_hits,
        "new_upper_bound": len(new),
        "new_examples": sorted(new)[:8],
    }


def summarise(
    totals: dict[str, Any],
    sample: list[str],
    openfigi: dict[str, Any],
    gleif: dict[str, Any],
    companies: list[str],
    *,
    target: int,
    release: Path,
    seconds: float,
) -> dict[str, Any]:
    isins: dict[str, IsinAgg] = totals["isins"]
    buckets = totals["buckets"]
    bucket_total = sum(buckets.values()) or 1.0

    sampled = [(isin, isins[isin]) for isin in sample if isin in isins]
    sampled_weight = sum(aggregate.weight for _, aggregate in sampled)
    resolved_rows = [
        (isin, aggregate, openfigi["resolved"].get(isin)) for isin, aggregate in sampled
    ]
    resolved_weight = sum(
        aggregate.weight for _, aggregate, hit in resolved_rows if hit is not None
    )
    share = resolved_weight / sampled_weight if sampled_weight else 0.0
    low, high = bootstrap_interval(
        [aggregate.weight for _, aggregate in sampled],
        [aggregate.weight if hit else 0.0 for _, aggregate, hit in resolved_rows],
    )

    # By asset category and by US / non-US, over the same sampled units.
    by_category: dict[str, dict[str, float]] = {}
    for _, aggregate, hit in resolved_rows:
        category = aggregate.dominant_category
        row = by_category.setdefault(category, {"weight": 0.0, "resolved": 0.0, "units": 0})
        row["weight"] += aggregate.weight
        row["units"] += 1
        if hit:
            row["resolved"] += aggregate.weight
    by_country: dict[str, dict[str, float]] = {}
    for _, aggregate, hit in resolved_rows:
        group = aggregate.country_group
        row = by_country.setdefault(group, {"weight": 0.0, "resolved": 0.0, "units": 0})
        row["weight"] += aggregate.weight
        row["units"] += 1
        if hit:
            row["resolved"] += aggregate.weight

    resolved_names = sorted(
        {hit["name"] for _, _, hit in resolved_rows if hit and hit.get("name")},
    )
    dedupe = dedupe_against(companies, resolved_names)

    # A resolved row is not automatically a company. OpenFIGI's `marketSector` says
    # what kind of instrument answered: `Equity` is a company's share, while
    # `Govt`/`Muni`/`Mtge` are issuers that are not companies at all and a fund
    # share (ETP / Open-End Fund) is another fund. So the name-level "new company"
    # question is asked twice: once over every resolved name, and once over only the
    # names whose instrument sits in the Equity sector — the only bucket that can
    # become a company without a second, entity-level step.
    sector_of_name: dict[str, set[str]] = {}
    weight_of_name: dict[str, float] = {}
    for _, aggregate, hit in resolved_rows:
        if not hit or not hit.get("name"):
            continue
        sector_of_name.setdefault(hit["name"], set()).add(str(hit.get("marketSector") or "unknown"))
        weight_of_name[hit["name"]] = weight_of_name.get(hit["name"], 0.0) + aggregate.weight
    equity_names = sorted(
        (name for name, sectors in sector_of_name.items() if "Equity" in sectors),
        key=lambda name: (-weight_of_name.get(name, 0.0), name),
    )
    dedupe_equity = dedupe_against(companies, equity_names)

    # What the misses are, not just how many: an unresolved ISIN is a coverage
    # boundary only if it is concentrated somewhere a second source could reach.
    unresolved_by_category: dict[str, int] = {}
    unresolved_by_country: dict[str, int] = {}
    unresolved_weight = 0.0
    for _, aggregate, hit in resolved_rows:
        if hit is not None:
            continue
        unresolved_weight += aggregate.weight
        unresolved_by_category[aggregate.dominant_category] = (
            unresolved_by_category.get(aggregate.dominant_category, 0) + 1
        )
        unresolved_by_country[aggregate.country_group] = (
            unresolved_by_country.get(aggregate.country_group, 0) + 1
        )

    by_sector: dict[str, dict[str, float]] = {}
    for _, aggregate, hit in resolved_rows:
        if not hit:
            continue
        sector = str(hit.get("marketSector") or "unknown")
        row = by_sector.setdefault(sector, {"weight": 0.0, "units": 0})
        row["weight"] += aggregate.weight
        row["units"] += 1

    # Projection. Three definitions, because a single number here would be a lie of
    # emphasis: everything that resolves (stratified by category, so the cash rows
    # that resolve at 74% do not get the equity rate); the same over company-exposure
    # categories only; and equity only, which is the part that genuinely becomes a
    # company.
    gross = totals["artifact_gross"] or 1.0
    mapped = totals["artifact_mapped_gross"]
    unmapped_company = sum(totals["buckets_company"].values())
    isin_weight_by_cat: dict[str, float] = {}
    for aggregate in isins.values():
        category = aggregate.dominant_category
        isin_weight_by_cat[category] = isin_weight_by_cat.get(category, 0.0) + aggregate.weight
    isin_weight = sum(isin_weight_by_cat.values())
    projected_stratified = mapped
    for category, row in by_category.items():
        if row["weight"] <= 0:
            continue
        rate = row["resolved"] / row["weight"]
        projected_stratified += rate * isin_weight_by_cat.get(category, 0.0)
    equity_row = by_category.get(classify.EQUITY) or {"weight": 0.0, "resolved": 0.0}
    equity_rate = (
        equity_row["resolved"] / equity_row["weight"] if equity_row["weight"] else 0.0
    )
    projected_equity = mapped + equity_rate * isin_weight_by_cat.get(classify.EQUITY, 0.0)
    projected_company = mapped + sum(
        (row["resolved"] / row["weight"]) * isin_weight_by_cat.get(category, 0.0)
        for category, row in by_category.items()
        if category in classify.COMPANY_CATEGORIES and row["weight"] > 0
    )

    matched_rows = [
        (name, row) for name, row in gleif["results"].items() if row["matched"]
    ]
    exact_legal_matches = sum(
        1
        for name, row in matched_rows
        if _normalised(row["legal_name"]) == _normalised(name)
    )
    collisions = [
        {"queried": name, "returned": row["legal_name"], "candidates": row["total"]}
        for name, row in matched_rows
        if _normalised(row["legal_name"]) != _normalised(name)
    ]

    security_types = Counter(
        hit.get("securityType") or "unknown"
        for _, _, hit in resolved_rows
        if hit is not None
    )
    market_sectors = Counter(
        hit.get("marketSector") or "unknown"
        for _, _, hit in resolved_rows
        if hit is not None
    )
    with_share_class = sum(
        1 for _, _, hit in resolved_rows if hit and hit.get("shareClassFIGI")
    )
    with_composite = sum(
        1 for _, _, hit in resolved_rows if hit and hit.get("compositeFIGI")
    )

    return {
        "release": str(release.relative_to(REPO)) if release.is_relative_to(REPO) else str(release),
        "seconds_total": round(seconds, 1),
        "seconds_measure": totals["seconds"],
        "funds": {
            "published": totals["funds"],
            "with_unmapped_weight": totals["funds_with_unmapped"],
            "measured_failures": len(totals["failures"]),
            "first_failure": totals["failures"][0] if totals["failures"] else None,
        },
        "weight_bp": {
            "gross": round(totals["artifact_gross"], 1),
            "mapped_gross": round(mapped, 1),
            "unmapped_gross": round(totals["artifact_unmapped_gross"], 1),
            "unmapped_signed": round(totals["artifact_unmapped_signed"], 1),
            "recovered_signed": round(totals["recovered_signed"], 1),
            "recovered_delta": round(
                totals["recovered_signed"] - totals["artifact_unmapped_signed"], 1
            ),
            "unmapped_share_pct": round(100 * totals["artifact_unmapped_gross"] / gross, 2),
            "mapped_share_pct": round(100 * mapped / gross, 2),
        },
        "rows": {
            "published": totals["artifact_rows"],
            "unmapped": totals["unmapped_rows"],
            "recovered": totals["recovered_rows"],
            "fallback": totals["fallback_rows"],
        },
        "unmapped_by_category_bp": {
            category: round(weight, 1)
            for category, weight in sorted(
                totals["unmapped_cat_gross"].items(), key=lambda row: -row[1]
            )
        },
        "identifiers": {
            "buckets_bp": {key: round(value, 1) for key, value in buckets.items()},
            "buckets_pct": {
                key: round(100 * value / bucket_total, 2) for key, value in buckets.items()
            },
            "by_category_pct": {
                category: {
                    bucket: round(100 * weight / (sum(split.values()) or 1.0), 2)
                    for bucket, weight in split.items()
                }
                for category, split in totals["buckets_by_cat"].items()
            },
            "company_buckets_pct": {
                key: round(100 * value / (sum(totals["buckets_company"].values()) or 1.0), 2)
                for key, value in totals["buckets_company"].items()
            },
            "distinct_isins": len(isins),
            "isin_weight_bp": round(isin_weight, 1),
            "isin_share_of_unmapped_pct": round(100 * isin_weight / bucket_total, 2),
            "isin_weight_by_category_bp": {
                category: round(weight, 1)
                for category, weight in sorted(
                    isin_weight_by_cat.items(), key=lambda row: -row[1]
                )
            },
        },
        "sample": {
            "target": target,
            "units": len(sampled),
            "weight_bp": round(sampled_weight, 1),
            "coverage_of_isin_weight_pct": round(
                100 * sampled_weight / (isin_weight or 1.0), 2
            ),
            "openfigi_requests": openfigi["requests"],
            "openfigi_cache_hits": openfigi["cache_hits"],
            "openfigi_stopped": openfigi["stopped"],
            "openfigi_seconds": openfigi["seconds"],
            "openfigi_errors": dict(openfigi["errors"]),
        },
        "openfigi": {
            "resolved_units": sum(1 for _, _, hit in resolved_rows if hit is not None),
            "resolved_weight_bp": round(resolved_weight, 1),
            "resolved_share_pct": round(100 * share, 2),
            "resolved_share_ci95_pct": [round(100 * low, 2), round(100 * high, 2)],
            "by_category": {
                category: {
                    "units": int(row["units"]),
                    "weight_bp": round(row["weight"], 1),
                    "resolved_bp": round(row["resolved"], 1),
                    "resolved_pct": round(100 * row["resolved"] / row["weight"], 2)
                    if row["weight"]
                    else None,
                }
                for category, row in sorted(
                    by_category.items(), key=lambda row: -row[1]["weight"]
                )
            },
            "by_country": {
                group: {
                    "units": int(row["units"]),
                    "weight_bp": round(row["weight"], 1),
                    "resolved_bp": round(row["resolved"], 1),
                    "resolved_pct": round(100 * row["resolved"] / row["weight"], 2)
                    if row["weight"]
                    else None,
                }
                for group, row in sorted(by_country.items(), key=lambda row: -row[1]["weight"])
            },
            "by_market_sector": {
                sector: {
                    "units": int(row["units"]),
                    "weight_bp": round(row["weight"], 1),
                    "share_of_resolved_pct": round(
                        100 * row["weight"] / (resolved_weight or 1.0), 2
                    ),
                }
                for sector, row in sorted(
                    by_sector.items(), key=lambda row: -row[1]["weight"]
                )
            },
            "security_types": dict(security_types.most_common(10)),
            "market_sectors": dict(market_sectors.most_common(10)),
            "units_with_share_class_figi": with_share_class,
            "units_with_composite_figi": with_composite,
            "unresolved_units": len(sampled) - sum(1 for _, _, hit in resolved_rows if hit),
            "unresolved_weight_bp": round(unresolved_weight, 1),
            "unresolved_by_category": unresolved_by_category,
            "unresolved_by_country": unresolved_by_country,
        },
        "gleif": {
            "requested": gleif["requested"],
            "attempted": gleif["attempted"],
            "matched": gleif["matched"],
            # A match is not an identity: the exact-name filter happily returns a
            # different entity that shares the words ("TREASURY BILL" → a fund named
            # ...Treasury Bill Fund). Splitting the two is the difference between a
            # 32% hit rate and a 32% hit rate that is partly wrong.
            "exact_legal_name_matches": exact_legal_matches,
            "name_collisions": gleif["matched"] - exact_legal_matches,
            "collision_examples": collisions[:3],
            "stopped": gleif["stopped"],
            "seconds": gleif["seconds"],
            "errors": dict(gleif["errors"]),
            "examples": [
                {"name": name, "legal_name": row["legal_name"], "total": row["total"]}
                for name, row in list(gleif["results"].items())[:8]
            ],
        },
        # Equity-sector names are the only ones that can become a company without a
        # second step, so they lead; the all-names figure is kept for context only.
        "new_companies_equity_sector": dedupe_equity,
        "new_companies_all_names": dedupe,
        "projection": {
            "blended_coverage_pct_now": round(100 * mapped / gross, 2),
            "blended_if_stratified_resolves_pct": round(100 * projected_stratified / gross, 2),
            "blended_if_company_categories_resolve_pct": round(100 * projected_company / gross, 2),
            "blended_if_equity_resolves_pct": round(100 * projected_equity / gross, 2),
            "equity_resolution_rate_pct": round(100 * equity_rate, 2),
            "company_unmapped_bp": round(unmapped_company, 1),
            "company_unmapped_with_isin_bp": round(
                sum(
                    weight
                    for category, weight in isin_weight_by_cat.items()
                    if category in classify.COMPANY_CATEGORIES
                ),
                1,
            ),
        },
        "rate_limits": {
            "requests_by_host": dict(_requests_made),
            "cache_hits_by_host": dict(_cache_hits),
            "rate_limited_429": dict(_rate_limited),
            "retry_after_seconds": [round(value, 1) for value in _retry_after_seen],
        },
        "masked_example": {
            "isin": _masked("isin"),
            "lei": _masked("lei"),
        },
    }


def render(summary: dict[str, Any]) -> str:
    """The compact stdout block: counts, percentages, timings. No identifiers."""
    weight = summary["weight_bp"]
    identifiers_block = summary["identifiers"]
    sample = summary["sample"]
    openfigi = summary["openfigi"]
    lines = [
        f"ISIN coverage probe — release {summary['release']}",
        "",
        "Size of the prize (no network yet, from the published artifact)",
        f"  funds scanned                     {summary['funds']['published']:>12,}"
        f"  ({summary['funds']['with_unmapped_weight']:,} with unmapped weight)",
        f"  published holding weight          {weight['gross']:>12,.0f} bp",
        f"  mapped to a company               {weight['mapped_gross']:>12,.0f} bp"
        f"  ({weight['mapped_share_pct']}%)",
        f"  unmapped                          {weight['unmapped_gross']:>12,.0f} bp"
        f"  ({weight['unmapped_share_pct']}%)",
        f"  unmapped rows                     {summary['rows']['unmapped']:>12,}",
        f"  unmapped by category (bp)         "
        + ", ".join(
            f"{category} {value:,.0f}"
            for category, value in summary["unmapped_by_category_bp"].items()
        ),
        "",
        "Do the filings already carry the identifier? (recovered from the N-PORT XML)",
        f"  reconciliation                    recovered {weight['recovered_signed']:,.0f} bp"
        f" vs artifact {weight['unmapped_signed']:,.0f} bp"
        f" → delta {weight['recovered_delta']:,.0f} bp",
    ]
    for bucket in UNMAPPED_BUCKETS:
        lines.append(
            f"  {bucket:<32} {identifiers_block['buckets_bp'][bucket]:>12,.0f} bp"
            f"  {identifiers_block['buckets_pct'][bucket]:>6.1f}%"
        )
    lines += [
        f"  distinct ISINs in the unmapped set {identifiers_block['distinct_isins']:>11,}"
        f"  carrying {identifiers_block['isin_share_of_unmapped_pct']}% of unmapped weight",
        "",
        "OpenFIGI, unauthenticated (ISIN → named security)",
        f"  sample                            {sample['units']:,} ISINs of "
        f"{identifiers_block['distinct_isins']:,}"
        f" = {sample['coverage_of_isin_weight_pct']}% of the ISIN-carrying weight",
        f"  requests                          {sample['openfigi_requests']}"
        f" ({JOBS_PER_REQUEST} jobs each, {OPENFIGI_INTERVAL_S}s apart),"
        f" {sample['openfigi_cache_hits']} served from cache  {sample['openfigi_seconds']}s",
    ]
    if sample["openfigi_stopped"]:
        lines.append(f"  stopped early                    {sample['openfigi_stopped']}")
    lines += [
        f"  resolved to a named security      {openfigi['resolved_units']}/{sample['units']}"
        f" units = {openfigi['resolved_share_pct']}% of sampled unmapped weight"
        f"  (bootstrap 95% {openfigi['resolved_share_ci95_pct'][0]}–"
        f"{openfigi['resolved_share_ci95_pct'][1]}%)",
        "  by asset category:",
    ]
    for category, row in openfigi["by_category"].items():
        lines.append(
            f"    {category:<14} {row['units']:>5,} units  {row['weight_bp']:>12,.0f} bp"
            f"  resolved {row['resolved_pct']}%"
        )
    lines.append("  by country:")
    for group, row in openfigi["by_country"].items():
        lines.append(
            f"    {group:<14} {row['units']:>5,} units  {row['weight_bp']:>12,.0f} bp"
            f"  resolved {row['resolved_pct']}%"
        )
    lines += [
        f"  shareClassFIGI / compositeFIGI   {openfigi['units_with_share_class_figi']}"
        f" / {openfigi['units_with_composite_figi']} of {openfigi['resolved_units']} resolved",
        "  what answered it (share of resolved weight):",
    ]
    for sector, row in openfigi["by_market_sector"].items():
        lines.append(
            f"    {sector:<14} {row['units']:>5,} units"
            f"  {row['share_of_resolved_pct']:>6.1f}% of resolved weight"
        )
    lines += [
        f"  security types                    {openfigi['security_types']}",
        "",
        "GLEIF, unauthenticated (security name → legal entity, exact name filter)",
        f"  lookups                           {summary['gleif']['attempted']}"
        f" of {summary['gleif']['requested']} requested, {summary['gleif']['seconds']}s",
        f"  matched a legal entity            {summary['gleif']['matched']}"
        f"  (same legal name: {summary['gleif']['exact_legal_name_matches']},"
        f" name collisions: {summary['gleif']['name_collisions']})",
        "",
        "Would they be new companies? (name-only dedupe against the release's companies)",
        f"  equity-sector names sampled       "
        f"{summary['new_companies_equity_sector']['distinct_names']}",
        f"  already published (exact name)    "
        f"{summary['new_companies_equity_sector']['already_exact']}",
        f"  already published (token subset)  "
        f"{summary['new_companies_equity_sector']['already_token']}",
        f"  new — upper bound                 "
        f"{summary['new_companies_equity_sector']['new_upper_bound']}",
        f"  e.g.                              "
        f"{', '.join(summary['new_companies_equity_sector']['new_examples'][:5]) or '—'}",
        "  (all resolved names, context only "
        f"{summary['new_companies_all_names']['distinct_names']} names, "
        f"{summary['new_companies_all_names']['new_upper_bound']} new)",
        "",
        "What it would do to blended coverage",
        f"  now                               {summary['projection']['blended_coverage_pct_now']}%",
        f"  all ISIN weight, stratified       "
        f"{summary['projection']['blended_if_stratified_resolves_pct']}%"
        f"  (ceiling: fund shares and bonds count)",
        f"  company categories only           "
        f"{summary['projection']['blended_if_company_categories_resolve_pct']}%",
        f"  equity only                       "
        f"{summary['projection']['blended_if_equity_resolves_pct']}%"
        f"  (equity rows resolve at {summary['projection']['equity_resolution_rate_pct']}%;"
        " this is the part that becomes a company)",
        "",
        "Cost and limits",
        f"  cost                              $0.00 (no key, no account, no signup)",
        f"  wall clock                        {summary['seconds_total']}s"
        f" (measure {summary['seconds_measure']}s)",
        f"  requests by host                  {summary['rate_limits']['requests_by_host']}",
        f"  cache hits by host                {summary['rate_limits']['cache_hits_by_host']}",
        f"  observed 429s                     {summary['rate_limits']['rate_limited_429'] or 'none'}",
        f"  retry-after obeyed                {summary['rate_limits']['retry_after_seconds'] or 'none'}",
        f"  example identifier shape          {summary['masked_example']['isin']}"
        f" / {summary['masked_example']['lei']} (masked, never a real value)",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python scripts/isin_coverage_probe.py",
        description=(
            "Measure how much of the published unmapped weight an identifier source "
            "would recover. No key, no account, no release writes; every request is "
            "cached, so a second run is free. Full method in the module docstring."
        ),
        epilog="Example: python scripts/isin_coverage_probe.py --no-network",
    )
    parser.add_argument("--release", type=Path, default=DEFAULT_RELEASE)
    parser.add_argument(
        "--target", type=int, default=360, help="ISINs to sample (10 per request)"
    )
    parser.add_argument(
        "--max-requests", type=int, default=40, help="hard cap on OpenFIGI requests"
    )
    parser.add_argument("--gleif-max", type=int, default=25, help="hard cap on GLEIF lookups")
    parser.add_argument("--workers", type=int, default=min(8, (os.cpu_count() or 4)))
    parser.add_argument(
        "--deadline-seconds", type=float, default=600.0, help="give up on network after this"
    )
    parser.add_argument("--no-network", action="store_true", help="read only what is cached")
    parser.add_argument("--out", type=Path, default=None, help="summary JSON path")
    args = parser.parse_args(argv)

    started = time.time()
    release = args.release if args.release.is_absolute() else (REPO / args.release)
    if not (release / "funds").is_dir():
        raise SystemExit(f"no funds/ under {release}")
    PROBE_CACHE.mkdir(parents=True, exist_ok=True)
    # The build's byte cache is keyed by sha256(url); use its own derivation, but
    # anchor it at the repo so a run from any directory reads the same files.
    if not Path(sec.CACHE_DIR).is_absolute():
        sec.CACHE_DIR = REPO / sec.CACHE_DIR

    log(f"measuring {release.name} with {args.workers} worker(s)")
    totals = measure(release, args.workers)
    prize_bp = totals["artifact_unmapped_gross"]
    log(
        f"unmapped {prize_bp:,.0f} bp across {totals['unmapped_rows']:,} rows; "
        f"{len(totals['isins']):,} distinct ISINs"
    )
    if totals["failures"]:
        log(f"  {len(totals['failures'])} fund(s) could not be measured: {totals['failures'][0]}")

    target = max(1, min(args.target, args.max_requests * JOBS_PER_REQUEST))
    sample = pps_sample(totals["isins"], target)
    deadline = time.monotonic() + args.deadline_seconds
    allow_network = not args.no_network
    log(f"sampled {len(sample)} ISINs for OpenFIGI")
    openfigi = openfigi_map(sample, deadline=deadline, allow_network=allow_network)

    # The GLEIF sample is the heaviest resolved names first: a name lookup is the
    # weakest link in the chain, so it deserves the weight that decides the answer.
    name_weight: dict[str, float] = {}
    for isin, hit in openfigi["resolved"].items():
        name = hit.get("name") or ""
        if name:
            name_weight[name] = name_weight.get(name, 0.0) + totals["isins"][isin].weight
    gleif_names = [
        name for name, _ in sorted(name_weight.items(), key=lambda row: (-row[1], row[0]))
    ][: args.gleif_max]
    gleif = gleif_lookup(gleif_names, deadline=deadline, allow_network=allow_network)

    companies = [
        str(row[1])
        for row in json.loads((release / "companies/index.json").read_text()).get("companies") or []
        if len(row) > 1 and row[1]
    ]
    summary = summarise(
        totals,
        sample,
        openfigi,
        gleif,
        companies,
        target=target,
        release=release,
        seconds=time.time() - started,
    )
    out_path = args.out or (PROBE_CACHE / "last-run.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(render(summary))
    log(f"summary written to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
