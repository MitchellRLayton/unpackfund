"""Copy the live release's page inputs onto disk so its pages can be generated.

`pipeline.fund_pages` needs a release *directory*: `catalogue.json` beside `funds/*.json`,
and — since the pages colour companies by domicile — `companies/countries.json` beside
those. `refresh.yml` has such a directory because it just built the release. A code
deploy has no such directory and no reason to earn one — rebuilding twenty-six minutes of
EDGAR data to publish a button is the wrong cost, and reusing the previous `site` artefact
is worse, because the pages it holds belong to whichever release was live when *that*
build ran.

So this reads what the ledger reads: the pointer, the catalogue it names, one document
per fund, and the release-wide objects the page generator declares. Nothing is recomputed
and nothing is interpreted beyond "is this the object the pointer describes". The
catalogue is written byte-for-byte and checked against the sha256 the pointer publishes;
so is every declared object the pointer names a hash for; a required object that is
absent or unparseable fails the run instead of producing a page that says less than the
ledger does.

**What is copied is not a list here.** `fund_pages.RELEASE_INPUTS` names every object a
page is built from, and this module copies the release-wide entries from that tuple. That
is deliberate: the country map was read by the generator for weeks while this module,
which had its own hard-coded idea of the release, never fetched it, so every page in
production would have printed "Not traced" for the market split. A second list is a way
to be right on the day it is written and wrong later; a shared one is not.

Why the public host rather than R2: this runs from a runner that has no object-store
credentials, and the bytes a browser gets are exactly the bytes the site should be built
from. It is a GET-only consumer, which is what `data.unpackfund.com` exists for.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .artifact import sha256_hex
from .fund_pages import (
    CATALOGUE_FILE,
    FUNDS_FILE,
    RELEASE_INPUTS,
    ReleaseInput,
    missing_release_inputs,
)
from .r2 import PublicReader, R2Error

#: Where the browser reads the pointer. Production uses the live one; a mirror of a
#: staging release passes `--pointer staging/latest/release.json`.
DEFAULT_BASE = "https://data.unpackfund.com"
POINTER_KEY = "latest/release.json"

#: Concurrent GETs. The data host is a CDN in front of R2 and the objects are immutable,
#: so this is throughput, not risk; the 4-try retry in `PublicReader` covers a blip at
#: this count. 16 keeps a 9,000-document copy to a couple of minutes on a runner.
DEFAULT_WORKERS = 16

#: The generator's own guard: a ticker that cannot be a path segment is skipped there,
#: so mirroring it would download a file no page will ever read.
SAFE_TICKER = re.compile(r"^[A-Z0-9.\-]{1,12}$")

#: The release-wide objects a page is built from: every declared input that is neither
#: the catalogue (copied first, because it names the funds) nor one document per fund
#: (copied by the pool below). Derived, never typed out, so an input added to
#: `RELEASE_INPUTS` is copied on the next run without an edit here.
RELEASE_WIDE_INPUTS: tuple[ReleaseInput, ...] = tuple(
    item
    for item in RELEASE_INPUTS
    if "{ticker}" not in item.path and item.path != CATALOGUE_FILE
)


class MirrorError(RuntimeError):
    """The public host did not hold what the live pointer says it holds."""


@dataclass(frozen=True)
class MirrorReport:
    release: str
    catalogue_sha256: str
    funds: int
    documents: int
    bytes: int
    fetched: int
    reused: int
    #: Release-wide objects copied, by release-relative path, with their size in bytes.
    objects: dict[str, int] = field(default_factory=dict)
    #: Companies the release places, when it publishes a country map; 0 when it does not.
    countries: int = 0
    missing: list[str] = field(default_factory=list)

    def summary(self) -> str:
        megabytes = self.bytes / 1_000_000
        geography = (
            f"{self.countries:,} companies placed"
            if self.countries
            else "no country map — the market section will say so"
        )
        copied = f", {len(self.objects):,} release-wide object(s)" if self.objects else ""
        return (
            f"release {self.release}: {self.documents:,} of {self.funds:,} fund documents "
            f"({megabytes:.0f} MB; {self.fetched:,} fetched, {self.reused:,} reused){copied}, "
            f"{geography}, catalogue sha256 {self.catalogue_sha256[:16]}…"
        )


def _pointer(public: PublicReader, pointer_key: str, cache_bust: str | None) -> tuple[str, dict]:
    """The release the site is serving, and the pointer document that names it."""
    try:
        document = public.fetch_json(pointer_key, cache_bust=cache_bust)
    except R2Error as error:
        raise MirrorError(f"{pointer_key}: {error}") from error
    release = document.get("as_of")
    if not isinstance(release, str) or not release:
        raise MirrorError(f"{pointer_key}: no as_of, so there is no release to mirror")
    return release, document


def _published_sha256(pointee: dict, item: ReleaseInput) -> str | None:
    """The hash the pointer publishes for one declared object, when it publishes one."""
    if item.pointer is None:
        return None
    node: object = pointee.get("objects")
    for key in item.pointer:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    digest = node.get("sha256") if isinstance(node, dict) else None
    return digest if isinstance(digest, str) and digest else None


def _catalogue(
    public: PublicReader, release: str, pointee: dict, *, verify: bool, cache_bust: str | None
) -> tuple[dict, bytes, str]:
    key = f"releases/{release}/{CATALOGUE_FILE}"
    try:
        response = public.fetch(key, cache_bust=cache_bust)
    except R2Error as error:
        raise MirrorError(f"{key}: {error}") from error
    if response.status != 200:
        raise MirrorError(f"{key}: HTTP {response.status}")
    digest = sha256_hex(response.body)
    published = ((pointee.get("objects") or {}).get("catalogue") or {}).get("sha256")
    if verify and isinstance(published, str) and published and published != digest:
        # A catalogue that does not hash to what the pointer published means the release
        # prefix and the pointer disagree. Building pages from it would put a mixture of
        # two releases on one site, which is the one outcome this module exists to avoid.
        raise MirrorError(
            f"{key}: sha256 {digest[:16]}… does not match the pointer's {published[:16]}…"
        )
    try:
        document = json.loads(response.body)
    except json.JSONDecodeError as error:
        raise MirrorError(f"{key}: not JSON ({error})") from error
    funds = document.get("funds")
    if not isinstance(funds, dict) or not funds:
        raise MirrorError(f"{key}: no funds, so there are no pages to build")
    return document, response.body, digest


def _release_wide(
    public: PublicReader,
    release: str,
    pointee: dict,
    *,
    verify: bool,
    cache_bust: str | None,
) -> dict[str, bytes]:
    """Fetch the declared release-wide objects, skipping an optional one a release lacks.

    `companies/countries.json` is optional because a release publishes it only when it
    placed at least one company. An older release without it is still a complete page
    input set — the page says "Not traced" for the market split rather than colouring a
    guess — but any other non-200 is a failure, and a 404 on a *required* object is one
    too, because a page cannot be built from an object that does not exist.
    """
    copied: dict[str, bytes] = {}
    for item in RELEASE_WIDE_INPUTS:
        key = f"releases/{release}/{item.path}"
        try:
            response = public.fetch(key, cache_bust=cache_bust)
        except R2Error as error:
            raise MirrorError(f"{key}: {error}") from error
        if response.status == 404 and not item.required:
            # `item.what` is what the page loses; say so in the run, not only in the page.
            print(f"mirror: {item.path} is not published by this release ({item.what})", file=sys.stderr)
            continue
        if response.status != 200:
            raise MirrorError(f"{key}: HTTP {response.status}")
        try:
            json.loads(response.body)
        except json.JSONDecodeError as error:
            # A truncated copy would look like a release that resolved fewer companies.
            raise MirrorError(f"{key}: not JSON ({error})") from error
        published = _published_sha256(pointee, item)
        if verify and published is not None:
            digest = sha256_hex(response.body)
            if digest != published:
                raise MirrorError(
                    f"{key}: sha256 {digest[:16]}… does not match the pointer's {published[:16]}…"
                )
        copied[item.path] = response.body
    return copied


def _document(public: PublicReader, release: str, ticker: str, *, cache_bust: str | None) -> bytes:
    key = f"releases/{release}/{FUNDS_FILE.format(ticker=ticker)}"
    try:
        response = public.fetch(key, cache_bust=cache_bust)
    except R2Error as error:
        raise MirrorError(f"{key}: {error}") from error
    if response.status != 200:
        raise MirrorError(f"{key}: HTTP {response.status}")
    try:
        document = json.loads(response.body)
    except json.JSONDecodeError as error:
        raise MirrorError(f"{key}: not JSON ({error})") from error
    # The document names its own fund. A page built from a document for another ticker
    # would look right and be about a different fund, so the mismatch is fatal, not a note.
    if document.get("ticker") != ticker:
        raise MirrorError(f"{key}: document is for {document.get('ticker')!r}, not {ticker!r}")
    return response.body


def _country_count(body: bytes | None) -> int:
    """How many companies the release placed, for the run's own log line."""
    if body is None:
        return 0
    document = json.loads(body)
    companies = document.get("companies") if isinstance(document, dict) else None
    return len(companies) if isinstance(companies, dict) else 0


