"""The OpenFIGI security layer: ISIN → share-class FIGI → an ``f_`` company, behind a pinned cache.

Rung R7 of the mapping ladder (``docs/platform/coverage-uplift.md``). A holding the ladder could
not tie to a company — no ticker/name match, no LEI, no corroborated ISIN — may still be a
**known equity share line**. OpenFIGI names it; this module turns the answer into an ``f_`` id
(``namespaces``) that merges across funds by the same ISIN and counts toward ``coverage_pct`` with
the share it carries disclosed as ``security_matched_pct``.

What this module is, and is not
-------------------------------

* **A cache, not a client.** The transport, batching, pacing and ``Retry-After`` handling are
  ``identifiers``' (``http_transport``, ``batch``, ``Throttle``, ``retry_after_seconds``): one
  OpenFIGI client in the pipeline, not two. This adds what ``identifiers.harvest`` lacks — a
  cache that survives between nightly runs, expiry, ``NO_MATCH`` answers, and a pin per release.
* **The build never calls the API.** ``refresh`` is the only network function and runs *before*
  the build (H-CV5): a build reads a cache snapshot, so two builds of one release read the same
  bytes and hash identically.
* **No identifier is stored in the clear.** The cache key is ``HMAC-SHA256(pepper, ISIN)``. The
  public bucket serves every prefix, so a file keyed by ISIN would publish ISINs — and a US ISIN
  embeds a licensed CUSIP (compliance skill §3a). The pepper is a secret
  (``FIGI_CACHE_PEPPER``); without it the cache is unreadable, and there is deliberately **no
  fallback to an unkeyed hash**: a missing pepper is an error, never a quietly weaker file.
* **Only public-domain fields are kept.** The FIGI, ``marketSector`` and ``securityType2``. The
  OpenFIGI ``name`` and ``ticker`` are "Related Security Descriptions" with no public-domain
  grant (ToS §3) and are never read, stored or published.

What is accepted
----------------

An answer makes an ``f_`` company only when OpenFIGI says ``marketSector == "Equity"`` **and**
``securityType2`` is one of ``ACCEPTED_TYPES``, and the share-class FIGI passes its own check
digit. ``securityType2`` is the field with that vocabulary (``Common Stock``, ``Depositary
Receipt``); ``securityType`` says ``ADR``/``NVDR``/``Foreign Sh.`` instead. Measured on the 11,663
candidate ISINs of release ``2026-11-16.1``: 84.7% of their weight is accepted, 14.1% is
``Mutual Fund`` (an open-end fund, ETP or closed-end fund filed as an equity — a fund position,
refused on purpose), 1.0% has no match.

    python -m pipeline.figi pull    --out figi_cache_v1.jsonl          # the last night's cache, if any
    python -m pipeline.figi collect --universe all --out isins.json    # every long equity ISIN in the latest filings
    python -m pipeline.figi refresh --isins isins.json --cache figi_cache_v1.jsonl
    python -m pipeline.figi push    --cache figi_cache_v1.jsonl        # keep it for tomorrow
    python -m pipeline.figi stats   --cache figi_cache_v1.jsonl

The nightly job runs the first four **before** the build (``refresh.yml``); the build then reads the file with
``--figi-cache``. The cache lives in R2 at ``inputs/figi_cache_v1.jsonl`` — outside every release prefix, and with no ISIN in
it (``verify_cache_shape`` refuses to push a file that has anything but the five public-domain fields under an HMAC key).
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from . import identifiers
from .namespaces import ID_HEX_DIGITS, SECURITY_PREFIX

PEPPER_ENV = "FIGI_CACHE_PEPPER"
#: A pepper shorter than this is a typo, not a secret.
MIN_PEPPER_BYTES = 16

CACHE_VERSION = 1
DEFAULT_CACHE_NAME = f"figi_cache_v{CACHE_VERSION}.jsonl"

STATUS_OK = "OK"
STATUS_NO_MATCH = "NO_MATCH"

#: How long an answer is believed. A listing's share class does not change often; "no match" is
#: re-asked sooner because a new listing can appear. An ``ERROR`` is never stored.
OK_TTL_DAYS = 180
NO_MATCH_TTL_DAYS = 90

EQUITY_SECTOR = "Equity"
#: ``securityType2`` values that are a company's own equity. ``Mutual Fund``, ``Warrant``,
#: ``Right`` and anything not ``Equity`` are refused: they are not the company.
ACCEPTED_TYPES = frozenset(
    {"Common Stock", "Depositary Receipt", "Preference", "REIT", "Receipt", "Unit"}
)

#: 80% of the keyed ceiling (250 requests/minute, 100 jobs/request; OpenFIGI documentation,
#: read 2026-11-18). The 25/10 unauthenticated limits are not used: a run without a key refuses.
DEFAULT_RPM = 0.8 * identifiers.KEYED_RPM
DEFAULT_JOBS = identifiers.KEYED_JOBS

#: Write the cache after this many batches, so a run that dies keeps what it had.
CHECKPOINT_BATCHES = 20


class FigiError(RuntimeError):
    """The layer cannot proceed and says why. Never carries an identifier or a key."""


class PepperMissing(FigiError):
    """``FIGI_CACHE_PEPPER`` is absent or too short. There is no unkeyed fallback."""


# --- keys and ids ------------------------------------------------------------


def pepper_from_env(environ: Mapping[str, str] | None = None) -> bytes:
    """The cache's HMAC key, from the environment, or a refusal."""
    value = (environ if environ is not None else os.environ).get(PEPPER_ENV, "")
    encoded = value.strip().encode()
    if len(encoded) < MIN_PEPPER_BYTES:
        raise PepperMissing(
            f"{PEPPER_ENV} is not set (or shorter than {MIN_PEPPER_BYTES} bytes). The FIGI cache "
            "is keyed by HMAC(pepper, ISIN) so that no ISIN is stored in the clear; there is no "
            "unkeyed fallback."
        )
    return encoded


