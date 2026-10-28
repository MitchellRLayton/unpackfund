# UnpackFund

Fund portfolio X-ray: look through an ETF to the companies you actually own, with
every number traceable to a public filing.

**Status: infrastructure only.** The domain, edge hosting, object storage, and
data host are live; the application and data pipeline are not written yet, so this
repository currently holds no application code.

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

## Local commands (target surface)

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install workspace dependencies. |
| `pnpm build` | Static export of the site to `web/out`. |
| `pnpm deploy:prod` | Build and deploy the site to Cloudflare Workers. |
| `python -m pipeline.build` | Build a data release into `artifacts/`. |
| `pnpm data:validate` | Validate artifacts against the schema before publishing. |
| `pnpm verify` | Lint, typecheck, and test. |

These land with the first code commit; nothing above runs in this repository yet.

## Layout (target)

```
web/        static site (static export to web/out)
pipeline/   Python data pipeline (SEC EDGAR -> artifacts/)
schemas/    JSON Schemas for published artifacts
```

## Security

- No secrets in this repository. Local values live in `.env` (git-ignored); CI
  values live in GitHub Actions secrets or Cloudflare's dashboard.
- Publishing credentials are scoped to the R2 bucket only (no zone, no account
  administration).

## License

MIT — see [LICENSE](LICENSE).
