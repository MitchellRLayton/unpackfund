# pipeline

Build-time data pipeline: SEC EDGAR Form N-PORT → versioned JSON artifacts.
Python only, no server, no database at rest. It never serves a request; the
browser reads what this writes.

```
python -m pipeline.refresh detect          # did EDGAR change? one index file, ~1 s
python -m pipeline.build --tickers VOO     # filing → artifacts/releases/<id>/
python -m pipeline.validate --release 2026-10-29.1   # the gate
python -m pipeline.checks --tickers VOO    # two builds must be byte-identical
python -m pipeline.review --release <id> --parent <id>      # what changed, deterministic rules
python -m pipeline.triage --release 2026-10-29.1 --upload   # log what could not be published
python -m pipeline.release upload --release 2026-10-29.1   # R2, verified by public GET
python -m pipeline.release verify --release 2026-10-29.1   # re-read a published prefix
python -m pipeline.release promote --release 2026-10-29.1 --allow-live   # move the pointer only
python -m pipeline.retention plan          # what a prune would keep, stub, or delete
python -m pipeline.retention apply --yes   # the prune (DeleteObject is free)
python -m pipeline.live                    # is EDGAR up, is the data host answering
```

Wrapped as `pnpm refresh:detect`, `pnpm pipeline:build`, `pnpm data:validate --release <id>`,
`pnpm data:validate --fixtures` (offline, CI form), `pnpm check:determinism`,
`pnpm data:review`, `pnpm data:triage`, `pnpm release:upload`, `pnpm release:verify`,
`pnpm release:promote`, `pnpm data:retention` and `pnpm verify:live`. A bare release
id resolves against `artifacts/releases/`.

The daily loop is two workflows, not one: `refresh.yml` stages a release and deploys the
preview Worker, `promote.yml` moves the live pointer and deploys production the next day.
[ADR-0011](../../docs/04-decisions/ADR-0011-daily-refresh-promotion-and-retention.md) is why.

## Layout

| Module | Responsibility |
|---|---|
| `sec.py` | EDGAR HTTP client: declared User-Agent, ≤8 req/s, retries, content-addressed byte cache with an explicit lifetime per URL kind |
| `universe.py` | ticker → registrant CIK → N-PORT series (`company_tickers_mf.json`, then `overrides/tickers.csv`) |
| `refresh.py` | the refresh trigger: EDGAR's daily index → which registrants filed, optionally which published funds that supersedes |
| `filings.py` | newest N-PORT document for one series (the trust files one per series per quarter) |
| `nport.py` | `primary_doc.xml` parser, matched on local element name |
| `classify.py` | N-PORT codes → `equity` / `debt` / `cash` / `derivative` / `fund` / `other` |
| `companies.py` | holding → `company_id`, with the rung recorded |
| `weights.py` | basis points, coverage, HHI / effective N / top-10 |
| `artifact.py` | the published per-fund document: field order, canonical bytes, hash |
| `manifest.py` | the release index consumers read first |
| `build.py` | orchestration and the three pre-publication gates |
| `validate.py` | offline contract checks over a built release |
| `checks.py` | determinism across two builds |
| `paths.py` | where a release lives on disk; bare id → `artifacts/releases/<id>` |
| `sigv4.py` | AWS SigV4 in stdlib, so the upload step installs nothing |
| `r2.py` | R2 S3 client (put/head/get/list/delete, batched) and the public reader used for verification |
| `release.py` | the publish sequence (objects, verify every one by public GET, pointer last) and `promote`, which moves the pointer without re-uploading |
| `review.py` | deterministic rules comparing a release to its parent: coverage, residual, holdings count, top-10, `as_of` sanity |
| `triage.py` | the append-only log of submissions that could not be published, by failure kind, in R2 under `triage/` |
| `retention.py` | the prune: three live releases, four quarterly archive stubs, everything else deleted |
| `live.py` | reachability checks for EDGAR and the data host — never a gate |
| `fixtures.py` | the offline sample release used by tests and `--fixtures` |

## Data decisions this code makes

These are the ones a reviewer would otherwise have to reverse-engineer from the
diff. Each is recorded because the alternative is a silent choice.