def cache_key(pepper: bytes, isin: str) -> str:
    """``HMAC-SHA256(pepper, "isin:" + ISIN)``, 32 hex characters. Never reversible without the pepper."""
    digest = hmac.new(pepper, b"isin:" + isin.strip().upper().encode("ascii"), hashlib.sha256)
    return digest.hexdigest()[:32]


def security_id(share_class_figi: str) -> str:
    """The published ``f_`` id for a share line: ``f_`` + 16 hex of sha256(share-class FIGI)."""
    digest = hashlib.sha256(share_class_figi.strip().upper().encode("ascii")).hexdigest()
    return f"{SECURITY_PREFIX}{digest[:ID_HEX_DIGITS]}"


# --- one answer ---------------------------------------------------------------


@dataclass(frozen=True)
class Answer:
    """What OpenFIGI said about one ISIN — only the public-domain fields."""

    status: str
    fetched_at: str
    share_class_figi: str | None = None
    sector: str | None = None
    security_type2: str | None = None

    def accepted(self) -> bool:
        """True when this answer may become an ``f_`` company (see the module docstring)."""
        return (
            self.status == STATUS_OK
            and self.sector == EQUITY_SECTOR
            and self.security_type2 in ACCEPTED_TYPES
            and identifiers.valid_figi(self.share_class_figi)
        )

    def expired(self, today: str) -> bool:
        ttl = OK_TTL_DAYS if self.status == STATUS_OK else NO_MATCH_TTL_DAYS
        try:
            age = date.fromisoformat(today) - date.fromisoformat(self.fetched_at)
        except ValueError:
            return True
        return age > timedelta(days=ttl)

    def to_record(self, key: str) -> dict[str, Any]:
        record: dict[str, Any] = {"key": key, "status": self.status, "fetched_at": self.fetched_at}
        if self.status == STATUS_OK:
            record["share_class_figi"] = self.share_class_figi
            record["sector"] = self.sector
            record["security_type2"] = self.security_type2
        return record

    @classmethod
    def from_record(cls, record: Mapping[str, Any]) -> "Answer":
        return cls(
            status=str(record["status"]),
            fetched_at=str(record["fetched_at"]),
            share_class_figi=record.get("share_class_figi"),
            sector=record.get("sector"),
            security_type2=record.get("security_type2"),
        )


