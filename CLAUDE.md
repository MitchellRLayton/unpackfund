# Claude Code — this repository's rules are in AGENTS.md

@AGENTS.md

`AGENTS.md` beside this file governs work in the repository; `../AGENTS.md` (the workspace) governs
everything. Two hard boundaries worth restating for a harness that opens this folder directly:

- **Cost.** The product runs on free plans. The ceilings have one definition —
  `pipeline/pipeline/cost_ceilings.py` — and `release.upload_release` refuses a release that would
  cross the storage or Class A line before the first `PutObject`. Report a refusal with both figures;
  never add an override, raise a number, or upgrade a plan. Policy and sources:
  `../docs/04-decisions/ADR-0028-free-tier-cost-ceilings.md`. Measure with
  `pnpm check:budget -- --release <dir>` or `--site web/out`.
- **Filesystem.** Everything stays inside `/Users/mitchelllayton/Personal-AI-Sandbox`. Nothing
  outside it, ever — see `../AGENTS.md` §*Filesystem scope*.
