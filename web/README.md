# `web/` — the static app

Next.js 16 app router, `output: 'export'`, `trailingSlash: true`. The build in `web/out` is a directory of files; nothing
here runs at request time. Hosting is the `unpackfund` Worker with static assets (ADR-0005).

The app existed on 2026-10-29 in a state worth knowing before editing it: `/` is the portfolio builder, `/x` is the
look-through ledger, and both read the same portfolio from the URL fragment.

## Commands

Run from the repo root unless noted. `pnpm` here is `unpackfund/.local/bin/pnpm`; add `CI=true` in a non-TTY shell.

| Command              | What it does                                                                  |
| -------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`           | Bundles the worker, then `next dev` on `:3000`                                |
| `pnpm build`         | Bundles the worker, then `next build` into `web/out`                          |
| `pnpm test`          | `vitest run` — unit and component tests (jsdom; loader tests opt into `node`) |
| `pnpm test:watch`    | `vitest` in watch mode                                                        |
| `pnpm typecheck`     | `tsc --noEmit`                                                                |
| `pnpm lint`          | `eslint .`                                                                    |
| `pnpm format`        | `prettier --write .`                                                          |
| `pnpm verify` (root) | typecheck → lint → test → pipeline tests → data validation → build            |

## Two build-time environment variables

Both are inlined by `next build`; changing either needs a rebuild.

| Variable                   | Default                        | Meaning                                                                                                                                                                     |
| -------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_DATA_BASE`    | `https://data.unpackfund.com`  | Origin for release objects. The R2 custom domain allows exactly `http://localhost:3000` as a browser origin, so **use `localhost`, not `127.0.0.1`**, when testing locally. |
| `NEXT_PUBLIC_POINTER_PATH` | `staging/latest/manifest.json` | Which pointer file to read. The non-live default is deliberate: day 3 does not read `latest/`.                                                                              |

## How data is loaded

`staging/latest/manifest.json` → `releases/{as_of}/funds/{TICKER}.json`. Every object is hashed with `crypto.subtle` and
compared to the manifest before use, so a truncated or swapped object is an error, not a wrong number. Requests use
`cache: 'no-cache'` for the pointer (it is the one mutable object) and the default cache for release objects (immutable,
one year). One network retry, in `lib/use-release.ts`, only for `network` failures.

## The worker

`workers/ledger.worker.ts` is bundled by `scripts/build-worker.mjs` (esbuild, IIFE, ~2.6 KB) into
`public/ledger.worker.js`, which is git-ignored and rebuilt by `dev` and `build`. The worker path is a plain
`new Worker('/ledger.worker.js')`.

Do not hand this file to the framework's worker convention: on 2026-10-29 Turbopack emitted the `.ts` source into
`_next/static/media/` and the browser refused to execute it (`text/plain` / `video/mp2t` MIME). The main thread runs the
same aggregation as a fallback if the worker fails to load, and the live region says which one produced the numbers.

## Layout

| Path          | Contents                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `app/`        | routes, layout, global stylesheet, static 404                                                     |
| `components/` | `PortfolioBuilder`, `LedgerView`, `LedgerTable`, `FreshnessStrip`, `Notice`, `SiteNav`            |
| `lib/`        | `types`, `format`, `fragment`, `aggregate`, `data`, `ledger-protocol`, the hooks, and their tests |
| `workers/`    | the aggregation worker                                                                            |
| `scripts/`    | the worker bundler                                                                                |

`lib/` is git-ignored by the stock Python `.gitignore` rule `lib/` unless that line has been removed — check
`git check-ignore -v web/lib/types.ts` if a new file in `lib/` refuses to stage.

## See also

- `web/DESIGN.md` — the provisional visual direction and its open questions.
- `docs/05-build-log/` in the workspace — what was built on which day, and why.