def answers_from_payload(
    payload: Any, isins: list[str], today: str
) -> dict[str, Answer]:
    """Map one response (a list the same length as the jobs) to an answer per ISIN.

    A job with no ``data`` — OpenFIGI answered, it just does not name the ISIN — is
    ``NO_MATCH``. Only the first record is read: one ISIN can list on several venues, and they
    share a share-class FIGI. ``name`` and ``ticker`` are not read.
    """
    if not isinstance(payload, list) or len(payload) != len(isins):
        raise FigiError("malformed OpenFIGI response: length does not match the jobs")
    answers: dict[str, Answer] = {}
    for isin, entry in zip(isins, payload):
        records = entry.get("data") if isinstance(entry, dict) else None
        first = records[0] if isinstance(records, list) and records and isinstance(records[0], dict) else None
        if first is None or not first.get("figi"):
            answers[isin] = Answer(status=STATUS_NO_MATCH, fetched_at=today)
            continue
        answers[isin] = Answer(
            status=STATUS_OK,
            fetched_at=today,
            share_class_figi=first.get("shareClassFIGI"),
            sector=first.get("marketSector"),
            security_type2=first.get("securityType2"),
        )
    return answers


# --- the cache ----------------------------------------------------------------


class ShareClassMap:
    """The cache, read: ISIN → :class:`Answer`, keyed by HMAC so no ISIN is held in the clear."""

    def __init__(
        self, answers: dict[str, Answer], pepper: bytes, *, sha256: str | None = None
    ) -> None:
        self._answers = answers
        self._pepper = pepper
        #: Hash of the file this map was read from: what a release manifest records so a
        #: rebuild can prove it read the same bytes (H-CV5).
        self.sha256 = sha256

    def __len__(self) -> int:
        return len(self._answers)

    def answer_for(self, isin: str | None) -> Answer | None:
        """The cached answer for an ISIN, or ``None`` when it was never asked."""
        if not isin or not identifiers.valid_isin(isin):
            return None
        return self._answers.get(cache_key(self._pepper, isin))

    def security_for(self, isin: str | None) -> str | None:
        """The ``f_`` id of the ISIN's share line, or ``None`` unless the answer is accepted."""
        answer = self.answer_for(isin)
        if answer is None or not answer.accepted():
            return None
        return security_id(answer.share_class_figi)  # type: ignore[arg-type]

    def stats(self) -> dict[str, int]:
        """Counts only — never a key, an ISIN or a FIGI."""
        accepted = sum(1 for answer in self._answers.values() if answer.accepted())
        ok = sum(1 for answer in self._answers.values() if answer.status == STATUS_OK)
        return {
            "records": len(self._answers),
            "ok": ok,
            "no_match": len(self._answers) - ok,
            "accepted": accepted,
        }

    def provenance(self) -> dict[str, Any]:
        """The block a release manifest records about this cache: the pin, and counts."""
        return {"sha256": self.sha256, "version": CACHE_VERSION, **self.stats()}

    def write(self, path: Path) -> str:
        """Write the cache deterministically (sorted by key, compact) and return its sha256."""
        lines = [
            json.dumps(answer.to_record(key), sort_keys=True, separators=(",", ":"))
            for key, answer in sorted(self._answers.items())
        ]
        body = ("\n".join(lines) + ("\n" if lines else "")).encode()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_bytes(body)
        temporary.replace(path)
        self.sha256 = hashlib.sha256(body).hexdigest()
        return self.sha256

    @classmethod
    def empty(cls, pepper: bytes) -> "ShareClassMap":
        return cls({}, pepper)

    @classmethod
    def load(cls, path: Path, pepper: bytes) -> "ShareClassMap":
        body = path.read_bytes()
        answers: dict[str, Answer] = {}
        for number, line in enumerate(body.decode().splitlines(), 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                answers[str(record["key"])] = Answer.from_record(record)
            except (ValueError, KeyError) as error:
                raise FigiError(f"{path.name} line {number} is not a cache record") from error
        return cls(answers, pepper, sha256=hashlib.sha256(body).hexdigest())

    def merge(self, answers: Mapping[str, Answer]) -> None:
        """Fold fresh answers (keyed by ISIN) in, replacing any older ones."""
        for isin, answer in answers.items():
            self._answers[cache_key(self._pepper, isin)] = answer

    def needs_asking(self, isin: str, today: str) -> bool:
        answer = self._answers.get(cache_key(self._pepper, isin))
        return answer is None or answer.expired(today)


# --- the refresh (the only network function) -----------------------------------


@dataclass
class RefreshStats:
    candidates: int = 0
    already_cached: int = 0
    asked: int = 0
    requests: int = 0
    ok: int = 0
    no_match: int = 0
    failed_batches: int = 0
    seconds: float = 0.0


def refresh(
    isins: Iterable[str],
    *,
    cache_path: Path,
    pepper: bytes,
    api_key: str | None,
    today: str | None = None,
    rpm: float = DEFAULT_RPM,
    jobs_per_request: int = DEFAULT_JOBS,
    limit: int | None = None,
    transport: identifiers.Transport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    progress: Callable[[str], None] | None = None,
) -> RefreshStats:
    """Ask OpenFIGI about every ISIN the cache does not already answer, and write the cache.

    Only uncached or expired ISINs are sent (H-CV6), so a second run with nothing new makes
    **zero** requests. A batch that still fails after ``identifiers.MAX_ATTEMPTS`` is counted and
    skipped — never stored as an answer — so it is asked again next run. A 401/403 stops the run
    (``identifiers.KeyRequired``): a missing or rejected key is not fixed by retrying, and an
    unkeyed run would be 10 jobs per request at 25 a minute, which is not what this function is
    sized for, so a missing key refuses outright.
    """
    if not api_key:
        raise identifiers.KeyRequired(f"{identifiers.KEY_ENV} is not set; refusing an unkeyed run")
    transport = transport or identifiers.http_transport
    today = today or time.strftime("%Y-%m-%d", time.gmtime())
    started = clock()

    cache = ShareClassMap.load(cache_path, pepper) if cache_path.exists() else ShareClassMap.empty(pepper)
    candidates = sorted({isin.strip().upper() for isin in isins if identifiers.valid_isin(isin)})
    stats = RefreshStats(candidates=len(candidates))
    todo = [isin for isin in candidates if cache.needs_asking(isin, today)]
    stats.already_cached = len(candidates) - len(todo)
    if limit is not None:
        todo = todo[: int(limit)]
    stats.asked = len(todo)

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": identifiers.USER_AGENT,
        "X-OPENFIGI-APIKEY": api_key,
    }
    throttle = identifiers.Throttle(identifiers.interval_seconds(rpm), clock=clock, sleep=sleep)
    batches = identifiers.batch(todo, jobs_per_request)

    for number, chunk in enumerate(batches, 1):
        body = identifiers._request_body(chunk)
        payload = None
        for attempt in range(1, identifiers.MAX_ATTEMPTS + 1):
            throttle.wait()
            stats.requests += 1
            try:
                status, response_headers, raw = transport(body, headers)
            except identifiers.TransportError:
                if attempt < identifiers.MAX_ATTEMPTS:
                    sleep(identifiers.FALLBACK_RETRY_S / 2)
                    continue
                break
            if status in (401, 403):
                cache.write(cache_path)
                raise identifiers.KeyRequired(
                    f"OpenFIGI answered {status}: the key is missing, rejected or out of scope"
                )
            if status == 429:
                if attempt < identifiers.MAX_ATTEMPTS:
                    sleep(identifiers.retry_after_seconds(response_headers))
                    continue
                break
            if status != 200:
                if attempt < identifiers.MAX_ATTEMPTS:
                    sleep(identifiers.FALLBACK_RETRY_S)
                    continue
                break
            try:
                payload = json.loads(raw)
                answers = answers_from_payload(payload, chunk, today)
            except (ValueError, FigiError):
                payload = None
                if attempt < identifiers.MAX_ATTEMPTS:
                    sleep(identifiers.FALLBACK_RETRY_S)
                    continue
                break
            cache.merge(answers)
            stats.ok += sum(1 for answer in answers.values() if answer.status == STATUS_OK)
            stats.no_match += sum(1 for answer in answers.values() if answer.status == STATUS_NO_MATCH)
            break
        if payload is None:
            stats.failed_batches += 1
        if number % CHECKPOINT_BATCHES == 0:
            cache.write(cache_path)
            if progress is not None:
                progress(f"figi: batch {number}/{len(batches)}, {stats.requests} requests")

    if batches or not cache_path.exists():
        cache.write(cache_path)
    stats.seconds = clock() - started
    return stats


