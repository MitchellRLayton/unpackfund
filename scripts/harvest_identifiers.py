#!/usr/bin/env python3
"""Run the OpenFIGI harvest with the key from the workspace `.env`, if there is one.

Four reasons this exists instead of "export the variable and run the module":

1. **The key never reaches a command line.** It is read from the file into this
   process's environment and handed to the harvest in-process — not in `argv`, not
   in a shell history, not in a log line, and not in the output of this script.
2. **The batch size has to match the key.** A keyed pass uses 100 jobs per request
   at 250 requests a minute; unauthenticated it is 10 at 25. The request hash
   includes the batch, so switching size mid-pass misses the cache — pin the size
   once, here, and a resumed pass stays resumable.
3. **The ISIN pass was not the whole gap.** `pipeline.identifiers harvest` asks
   OpenFIGI about one identifier type, `ID_ISIN`, and the N-PORT cache carries a
   second one on nearly every holding: the `<cusip>` element. A row whose only
   identifier is a CUSIP was never asked about, and neither was an ISIN that came
   back unresolved, because the *value* sent was the wrong one rather than the
   security being absent. The `enumerate` / `harvest-cusip` / `build-cusip`
   subcommands below are that second pass, built on the same cache, the same
   throttle and the same record format as the first — they reuse
   `pipeline.identifiers`' cache key, transport and retry rules rather than
   reimplementing them, so a warm re-run is a cache hit for exactly the same reason
   the ISIN pass's is.
4. **This module is where the second pass lives because the first one's owner is
   moving.** `pipeline/pipeline/identifiers.py` is a shared file with three sessions
   in it; a new identifier type belongs in a script that calls it, not in a diff
   against it.

Usage (from the repo root):

    scripts/harvest-identifiers.sh                  # ISIN pass, keyed if a key exists
    scripts/harvest-identifiers.sh --limit 400      # ISIN harvest flags pass through
    scripts/harvest-identifiers.sh build            # isin_map.json + the measurement
    scripts/harvest-identifiers.sh enumerate        # offline: what a CUSIP pass would ask
    scripts/harvest-identifiers.sh harvest-cusip    # CUSIP -> FIGI, cached, resumable
    scripts/harvest-identifiers.sh build-cusip      # cusip_map.json + the measurement

Every subcommand writes into `data/identifier-layer/<date>.staging/`, and `build-cusip`
renames that directory to `<date>/` in one step once all four files are in place. A
date-named directory is a layer to every other tool in the repo — the first consumer to
find one map inside it will read the layer — so a half-written pass must never own one.

Unauthenticated the full ISIN pass is about 19 hours; keyed it is about 11 minutes.
The CUSIP pass is a fraction of that, and it obeys the same rule: pin `--jobs`, and a
re-run costs nothing.

**Never print an identifier.** Every line either of the second pass emits is a count,
a weight in basis points, or a path. The values themselves live only in the layer
files under `data/`, which is git-ignored and never published.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import re
import shutil
import sys
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
PIPELINE = REPO / "pipeline"
KEY_ENV = "OPENFIGI_API_KEY"
KEYED_JOBS = "100"
KEYED_RPM = "250"
PLAIN_JOBS = "10"
PLAIN_RPM = "25"

#: The pipeline package is a sibling directory, not an installed dependency.
if str(PIPELINE) not in sys.path:
    sys.path.insert(0, str(PIPELINE))

from pipeline import classify, identifiers, nport  # noqa: E402 — after sys.path
from pipeline.weights import _fraction  # noqa: E402 — `identifiers` must load first

# ---------------------------------------------------------------------------
# The second identifier type
# ---------------------------------------------------------------------------

#: OpenFIGI's job type for a CUSIP. Verified against the endpoint's own idType list
#: (24 values, `ID_CUSIP` among them) in `2026-10-29-sources-beyond-edgar` §2; the
#: same document records the per-request job counts this pass batches at.
ID_TYPE = "ID_CUSIP"
ID_TYPE_SOURCE = "cusip"

#: A top-level key of a `json.dump(indent=4)` map — how a 74 MB map yields its key
#: set without becoming a 1 GB dict.
MAP_KEY = re.compile(r'^  "([^"]+)": \{', re.MULTILINE)

#: Three digits, five alphanumerics, a check digit — the same shape the licence rule
#: in `pipeline.identifiers` redacts, anchored so a substring cannot match.
CUSIP_RE = re.compile(r"\A[0-9]{3}[0-9A-Z]{5}[0-9]\Z")

#: The layer files this pass writes. Four of them, one per thing the pass knows:
#: what it asked, what it spent, what came back, and what that recovered.
INDEX_NAME = "cusip_index.json.gz"
MAP_NAME = "cusip_map.json"
MEASUREMENT_NAME = "measurement.json"

#: A mirrored release is mounted at ``artifacts/mirror/live``, so the directory name is
#: not the release's name. The layer is named for the day the pass ran (that is what a
#: reader asks for: "what did we learn when"), and the release it measured is recorded
#: inside every file, taken from the release's own manifest rather than guessed.
def today() -> str:
    """The local date, ISO-8601. The only clock read in this script."""
    return datetime.date.today().isoformat()


def release_identity(release: pathlib.Path) -> str:
    """The release's own id: ``as_of`` from its manifest, else its directory name."""
    for name in ("release.json", "catalogue.json"):
        path = release / name
        if not path.is_file():
            continue
        try:
            document = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(document, dict):
            identifier = document.get("as_of") or document.get("release")
            if isinstance(identifier, str) and identifier.strip():
                return identifier.strip()
    return release.name


#: A directory whose name is a date is a *layer* to every other tool in this repo, and
#: the first consumer to find one map inside it will read the layer. So a pass writes
#: into `<date>.staging` and the directory is renamed once, when it is whole.
STAGING_SUFFIX = ".staging"


def layer_for(release: pathlib.Path, layer_dir: pathlib.Path | None) -> pathlib.Path:
    """``data/identifier-layer/<today>.staging/`` unless the caller overrode it."""
    return layer_dir or identifiers.default_layer_dir(today() + STAGING_SUFFIX)


def final_layer_name(layer: pathlib.Path) -> str:
    """The name the layer will have once it is promoted — what a reader will find."""
    return layer.name[: -len(STAGING_SUFFIX)] if layer.name.endswith(STAGING_SUFFIX) else layer.name


