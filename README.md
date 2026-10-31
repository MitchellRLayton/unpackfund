# UnpackFund

Fund portfolio X-ray: look through an ETF to the companies you actually own, with
every number traceable to a public filing.

**Status: infrastructure + app shell + pipeline + published release path.**
The domain, edge hosting, object storage, and data host are live. `pipeline/`
takes a ticker to a real N-PORT filing, emits a per-fund artifact plus a release
manifest, validates it, and uploads it to R2 with a hash-verified read-back.
`web/` is a scaffolded Next.js static export that deploys as a Worker and still
serves a placeholder page — the `/x` ledger and every product surface are
unwritten, and the live pointer is deliberately unmoved.

## Architecture

| Layer | Service | Notes |
| --- | --- | --- |
| App hosting | Cloudflare Workers (Static Assets) | Free plan. Requests for static assets are free and unlimited. |
| Data artifacts | Cloudflare R2, bucket `unpackfund-artifacts` | Public read-only via `data.unpackfund.com`; private raw zone. |
| DNS / TLS / email | Cloudflare | Registrar + DNS, strict TLS, email forwarding (receive-only). |
| Builds | Workers Builds (Git integration) | Build from this repository, deploy with `wrangler deploy`. |
| Data pipeline | GitHub Actions (`refresh.yml`) | Daily 06:30 UTC on EDGAR's daily index; writes artifacts to R2; staging pointer only ([ADR-0010](../docs/04-decisions/ADR-0010-refresh-orchestration-and-cadence.md)). |

## Domains

| Host | Serves |
| --- | --- |
| `unpackfund.com` | The site (canonical). |
| `www.unpackfund.com` | `301` to the apex. |
| `data.unpackfund.com` | Versioned data artifacts from R2. Only mutable pointer is `manifest.json` (no-cache); releases are immutable. |

## Data layout (R2, `data.unpackfund.com`)

```
latest/manifest.json           the only mutable object, Cache-Control: no-cache
releases/{as_of}/manifest.json immutable, Cache-Control: public, max-age=31536000, immutable
releases/{as_of}/funds/*.json  immutable, same
releases/{as_of}/indices/*.json
staging/latest/manifest.json   pointer rehearsal target; non-live, never read by the app
raw/                           private working data, never published
```

`{as_of}` is the release stamp (`2026-10-29.1`) and is also the release manifest's
`as_of` — the pointer names a release by that field, so the directory and the field
cannot disagree. `latest/manifest.json` is a byte-identical copy of one release's
manifest, which makes a rollback a copy rather than an edit.

Artifact requests are cached at the edge by a Cache Rule on the `data.` host, so
repeat reads do not consume R2 Class B operations.

## Local development

Node 24 (`>=24 <25`) and pnpm 11.28.5, pinned by `.nvmrc` and `packageManager`.
Install once with `pnpm install`; the store is kept in-repo (`.pnpm-store/`,
git-ignored) so nothing is written to a user-level cache.

| Command | Purpose | Works today |
| --- | --- | --- |
| `pnpm install` | Install workspace dependencies. | yes |
| `pnpm dev` | Next dev server on :3000. | yes |
| `pnpm build` | Static export of the site to `web/out`. | yes |
| `pnpm typecheck` | `tsc --noEmit` across the workspace. | yes |
| `pnpm lint` | ESLint (flat config, `eslint-config-next`) + `prettier --check`. No writes. | yes |
| `pnpm format` | `prettier --write` over `web/` (the only writing command). | yes |
| `pnpm verify` | `typecheck` → `lint` → `pipeline:test` → `data:validate --fixtures` → `build`. The pre-push gate. | yes |
| `pnpm pipeline:build` | Fetch the newest N-PORT filing for a ticker and write a release into `artifacts/`. Needs network on first run. | yes |
| `pnpm pipeline:test` | The pipeline's pytest suite (68 tests, offline). | yes |
| `pnpm data:validate --release <id \| dir>` | Schema, weight sums, duplicates, hashes, CUSIP rejection, size budget. Offline; a bare release id resolves against `artifacts/releases/`. | yes |
| `pnpm data:validate --fixtures` | The same checks against the committed fixture, no network. CI form. | yes |
| `pnpm check:determinism` | Build a release twice and compare every published byte. | yes |
| `pnpm release:upload --release <id>` | Upload a release to R2, verify every object by public GET (sha256, cache headers, CORS), then write the pointer. Non-live pointer by default; `--allow-live` required for `latest/`. | yes |
| `pnpm release:verify --release <id>` | Re-read a published prefix and check it against the manifest hashes. | yes |
| `pnpm verify:live` | EDGAR reachable with our User-Agent; data host answering with CORS and the contracted cache headers. Never a gate. | yes |
| `pnpm deploy:prod` | Build and deploy to Cloudflare Workers. | not yet |

