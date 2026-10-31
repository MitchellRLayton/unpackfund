"""Copy the live release's fund documents onto disk so its pages can be generated.

`pipeline.fund_pages` needs a release *directory*: `catalogue.json` beside `funds/*.json`.
`refresh.yml` has one because it just built the release. A code deploy has no such
directory and no reason to earn one — rebuilding twenty-six minutes of EDGAR data to
publish a button is the wrong cost, and reusing the previous `site` artefact is worse,
because the pages it holds belong to whichever release was live when *that* build ran.

So this reads what the ledger reads: the pointer, the catalogue it names, and one
document per fund. Nothing is recomputed and nothing is interpreted beyond "is this a
document for this ticker". The catalogue is written byte-for-byte and checked against
the sha256 the pointer publishes; a fund document that is absent or unparseable fails
the run instead of producing a page that says less than the ledger does.

Why the public host rather than R2: this runs from a runner that has no object-store
credentials, and the bytes a browser gets are exactly the bytes the site should be
built from. It is a GET-only consumer, which is what `data.unpackfund.com` exists for.
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
    missing: list[str] = field(default_factory=list)

    def summary(self) -> str:
        megabytes = self.bytes / 1_000_000
        return (
            f"release {self.release}: {self.documents:,} of {self.funds:,} fund documents "
            f"({megabytes:.0f} MB; {self.fetched:,} fetched, {self.reused:,} reused), "
            f"catalogue sha256 {self.catalogue_sha256[:16]}…"
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


def _catalogue(
    public: PublicReader, release: str, pointee: dict, *, verify: bool
) -> tuple[dict, bytes, str]:
    key = f"releases/{release}/catalogue.json"
    try:
        response = public.fetch(key)
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


def _document(public: PublicReader, release: str, ticker: str) -> bytes:
    key = f"releases/{release}/funds/{ticker}.json"
    try:
        response = public.fetch(key)
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
    """Write `out/catalogue.json` and `out/funds/*.json` for one release.

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

    # The pointer's hash describes the release it names, so an explicitly requested
    # release is copied without that check: the operator asked for these bytes by name.
    document, raw_catalogue, digest = _catalogue(
        public, release, pointee, verify=pointee.get("as_of") == release
    )
    tickers = [ticker for ticker in document["funds"] if SAFE_TICKER.match(ticker)]
    if limit is not None:
        tickers = tickers[:limit]

    out.mkdir(parents=True, exist_ok=True)
    (out / "catalogue.json").write_bytes(raw_catalogue)
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
        return _document(public, release, ticker)

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        # `pool.map` yields in order, so the files are written in ticker order: a copied
        # release directory hashes the same on two machines.
        for ticker, body in zip(pending, pool.map(fetch, pending)):
            (funds_dir / f"{ticker}.json").write_bytes(body)
            total_bytes += len(body)

    on_disk = {path.stem for path in funds_dir.glob("*.json")}
    missing = sorted(ticker for ticker in tickers if ticker not in on_disk)
    if missing:
        shown = ", ".join(missing[:8]) + (f" (+{len(missing) - 8} more)" if len(missing) > 8 else "")
        raise MirrorError(
            f"{len(missing)} of {len(tickers):,} fund documents are missing from {funds_dir}: {shown}"
        )

    return MirrorReport(
        release=release,
        catalogue_sha256=digest,
        funds=len(document["funds"]),
        documents=len(tickers),
        bytes=total_bytes,
        fetched=len(pending),
        reused=reused,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.mirror",
        description="Copy the live release's catalogue and fund documents for page generation.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="directory to write: catalogue.json and funds/<TICKER>.json",
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
    print(f"mirror: wrote {args.out / 'catalogue.json'} and {args.out / 'funds'}")
    return 0


if __name__ == "__main__":  # pragma: no cover - the CLI is exercised through main()
    raise SystemExit(main())