def promote_layer(staging: pathlib.Path) -> pathlib.Path:
    """Rename a complete staging directory to its published name, or refuse.

    One `rename` on the same filesystem, so a reader sees either no layer or the whole
    one — never a directory holding one map out of two.
    """
    if not staging.name.endswith(STAGING_SUFFIX):
        raise CusipError(f"{staging.name} is not a staging directory")
    missing = [
        name
        for name in (INDEX_NAME, MAP_NAME, MEASUREMENT_NAME, "harvest.json")
        if not (staging / name).is_file()
    ]
    if missing:
        raise CusipError(f"{staging} is incomplete: missing {', '.join(missing)}")
    final = staging.parent / final_layer_name(staging)
    if final.exists():
        raise CusipError(f"{final} already exists; a layer is immutable once published")
    staging.rename(final)
    return final


class CusipError(Exception):
    """A layer or cache file that cannot be read."""
    """A CUSIP pass that cannot continue, with a message that names no identifier."""


def valid_cusip(value: str | None) -> bool:
    """True when ``value`` is a well-formed nine-character CUSIP.

    The check digit is deliberately *not* enforced here. Some filers put a
    security's ISIN or a truncated value in `<cusip>`, and a real CUSIP with a
    mistyped check digit would be dropped silently if this filtered on it — losing
    coverage to protect a request budget that is not scarce. The check digit is
    reported as a data-quality count instead (``totals.cusip_check_digit_bad``), so
    a reader can see how much of the frame is phonetically shaped rather than real.
    """
    if not value:
        return False
    return CUSIP_RE.match(str(value).strip().upper()) is not None


def _cusip_check_digit_ok(value: str) -> bool:
    """The CUSIP mod-10 double-add check, for the quality count only."""
    cleaned = str(value).strip().upper()
    if len(cleaned) != 9 or not cleaned[8].isdigit():
        return False
    total = 0
    for position, character in enumerate(cleaned[:8], start=1):
        if character.isdigit():
            digit = int(character)
        elif "A" <= character <= "Z":
            # Letters are 10..35, then their decimal digits are summed.
            digit = ord(character) - ord("A") + 10
        else:
            return False
        if position % 2 == 0:
            digit *= 2
        total += digit // 10 + digit % 10
    return (10 - total % 10) % 10 == int(cleaned[8])


# ---------------------------------------------------------------------------
# Key handling and defaults
# ---------------------------------------------------------------------------


def env_candidates() -> list[pathlib.Path]:
    """The same order as `pipeline.paths.env_file_candidates`, nearest first."""
    override = os.environ.get("UNPACKFUND_ENV_FILE")
    candidates = [pathlib.Path(override)] if override else []
    candidates += [REPO / ".env", REPO.parent / ".env"]
    return candidates


def key_from_env_file() -> tuple[bool, str]:
    """Return (found, path). Reads only the one name; never returns the value."""
    for candidate in env_candidates():
        if not candidate.is_file():
            continue
        for raw in candidate.read_text(encoding="utf-8").splitlines():
            name, sep, rest = raw.strip().partition("=")
            if sep and name.strip() == KEY_ENV:
                value = rest.strip().strip('"').strip("'")
                if value:
                    return True, str(candidate)
    return False, ""


def load_key() -> tuple[bool, str]:
    """Populate ``os.environ`` with the key from the nearest `.env`, if any.

    Returns whether a key was found and where it came from — never the value.
    """
    if os.environ.get(KEY_ENV):
        return True, "the environment"
    found, source = key_from_env_file()
    if not found:
        return False, ""
    for candidate in env_candidates():
        if candidate.is_file() and pathlib.Path(source) == candidate:
            for raw in candidate.read_text(encoding="utf-8").splitlines():
                name, sep, rest = raw.strip().partition("=")
                if sep and name.strip() == KEY_ENV:
                    os.environ[KEY_ENV] = rest.strip().strip('"').strip("'")
                    break
            break
    return True, source


# ---------------------------------------------------------------------------
# enumerate: the offline frame, before a single request
# ---------------------------------------------------------------------------


def _joined_rows(
    document: dict,
    filing: nport.NportFiling,
    totals: dict,
) -> list[tuple[float, str, str | None, list[tuple[str, str]]]]:
    """Mirror of `pipeline.identifiers._target_rows`, keeping the CUSIP.

    The join, the scope and the ambiguity rule are copied *line for line* on
    purpose: this pass has to describe the same rows the ISIN pass described, or
    the two weights cannot be reconciled. Two deliberate differences, and nothing
    else:

    * a row with **no** valid ISIN is kept instead of dropped (that is the whole
      point — ``identifiers`` counts those under ``no_isin_bp`` and moves on);
    * each kept row also carries its CUSIP-shaped values, from ``<cusip>`` and from
      an as-filed ``<ticker>`` that is really a CUSIP (Part 1 of the module docstring
      records that filers do this).

    If `pipeline.identifiers._target_rows` changes its scope, this must change with
    it. That is a real coupling, and it is the price of not editing a shared file
    mid-session; `measurement.json` records both weights so a drift shows up as a
    reconciliation difference instead of a quiet one.
    """
    keys: set[tuple[str, str]] = set()
    names: dict[str, int] = {}
    mapped_names: set[str] = set()
    for row in document.get("holdings") or []:
        if row.get("company_id"):
            mapped_names.add(identifiers.public_name(row.get("name")).upper())
            continue
        category = str(row.get("asset_cat") or classify.OTHER)
        if category not in identifiers.TARGET_CATEGORIES:
            continue
        name = identifiers.public_name(row.get("name")).upper()
        keys.add((name, category))
        names[name] = names.get(name, 0) + 1
    if not keys:
        return []

    joined: list[tuple[float, str, str | None, list[tuple[str, str]]]] = []
    for holding in filing.holdings:
        fraction = _fraction(holding, filing.net_assets)
        if fraction is None:
            continue
        classification = classify.classify(
            holding.asset_cat, holding.issuer_cat, holding.is_derivative
        )
        category = classification.category
        if category not in identifiers.TARGET_CATEGORIES:
            continue
        name = identifiers.public_name(holding.name).upper()
        if (name, category) not in keys:
            if names.get(name) != 1 or name in mapped_names:
                totals["ambiguous_rows"] += 1
                continue
            totals["category_moved_rows"] += 1
        bp = abs(fraction * 10_000.0)
        totals["computed_bp"] += bp

        values: list[tuple[str, str]] = []
        seen: set[str] = set()
        for source, raw in (
            (ID_TYPE_SOURCE, holding.cusip),
            ("ticker", holding.ticker),
        ):
            if not valid_cusip(raw):
                continue
            value = str(raw).strip().upper()
            if value in seen:
                continue
            seen.add(value)
            values.append((value, source))

        isin = str(holding.isin).strip().upper() if identifiers.valid_isin(holding.isin) else None
        has_isin = isin is not None
        totals["joined_rows"] += 1
        if has_isin:
            totals["bp_with_isin"] += bp
            totals["rows_with_isin"] += 1
        else:
            totals["bp_no_isin"] += bp
            totals["rows_no_isin"] += 1
        if values:
            totals["bp_with_cusip"] += bp
            totals["rows_with_cusip"] += 1
            if not has_isin:
                totals["bp_cusip_only"] += bp
                totals["rows_cusip_only"] += 1
        else:
            totals["bp_no_cusip"] += bp
            totals["rows_no_cusip"] += 1
            if not has_isin:
                totals["bp_no_identifier"] += bp
                totals["rows_no_identifier"] += 1
        joined.append((bp, category, isin, values))
    return joined


