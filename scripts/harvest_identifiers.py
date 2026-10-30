#!/usr/bin/env python3
"""Run the OpenFIGI harvest with the key from the workspace `.env`, if there is one.

Two reasons this exists instead of "export the variable and run the module":

1. **The key never reaches a command line.** It is read from the file into this
   process's environment and handed to the harvest in-process — not in `argv`, not
   in a shell history, not in a log line, and not in the output of this script.
2. **The batch size has to match the key.** A keyed pass uses 100 jobs per request
   at 250 requests a minute; unauthenticated it is 10 at 25. The request hash
   includes the batch, so switching size mid-pass misses the cache — pin the size
   once, here, and a resumed pass stays resumable.

Usage (from the repo root):

    scripts/harvest-identifiers.sh                  # full pass, keyed if a key exists
    scripts/harvest-identifiers.sh --limit 400      # harvest flags pass through

Unauthenticated the full pass is about 19 hours; keyed it is about 11 minutes.
"""

from __future__ import annotations

import os
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
PIPELINE = REPO / "pipeline"
KEY_ENV = "OPENFIGI_API_KEY"
KEYED_JOBS = "100"
KEYED_RPM = "250"
PLAIN_JOBS = "10"
PLAIN_RPM = "25"


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


def main(argv: list[str]) -> int:
    if os.environ.get(KEY_ENV):
        keyed, source = True, "the environment"
    else:
        keyed, source = key_from_env_file()
        if keyed:
            # Populate this process only. `pipeline.identifiers` reads it from
            # `os.environ`, and nothing here prints or logs it.
            for candidate in env_candidates():
                if candidate.is_file() and pathlib.Path(source) == candidate:
                    for raw in candidate.read_text(encoding="utf-8").splitlines():
                        name, sep, rest = raw.strip().partition("=")
                        if sep and name.strip() == KEY_ENV:
                            os.environ[KEY_ENV] = rest.strip().strip('"').strip("'")
                            break
                    break

    defaults = (
        ("--jobs", KEYED_JOBS, "--rpm", KEYED_RPM)
        if keyed
        else ("--jobs", PLAIN_JOBS, "--rpm", PLAIN_RPM)
    )
    # Explicit flags win; the defaults only fill what the caller left out. The
    # subcommand is implied, because the only thing this wrapper wraps is `harvest`.
    args = list(argv)
    if not args or args[0] not in ("harvest", "build"):
        args = ["harvest"] + args
    for flag, value in zip(defaults[0::2], defaults[1::2]):
        if flag not in args:
            args += [flag, value]

    jobs = args[args.index("--jobs") + 1]
    rpm = args[args.index("--rpm") + 1]
    if keyed:
        print(
            f"harvest: {KEY_ENV} found in {source} — {jobs} jobs/request at {rpm} req/min",
            file=sys.stderr,
        )
    else:
        print(
            f"harvest: no {KEY_ENV} in any .env — {jobs} jobs/request at {rpm} req/min "
            "(a full pass takes about 19 hours this way)",
            file=sys.stderr,
        )

    sys.path.insert(0, str(PIPELINE))
    from pipeline.identifiers import main as harvest_main  # noqa: PLC0415 — after sys.path

    return harvest_main(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