# --- the nightly's three small steps: collect, pull, push -----------------------


#: Where the cache is kept between nights. Outside ``releases/`` and ``latest/``: it is a build input, not a
#: release, and no retention rule or promotion touches it.
REMOTE_KEY = f"inputs/{DEFAULT_CACHE_NAME}"
DEFAULT_PUBLIC_BASE = "https://data.unpackfund.com"

_KEY_RE = re.compile(r"^[0-9a-f]{32}$")
_ALLOWED_FIELDS = frozenset(
    {"key", "status", "fetched_at", "share_class_figi", "sector", "security_type2"}
)


def verify_cache_shape(path: Path) -> int:
    """Refuse a cache file that could carry an identifier in the clear; return its record count.

    The bucket serves every prefix publicly, so this is the guard between "a file of HMAC keys and
    public-domain fields" and "a file that publishes ISINs". Every line must be a record whose key is 32
    hex characters and whose fields are within the five the layer writes. ``Answer.to_record`` can only
    produce that shape; this holds the file, not the writer, to it.
    """
    count = 0
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as error:
            raise FigiError(f"{path.name} line {number} is not JSON") from error
        if not isinstance(record, dict) or not _KEY_RE.match(str(record.get("key", ""))):
            raise FigiError(f"{path.name} line {number}: the key is not a 32-hex HMAC")
        extra = set(record) - _ALLOWED_FIELDS
        if extra:
            raise FigiError(f"{path.name} line {number}: unexpected fields {sorted(extra)}")
        count += 1
    return count