def enumerate_cusips(
    release: pathlib.Path,
    *,
    filing_cache: pathlib.Path | None = None,
    layer_dir: pathlib.Path | None = None,
    refresh: bool = False,
    progress=None,
) -> dict:
    """Walk the release offline and record every CUSIP-shaped value that matters.

    Reads only `funds/*.json` and the filing cache that produced them. No network,
    no key, no spend — this is the step that says whether the second pass is worth
    buying before it is bought.
    """
    cache = filing_cache or identifiers.default_filing_cache()
    release_id = release_identity(release)
    layer = layer_for(release, layer_dir)
    index_file = layer / INDEX_NAME
    fund_files = sorted((release / "funds").glob("*.json"))
    if not fund_files:
        raise CusipError(f"no fund documents under {release / 'funds'}")

    newest_mtime = 0.0
    for path in fund_files:
        newest_mtime = max(newest_mtime, path.stat().st_mtime)
    fingerprint = {
        "funds": len(fund_files),
        "newest_mtime": int(newest_mtime),
        "filing_cache": str(cache),
        "id_type": ID_TYPE,
    }
    if not refresh:
        existing = identifiers._read_gzip_json(index_file)
        if isinstance(existing, dict) and existing.get("fingerprint") == fingerprint:
            if progress is not None:
                progress(f"enumerate: reusing {index_file}")
            return existing

    totals: dict[str, float] = {
        "funds": 0.0,
        "funds_with_targets": 0.0,
        "published_target_bp": 0.0,
        "published_rows": 0.0,
        "gross_bp": 0.0,
        "computed_bp": 0.0,
        "joined_rows": 0.0,
        "ambiguous_rows": 0.0,
        "category_moved_rows": 0.0,
        "bp_with_isin": 0.0,
        "rows_with_isin": 0.0,
        "bp_no_isin": 0.0,
        "rows_no_isin": 0.0,
        "bp_with_cusip": 0.0,
        "rows_with_cusip": 0.0,
        "bp_cusip_only": 0.0,
        "rows_cusip_only": 0.0,
        "bp_no_cusip": 0.0,
        "rows_no_cusip": 0.0,
        "bp_no_identifier": 0.0,
        "rows_no_identifier": 0.0,
        "cusip_check_digit_bad": 0.0,
    }
    errors: list[str] = []
    rows: list[list] = []
    values: list[list[str]] = []
    value_position: dict[str, int] = {}
    isins: list[str] = []
    isin_position: dict[str, int] = {}

    for number, path in enumerate(fund_files, 1):
        totals["funds"] += 1
        try:
            document = json.loads(path.read_text())
        except (OSError, ValueError) as error:
            errors.append(f"{path.stem}: {type(error).__name__}")
            continue

        unmapped_bp = 0.0
        for row in document.get("holdings") or []:
            weight = abs(int(row.get("weight_bp") or 0))
            totals["gross_bp"] += weight
            if row.get("company_id"):
                continue
            category = str(row.get("asset_cat") or classify.OTHER)
            if category not in identifiers.TARGET_CATEGORIES:
                continue
            unmapped_bp += weight
            totals["published_target_bp"] += weight
            totals["published_rows"] += 1
        if not unmapped_bp:
            continue

        totals["funds_with_targets"] += 1
        source_url = str(document.get("source_url") or "")
        try:
            filing = identifiers.load_nport_filing(source_url, cache)
            joined = _joined_rows(document, filing, totals)
        except (CusipError, identifiers.IdentifierError, nport.NportParseError) as error:
            errors.append(f"{path.stem}: {type(error).__name__}")
            joined = []

        for bp, category, isin, row_values in joined:
            positions: list[int] = []
            for value, source in row_values:
                position = value_position.get(value)
                if position is None:
                    position = len(values)
                    value_position[value] = position
                    values.append([value, source])
                    if not _cusip_check_digit_ok(value):
                        totals["cusip_check_digit_bad"] += 1
                positions.append(position)
            if isin is None:
                at_isin = -1
            else:
                at_isin = isin_position.get(isin)
                if at_isin is None:
                    at_isin = len(isins)
                    isin_position[isin] = at_isin
                    isins.append(isin)
            rows.append([round(bp, 2), category, at_isin, positions])

        if progress is not None and (number % 500 == 0 or number == len(fund_files)):
            progress(
                f"enumerate: {number}/{len(fund_files)} funds, "
                f"{len(values):,} distinct values, {len(rows):,} rows"
            )

    weight_by_value: dict[str, float] = {}
    for bp, _category, _at_isin, positions in rows:
        for position in positions:
            value = values[position][0]
            weight_by_value[value] = weight_by_value.get(value, 0.0) + bp

    document = {
        "release": release_id,
        "as_of": release_id,
        "release_path": str(release),
        "layer": final_layer_name(layer),
        "id_type": ID_TYPE,
        "source": "filing <cusip> plus an as-filed <ticker> that is CUSIP-shaped",
        "fingerprint": fingerprint,
        "totals": {key: round(value, 2) for key, value in sorted(totals.items())},
        "errors": sorted(errors),
        "values": values,
        "isins": isins,
        "value_bp": {value: round(weight, 2) for value, weight in sorted(weight_by_value.items())},
        "rows": rows,
    }
    identifiers._write_gzip_json(index_file, document)
    return document


def distinct_by_source(document: dict) -> dict[str, int]:
    """How many distinct values came from each source. The first source a value was
    seen under wins, so a value filed as a CUSIP and repeated as a ticker counts once."""
    counts: dict[str, int] = {}
    for _value, source in document.get("values") or []:
        counts[source] = counts.get(source, 0) + 1
    return counts


def coverage_bp(document: dict) -> float:
    """The weight of the rows this pass has a candidate identifier for."""
    return float((document.get("totals") or {}).get("bp_with_cusip") or 0.0)


