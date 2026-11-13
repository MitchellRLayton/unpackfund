# Fundamentals layer on the fund page — build plan

**Decided 2026-11-12**, revised **2026-11-13** by the operator. Prototype:
`docs/01-research/2026-11-11-sec-xbrl-fundamentals/prototype/`.

## Where it lives — one component, three surfaces, never its own page

Profitability is one of the four Fama-French characteristics (value, profitability, investment, size), so it ships as a
**Characteristics section** built once and reused, in this order:

| Order | Surface | Variant | Why that variant |
|---:|---|---|---|
| 1 | **Fund detail page**, directly below the holdings summary | **A · headline + disclosure** | one fund, no cross-fund weighting, coverage easy to explain: one number with the breakdown behind an expander |
| 2 | **Compare page** | **C · table first** | the page exists to compare across columns; a table is the comparison |
| 3 | **Portfolio → new Characteristics tab**, after Funds and before Overlap | **A**, plus per-fund contribution against the benchmark (VT and the chips) and the style-peer column where the gate passes | needs cross-fund weighting and normalised coverage — hence last |

**Not** Portfolio → Companies (concentration, already dense) and **not** a standalone Companies page — company figures
appear only as raw inputs on a company's own detail page.

## Which number leads

**Cash operating return is the headline** (96.7 % coverage, least distorted, and the cash-based measure the mandate names);
ROE stays in the table as context, with its limitation beside it. Operating profit is the second column, measured against
the non-financial weight.

**Two statistics, not a mean.** The simple mean of a profitability ratio is not publishable — AVUV's operating profit mean
is 54.9 % against a 27.1 % median because companies with near-zero book equity produce enormous ratios. Each measure
reports the **weighted median** and an **aggregate ratio** (`Σ numerator ÷ Σ book equity` over the fund's holdings), which
is what a portfolio sort actually measures. The winsorised mean stays internal as a diagnostic and never on the page.

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


## Cloudflare limits — what this adds, and what it must not

Measured 2026-11-10 (`docs/08-operations/2026-11-10-cloudflare-free-tier-usage.md`): **16.33 GB stored against a 10 GB
free tier**, 625,234 objects, and Class A at 553k of 1M by day 10 — the cause is 34 releases kept where the policy keeps
three, not this feature.

| This layer adds | Cost | Why |
|---|---|---|
| Company metrics artifact | **3.2 MB**, one object per fundamentals version | a single file, not per-company shards |
| A profitability block inside each existing fund shard | ~1–2 KB × 9,015 ≈ **10–18 MB** per release, **0 new objects** | the block rides in a document the release already writes |
| Fund pages | 0 new objects | the section is markup inside an existing page |

So the feature adds **no Class A, no Class B and no objects** — only bytes in objects already being written. The two
levers that keep the account inside the free tier are therefore unchanged and are **preconditions of the release**:
retention down to the policy's three releases (≈15 GB returned), and the validator reading the manifest rather than
listing the bucket (a full `ListObjects` sweep bills as Class A).

## Keeping it current

| Source | Changes | Rebuild |
|---|---|---|
| XBRL company facts | weekly bulk archive, facts effectively quarterly | **weekly** fundamentals artifact — 96 s, 3.2 MB, one object |
| N-PORT holdings | quarterly-public, per-fund report dates | the existing **daily refresh** recomputes a fund's block when its holdings change; no separate job |

The daily refresh already detects new filings and rebuilds only the touched funds, so the profitability block rides the
existing cadence with no new schedule. The weekly artifact rebuild is the one new step, and it is cheap enough to run
inside the Monday refresh.