### Publishing a release

```bash
pnpm pipeline:build --tickers VOO,AVUV,SPY,QQQ,ARKK --release-id 2026-10-29.1
pnpm data:validate --release 2026-10-29.1
pnpm release:upload --release 2026-10-29.1            # objects + staging/latest pointer
pnpm release:upload --release 2026-10-29.1 --pointer-prefix latest --allow-live   # production promotion
```

The upload verifies what a browser would receive, not what S3 acknowledged: every
object is re-fetched from `data.unpackfund.com` and compared to its manifest hash,
with `Origin: http://localhost:3000` attached so a missing CORS header fails the
run. The pointer is written last, after the objects verify, because a pointer that
moves first is a live 404 for every fund in the release.

Credentials come from the workspace `.env` (`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, optional `R2_BUCKET`), or from the environment in CI. The
command prints the names it loaded and never a value.

The pipeline needs its own interpreter and a workspace-local venv (never a system
Python):

```bash
python3.13 -m venv .venv/pipeline
.venv/pipeline/bin/python -m pip install pytest
pnpm pipeline:build --tickers VOO     # args pass through to pipeline.build
```

SEC requires a declared User-Agent with a contact address, at most 10 requests a
second. The client sends `UnpackFund research data@unpackfund.com` and throttles
to 8/s; override the first with `SEC_USER_AGENT`.

**Deploying production.** Production is a Worker with Static Assets
(ADR-0005) and it is only ever published by something that has the fund pages,
because a shell-only deploy takes all 9,016 `/f/<TICKER>/` pages down with it —
which is exactly what Workers Builds did twice on 2026-10-30.

- Normal path: push to `main`. `.github/workflows/deploy-site.yml` builds the app,
  copies the live release (`pipeline.mirror`), generates its fund pages, checks the
  bundle, and deploys with `--config wrangler.prod.jsonc`. It also runs after a
  successful `promote`, so a data promotion cannot leave older code behind.
- Nightly data path: `.github/workflows/promote.yml` deploys the reviewed `site`
  artefact from `refresh.yml` with the same config.
- By hand: `pnpm build && pnpm pages:mirror && pnpm pages:funds &&
  npx wrangler@4.155.0 deploy --config wrangler.prod.jsonc`.

`wrangler.jsonc` is **not** production and cannot deploy anything: its Worker is a
throwaway (`unpackfund-buildcheck`) and its `assets.directory` points at a path that
never exists, so a deploy that reads it dies in validation instead of publishing half
a site. It does not control the Git build either — Cloudflare's Workers Builds
connection pins its own Worker — which is why the repo stops that build in two
independent ways: the web build exits non-zero under any CI that is not GitHub
Actions (`web/scripts/build-worker.mjs`), and the assets path above fails the deploy
if the build ever gets that far. Expect one red "Workers Builds" check per push until
the Git link is disconnected in the Cloudflare dashboard (Worker `unpackfund` →
Settings → Build → Disconnect); nothing depends on it.

**Preview, without touching production.** `wrangler.preview.jsonc` deploys the
same `web/out` as a *separate* Worker with its own `workers.dev` hostname, so the
app can be reviewed on a real URL before anything reaches `unpackfund.com`:

```
pnpm build
npx wrangler@4 deploy --config wrangler.preview.jsonc   # https://unpackfund-preview.<subdomain>.workers.dev
```

It owns no custom domain and is never built by Workers Builds. Remove it with
`npx wrangler@4 delete --config wrangler.preview.jsonc`. The data host allows the
preview origin in its R2 CORS rule; a new preview hostname needs its origin added
there or the app will report that it cannot reach the data host.

## Layout

```
web/            Next.js app, static export to web/out
pipeline/       Python data pipeline, SEC EDGAR -> artifacts/ (see pipeline/README.md)
pipeline/overrides/  reviewed ticker -> registrant rows for symbols EDGAR's fund
                ticker file does not carry (unit investment trusts)
schemas/        JSON Schemas for published artifacts (not yet)
wrangler.jsonc  Worker config the Git build reads — a throwaway build-check
                Worker, not production (see "Deploying production")
wrangler.prod.jsonc  the production Worker, `unpackfund`
```

## Security

- No secrets in this repository. Local values live in `.env` (git-ignored); CI
  values live in GitHub Actions secrets or Cloudflare's dashboard.
- Publishing credentials are scoped to the R2 bucket only (no zone, no account
  administration).

## License

MIT — see [LICENSE](LICENSE).
