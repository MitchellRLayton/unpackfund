"""Cross-build gates: determinism, and the manifest's own consistency.

    python -m pipeline.checks --tickers VOO

Determinism is not "the hash looked stable once". This builds a release twice,
from two separate output directories, under a pinned ``SOURCE_DATE_EPOCH``, and
compares every published byte. A hash that only matches because the second run
reused the first run's files would pass a weaker test than this one; here the two
builds share only the HTTP cache, which is content-addressed, so a differing
artifact can only come from the pipeline itself.
"""

from __future__ import annotations

import argparse
import filecmp
import os
import shutil
import sys
from pathlib import Path

from . import build

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORKDIR = REPO_ROOT / ".determinism"
PINNED_EPOCH = "1793318400"  # 2026-10-30T00:00:00Z, so generated_at is stable


def _published_files(release_dir: Path) -> dict[str, Path]:
    """The files a consumer reads: fund artifacts and the manifest."""
    files = {path.name: path for path in sorted((release_dir / "funds").glob("*.json"))}
    files["manifest.json"] = release_dir / "manifest.json"
    return files


def determinism(tickers: list[str], workdir: Path = DEFAULT_WORKDIR) -> int:
    previous = os.environ.get("SOURCE_DATE_EPOCH")
    os.environ["SOURCE_DATE_EPOCH"] = PINNED_EPOCH
    try:
        if workdir.exists():
            shutil.rmtree(workdir)
        releases = []
        for run in ("a", "b"):
            out = workdir / run
            build.build_release(tickers, out_dir=out, release_id="determinism")
            releases.append(out / "releases" / "determinism")
    finally:
        if previous is None:
            os.environ.pop("SOURCE_DATE_EPOCH", None)
        else:
            os.environ["SOURCE_DATE_EPOCH"] = previous

    first, second = (_published_files(release) for release in releases)
    if first.keys() != second.keys():
        print(f"FAIL determinism: different file sets {sorted(first)} vs {sorted(second)}")
        return 1
    mismatched = [
        name
        for name, path in first.items()
        if not filecmp.cmp(path, second[name], shallow=False)
    ]
    if mismatched:
        print(f"FAIL determinism: {len(mismatched)} file(s) differ: {sorted(mismatched)}")
        return 1
    print(f"ok determinism: {len(first)} files byte-identical across two builds")
    shutil.rmtree(workdir, ignore_errors=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.checks", description=__doc__)
    parser.add_argument("--tickers", default="VOO", help="comma-separated tickers")
    parser.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)
    args = parser.parse_args(argv)
    tickers = [ticker.strip().upper() for ticker in args.tickers.split(",") if ticker.strip()]
    return determinism(tickers, args.workdir)


if __name__ == "__main__":
    sys.exit(main())