def enum_line(document: dict) -> str:
    totals = document.get("totals") or {}
    counts = distinct_by_source(document)
    by_source = " · ".join(f"{name} {count:,}" for name, count in sorted(counts.items()))
    gross = float(totals.get("gross_bp") or 0.0)
    covered = coverage_bp(document)
    share = (covered / gross * 100.0) if gross else 0.0
    return (
        f"enumerate: {len(document.get('values') or []):,} distinct values"
        f" ({by_source or 'none'}) covering {covered:,.0f} bp"
        f" ({share:.2f}% of {gross:,.0f} published gross)"
        f" · of which {float(totals.get('bp_cusip_only') or 0):,.0f} bp has no ISIN"
    )


# ---------------------------------------------------------------------------
# harvest-cusip: the paid step, one request per 100 values, cached by body
# ---------------------------------------------------------------------------


class CusipHarvestRun:
    """What one CUSIP harvest run did, and why it stopped where it did."""

    def __init__(self, **values) -> None:
        self.__dict__.update(values)


def _request_body(values: list[str]) -> bytes:
    """The JSON job array for one batch. Order is preserved; it is the response's key.

    Same serialisation as `pipeline.identifiers._request_body` — `json.dumps` with
    its default separators — so the two passes read alike and a reader comparing the
    caches sees one convention.
    """
    return json.dumps(
        [{"idType": ID_TYPE, "idValue": value} for value in values]
    ).encode()


