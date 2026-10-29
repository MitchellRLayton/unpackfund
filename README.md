# UnpackFund

Fund portfolio X-ray: look through an ETF to the companies you actually own, with
every number traceable to a public filing.

**Status: infrastructure + app shell.** The domain, edge hosting, object storage,
and data host are live. `web/` is a scaffolded Next.js static export that builds to
static files and deploys as a Worker; it serves a placeholder page with no fund
data. The pipeline, the artifact schemas, and every product surface are still
unwritten.

## Architecture

| Layer | Service | Notes |
| --- | --- | --- |
| App hosting | Cloudflare Workers (Static Assets) | Free plan. Requests for static assets are free and unlimited. |
| Data artifacts | Cloudflare R2, bucket `unpackfund-artifacts` | Public read-only via `data.unpackfund.com`; private raw zone. |
| DNS / TLS / email | Cloudflare | Registrar + DNS, strict TLS, email forwarding (receive-only). |
| Builds | Workers Builds (Git integration) | Build from this repository, deploy with `wrangler deploy`. |
| Data pipeline | GitHub Actions (planned) | Quarterly run; writes artifacts to R2. |

## Domains

| Host | Serves |
| --- | --- |
| `unpackfund.com` | The site (canonical). |
| `www.unpackfund.com` | `301` to the apex. |
| `data.unpackfund.com` | Versioned data artifacts from R2. Only mutable pointer is `manifest.json` (no-cache); releases are immutable. |

## Data layout (R2, `data.unpackfund.com`)

```
manifest.json                  mutable pointer, Cache-Control: no-cache
releases/{as_of}/funds/*.json  immutable, Cache-Control: public, max-age=31536000, immutable
releases/{as_of}/indices/*.json
raw/                           private working data, never published
```

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
| `pnpm lint` | ESLint (flat config, `eslint-config-next`). | yes |
| `pnpm verify` | Typecheck + lint + build. The pre-push gate. | yes |
| `python -m pipeline.build` | Build a data release into `artifacts/`. | not yet |
| `pnpm data:validate` | Validate artifacts against the schema before publishing. | not yet |
| `pnpm deploy:prod` | Build and deploy to Cloudflare Workers. | not yet |

Deploying is `pnpm build && npx wrangler deploy` against `wrangler.jsonc`
(`assets.directory: web/out`), not a separate command yet.

## Layout

```
web/            Next.js app, static export to web/out (committed)
pipeline/       Python data pipeline, SEC EDGAR -> artifacts/ (not yet)
schemas/        JSON Schemas for published artifacts (not yet)
wrangler.jsonc  Worker + Static Assets config for the deploy
```

## Security

- No secrets in this repository. Local values live in `.env` (git-ignored); CI
  values live in GitHub Actions secrets or Cloudflare's dashboard.
- Publishing credentials are scoped to the R2 bucket only (no zone, no account
  administration).

## License

MIT — see [LICENSE](LICENSE).
