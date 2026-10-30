#!/bin/sh
# Thin wrapper so the harvest is one command with no secret in it.
# The logic — and the reason it is a script rather than an exported variable —
# is in scripts/harvest_identifiers.py.
#
#   scripts/harvest-identifiers.sh                 # full pass, keyed if a key exists
#   scripts/harvest-identifiers.sh --limit 400     # any harvest flag passes through
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
python=$repo/.venv/pipeline/bin/python
if [ ! -x "$python" ]; then
  echo "no pipeline virtualenv at $python" >&2
  exit 1
fi

cd "$repo/pipeline"
exec "$python" "$repo/scripts/harvest_identifiers.py" "$@"