def mirror(
    *,
    out: Path,
    base_url: str = DEFAULT_BASE,
    pointer_key: str = POINTER_KEY,
    release: str | None = None,
    workers: int = DEFAULT_WORKERS,
    limit: int | None = None,
    reader: PublicReader | None = None,
    cache_bust: str | None = None,
) -> MirrorReport:
    """Write the release directory `pipeline.fund_pages` reads for one release.

    `release` overrides the pointer — for reproducing an older release, never for a
    deploy. Documents already on disk are reused rather than re-fetched (a CI cache
    restore), but they are re-parsed, so a truncated file is caught instead of reused.
    """
    public = reader or PublicReader(base_url)
    if release is None:
        release, pointee = _pointer(public, pointer_key, cache_bust)
    else:
        # An explicit release still gets the pointer, because the catalogue hash lives in
        # it — but the pointer naming a different release is not an error here: the caller
        # asked for this one by name.
        try:
            _, pointee = _pointer(public, pointer_key, cache_bust)
        except MirrorError:
            pointee = {}

    # The pointer's hashes describe the release it names, so an explicitly requested
    # release is copied without those checks: the operator asked for these bytes by name.
    verify = pointee.get("as_of") == release
    document, raw_catalogue, digest = _catalogue(
        public, release, pointee, verify=verify, cache_bust=cache_bust
    )
    wide = _release_wide(
        public, release, pointee, verify=verify, cache_bust=cache_bust
    )
    tickers = [ticker for ticker in document["funds"] if SAFE_TICKER.match(ticker)]
    if limit is not None:
        tickers = tickers[:limit]

    out.mkdir(parents=True, exist_ok=True)
    (out / CATALOGUE_FILE).write_bytes(raw_catalogue)
    for relative, body in wide.items():
        target = out / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    funds_dir = out / "funds"
    funds_dir.mkdir(exist_ok=True)

    reused = 0
    pending: list[str] = []
    for ticker in tickers:
        path = funds_dir / f"{ticker}.json"
        if not path.is_file():
            pending.append(ticker)
            continue
        try:
            existing = json.loads(path.read_bytes())
        except (json.JSONDecodeError, OSError):
            pending.append(ticker)
            continue
        if existing.get("ticker") != ticker:
            pending.append(ticker)
            continue
        reused += 1

    total_bytes = 0

    def fetch(ticker: str) -> bytes:
        return _document(public, release, ticker, cache_bust=cache_bust)

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        # `pool.map` yields in order, so the files are written in ticker order: a copied
        # release directory hashes the same on two machines.
        for ticker, body in zip(pending, pool.map(fetch, pending)):
            (funds_dir / f"{ticker}.json").write_bytes(body)
            total_bytes += len(body)

    # The contract, checked against the directory that was actually written rather than
    # against the loop's intentions: `missing_release_inputs` expands `RELEASE_INPUTS`,
    # so a required object nobody copied is caught here even if no code path noticed it.
    gaps = missing_release_inputs(out, tickers)
    if gaps["required"]:
        shown = ", ".join(gaps["required"][:8])
        if len(gaps["required"]) > 8:
            shown += f" (+{len(gaps['required']) - 8} more)"
        raise MirrorError(
            f"{len(gaps['required']):,} required page input(s) are missing from {out}: {shown}"
        )

    return MirrorReport(
        release=release,
        catalogue_sha256=digest,
        funds=len(document["funds"]),
        documents=len(tickers),
        bytes=total_bytes,
        fetched=len(pending),
        reused=reused,
        objects={relative: len(body) for relative, body in wide.items()},
        countries=_country_count(wide.get("companies/countries.json")),
        missing=gaps["optional"],
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.mirror",
        description="Copy the release objects the fund-page generator reads.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="directory to write: catalogue.json, funds/<TICKER>.json, and the "
        "generator's other declared inputs (companies/countries.json)",
    )
    parser.add_argument("--base", default=DEFAULT_BASE, help=f"data host (default {DEFAULT_BASE})")
    parser.add_argument("--pointer", default=POINTER_KEY, help=f"pointer key (default {POINTER_KEY})")
    parser.add_argument(
        "--release",
        default=None,
        help="mirror this release id instead of the one the pointer names",
    )
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--limit", type=int, default=None, help="first N tickers, for a dry run")
    parser.add_argument("--cache-bust", default=None, help="query value that bypasses the edge")
    args = parser.parse_args(argv)

    try:
        report = mirror(
            out=args.out,
            base_url=args.base,
            pointer_key=args.pointer,
            release=args.release,
            workers=args.workers,
            limit=args.limit,
            cache_bust=args.cache_bust or str(int(time.time())),
        )
    except MirrorError as error:
        print(f"mirror: {error}", file=sys.stderr)
        return 1
    print(f"mirror: {report.summary()}")
    print(f"mirror: wrote {args.out / CATALOGUE_FILE}, {args.out / 'funds'}", end="")
    for relative in RELEASE_WIDE_INPUTS:
        path = args.out / relative.path
        if path.exists():
            print(f", {path}", end="")
    print()
    return 0


if __name__ == "__main__":  # pragma: no cover - the CLI is exercised through main()
    raise SystemExit(main())
