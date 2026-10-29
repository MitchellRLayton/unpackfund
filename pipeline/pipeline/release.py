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
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from . import paths
from .r2 import IMMUTABLE, NO_CACHE, Credentials, PublicReader, R2Client, R2Error
from .sigv4 import EMPTY_PAYLOAD_SHA256  # noqa: F401  (re-exported for tests that stub signing)

LIVE_POINTER = "latest/manifest.json"
DEFAULT_POINTER_PREFIX = "staging/latest"
DEFAULT_PUBLIC_BASE = "https://data.unpackfund.com"
DEFAULT_ORIGIN = "http://localhost:3000"
DEFAULT_BUCKET = "unpackfund-artifacts"


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


def read_release(release: Path) -> tuple[dict, list[tuple[str, bytes, str]]]:
    """Load the manifest and the exact bytes it describes, refusing any disagreement."""
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

    objects: list[tuple[str, bytes, str]] = [("manifest.json", manifest_bytes, sha256_hex(manifest_bytes))]
    for entry in manifest.get("files") or []:
        relative = entry.get("path") or ""
        body = (release / relative).read_bytes()
        digest = sha256_hex(body)
        if digest != entry.get("sha256"):
            raise ReleaseError(
                f"{relative}: local sha256 {digest[:12]}… does not match the manifest "
                f"({str(entry.get('sha256'))[:12]}…); rebuild the release"
            )
        if len(body) != entry.get("bytes"):
            raise ReleaseError(f"{relative}: {len(body)} bytes on disk, manifest says {entry.get('bytes')}")
        objects.append((relative, body, digest))
    return manifest, objects


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
) -> UploadReport:
    manifest, objects = read_release(release)
    guard_prefixes(prefix, pointer_prefix, allow_live)

    prefix = prefix.strip("/")
    pointer_key = f"{pointer_prefix.strip('/')}/manifest.json"
    report = UploadReport(
        release=str(manifest["as_of"]),
        prefix=prefix,
        pointer_key=pointer_key,
        public_base=public.base_url,
        dry_run=dry_run,
        started_at=datetime.now(UTC).isoformat(timespec="seconds"),
    )

    # Objects first: every immutable artifact, then its manifest.
    for relative, body, digest in objects:
        key = f"{prefix}/{relative}"
        item = UploadedObject(key=key, size=len(body), sha256=digest, etag="", cache_control=IMMUTABLE)
        report.objects.append(item)
        if dry_run:
            continue
        item.etag = client.put(key, body, cache_control=IMMUTABLE)
        if verify:
            _verify_public(item, public, origin, expected_cache=IMMUTABLE)

    # Only now may the pointer move. A pointer written before the objects exist
    # would be a live 404 for every fund in the release.
    manifest_body = next(body for relative, body, _ in objects if relative == "manifest.json")
    pointer = UploadedObject(
        key=pointer_key,
        size=len(manifest_body),
        sha256=sha256_hex(manifest_body),
        etag="",
        cache_control=NO_CACHE,
    )
    report.pointer = pointer
    if not dry_run and not report.failures:
        pointer.etag = client.put(pointer_key, manifest_body, cache_control=NO_CACHE)
        if verify:
            _verify_public(pointer, public, origin, expected_cache=NO_CACHE)
            _verify_pointer_content(pointer, public, manifest, origin)
    elif not dry_run:
        pointer.problem = "not written: the release objects did not verify"

    if not dry_run:
        _observe_live_pointer(report, public)

    report.finished_at = datetime.now(UTC).isoformat(timespec="seconds")
    if report_dir is not None and not dry_run:
        write_report(report, report_dir)
    return report


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
    pointer: UploadedObject, public: PublicReader, manifest: dict, origin: str | None
) -> None:
    """The pointer must resolve to this release, byte for byte."""
    try:
        published = public.fetch_json(pointer.key, origin=origin)
    except R2Error as error:
        pointer.problem = f"pointer is not readable: {error}"
        return
    if published.get("as_of") != manifest.get("as_of"):
        pointer.problem = f"pointer as_of {published.get('as_of')!r} != release {manifest.get('as_of')!r}"


def _observe_live_pointer(report: UploadReport, public: PublicReader) -> None:
    """Record what the live pointer says, without touching it.

    A pointer written seconds ago can still be answered with the *previous* 404 by
    an edge holding the negative lookup, which is exactly what this run did on its
    first live promotion: the report said "absent (HTTP 404)" while the pointer was
    already serving the new manifest. Three tries over 1.5 s makes the observation
    describe the pointer instead of the edge's cache.
    """
    response = public.fetch(LIVE_POINTER)
    for _ in range(2):
        if response.status == 200 or report.dry_run:
            break
        time.sleep(0.5)
        response = public.fetch(LIVE_POINTER)
    report.live_pointer_status = response.status
    if response.status == 200:
        try:
            report.live_pointer_release = json.loads(response.body).get("as_of")
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
    for item in report.objects:
        state = "dry-run" if report.dry_run else ("ok" if item.verified else f"FAIL {item.problem}")
        print(f"  {item.key:<52} {item.size:>9,} B  {item.cache_control:<32} {state}")
    if report.pointer:
        item = report.pointer
        state = "dry-run" if report.dry_run else ("ok" if item.verified and not item.problem else f"FAIL {item.problem}")
        print(f"  {item.key:<52} {item.size:>9,} B  {item.cache_control:<32} {state}")
    if report.live_pointer_status is not None:
        if report.live_pointer_status == 200:
            print(f"  live pointer untouched: {LIVE_POINTER} still points at {report.live_pointer_release}")
        else:
            print(f"  live pointer untouched: {LIVE_POINTER} absent (HTTP {report.live_pointer_status})")
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
    upload.add_argument("--dry-run", action="store_true")
    upload.add_argument("--skip-verify", action="store_true", help="upload without the public read-back")

    verify = sub.add_parser("verify", help="re-check an already-published prefix")
    verify.add_argument("--release", required=True)
    verify.add_argument("--prefix", default=None)
    verify.add_argument("--public-base", default=DEFAULT_PUBLIC_BASE)
    verify.add_argument("--origin", default=DEFAULT_ORIGIN)
    verify.add_argument("--env-file", type=Path, default=None)

    args = parser.parse_args(argv)
    try:
        loaded = load_env(args.env_file)
        release = paths.release_dir(args.release)
        if release is None or not release.is_dir():
            raise ReleaseError(f"{args.release} does not exist under artifacts/releases/")
        manifest, _ = read_release(release)
        prefix = args.prefix or f"releases/{manifest['as_of']}"

        if args.command == "verify":
            public = PublicReader(args.public_base)
            failures = 0
            for entry in manifest.get("files") or []:
                key = f"{prefix.strip('/')}/{entry['path']}"
                response = public.fetch(key, origin=args.origin or None)
                digest = sha256_hex(response.body)
                ok = response.status == 200 and digest == entry.get("sha256")
                print(f"  {'ok  ' if ok else 'FAIL'} {key}  HTTP {response.status}  {digest[:12]}…")
                failures += 0 if ok else 1
            print(f"\n{len(manifest.get('files') or []) - failures}/{len(manifest.get('files') or [])} verified")
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