def collect_isins(
    spec: str = "all",
    *,
    workers: int = 8,
    progress: Callable[[str], None] | None = None,
) -> list[str]:
    """Every valid ISIN of a long equity row in the latest filing of every fund in the universe.

    The cache refresh has to run *before* the build (the build never calls the network, H-CV5), and
    which rows the ladder leaves unmapped is only known after the build. So the question asked is the
    wider one the build can always answer from the same filings: every equity row with a positive balance
    and a valid ISIN. The first night that is the whole equity universe; afterwards only new or expired
    ISINs are sent (``refresh``), and the answers also serve the join rungs.

    Funds whose filing cannot be read are skipped and counted, never fatal: a missing ISIN only means a
    row stays unmapped, which is what it was.
    """
    # Imported here: ``build`` imports this module.
    from concurrent.futures import ThreadPoolExecutor

    from . import build, classify, filings

    refs = build.resolve_universe(spec)
    filings.prefetch(refs, workers=workers, progress=progress)

    def one(ref) -> set[str] | None:
        try:
            found = filings.latest(ref)
        except Exception:  # noqa: BLE001 - one unreadable filing must not stop the night
            return None
        isins: set[str] = set()
        for holding in found.filing.holdings:
            if (
                holding.isin
                and (holding.balance or 0) > 0
                and (holding.val_usd or 0) > 0
                and classify.classify(
                    holding.asset_cat, holding.issuer_cat, holding.is_derivative
                ).category
                == classify.EQUITY
                and identifiers.valid_isin(holding.isin)
            ):
                isins.add(holding.isin.strip().upper())
        return isins

    collected: set[str] = set()
    skipped = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for result in pool.map(one, refs):
            if result is None:
                skipped += 1
            else:
                collected |= result
    if progress is not None:
        progress(f"figi: {len(collected):,} equity ISINs from {len(refs) - skipped:,} funds ({skipped} unreadable)")
    return sorted(collected)


