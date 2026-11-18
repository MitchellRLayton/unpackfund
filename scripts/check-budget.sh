#!/usr/bin/env bash
# pnpm check:budget — measure a built release or site against the free-tier ceilings.
#
# Run from the **repo root** so every path resolves the way the rule files read it:
# `pnpm check:budget --site web/out`, `pnpm check:budget --release artifacts/releases/<id>`.
# (The first version of this wrapper `cd pipeline` first, which silently resolved `web/out`
# to `pipeline/web/out` and made the documented pre-upload measurement unusable; caught by
# the independent review of PR #128, which is why the paths now come from the caller's tree.)
#
# It exits non-zero when a directory cannot be measured as well as when a ceiling is
# crossed, because a gate that cannot run must not look like a pass.
set -euo pipefail
cd "$(dirname "$0")/.."
exec env PYTHONPATH="$PWD/pipeline" .venv/pipeline/bin/python -m pipeline.cost_ceilings "$@"
