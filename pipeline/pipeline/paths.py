"""Where things live, resolved once.

`pnpm` runs every pipeline script with `pipeline/` as the working directory, so a
repo-relative path a human typed at the repo root points somewhere else. Both
`data:validate` and `release:upload` take a release id or a directory, and both
have to agree on how a bare id resolves, so the rule lives here.
"""

from __future__ import annotations

from pathlib import Path

def find_repo_root(start: Path | None = None, cwd: Path | None = None) -> Path:
    """The checkout, found by its marker file rather than by counting parents.

    Counting parents works from a source checkout and breaks the moment the package is
    installed: `pip install ./pipeline` puts this file in site-packages, where
    `parents[2]` is the Python installation's `lib` directory. That is not hypothetical —
    it failed the production deploy on 2026-11-03 with "the design system is missing, so
    there is no page to style", because the generator looked for `web/app/globals.css`
    under `/opt/hostedtoolcache/Python/3.13.17/x64/lib`.

    So: walk up from the working directory first — in every caller that exists, `pnpm` or
    the deploy workflow runs from the repository root, so this is the checkout — and then
    from this file, for the case where someone runs the package from elsewhere. Take the
    first directory that has both the workspace manifest and the app. The fallback keeps
    the old behaviour for a tree that has neither, so the error a caller sees still names
    a path rather than raising `IndexError`.
    """
    here = (start or Path(__file__)).resolve()
    for origin in ((cwd or Path.cwd()).resolve(), here.parent):
        for candidate in (origin, *origin.parents):
            if (candidate / "pnpm-workspace.yaml").is_file() and (candidate / "web").is_dir():
                return candidate
    return here.parents[2]


REPO_ROOT = find_repo_root()
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
