#!/bin/sh
# Thin wrapper so the harvest is one command with no secret in it.
# The logic — and the reason it is a script rather than an exported variable —
# is in scripts/harvest_identifiers.py.
#
#   scripts/harvest-identifiers.sh                 # full ISIN pass, keyed if a key exists
#   scripts/harvest-identifiers.sh --limit 400     # any harvest flag passes through
#   scripts/harvest-identifiers.sh enumerate       # offline: what a CUSIP pass would ask
#   scripts/harvest-identifiers.sh harvest-cusip   # CUSIP -> FIGI, cached, resumable
#   scripts/harvest-identifiers.sh build-cusip     # cusip_map.json + measurement.json
#
# The CUSIP subcommands write into data/identifier-layer/<date>.staging/ and build-cusip
# publishes it by renaming the directory once it is whole. Do not hand-name a layer.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
# A worktree shares the repo's history, not its git-ignored `.venv`. Fall back to the
# canonical clone's virtualenv so `scripts/harvest-identifiers.sh` works from either
# tree, and to the interpreter on PATH as a last resort.
for candidate in \
  "$repo/.venv/pipeline/bin/python" \
  "$repo/../unpackfund/.venv/pipeline/bin/python" \
  "$repo/../.venv/pipeline/bin/python"
do
  if [ -x "$candidate" ]; then
    python=$candidate
    break
  fi
done
if [ -z "${python:-}" ]; then
  python=$(command -v python3 || true)
fi
if [ -z "${python:-}" ] || [ ! -x "$python" ]; then
  echo "no pipeline interpreter: tried $repo/.venv/pipeline/bin/python and siblings" >&2
  exit 1
fi

cd "$repo/pipeline"
exec "$python" "$repo/scripts/harvest_identifiers.py" "$@"