def pull(
    out: Path,
    *,
    base: str = DEFAULT_PUBLIC_BASE,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> bool:
    """Fetch last night's cache from R2. ``False`` (and no file) on the first night, when there is none.

    A cache-busting query is added: the public host caches objects, and this one changes every night.
    A file that fails the shape check is refused rather than used.
    """
    url = f"{base}/{REMOTE_KEY}?v={int(time.time())}"
    request = urllib.request.Request(url, headers={"User-Agent": identifiers.USER_AGENT})
    try:
        with opener(request, timeout=120) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise FigiError(f"could not fetch the cache: HTTP {error.code}") from error
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(body)
    try:
        verify_cache_shape(out)
    except FigiError:
        out.unlink(missing_ok=True)
        raise
    return True


def push(cache: Path, *, client: Any = None) -> int:
    """Upload the cache to R2 for tomorrow; returns the record count. Refuses an unsafe file."""
    count = verify_cache_shape(cache)
    if client is None:
        from . import r2, release

        credentials, endpoint, bucket = release.credentials_from_env()
        client = r2.R2Client(endpoint, bucket, credentials)
    # Mutable, unlike every release object: it is rewritten nightly, so it must not be cached.
    client.put(
        REMOTE_KEY, cache.read_bytes(), content_type="application/x-ndjson", cache_control="no-cache"
    )
    return count


# --- command line --------------------------------------------------------------


def _read_isins(path: Path) -> list[str]:
    text = path.read_text()
    try:
        payload = json.loads(text)
    except ValueError:
        return [line.strip() for line in text.splitlines() if line.strip()]
    if isinstance(payload, dict):
        payload = payload.get("isins") or payload.get("values") or []
    return [str(value) for value in payload]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.figi", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    refresh_parser = commands.add_parser("refresh", help="ask OpenFIGI about uncached ISINs")
    refresh_parser.add_argument("--isins", type=Path, required=True, help="JSON list or one ISIN per line")
    refresh_parser.add_argument("--cache", type=Path, required=True)
    refresh_parser.add_argument("--rpm", type=float, default=DEFAULT_RPM)
    refresh_parser.add_argument("--limit", type=int, default=None)
    stats_parser = commands.add_parser("stats", help="counts for a cache file")
    stats_parser.add_argument("--cache", type=Path, required=True)
    collect_parser = commands.add_parser("collect", help="list the equity ISINs of the latest filings")
    collect_parser.add_argument("--universe", default="all")
    collect_parser.add_argument("--out", type=Path, required=True)
    collect_parser.add_argument("--workers", type=int, default=8)
    pull_parser = commands.add_parser("pull", help="fetch last night's cache from R2 (none on night one)")
    pull_parser.add_argument("--out", type=Path, required=True)
    push_parser = commands.add_parser("push", help="upload the cache to R2 for tomorrow")
    push_parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args(argv)

    log = lambda message: print(message, file=sys.stderr, flush=True)  # noqa: E731
    try:
        # These three need neither the key nor the pepper: no ISIN is read from, or written to, a cache.
        if args.command == "collect":
            isins = collect_isins(args.universe, workers=args.workers, progress=log)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(isins))
            print(json.dumps({"isins": len(isins)}))
            return 0
        if args.command == "pull":
            found = pull(args.out)
            print(json.dumps({"pulled": found}))
            return 0
        if args.command == "push":
            if not args.cache.exists():
                print(json.dumps({"pushed": 0, "note": "no cache file"}))
                return 0
            print(json.dumps({"pushed": push(args.cache)}))
            return 0
        pepper = pepper_from_env()
        if args.command == "stats":
            cache = ShareClassMap.load(args.cache, pepper)
            print(json.dumps({**cache.stats(), "sha256": cache.sha256}, sort_keys=True))
            return 0
        outcome = refresh(
            _read_isins(args.isins),
            cache_path=args.cache,
            pepper=pepper,
            api_key=os.environ.get(identifiers.KEY_ENV) or None,
            rpm=args.rpm,
            limit=args.limit,
            progress=lambda message: print(message, file=sys.stderr, flush=True),
        )
    except (FigiError, identifiers.IdentifierError) as error:
        print(f"figi: {error}", file=sys.stderr)
        return 2
    print(json.dumps(outcome.__dict__, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