def harvest_cusips(
    document: dict,
    *,
    release: pathlib.Path,
    layer_dir: pathlib.Path | None = None,
    cache_dir: pathlib.Path | None = None,
    limit: int | None = None,
    rpm: float | None = None,
    jobs_per_request: int | None = None,
    no_network: bool = False,
    transport=None,
    sleep=time.sleep,
    clock=time.monotonic,
    progress=None,
) -> CusipHarvestRun:
    """Resolve CUSIPs to FIGIs, caching every response and resuming where it stopped.

    The resumability contract is `pipeline.identifiers.harvest`'s, unchanged: the
    order is a fixed function of the value set (`harvest_order` hashes it), the batch
    boundaries follow from that order and the batch size, and a batch whose request
    body is already in the cache is skipped without a request. ``--no-network`` turns
    a miss into a reported miss, so a warm rerun is *provably* free.
    """
    as_of = release_identity(release)
    layer = layer_for(release, layer_dir)
    cache = cache_dir or identifiers.default_openfigi_cache()
    transport = transport or identifiers.http_transport
    api_key = os.environ.get(KEY_ENV) or None
    keyed = bool(api_key)
    rate = float(rpm) if rpm is not None else identifiers.default_rpm(keyed)
    size = int(jobs_per_request) if jobs_per_request else identifiers.default_jobs_per_request(keyed)
    throttle = identifiers.Throttle(identifiers.interval_seconds(rate), clock=clock, sleep=sleep)

    weights = dict(document.get("value_bp") or {})
    order = identifiers.harvest_order(weights)
    selected = order[: int(limit)] if limit is not None else order
    batches = identifiers.batch(selected, size)

    record = _load_record(layer)
    known: dict[str, dict] = {
        str(entry["key"]): entry
        for entry in record.get("batches") or []
        if isinstance(entry, dict) and "key" in entry
    }
    record.update(
        {
            "as_of": as_of,
            "release": as_of,
            "release_path": str(release),
            "layer": final_layer_name(layer),
            "url": identifiers.OPENFIGI_URL,
            "id_type": ID_TYPE,
            "jobs_per_request": size,
            "rpm": rate,
            "batch_size": size,
            "updated_by": "scripts/harvest_identifiers.py harvest-cusip",
        }
    )

    outcome = CusipHarvestRun(
        as_of=as_of,
        keyed=keyed,
        jobs_per_request=size,
        rpm=rate,
        values_in_index=len(weights),
        values_selected=len(selected),
        batches_total=len(batches),
        batches_requested=0,
        batches_cached=0,
        batches_failed=0,
        offline_misses=0,
        requests=0,
        values_resolved=0,
        values_unresolved=0,
        seconds=0.0,
        stopped=None,
    )
    started = time.time()

    for number, values in enumerate(batches, 1):
        body = _request_body(values)
        key = identifiers.cache_key(body)
        cached = identifiers.read_cached_body(cache, key)
        if cached is not None:
            outcome.batches_cached += 1
            known[key] = {"key": key, "values": values, "status": "cached", "attempts": 0}
            try:
                outcome.values_resolved += len(identifiers.resolved_isins(cached, values))
            except identifiers.IdentifierError:
                pass
            continue
        if no_network:
            outcome.offline_misses += 1
            continue

        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": identifiers.USER_AGENT,
        }
        if api_key:
            headers["X-OPENFIGI-APIKEY"] = api_key

        attempts = 0
        status: int | None = None
        payload = b""
        stopped: str | None = None
        for attempt in range(1, identifiers.MAX_ATTEMPTS + 1):
            attempts = attempt
            throttle.wait()
            outcome.requests += 1
            try:
                status, response_headers, payload = transport(body, headers)
            except identifiers.TransportError as error:
                if attempt < identifiers.MAX_ATTEMPTS:
                    sleep(identifiers.FALLBACK_RETRY_S / 2)
                    continue
                outcome.batches_failed += 1
                known[key] = {
                    "key": key,
                    "values": values,
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
                pause = identifiers.retry_after_seconds(response_headers)
                if attempt < identifiers.MAX_ATTEMPTS:
                    sleep(pause)
                    continue
                outcome.batches_failed += 1
                known[key] = {
                    "key": key,
                    "values": values,
                    "status": "failed",
                    "attempts": attempts,
                    "reason": "429 after retries",
                }
                break
            if 500 <= status < 600:
                if attempt < identifiers.MAX_ATTEMPTS:
                    sleep(identifiers.FALLBACK_RETRY_S / 2)
                    continue
                outcome.batches_failed += 1
                known[key] = {
                    "key": key,
                    "values": values,
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
                progress(f"harvest-cusip: stopping — {stopped}")
            break
        if status is None or not 200 <= status < 300:
            continue

        identifiers.write_cached_body(cache, key, payload)
        outcome.batches_requested += 1
        entry: dict = {
            "key": key,
            "values": values,
            "status": "requested",
            "attempts": attempts,
        }
        known[key] = entry
        try:
            outcome.values_resolved += len(identifiers.resolved_isins(json.loads(payload), values))
        except (identifiers.IdentifierError, ValueError) as error:
            outcome.batches_failed += 1
            entry["status"] = "malformed"
            entry["reason"] = type(error).__name__

        if progress is not None and (number % 5 == 0 or number == len(batches)):
            elapsed = max(time.time() - started, 1e-6)
            remaining = len(batches) - number
            eta = remaining * (elapsed / max(number, 1))
            progress(
                f"harvest-cusip: {number}/{len(batches)} batches, "
                f"{outcome.values_resolved:,} values resolved, "
                f"{outcome.requests} requests, {elapsed:.0f}s elapsed, ETA {eta:.0f}s"
            )

    outcome.seconds = round(time.time() - started, 1)
    outcome.values_unresolved = outcome.values_selected - outcome.values_resolved
    record["batches"] = list(known.values())
    previous = record.get("stats") or {}
    previous_total = int(previous.get("requests_total", previous.get("requests", 0)) or 0)
    record["stats"] = {
        "batches_total": outcome.batches_total,
        "batches_requested": outcome.batches_requested,
        "batches_cached": outcome.batches_cached,
        "batches_failed": outcome.batches_failed,
        "offline_misses": outcome.offline_misses,
        "requests": outcome.requests,
        "requests_total": previous_total + outcome.requests,
        "values_in_index": outcome.values_in_index,
        "values_selected": outcome.values_selected,
        "values_resolved": outcome.values_resolved,
        "values_unresolved": outcome.values_unresolved,
    }
    _write_record(layer, record)
    outcome.record_path = _record_path(layer)
    outcome.requests_total = record["stats"]["requests_total"]
    return outcome


def _record_path(layer_dir: pathlib.Path) -> pathlib.Path:
    return layer_dir / "harvest.json"


def _load_record(layer_dir: pathlib.Path) -> dict:
    try:
        return json.loads(_record_path(layer_dir).read_text())
    except FileNotFoundError:
        return {"batches": []}
    except (OSError, ValueError) as error:
        raise CusipError(f"unreadable harvest file under {layer_dir}") from error


def _write_record(layer_dir: pathlib.Path, record: dict) -> None:
    """Deterministic: batches sorted by key, no timestamps, no clock."""
    record["batches"] = sorted(record.get("batches") or [], key=lambda item: item["key"])
    path = _record_path(layer_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")


def resolve_map(layer_dir: pathlib.Path, cache_dir: pathlib.Path | None = None) -> tuple[dict, dict]:
    """Join the record's batch order to the cached response bodies.

    Disk only: the order is the record's, the records are the cache's. A batch whose
    body is missing is counted, never guessed.
    """
    cache = cache_dir or identifiers.default_openfigi_cache()
    record = _load_record(layer_dir)
    batches = record.get("batches") or []
    if not batches:
        raise CusipError("no harvest record — run `harvest-cusip` first")
    mapping: dict[str, dict] = {}
    asked: set[str] = set()
    stats = {
        "batches": len(batches),
        "batches_missing": 0,
        "jobs_asked": 0,
        "jobs_resolved": 0,
        "requests": int((record.get("stats") or {}).get("requests_total") or 0),
        "errors": {},
    }
    for entry in batches:
        values = [str(value) for value in entry.get("values") or []]
        asked.update(values)
        stats["jobs_asked"] += len(values)
        payload = identifiers.read_cached_body(cache, entry["key"])
        if payload is None:
            stats["batches_missing"] += 1
            continue
        try:
            resolved = identifiers.resolved_isins(payload, values)
        except identifiers.IdentifierError:
            stats["batches_missing"] += 1
            continue
        stats["jobs_resolved"] += len(resolved)
        mapping.update(resolved)
        for value, entry_payload in zip(values, payload if isinstance(payload, list) else []):
            if value in resolved:
                continue
            error = entry_payload.get("error") if isinstance(entry_payload, dict) else None
            if error:
                key = str(error)
                stats["errors"][key] = stats["errors"].get(key, 0) + 1
    stats["asked_values"] = asked
    return mapping, stats


def auto_isin_layer(current: pathlib.Path) -> pathlib.Path | None:
    """The newest earlier layer that has an ``isin_map.json``, or ``None``.

    The marginal question — "how much of this did the ISIN pass not already have?" —
    should not depend on the caller remembering a flag, so a pass that finds a
    previous layer answers it by default and says which layer it used.
    """
    root = current.parent
    if not root.is_dir():
        return None
    for candidate in sorted((path for path in root.iterdir() if path.is_dir()), reverse=True):
        if candidate.resolve() == current.resolve():
            continue
        if (candidate / "isin_map.json").is_file():
            return candidate
    return None


def previous_isin_layers(layer_dir: pathlib.Path) -> tuple[set[str], set[str]]:
    """The ISINs a previous layer asked about, and the ones that came back resolved.

    This is what turns "the CUSIP resolved" into "the CUSIP resolved *and the ISIN
    pass had not*", which is the only honest way to state marginal coverage. Both
    sets are identifier values and live in memory only; nothing here is printed.
    """
    asked: set[str] = set()
    document = identifiers._read_gzip_json(layer_dir / "isin_index.json.gz")
    for payload in (document or {}).get("funds", {}).values():
        for row in payload.get("rows") or []:
            if row:
                asked.add(str(row[0]).strip().upper())
    # 74 MB of map is 1 GB of dicts once parsed; only the key set is wanted, and the
    # writer indents top-level keys by two spaces, so scan the text instead.
    resolved: set[str] = set()
    map_file = layer_dir / "isin_map.json"
    if map_file.is_file():
        try:
            text = map_file.read_text()
        except OSError as error:
            raise CusipError(f"unreadable ISIN map under {layer_dir}") from error
        resolved = {match.group(1).strip().upper() for match in MAP_KEY.finditer(text)}
        del text
        if not resolved and map_file.stat().st_size > 2:
            # The scan is a shortcut, not an assumption: if the writer's layout ever
            # changes, pay for the real parse rather than report every resolved row as
            # "never asked" — that would read as new coverage.
            try:
                parsed = json.loads(map_file.read_text())
            except ValueError:
                parsed = None
            if isinstance(parsed, dict) and parsed:
                resolved = {str(key).strip().upper() for key in parsed}
            else:
                raise CusipError(f"{map_file} is not a readable identifier map")
    return asked, resolved


def build_cusips(
    document: dict,
    *,
    release: pathlib.Path,
    layer_dir: pathlib.Path | None = None,
    cache_dir: pathlib.Path | None = None,
    isin_layer: pathlib.Path | None = None,
    top: int = 20,
    promote: bool = True,
) -> tuple[dict, dict, str]:
    """Write ``cusip_map.json`` and ``measurement.json``; return them and a report."""
    release_id = release_identity(release)
    layer = layer_for(release, layer_dir)
    mapping, stats = resolve_map(layer, cache_dir)
    values = document.get("values") or []
    value_bp = dict(document.get("value_bp") or {})
    totals = dict(document.get("totals") or {})

    resolved_positions = {
        position for position, (value, _source) in enumerate(values) if value in mapping
    }
    #: A row counts once, however many of its identifiers resolved. The ISIN pass
    #: measured weight the same way, so the two are addable.
    isins = document.get("isins") or []
    asked_before: set[str] = set()
    resolved_before: set[str] = set()
    if isin_layer is None:
        isin_layer = auto_isin_layer(layer)
    if isin_layer is not None:
        asked_before, resolved_before = previous_isin_layers(isin_layer)

    bp_resolved = bp_unresolved = 0.0
    bp_resolved_new = bp_resolved_had_isin = 0.0
    bp_resolved_isin_covered = bp_resolved_isin_unresolved = bp_resolved_isin_unasked = 0.0
    bp_resolved_without_isin = 0.0
    #: Only a row that carried a CUSIP was ever in this pass's frame. Weight on rows
    #: with no CUSIP-shaped value must not be reported as "unresolved" — it was never
    #: asked, and lumping it in overstates what the pass missed by millions of bp.
    bp_frame_resolved = bp_frame_unresolved = bp_out_of_frame = 0.0
    rows_resolved = rows_unresolved = 0
    rows_resolved_new = 0
    per_category: dict[str, float] = {}
    per_category_new: dict[str, float] = {}
    per_security_type: dict[str, float] = {}
    per_market_sector: dict[str, float] = {}
    for bp, category, at_isin, positions in document.get("rows") or []:
        weight = float(bp)
        matched = next(
            (mapping[values[position][0]] for position in positions if position in resolved_positions),
            None,
        )
        if not positions:
            bp_out_of_frame += weight
        if matched is not None:
            bp_resolved += weight
            if positions:
                bp_frame_resolved += weight
            rows_resolved += 1
            per_category[category] = per_category.get(category, 0.0) + weight
            security_type = str(matched.get("security_type") or "UNKNOWN")
            sector = str(matched.get("market_sector") or "UNKNOWN")
            per_security_type[security_type] = per_security_type.get(security_type, 0.0) + weight
            per_market_sector[sector] = per_market_sector.get(sector, 0.0) + weight
            if at_isin < 0:
                bp_resolved_new += weight
                bp_resolved_without_isin += weight
                rows_resolved_new += 1
                per_category_new[category] = per_category_new.get(category, 0.0) + weight
                continue
            bp_resolved_had_isin += weight
            if isin_layer is None:
                continue
            value = str(isins[at_isin]).strip().upper() if at_isin < len(isins) else ""
            if value in resolved_before:
                bp_resolved_isin_covered += weight
            elif value in asked_before:
                bp_resolved_isin_unresolved += weight
                bp_resolved_new += weight
                rows_resolved_new += 1
                per_category_new[category] = per_category_new.get(category, 0.0) + weight
            else:
                bp_resolved_isin_unasked += weight
                bp_resolved_new += weight
                rows_resolved_new += 1
                per_category_new[category] = per_category_new.get(category, 0.0) + weight
        else:
            bp_unresolved += weight
            rows_unresolved += 1
            if positions:
                bp_frame_unresolved += weight

    gross = float(totals.get("gross_bp") or 0.0)
    frame = float(totals.get("bp_with_cusip") or 0.0)

    def share(value: float, denominator: float) -> float:
        return (value / denominator * 100.0) if denominator else 0.0

    measurement = {
        "release": release_id,
        "as_of": release_id,
        "release_path": str(release),
        "layer": final_layer_name(layer),
        "id_type": ID_TYPE,
        "denominators": {
            "published_gross_bp": round(gross, 2),
            "published_target_bp": round(float(totals.get("published_target_bp") or 0.0), 2),
            "frame_bp": round(frame, 2),
            "frame_share_of_gross_pct": round(share(frame, gross), 4),
        },
        "distinct": {
            "values_total": len(values),
            "by_source": distinct_by_source(document),
            "values_resolved": len(mapping),
            "values_unresolved": len(values) - len(mapping),
            "values_asked": len(stats["asked_values"]),
        },
        "weight": {
            "frame_bp": round(frame, 2),
            "resolved_bp": round(bp_resolved, 2),
            "unresolved_bp": round(bp_unresolved, 2),
            "unresolved_bp_in_frame": round(bp_frame_unresolved, 2),
            "out_of_frame_bp": round(bp_out_of_frame, 2),
            "resolved_bp_no_isin": round(bp_resolved_without_isin, 2),
            "resolved_bp_had_isin": round(bp_resolved_had_isin, 2),
            "resolved_bp_isin_covered_before": round(bp_resolved_isin_covered, 2),
            "resolved_bp_isin_unresolved_before": round(bp_resolved_isin_unresolved, 2),
            "resolved_bp_isin_never_asked": round(bp_resolved_isin_unasked, 2),
            "new_bp_total": round(bp_resolved_new, 2),
            "new_share_of_gross_pct": round(share(bp_resolved_new, gross), 4),
            "resolved_share_of_frame_pct": round(share(bp_frame_resolved, frame), 4),
            "resolved_share_of_gross_pct": round(share(bp_resolved, gross), 4),
            "by_category": {key: round(value, 2) for key, value in sorted(per_category.items())},
            "by_category_new": {
                key: round(value, 2) for key, value in sorted(per_category_new.items())
            },
            "by_security_type": {
                key: round(value, 2)
                for key, value in sorted(
                    per_security_type.items(), key=lambda item: -item[1]
                )
            },
            "by_market_sector": {
                key: round(value, 2)
                for key, value in sorted(per_market_sector.items(), key=lambda item: -item[1])
            },
        },
        "rows": {
            "joined": int(totals.get("joined_rows") or 0),
            "resolved": rows_resolved,
            "unresolved": rows_unresolved,
            "resolved_no_isin": rows_resolved_new,
            "ambiguous": int(totals.get("ambiguous_rows") or 0),
            "category_moved": int(totals.get("category_moved_rows") or 0),
        },
        "quality": {
            "cusip_check_digit_bad": int(totals.get("cusip_check_digit_bad") or 0),
        },
        "compared_against": {
            "isin_layer": str(isin_layer) if isin_layer is not None else None,
            "isins_asked_before": len(asked_before),
            "isins_resolved_before": len(resolved_before),
        },
        "harvest": {
            "requests_total": stats["requests"],
            "batches": stats["batches"],
            "batches_missing": stats["batches_missing"],
            "jobs_asked": stats["jobs_asked"],
            "jobs_resolved": stats["jobs_resolved"],
            "errors": dict(sorted(stats["errors"].items())),
        },
    }

    # One directory should be a whole layer, so a consumer never has to consult two:
    # the ISIN map is carried forward byte for byte rather than rebuilt (an ISIN's
    # FIGI does not depend on which release asked for it), and the copy is recorded.
    if isin_layer is not None:
        source = isin_layer / "isin_map.json"
        if source.is_file() and not (layer / "isin_map.json").exists():
            shutil.copyfile(source, layer / "isin_map.json")
            measurement["isin_map_copied_from"] = str(isin_layer)
            measurement["isin_map_copied_entries"] = len(resolved_before)

    # Plain JSON, exactly like `isin_map.json` beside it: a consumer that resolves the
    # map by name should not have to know which of the two is compressed.
    map_path = layer / MAP_NAME
    map_path.write_text(json.dumps(mapping, indent=2, sort_keys=True) + "\n")
    measurement["cusip_map_path"] = str(layer.parent / final_layer_name(layer) / MAP_NAME)
    (layer / MEASUREMENT_NAME).write_text(
        json.dumps(measurement, indent=2, sort_keys=True) + "\n"
    )

    report: list[str] = []
    published = layer
    if promote:
        try:
            published = promote_layer(layer)
        except CusipError as error:
            report.append(f"  not published: {error}")

    heaviest = sorted(
        ((value_bp.get(value, 0.0), value, mapping[value].get("security_type")) for value in mapping),
        reverse=True,
    )[: max(int(top), 0)]
    report.append(
        f"cusip build: {len(values):,} distinct values → {len(mapping):,} resolved"
        f" ({share(len(mapping), len(values)):.1f}%) as named securities,"
        f" against {gross:,.0f} bp of published gross"
    )
    report.append(
        f"  frame {frame:,.0f} bp ({share(frame, gross):.2f}% of gross)"
        f" · resolved {bp_resolved:,.0f} bp ({share(bp_resolved, frame):.1f}% of frame,"
        f" {share(bp_resolved, gross):.2f}% of gross)"
        f" · unresolved in frame {bp_frame_unresolved:,.0f} bp"
        f" (another {bp_out_of_frame:,.0f} bp of joined weight carried no CUSIP and was"
        f" never in the frame)"
    )
    report.append(
        f"  of the resolved weight, {bp_resolved_had_isin:,.0f} bp also carried an ISIN"
        f" and {bp_resolved - bp_resolved_had_isin if isin_layer is not None else bp_resolved_new:,.0f} bp carried none"
    )
    if isin_layer is not None:
        report.append(
            f"  marginal over the ISIN pass: {bp_resolved_new:,.0f} bp newly identifiable"
            f" ({share(bp_resolved_new, gross):.3f}% of gross)"
            f" = {bp_resolved - bp_resolved_had_isin:,.0f} bp with no ISIN at all"
            f" + {bp_resolved_isin_unresolved:,.0f} bp whose ISIN was asked and failed"
            f" + {bp_resolved_isin_unasked:,.0f} bp whose ISIN was never asked;"
            f" {bp_resolved_isin_covered:,.0f} bp was already resolvable by ISIN"
        )
    report.append(
        f"  rows {rows_resolved:,} resolved / {rows_unresolved:,} not"
        f" · {rows_resolved_new:,} of the resolved rows had no ISIN"
        f" · ambiguous dropped {int(totals.get('ambiguous_rows') or 0):,}"
    )
    if isin_layer is not None:
        report.append(
            f"  compared against {isin_layer.name}: {len(resolved_before):,} ISINs resolved"
            f" of {len(asked_before):,} asked"
        )
    if stats["errors"]:
        report.append(f"  openfigi errors: {json.dumps(dict(sorted(stats['errors'].items())))}")
    if stats["batches_missing"]:
        report.append(f"  batches missing from the cache: {stats['batches_missing']:,}")
    if heaviest:
        report.append(f"  heaviest resolved values by weight (top {len(heaviest)}):")
        for position, (weight, value, security_type) in enumerate(heaviest, 1):
            # The value itself is never printed — only its weight and its type.
            report.append(
                f"    {position:>3}. {weight:>12,.1f} bp  {security_type or 'unknown type'}"
            )
    report.append(f"  layer: {published}")
    return mapping, measurement, "\n".join(report)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _release_from(target: str | None) -> pathlib.Path:
    """Resolve a release directory from a path, an id, or the newest mirror on disk.

    `pipeline.identifiers.find_release` looks under ``artifacts/*/releases/*``; this
    repo also publishes ``artifacts/releases/<id>`` and mirrors a live release to
    ``artifacts/mirror/live``. All three are accepted so the common case —
    "the release this worktree has" — needs no argument.
    """
    candidates: list[pathlib.Path] = []
    if target:
        path = pathlib.Path(target)
        if path.is_dir():
            return path
        candidates += [
            pathlib.Path(path),
            REPO / "artifacts" / "releases" / path.name,
            REPO / "artifacts" / "mirror" / "live",
        ]
    else:
        candidates += [REPO / "artifacts" / "mirror" / "live"]
        candidates += sorted((REPO / "artifacts" / "releases").glob("*"), reverse=True)
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "funds").is_dir():
            return candidate
    raise CusipError(f"no release with fund documents for {target or 'the default path'}")


def _progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _second_pass_main(argv: list[str], keyed: bool) -> int:
    defaults = (
        (KEYED_JOBS, KEYED_RPM) if keyed else (PLAIN_JOBS, PLAIN_RPM)
    )
    parser = argparse.ArgumentParser(
        prog="scripts/harvest_identifiers.py",
        description="The CUSIP half of the OpenFIGI identifier layer.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name, help_text in (
        ("enumerate", "offline: which CUSIP-shaped values a pass would ask about"),
        ("harvest-cusip", "resolve CUSIPs to FIGIs, caching every response"),
        ("build-cusip", "write cusip_map.json + measurement.json from the cache"),
    ):
        sub = subparsers.add_parser(name, help=help_text)
        sub.add_argument("--release", default=None, help="release id or directory")
        sub.add_argument("--layer-dir", default=None, help="override the layer directory")
        sub.add_argument("--cache-dir", default=None, help="override the response cache")
        sub.add_argument(
            "--filing-cache", default=None, help="override the N-PORT filing cache"
        )
        if name != "build-cusip":
            sub.add_argument(
                "--refresh", action="store_true", help="rebuild the CUSIP index from the release"
            )
        if name == "harvest-cusip":
            sub.add_argument("--limit", type=int, default=None, help="only the first N values")
            sub.add_argument("--rpm", type=float, default=float(defaults[1]))
            sub.add_argument("--jobs", type=int, default=int(defaults[0]))
            sub.add_argument(
                "--no-network",
                action="store_true",
                help="answer from the cache only; a miss is reported, never fetched",
            )
        if name == "build-cusip":
            sub.add_argument("--top", type=int, default=20, help="heaviest values to list")
            sub.add_argument(
                "--isin-layer",
                default=None,
                help="a previous layer's isin_map.json to measure the marginal against"
                " (default: the newest one on disk)",
            )
            sub.add_argument(
                "--no-promote",
                action="store_true",
                help="leave the layer in <date>.staging instead of publishing it",
            )

    arguments = parser.parse_args(argv)
    release = _release_from(arguments.release)
    layer = pathlib.Path(arguments.layer_dir) if arguments.layer_dir else None
    cache = pathlib.Path(arguments.cache_dir) if arguments.cache_dir else None
    filing_cache = pathlib.Path(arguments.filing_cache) if arguments.filing_cache else None

    try:
        if arguments.command == "enumerate":
            document = enumerate_cusips(
                release,
                filing_cache=filing_cache,
                layer_dir=layer,
                refresh=arguments.refresh,
                progress=_progress,
            )
            totals = document.get("totals") or {}
            print(
                f"enumerate: release {document.get('as_of')}"
                f" · {int(totals.get('funds') or 0):,} funds"
                f" · {int(totals.get('funds_with_targets') or 0):,} with unmapped targets"
                f" · {int(totals.get('joined_rows') or 0):,} rows joined"
            )
            print(enum_line(document))
            print(
                f"  frame reconciliation: published target {float(totals.get('published_target_bp') or 0):,.0f} bp,"
                f" computed from filings {float(totals.get('computed_bp') or 0):,.0f} bp,"
                f" ambiguous rows dropped {int(totals.get('ambiguous_rows') or 0):,},"
                f" category-moved {int(totals.get('category_moved_rows') or 0):,}"
            )
            print(
                f"  rows with an ISIN {int(totals.get('rows_with_isin') or 0):,}"
                f" ({float(totals.get('bp_with_isin') or 0):,.0f} bp)"
                f" · without {int(totals.get('rows_no_isin') or 0):,}"
                f" ({float(totals.get('bp_no_isin') or 0):,.0f} bp)"
                f" · no identifier at all {int(totals.get('rows_no_identifier') or 0):,}"
                f" ({float(totals.get('bp_no_identifier') or 0):,.0f} bp)"
            )
            print(
                f"  check-digit implausible values {int(totals.get('cusip_check_digit_bad') or 0):,}"
                f" of {len(document.get('values') or []):,}"
                f" · filing errors {len(document.get('errors') or []):,}"
            )
            return 0

        document = enumerate_cusips(
            release,
            filing_cache=filing_cache,
            layer_dir=layer,
            refresh=getattr(arguments, "refresh", False),
            progress=_progress,
        )
        layer = layer or layer_for(release, None)
        if arguments.command == "harvest-cusip":
            mode = "keyed" if os.environ.get(KEY_ENV) else "unauthenticated"
            print(
                f"harvest-cusip: {mode} ({arguments.rpm:g} req/min,"
                f" {arguments.jobs} jobs/request), release {release_identity(release)}"
            )
            run = harvest_cusips(
                document,
                release=release,
                layer_dir=layer,
                cache_dir=cache,
                limit=arguments.limit,
                rpm=arguments.rpm,
                jobs_per_request=arguments.jobs,
                no_network=arguments.no_network,
                progress=_progress,
            )
            print(
                f"  values in index {run.values_in_index:,}"
                f" · selected {run.values_selected:,}"
                f" · batches {run.batches_total:,}"
                f" · cached {run.batches_cached:,}"
                f" · failed {run.batches_failed:,}"
                f" · offline misses {run.offline_misses:,}"
            )
            print(
                f"harvest-cusip: {run.requests:,} requests ({run.requests_total:,} for the layer),"
                f" {run.values_resolved:,} resolved, {run.values_unresolved:,} unresolved,"
                f" {run.seconds:.1f} s — {run.record_path}"
            )
            if run.stopped:
                print(f"  stopped: {run.stopped}", file=sys.stderr)
                return 1
            if run.offline_misses:
                print(
                    f"  offline: {run.offline_misses:,} batches are not in the cache",
                    file=sys.stderr,
                )
                return 1
            return 0

        _mapping, _measurement, report = build_cusips(
            document,
            release=release,
            layer_dir=layer,
            cache_dir=cache,
            isin_layer=(
                pathlib.Path(arguments.isin_layer)
                if arguments.isin_layer
                else None
            ),
            top=arguments.top,
            promote=not getattr(arguments, "no_promote", False),
        )
        print(report)
        published = layer.parent / final_layer_name(layer)
        print(f"cusip build: layer {published if published.exists() else layer}")
        return 0
    except (CusipError, identifiers.IdentifierError) as error:
        print(f"harvest-cusip: {error}", file=sys.stderr)
        return 1


def main(argv: list[str]) -> int:
    keyed, source = load_key()
    if keyed:
        print(f"harvest: {KEY_ENV} found in {source}", file=sys.stderr)
    else:
        print(
            f"harvest: no {KEY_ENV} in any .env — 10 jobs/request at 25 req/min "
            "(a full ISIN pass takes about 19 hours this way)",
            file=sys.stderr,
        )

    if not argv or argv[0] in ("harvest", "build"):
        defaults = (
            ("--jobs", KEYED_JOBS, "--rpm", KEYED_RPM)
            if keyed
            else ("--jobs", PLAIN_JOBS, "--rpm", PLAIN_RPM)
        )
        # Explicit flags win; the defaults only fill what the caller left out. The
        # subcommand is implied, because the first pass has only these two commands.
        args = list(argv) or ["harvest"]
        for flag, value in zip(defaults[0::2], defaults[1::2]):
            if flag not in args:
                args += [flag, value]
        jobs = args[args.index("--jobs") + 1]
        rpm = args[args.index("--rpm") + 1]
        print(
            f"harvest: {jobs} jobs/request at {rpm} req/min",
            file=sys.stderr,
        )
        return identifiers.main(args)

    return _second_pass_main(argv, keyed)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
