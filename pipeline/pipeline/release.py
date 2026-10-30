"""Publish a built release to R2, in the order that keeps a failure invisible.

The sequence is fixed by `data-contract-and-release` §4 and `cloudflare-workers-r2-deploy` §6:

1. read the release manifest and refuse to continue if a local file's hash disagrees with it;
2. upload the release objects under an immutable path;
3. **verify each one the way a browser will fetch it** — public URL, sha256, cache headers, CORS;
4. only then write the pointer, because a pointer that moves before the objects exist is a broken site;
5. report what the live pointer still says, so "did this publish?" is answered by the run, not by memory.

Day 2 rehearses the whole sequence against a non-live prefix (`staging/latest`): the objects are
real and the pointer is real, but nothing the app reads has changed. Writing `latest/` is a
production action and needs `--allow-live`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from . import paths
from .r2 import IMMUTABLE, NO_CACHE, Credentials, PublicReader, R2Client, R2Error
from .sigv4 import EMPTY_PAYLOAD_SHA256  # noqa: F401  (re-exported for tests that stub signing)

LIVE_POINTER = "latest/release.json"
DEFAULT_POINTER_PREFIX = "staging/latest"
#: The pointer object name. It changed with the schema: see `upload_release`.
DEFAULT_POINTER_NAME = "release.json"
DEFAULT_PUBLIC_BASE = "https://data.unpackfund.com"
DEFAULT_ORIGIN = "http://localhost:3000"
DEFAULT_BUCKET = "unpackfund-artifacts"

#: Objects in flight during an upload. R2 tolerates far more; 8 keeps a failure
#: attributable and the public read-back honest.
DEFAULT_CONCURRENCY = 8


class ReleaseError(RuntimeError):
    """A release that must not be published as it stands."""


@dataclass
class UploadedObject:
    key: str
    size: int
    sha256: str
    etag: str
    cache_control: str
    verified: bool = False
    allow_origin: str | None = None
    problem: str | None = None


@dataclass
class UploadReport:
    release: str
    prefix: str
    pointer_key: str
    public_base: str
    objects: list[UploadedObject] = field(default_factory=list)
    pointer: UploadedObject | None = None
    live_pointer_status: int | None = None
    live_pointer_release: str | None = None
    #: Set when the plain pointer URL and a cache-busted one disagree, which is the
    #: edge's negative cache talking, not the release.
    live_pointer_edge: str | None = None
    dry_run: bool = False
    started_at: str = ""
    finished_at: str = ""

    @property
    def total_bytes(self) -> int:
        return sum(item.size for item in self.objects) + (self.pointer.size if self.pointer else 0)

    @property
    def failures(self) -> list[str]:
        problems = [f"{item.key}: {item.problem}" for item in self.objects if item.problem]
        if self.pointer and self.pointer.problem:
            problems.append(f"{self.pointer.key}: {self.pointer.problem}")
        return problems


# -- environment -------------------------------------------------------------
def load_env(explicit: Path | None = None) -> list[str]:
    """Populate `os.environ` from the workspace `.env`; return the names loaded.

    Existing environment variables win, so CI secrets and an explicit
    `R2_ENDPOINT=… pnpm release:upload` both behave as expected. Values are never
    returned, printed, or logged — only names.
    """
    candidates = [explicit] if explicit else paths.env_file_candidates()
    for candidate in candidates:
        if candidate and candidate.is_file():
            loaded = []
            for raw in candidate.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                name = name.strip()
                value = value.strip().strip('"').strip("'")
                if name and name not in os.environ:
                    os.environ[name] = value
                    loaded.append(name)
            return loaded
    return []


def credentials_from_env() -> tuple[Credentials, str, str]:
    missing = [
        name
        for name in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
        if not os.environ.get(name)
    ]
    if missing:
        raise ReleaseError(
            "missing credential(s): "
            + ", ".join(missing)
            + " — put them in the workspace .env (names in .env.example) or export them"
        )
    credentials = Credentials(
        access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )
    return credentials, os.environ["R2_ENDPOINT"], os.environ.get("R2_BUCKET", DEFAULT_BUCKET)


# -- planning ----------------------------------------------------------------
def sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


#: Written by the build for humans and for the next build, never published.
NOT_PUBLISHED = {"build-summary.json", "upload-report.json"}


def read_release(
    release: Path,
) -> tuple[dict, list[tuple[str, bytes, str]], dict]:
    """Load the manifest and every byte the release publishes, refusing disagreement.

    Day 4 published exactly the files ``manifest.files`` listed. A release now also
    carries the catalogue objects (``catalogue.py``) and the reverse X-Ray shards,
    which are too numerous to enumerate in the manifest — enumerating 5,179 company
    shards would put the inventory back on the wire. So the directory is the
    inventory and the manifest is the cross-check: every fund file it names must
    hash to what it says, and nothing in the directory may be a directory, a
    symlink, or a file the build did not write.
    """
    manifest_path = release / "manifest.json"
    if not manifest_path.is_file():
        raise ReleaseError(f"{release} has no manifest.json")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)

    if manifest.get("as_of") != release.name:
        raise ReleaseError(
            f"manifest as_of is {manifest.get('as_of')!r} but the directory is {release.name!r}; "
            "the published path is derived from as_of, so they must agree"
        )
    release_path = release / "release.json"
    if not release_path.is_file():
        raise ReleaseError(f"{release} has no release.json; rebuild the release")
    release_document = json.loads(release_path.read_bytes())
    if release_document.get("kind") != "release":
        raise ReleaseError(f"release.json kind is {release_document.get('kind')!r}, expected 'release'")

    digests: dict[str, tuple[bytes, str]] = {}
    for path in sorted(release.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(release).as_posix()
        if relative in NOT_PUBLISHED:
            continue
        body = path.read_bytes()
        digests[relative] = (body, sha256_hex(body))

    for entry in manifest.get("files") or []:
        relative = entry.get("path") or ""
        if relative not in digests:
            raise ReleaseError(f"{relative}: named by the manifest but absent from {release}")
        body, digest = digests[relative]
        if digest != entry.get("sha256"):
            raise ReleaseError(
                f"{relative}: local sha256 {digest[:12]}… does not match the manifest "
                f"({str(entry.get('sha256'))[:12]}…); rebuild the release"
            )
        if len(body) != entry.get("bytes"):
            raise ReleaseError(f"{relative}: {len(body)} bytes on disk, manifest says {entry.get('bytes')}")

    # The release descriptor must describe the bytes next to it, or the pointer
    # would publish a claim the release does not support.
    for name, descriptor in (release_document.get("objects") or {}).items():
        if not isinstance(descriptor, dict) or "path" not in descriptor:
            continue
        relative = descriptor["path"]
        if relative not in digests:
            raise ReleaseError(f"release.json objects.{name} names {relative}, which is not in the release")
        body, digest = digests[relative]
        if digest != descriptor.get("sha256") or len(body) != descriptor.get("bytes"):
            raise ReleaseError(
                f"release.json objects.{name}: {relative} does not match its descriptor; rebuild the release"
            )

    order = ["release.json", "manifest.json"]
    objects: list[tuple[str, bytes, str]] = [
        (relative, *digests[relative]) for relative in order if relative in digests
    ]
    objects.extend(
        (relative, body, digest)
        for relative, (body, digest) in digests.items()
        if relative not in order
    )
    return manifest, objects, release_document


def guard_prefixes(prefix: str, pointer_prefix: str, allow_live: bool) -> None:
    """Refuse anything that would touch what the live site reads, unless told twice."""
    for name, value in (("--prefix", prefix), ("--pointer-prefix", pointer_prefix)):
        if value.strip("/").split("/")[0] == "latest" and not allow_live:
            raise ReleaseError(
                f"{name} {value!r} is under the live pointer prefix; publishing there is a production "
                "action — re-run with --allow-live when that is the intent"
            )
    if not prefix.strip("/"):
        raise ReleaseError("--prefix must not be empty")


# -- the release itself ------------------------------------------------------
def upload_release(
    release: Path,
    *,
    client: R2Client,
    public: PublicReader,
    prefix: str,
    pointer_prefix: str,
    origin: str | None = DEFAULT_ORIGIN,
    dry_run: bool = False,
    verify: bool = True,
    allow_live: bool = False,
    report_dir: Path | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    progress_every: int = 500,
    pointer_name: str = DEFAULT_POINTER_NAME,
) -> UploadReport:
    manifest, objects, release_descriptor = read_release(release)
    guard_prefixes(prefix, pointer_prefix, allow_live)

    prefix = prefix.strip("/")
    # The pointer's *name* carries its schema. Day 4's pointer was
    # `latest/manifest.json` and held the 1.29 MB inventory; this one is
    # `latest/release.json` and holds the descriptor. Publishing under a new name
    # means the old bundle and the old pointer stay a working pair until the new
    # bundle is deployed, so the swap has no window where either is wrong.
    pointer_key = f"{pointer_prefix.strip('/')}/{pointer_name}"
    report = UploadReport(
        release=str(manifest["as_of"]),
        prefix=prefix,
        pointer_key=pointer_key,
        public_base=public.base_url,
        dry_run=dry_run,
        started_at=datetime.now(UTC).isoformat(timespec="seconds"),
    )

    # Objects first: every immutable artifact, then its manifest.
    #
    # Day 4 uploaded these one at a time and re-read each one from the public URL
    # before moving on: 8,533 objects took about an hour, which made publishing the
    # wide release an overnight job. Each object is independent, so they go through
    # a small pool; the pointer still waits for *every* object to verify.
    for relative, body, digest in objects:
        report.objects.append(
            UploadedObject(
                key=f"{prefix}/{relative}",
                size=len(body),
                sha256=digest,
                etag="",
                cache_control=IMMUTABLE,
            )
        )

    if not dry_run:
        _upload_objects(
            objects,
            report=report,
            client=client,
            public=public,
            prefix=prefix,
            origin=origin,
            verify=verify,
            concurrency=concurrency,
            progress_every=progress_every,
        )

    # Only now may the pointer move. A pointer written before the objects exist
    # would be a live 404 for every fund in the release. The pointer publishes
    # release.json — the small document that says where everything is — not the
    # 1.29 MB inventory the day-4 pointer carried.
    manifest_body = next(body for relative, body, _ in objects if relative == "release.json")
    pointer = UploadedObject(
        key=pointer_key,
        size=len(manifest_body),
        sha256=sha256_hex(manifest_body),
        etag="",
        cache_control=NO_CACHE,
    )
    report.pointer = pointer
    if not dry_run and not report.failures:
        pointer.etag = _retrying(lambda: client.put(pointer_key, manifest_body, cache_control=NO_CACHE), label=pointer_key)
        if verify:
            _retrying(
                lambda: _verify_public(pointer, public, origin, expected_cache=NO_CACHE), label=f"verify {pointer_key}"
            )
            _retrying(
                lambda: _verify_pointer_content(pointer, public, manifest, origin, release_descriptor),
                label=f"content {pointer_key}",
            )
    elif not dry_run:
        pointer.problem = "not written: the release objects did not verify"

    if not dry_run:
        _observe_live_pointer(report, public)

    report.finished_at = datetime.now(UTC).isoformat(timespec="seconds")
    if report_dir is not None and not dry_run:
        write_report(report, report_dir)
    return report



# -- promotion, which is not an upload ----------------------------------------
def _public_json(public: PublicReader, key: str, origin: str | None) -> tuple[dict, bytes]:
    """Fetch one published JSON object, or say which object blocked the promotion."""
    response = public.fetch(key, origin=origin)
    if response.status != 200:
        raise ReleaseError(f"{key} is not published (HTTP {response.status}); nothing to promote")
    try:
        return json.loads(response.body), response.body
    except json.JSONDecodeError as error:
        raise ReleaseError(f"{key} is not JSON ({error}); rebuild and republish the release") from error


def _pointer_document(public: PublicReader, pointer_key: str, origin: str | None) -> tuple[dict | None, int]:
    """Read a pointer the way the edge serves it: plain URL first, cache-buster second.

    A pointer written seconds ago can be answered with a cached 404 — measured at about
    three minutes per POP, see `_observe_live_pointer`. For a *read* that means the plain
    URL is not evidence on its own, so the second attempt asks for a fresh copy.
    """
    response = public.fetch(pointer_key, origin=origin)
    if response.status == 200:
        try:
            return json.loads(response.body), 200
        except json.JSONDecodeError:
            return None, 200
    busted = public.fetch(f"{pointer_key}?probe={int(time.time())}", origin=origin)
    if busted.status == 200:
        try:
            return json.loads(busted.body), 200
        except json.JSONDecodeError:
            return None, 200
    return None, response.status


def promote_release(
    release_id: str,
    *,
    client: R2Client | None,
    public: PublicReader,
    prefix: str | None = None,
    pointer_prefix: str = "latest",
    pointer_name: str = DEFAULT_POINTER_NAME,
    origin: str | None = DEFAULT_ORIGIN,
    allow_live: bool = False,
    allow_downgrade: bool = False,
    dry_run: bool = False,
    verify: bool = True,
) -> dict:
    """Move the live pointer onto a release that is already published and verified.

    A promotion is deliberately **not** an upload. The refresh job uploads and verifies
    every object under `staging/`; promotion re-reads what is already on the public host,
    proves the descriptor agrees with the manifest beside it, and then writes the one
    mutable object in the bucket. Re-uploading 14,239 objects (331 MB, ~26 minutes at the
    measured 9–10 objects/s) to change a 1.9 kB pointer would also re-open the possibility
    that the promotion publishes bytes nobody reviewed — the exact thing staging exists to
    prevent.

    The integrity check is two objects, not fourteen thousand: the release descriptor
    (`release.json`) claims a sha256 and size for `manifest.json`, and the manifest claims
    a sha256 for `release.json`. Fetching both and comparing both closes the loop without a
    local copy of the release, which is what lets the promotion run on a machine that never
    built the data.

    Downgrades are refused unless `--allow-downgrade` is given: a rollback is a promotion
    of an older release id, and it should be a decision recorded in the run, not something a
    stale workflow input can do by accident.
    """
    prefix = (prefix or f"releases/{release_id}").strip("/")
    guard_prefixes(prefix, pointer_prefix, allow_live)
    pointer_key = f"{pointer_prefix.strip('/')}/{pointer_name}"

    descriptor, descriptor_bytes = _public_json(public, f"{prefix}/release.json", origin)
    if descriptor.get("kind") != "release":
        raise ReleaseError(f"{prefix}/release.json kind is {descriptor.get('kind')!r}, expected 'release'")
    if descriptor.get("as_of") != release_id:
        raise ReleaseError(
            f"{prefix}/release.json describes {descriptor.get('as_of')!r}, not {release_id!r}; "
            "the published path and the descriptor disagree"
        )

    manifest, manifest_bytes = _public_json(public, f"{prefix}/manifest.json", origin)
    if manifest.get("as_of") != release_id:
        raise ReleaseError(f"{prefix}/manifest.json describes {manifest.get('as_of')!r}, not {release_id!r}")

    # Both directions of the claim: descriptor → manifest, and manifest → descriptor.
    claimed_manifest = ((descriptor.get("objects") or {}).get("manifest") or {})
    actual_manifest = sha256_hex(manifest_bytes)
    if claimed_manifest.get("sha256") != actual_manifest:
        raise ReleaseError(
            f"{prefix}/manifest.json hashes to {actual_manifest[:12]}… but its descriptor claims "
            f"{str(claimed_manifest.get('sha256'))[:12]}…; the release is not internally consistent"
        )
    if claimed_manifest.get("bytes") not in (None, len(manifest_bytes)):
        raise ReleaseError(
            f"{prefix}/manifest.json is {len(manifest_bytes)} bytes but its descriptor claims "
            f"{claimed_manifest.get('bytes')}; the release is not internally consistent"
        )
    claimed_self = next(
        (entry for entry in manifest.get("files") or [] if entry.get("path") == "release.json"), None
    )
    if claimed_self is not None and claimed_self.get("sha256") not in (None, sha256_hex(descriptor_bytes)):
        raise ReleaseError(
            f"{prefix}/release.json hashes to {sha256_hex(descriptor_bytes)[:12]}… but the manifest beside it "
            f"claims {str(claimed_self.get('sha256'))[:12]}…; the release is not internally consistent"
        )

    current, pointer_status = _pointer_document(public, pointer_key, origin)
    live_id = (current or {}).get("as_of")
    result = {
        "pointer_key": pointer_key,
        "from": live_id,
        "to": release_id,
        "prefix": prefix,
        "pointer_status_before": pointer_status,
        "dry_run": dry_run,
        "wrote_pointer": False,
        "verified": False,
        "action": "promote",
    }
    if live_id == release_id:
        result["action"] = "already-live"
        return result
    if live_id and release_id < live_id and not allow_downgrade:
        raise ReleaseError(
            f"the live pointer names {live_id!r} and {release_id!r} sorts before it; a rollback is a "
            "deliberate act — re-run with --allow-downgrade when that is the intent"
        )
    if dry_run:
        return result
    if client is None:
        raise ReleaseError("no R2 client: promotion needs credentials unless --dry-run")

    # The only mutable object in the bucket, written last: everything it names is already
    # published and just proved consistent.
    _retrying(lambda: client.put(pointer_key, descriptor_bytes, cache_control=NO_CACHE), label=pointer_key)
    result["wrote_pointer"] = True
    if verify:
        published, status = _pointer_document(public, pointer_key, origin)
        result["pointer_status_after"] = status
        if (published or {}).get("as_of") != release_id:
            raise ReleaseError(
                f"{pointer_key} was written but reads back as {(published or {}).get('as_of')!r} "
                f"(HTTP {status}); the edge may still be serving a cached 404 — re-check in ~3 minutes"
            )
        described = ((published or {}).get("objects") or {}).get("manifest") or {}
        if described.get("sha256") != actual_manifest:
            raise ReleaseError(f"{pointer_key} reads back describing manifest {described.get('sha256')}, expected {actual_manifest}")
        result["verified"] = True
    return result


#: Statuses worth a second attempt: a DNS or connection failure (0), throttling, and
#: the two gateway errors R2 returns while an object is still settling. A 403 or a 404
#: is never retried — those are answers, and repeating them only slows the failure down.
TRANSIENT_STATUSES = frozenset({0, 429, 500, 502, 503, 504})


def _retry_sleep(seconds: float) -> None:
    """Indirection so a test can assert the backoff without waiting for it."""
    time.sleep(seconds)


def _retrying(action, *, attempts: int = 4, label: str = "request", sleep=None):
    """Run ``action``, retrying transient transport failures with exponential backoff.

    A 13,482-object upload at 32 in flight makes about 27,000 public reads, so a resolver
    that misses once in ten thousand requests would otherwise abort the whole publish —
    which is exactly what happened on 2026-10-30 at object 9,600 (`nodename nor servname
    provided`). One transient failure is not evidence about the release, so it gets a
    retry; a persistent one still raises after `attempts`.
    """
    # Resolved here, not as a default argument: a default binds the function object at
    # import time, so a test could not observe or replace the backoff.
    sleep = sleep or _retry_sleep
    delay = 0.5
    for attempt in range(1, attempts + 1):
        try:
            return action()
        except (R2Error, TimeoutError, OSError) as error:
            status = getattr(error, "status", 0)
            if status not in TRANSIENT_STATUSES or attempt == attempts:
                raise
            print(f"  … retry {attempt}/{attempts - 1} {label}: {error}", flush=True)
            sleep(delay)
            delay *= 2
    raise AssertionError("unreachable")


def _upload_objects(
    objects: list[tuple[str, bytes, str]],
    *,
    report: UploadReport,
    client: R2Client,
    public: PublicReader,
    prefix: str,
    origin: str | None,
    verify: bool,
    concurrency: int,
    progress_every: int,
) -> None:
    """PUT and public read-back, ``concurrency`` objects at a time.

    Order is not a dependency here: an object is only reachable through the pointer
    and the pointer is written afterwards. What *is* a dependency is the report, so
    each worker writes into its own pre-built ``UploadedObject`` and the report keeps
    the release's order regardless of completion order.
    """
    workers = max(1, min(concurrency, 32))
    started = time.monotonic()
    done = 0

    def work(pair: tuple[tuple[str, bytes, str], UploadedObject]) -> None:
        (relative, body, _digest), item = pair
        item.etag = _retrying(lambda: client.put(item.key, body, cache_control=IMMUTABLE), label=item.key)
        if verify:
            _retrying(
                lambda: _verify_public(item, public, origin, expected_cache=IMMUTABLE),
                label=f"verify {item.key}",
            )

    pairs = list(zip(objects, report.objects))
    if workers == 1:
        for pair in pairs:
            work(pair)
            done += 1
            if progress_every and done % progress_every == 0:
                _log_progress(done, len(pairs), started, report)
        if progress_every and len(pairs) > progress_every:
            _log_progress(done, len(pairs), started, report)
        return

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work, pair) for pair in pairs]
        for index, future in enumerate(as_completed(futures), start=1):
            # Re-raised here rather than swallowed by the pool: an upload that
            # failed for one object must stop the pointer, and a bare `pass` would
            # leave `item.verified` False with no explanation in the report.
            future.result()
            if progress_every and index % progress_every == 0:
                _log_progress(index, len(pairs), started, report)
    if progress_every and len(pairs) > progress_every:
        _log_progress(len(pairs), len(pairs), started, report)


def _log_progress(done: int, total: int, started: float, report: UploadReport) -> None:
    elapsed = time.monotonic() - started
    rate = done / elapsed if elapsed else 0
    failures = len(report.failures)
    print(
        f"  … {done:,}/{total:,} objects, {rate:.0f}/s, {elapsed:.0f}s elapsed"
        + (f", {failures} failure(s)" if failures else ""),
        flush=True,
    )


def _verify_public(item: UploadedObject, public: PublicReader, origin: str | None, *, expected_cache: str) -> None:
    """Check the object as a browser sees it: status, bytes, cache header, CORS."""
    response = public.fetch(item.key, origin=origin)
    if response.status != 200:
        item.problem = f"public GET returned {response.status}"
        return
    digest = sha256_hex(response.body)
    if digest != item.sha256:
        item.problem = f"public sha256 {digest[:12]}… != manifest {item.sha256[:12]}…"
        return
    cache = response.header("cache-control") or ""
    if expected_cache not in cache:
        item.problem = f"cache-control {cache!r} does not contain {expected_cache!r}"
        return
    if origin:
        allowed = response.allow_origin
        if not allowed:
            item.problem = "no access-control-allow-origin header"
            return
        item.allow_origin = allowed
    item.verified = True


def _verify_pointer_content(
    pointer: UploadedObject,
    public: PublicReader,
    manifest: dict,
    origin: str | None,
    release_descriptor: dict | None = None,
) -> None:
    """The pointer must resolve to this release, byte for byte."""
    try:
        published = public.fetch_json(pointer.key, origin=origin)
    except R2Error as error:
        pointer.problem = f"pointer is not readable: {error}"
        return
    if published.get("as_of") != manifest.get("as_of"):
        pointer.problem = f"pointer as_of {published.get('as_of')!r} != release {manifest.get('as_of')!r}"
        return
    if published.get("kind") != "release":
        pointer.problem = f"pointer kind is {published.get('kind')!r}, expected 'release'"
        return
    described = (published.get("objects") or {}).get("manifest") or {}
    expected = ((release_descriptor or {}).get("objects") or {}).get("manifest") or {}
    if described != expected:
        pointer.problem = (
            f"pointer describes manifest {described.get('sha256', '?')[:12]}… "
            f"but the release publishes {expected.get('sha256', '?')[:12]}…"
        )


def _observe_live_pointer(report: UploadReport, public: PublicReader) -> None:
    """Record what the live pointer says, without touching it.

    A pointer written seconds ago can still be answered with a cached 404 by an edge
    that looked the key up before it existed. Measured 2026-10-30: Cloudflare holds a
    404 for a data-host key for about **three minutes** per POP, and retrying for a
    second and a half only samples the same cache entry — the first live promotion
    reported "absent (HTTP 404)" for a pointer that was already serving.

    So the plain URL is reported as-is (it is what a browser gets), and the pointer is
    read a second time through a cache-busting query, which is what makes the report
    describe the pointer rather than the edge. `live_pointer_release` comes from
    whichever answered.
    """
    response = public.fetch(LIVE_POINTER)
    report.live_pointer_status = response.status
    body = response.body if response.status == 200 else None
    if body is None and not report.dry_run:
        busted = public.fetch(f"{LIVE_POINTER}?probe={int(time.time())}")
        if busted.status == 200:
            report.live_pointer_edge = f"plain URL answered {response.status}; cache-busted URL answered 200"
            body = busted.body
    if body is not None:
        try:
            report.live_pointer_release = json.loads(body).get("as_of")
        except json.JSONDecodeError:
            report.live_pointer_release = "<unparseable>"


def write_report(report: UploadReport, report_dir: Path) -> Path:
    report_dir.mkdir(parents=True, exist_ok=True)
    target = report_dir / "upload-report.json"
    payload = asdict(report)
    payload["total_bytes"] = report.total_bytes
    payload["failures"] = report.failures
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return target


# -- CLI ---------------------------------------------------------------------
def _print_report(report: UploadReport) -> None:
    # A 13,750-object release cannot print one line per object and still be read.
    # Under 40 objects the per-object list is the report; above that it is a summary
    # plus every failure, because a failure is the only line that needs acting on.
    if len(report.objects) > 40:
        groups: dict[str, list[UploadedObject]] = {}
        for item in report.objects:
            relative = item.key.split("/", 2)[-1]
            group = relative.split("/")[0] if "/" in relative else "root"
            groups.setdefault(group, []).append(item)
        for group in sorted(groups):
            items = groups[group]
            bad = [item for item in items if not item.verified and not report.dry_run]
            state = "dry-run" if report.dry_run else ("ok" if not bad else f"FAIL {len(bad)}")
            print(
                f"  {group + '/':<24} {len(items):>6,} object(s)  "
                f"{sum(item.size for item in items):>12,} B  {state}"
            )
        for item in report.objects:
            if not item.verified and not report.dry_run:
                print(f"  FAIL {item.key}  {item.problem}")
    else:
        for item in report.objects:
            state = "dry-run" if report.dry_run else ("ok" if item.verified else f"FAIL {item.problem}")
            print(f"  {item.key:<52} {item.size:>9,} B  {item.cache_control:<32} {state}")
    if report.pointer:
        item = report.pointer
        if report.dry_run:
            state = "dry-run"
        elif item.problem:
            state = f"FAIL {item.problem}"
        elif not item.verified:
            # `--skip-verify`: uploaded, never read back. Saying "ok" would claim a
            # check that did not run, and "FAIL None" claims one that did.
            state = "uploaded (unverified)"
        else:
            state = "ok"
        print(f"  {item.key:<52} {item.size:>9,} B  {item.cache_control:<32} {state}")
    if report.live_pointer_status is not None:
        if report.live_pointer_status == 200:
            print(f"  live pointer: {LIVE_POINTER} serves {report.live_pointer_release}")
        elif report.live_pointer_edge:
            # The pointer was just written; the edge is serving a cached 404 for it.
            print(f"  live pointer: {LIVE_POINTER} serves {report.live_pointer_release} ({report.live_pointer_edge})")
        else:
            print(f"  live pointer: {LIVE_POINTER} absent (HTTP {report.live_pointer_status})")
    print(
        f"\n{report.release}: {len(report.objects)} release object(s) + pointer, "
        f"{report.total_bytes:,} B, {len(report.failures)} failure(s)"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.release", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    upload = sub.add_parser("upload", help="upload a built release and verify it publicly")
    upload.add_argument("--release", required=True, help="release id under artifacts/releases/ or a directory")
    upload.add_argument("--prefix", default=None, help="object prefix (default releases/<as_of>)")
    upload.add_argument("--pointer-prefix", default=DEFAULT_POINTER_PREFIX, help="pointer prefix (non-live by default)")
    upload.add_argument("--public-base", default=DEFAULT_PUBLIC_BASE)
    upload.add_argument("--origin", default=DEFAULT_ORIGIN, help="Origin header for the CORS check; '' to skip")
    upload.add_argument("--env-file", type=Path, default=None)
    upload.add_argument("--allow-live", action="store_true", help="permit writing under latest/ (production)")
    upload.add_argument(
        "--pointer-name",
        default=DEFAULT_POINTER_NAME,
        help="pointer object name under --pointer-prefix (default release.json)",
    )
    upload.add_argument("--dry-run", action="store_true")
    upload.add_argument("--skip-verify", action="store_true", help="upload without the public read-back")
    upload.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help=f"objects in flight (default {DEFAULT_CONCURRENCY})",
    )

    verify = sub.add_parser("verify", help="re-check an already-published prefix")
    verify.add_argument("--release", required=True)
    verify.add_argument("--prefix", default=None)
    verify.add_argument("--public-base", default=DEFAULT_PUBLIC_BASE)
    verify.add_argument("--origin", default=DEFAULT_ORIGIN)
    verify.add_argument("--env-file", type=Path, default=None)
    verify.add_argument("--verbose", action="store_true", help="print every object, not just failures")


    promote = sub.add_parser("promote", help="move the live pointer onto an already-published release")
    promote.add_argument("--release", required=True, help="release id already published, e.g. 2026-10-31.1")
    promote.add_argument("--prefix", default=None, help="object prefix (default releases/<release>)")
    promote.add_argument("--pointer-prefix", default="latest", help="pointer prefix (default latest)")
    promote.add_argument("--pointer-name", default=DEFAULT_POINTER_NAME)
    promote.add_argument("--public-base", default=DEFAULT_PUBLIC_BASE)
    promote.add_argument("--origin", default=DEFAULT_ORIGIN, help="Origin header for the CORS check; '' to skip")
    promote.add_argument("--env-file", type=Path, default=None)
    promote.add_argument(
        "--allow-live",
        action="store_true",
        help="required: a promotion writes the pointer the live site reads",
    )
    promote.add_argument(
        "--allow-downgrade",
        action="store_true",
        help="permit moving the pointer back to an older release id (rollback)",
    )
    promote.add_argument("--dry-run", action="store_true", help="prove the release is promotable, write nothing")
    promote.add_argument("--skip-verify", action="store_true", help="write the pointer without the public read-back")

    args = parser.parse_args(argv)
    try:
        loaded = load_env(args.env_file)

        if args.command == "promote":
            public = PublicReader(args.public_base)
            client = None
            if not args.dry_run:
                credentials, endpoint, bucket = credentials_from_env()
                client = R2Client(endpoint, bucket, credentials)
            promotion = promote_release(
                args.release,
                client=client,
                public=public,
                prefix=args.prefix,
                pointer_prefix=args.pointer_prefix,
                pointer_name=args.pointer_name,
                origin=args.origin or None,
                allow_live=args.allow_live,
                allow_downgrade=args.allow_downgrade,
                dry_run=args.dry_run,
                verify=not args.skip_verify,
            )
            if loaded:
                print(f"  credentials from .env: {', '.join(loaded)}")
            arrow = f"{promotion['from'] or '(empty)'} -> {promotion['to']}"
            print(f"\nrelease {promotion['to']}  {arrow}  under {promotion['pointer_key']}")
            if promotion["action"] == "already-live":
                print("  the pointer already names this release; nothing written")
                return 0
            if promotion["dry_run"]:
                print("  dry run: the release is consistent and promotable; the pointer was not written")
                return 0
            state = "verified public read-back" if promotion["verified"] else "written, read-back skipped"
            print(f"  pointer moved: {state}")
            return 0

        release = paths.release_dir(args.release)
        if release is None or not release.is_dir():
            raise ReleaseError(f"{args.release} does not exist under artifacts/releases/")
        manifest, _, _ = read_release(release)
        prefix = args.prefix or f"releases/{manifest['as_of']}"

        if args.command == "verify":
            public = PublicReader(args.public_base)
            _, objects, _ = read_release(release)
            failures = 0
            for relative, _body, digest in objects:
                key = f"{prefix.strip('/')}/{relative}"
                response = public.fetch(key, origin=args.origin or None)
                published_digest = sha256_hex(response.body)
                ok = response.status == 200 and published_digest == digest
                if not ok or args.verbose:
                    print(f"  {'ok  ' if ok else 'FAIL'} {key}  HTTP {response.status}  {published_digest[:12]}…")
                failures += 0 if ok else 1
            print(f"\n{len(objects) - failures}/{len(objects)} object(s) verified under {prefix}")
            return 1 if failures else 0

        credentials, endpoint, bucket = credentials_from_env()
        client = R2Client(endpoint, bucket, credentials)
        public = PublicReader(args.public_base)
        report = upload_release(
            release,
            client=client,
            public=public,
            prefix=prefix,
            pointer_prefix=args.pointer_prefix,
            origin=args.origin or None,
            dry_run=args.dry_run,
            verify=not args.skip_verify,
            allow_live=args.allow_live,
            report_dir=release,
            concurrency=args.concurrency,
        )
        if loaded:
            print(f"  credentials from .env: {', '.join(loaded)}")
        _print_report(report)
        return 1 if report.failures else 0
    except ReleaseError as error:
        print(f"FAIL: {error}")
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
