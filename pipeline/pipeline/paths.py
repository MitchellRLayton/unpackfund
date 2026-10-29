"""Where things live, resolved once.

`pnpm` runs every pipeline script with `pipeline/` as the working directory, so a
repo-relative path a human typed at the repo root points somewhere else. Both
`data:validate` and `release:upload` take a release id or a directory, and both
have to agree on how a bare id resolves, so the rule lives here.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = REPO_ROOT / "artifacts"
RELEASES = ARTIFACTS / "releases"


def release_dir(target: Path | str) -> Path | None:
    """Resolve a release id (`2026-10-28.2`) or an explicit directory.

    A bare id is looked up under `artifacts/releases/`. An explicit path is taken
    as given, whether or not it exists, so the caller can report "not found"
    against the path the human actually typed. Returns `None` when a
    path-looking argument does not exist.
    """
    path = Path(target)
    if path.exists():
        return path
    if path.is_absolute() or len(path.parts) > 1:
        return None
    return RELEASES / path.name


def env_file_candidates() -> list[Path]:
    """Where a local `.env` may be, nearest first.

    The workspace keeps one `.env` one level above the repo (secrets policy), and
    the repo's own `.env` is the CI/self-contained case. `UNPACKFUND_ENV_FILE`
    wins outright when set.
    """
    import os

    override = os.environ.get("UNPACKFUND_ENV_FILE")
    candidates = [Path(override)] if override else []
    candidates += [REPO_ROOT / ".env", REPO_ROOT.parent / ".env"]
    return candidates