**Weights are basis points of the fund's filed NAV, never renormalised.** A row's
weight is `valUSD / netAssets`; the vector therefore sums to whatever the filing
sums to. All five real funds measured on 2026-10-28 sum *above* 10,000 bp
(10,006–10,028) because derivatives and liabilities sit outside `invstOrSec`. The
artifact keeps that residual, the validator warns when it is outside
`[9,900, 10,000]`, and the UI must show it rather than hide it. Renormalising to
100% would make the ledger's cash and derivative lines lie.

**Rounding is largest-remainder, not `round()` per row.** Per-row rounding drifts
with row count; a 500-holding fund would sum to 10,004 or 9,996 unpredictably.
Ties break on fraction then position, so two runs produce identical bytes.

**Coverage is weight-based, and it counts resolution, not fundamentals.** The
contract defines covered weight as "resolved to a `company_id` with
fundamentals"; fundamentals do not exist yet, so day 1 measures resolution and
reports it. The field is the same one the UI's 60/70 bands read.

**Two mapping rungs, both exact, and the rung is published.** Ticker equality
first, then a normalised-name match accepted only when exactly one CIK normalises
to that name. This exists because the obvious ladder is unusable with free data:
VOO files 520 holdings with **one** ticker (Vanguard publishes none), so a
ticker-only mapper reports 0.2% coverage on the largest fund in the set, while
CUSIP/ISIN need a licensed security master and LEI needs an LEI→CIK table. Rung
counts go in the manifest (`mapping_rungs`) so a reviewer sees that one release
leaned on the weaker rung. Ambiguous names are refused, not resolved to "most
likely".

**No CUSIP or ISIN ever leaves the pipeline.** They are internal join keys; the
validator fails the release if a licensed identifier appears in any output file.

**Unmapped weight stays unmapped.** It is counted, labelled (`unmapped_holding`)
and shown, never redistributed across resolved companies — that is the mechanism
by which a low-coverage fund would look average.

**`etf_count` is `null` until a classifier exists.** VOO's series name is
"VANGUARD 500 INDEX FUND"; the ETF is a share class, not the series. Guessing from
the name was wrong for the largest fund in the sample, so the manifest publishes
`null` with `etf_classifier: pending_adr_0007_c3` and the validator accepts that
only when the reason is stated.

## Publishing

The upload is a sequence, not a copy, and the order is the design:

1. every local file is re-hashed and compared with the manifest — a disagreement
   aborts before the first `PUT`, so a stale manifest cannot be published;
2. objects go to `releases/{as_of}/` with `public, max-age=31536000, immutable`;
3. each object is re-fetched from `data.unpackfund.com` with
   `Origin: http://localhost:3000` and compared to its `sha256`, and its
   `cache-control` and `access-control-allow-origin` are checked — storage success
   is not reachability, and reachability is not CORS;
4. only then the pointer is written, byte-identical to the release manifest, with
   `no-cache`. The pointer defaults to `staging/latest/manifest.json`; anything
   under `latest/` needs `--allow-live`, because that is production;
5. the run reports what the live pointer says (`absent (HTTP 404)` or the release
   it names) and writes `upload-report.json` next to the release.

A failed verification writes no pointer and reports every failure, so a
half-published release never becomes visible.

SigV4 is ~120 lines of stdlib (`sigv4.py`) rather than a boto3 dependency for four
verbs; a wrong signature shows up as a 403 on the first object, which is a loud
failure. Two transport facts cost an hour to find and are commented where they
bite: R2 capitalises response header names (`Content-Length`, `ETag`), and the
data host answers **403** to a bare `Python-urllib` User-Agent while every other
UA tested gets 200.

## Adding a ticker

If `company_tickers_mf.json` has the symbol, nothing to do. If not — chiefly unit
investment trusts, which file N-PORT with no series id — add a reviewed row to
`overrides/tickers.csv` with the CIK, the series id (usually empty) and the
registrant name. The build compares that name with EDGAR's own entity name and
fails on a mismatch, so a typo cannot silently map a symbol to the wrong trust.
