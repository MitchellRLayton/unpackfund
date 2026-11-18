#!/usr/bin/env bash
# pnpm test:invariants — the AU-1 invariant gate (T-AU-1.2).
#
# One entry point for the invariants in docs/platform/automation-spec.yaml, so a
# green run names what it proved. Each invariant maps to a test that already
# existed (kept, not copied) or to the one added in web/lib/invariants.test.ts;
# the map is docs/platform/au1-computation-inventory.md §3.
#
# The exit status is the verdict. The lines below are the map, printed before the
# run so a failure can be read against the invariant it belongs to.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "invariants: I-2 per-term bound  -> web/lib/invariants.test.ts"
echo "invariants: I-2 symmetry        -> web/lib/overlap.test.ts"
echo "invariants: I-3 overlap identity-> web/lib/overlap.test.ts"
echo "invariants: I-4 Core <= Broad   -> web/lib/effective-holdings.property.test.ts"
echo "invariants: I-6 row order       -> web/lib/effective-holdings.property.test.ts"
echo "invariants: I-5 percent=dollars  -> web/lib/invariants.test.ts"
echo "invariants: I-6 determinism     -> web/lib/aggregate.test.ts"
echo "invariants: I-7 flatten weight  -> pipeline/tests/test_fund_of_funds_gates.py"
echo "invariants: I-7 composed sum    -> pipeline/tests/test_fund_lookthrough.py"
echo "invariants: I-1, I-8 deferred   -> skipped in web/lib/invariants.test.ts (T-A.5, WS-B)"

pnpm --filter @unpackfund/web exec vitest run \
  lib/invariants.test.ts \
  lib/overlap.test.ts \
  lib/effective-holdings.property.test.ts \
  lib/aggregate.test.ts

cd pipeline
# Local runs use the workspace venv; CI installs the pipeline with pip and has no
# venv, so fall back to the interpreter on PATH (`pr-checks` does the same).
PYTHON_BIN="${PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  if [ -x ../.venv/pipeline/bin/python ]; then PYTHON_BIN=../.venv/pipeline/bin/python; else PYTHON_BIN=python; fi
fi
"$PYTHON_BIN" -m pytest -q \
  tests/test_fund_of_funds_gates.py \
  tests/test_fund_lookthrough.py

echo "invariants: passed — I-2, I-3, I-4, I-5, I-6, I-7 covered; I-1 and I-8 skipped by task id"
