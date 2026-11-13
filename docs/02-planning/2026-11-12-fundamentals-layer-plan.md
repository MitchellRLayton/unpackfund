# Fundamentals layer on the fund page — build plan

**Decided 2026-11-12** by the operator: variant C (table first), peer comparisons tiers 1 and 2, tier 3 as the
style-grid cell. Prototype: `docs/01-research/2026-11-11-sec-xbrl-fundamentals/prototype/`.

## Objective

Every published fund's page carries a profitability table — ROE, operating profit, cash operating return, leverage —
each with its coverage, its definition, and where the fund sits (universe percentile, all-fund percentile, style-cell
peer), sourced only from SEC XBRL, with the as-of date of the holdings.

## What exists, and what does not

| Exists | Does not exist |
|---|---|
| The panel design (variant C) and its copy | Any fundamentals data in the pipeline or the release |
| A working measurement script (12 funds, offline) | Per-company metrics for the ~5,300 CIKs the release holds |
| The bulk archive on disk and the shared SEC client | A `fundamentals` artifact, a fund-shard field, a validator rule |
| The fund-page generator and the release pipeline | Peer ranks at any tier |

**The prototype's numbers are a one-off measurement, not a pipeline output.** Nothing in production may display them
until the pipeline computes them: a panel on 9,015 fund pages built from a 12-fund sample would be fabrication.

## Phases, each with its gate

| # | Work | Done when | Effort |
|---|---|---|---|
| P1 | `pipeline/fundamentals.py`: company metrics from the bulk archive at the latest annual anchor, one selection rule, `valid_zero` vs `missing`, median/mean per company set | module runs over the archive in <2 min and reproduces the 12-fund measurements to the last digit | 1 session |
| P2 | Artifact + fund field: `facts/{version}.json` in the release, `profitability` block on each fund shard; schema bump; validator rule; fund-page render of variant C | `pnpm data:validate` passes on a 5-fund local release; a fund page renders the table | 1 session |
| P3 | Peer ranks: holding → universe percentile (weight-averaged), fund → all-fund percentile, fund → style-cell peer from our own size × value grid; every rank carries its population | ranks reproduce for the 12 measured funds and are stable across two builds | 1 session |
| P4 | Release and deploy: full-universe build, upload, pointer, live verification | the daily refresh publishes it and `verify-live` passes | 0.5 session + the scheduled run |

## Risks

- **Schema change** — a fund shard gains a block; the validator, the app and the fund pages must all tolerate it.
  `data-contract-and-release` governs; schema_version bumps.
- **Release size** — roughly 1–2 KB per fund for the table, more with peers; ~9,015 funds is ~15 MB, acceptable, but
  R2 is already over its free tier until retention is fixed.
- **The panel's argument is the coverage** — a fund below 80 % shows the table with its coverage, never a bare number.
