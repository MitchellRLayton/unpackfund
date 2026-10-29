# Design direction — provisional

**Status:** provisional, recorded 2026-10-29. Replaceable. The operator owns visual direction (ADR-0006); this file exists
so the next session inherits the reasoning instead of re-deriving it, and so a replacement has something concrete to
replace.

## What the page has to do

Show a number the visitor can check. Everything below follows from that: the ledger is a document, not a dashboard. No
hero, no gradient, no illustration, no marketing voice. One column of content, a table that reads like a table, and the
provenance of every number visible without a click.

## The five rules the build follows

1. **Provenance is part of the number.** The freshness strip (release, filing period, longest lag, coverage, company
   count) sits above the metrics, not in a footnote. A fund's filing period is shown per fund because five funds can span
   three different quarters — the strip says `2026-05-31 – 2026-07-31` rather than picking one.
2. **Weight is a share of the portfolio, never of a fund.** The H1 subtitle and the table caption both say so in words,
   because a reader who assumes otherwise misreads every row.
3. **No colour-only meaning.** Coverage bands are text (`93.3% of weight covered`) with a chip as reinforcement; the
   sorted column is marked with `aria-sort` and a drawn arrow.
4. **Quiet chrome.** One accent colour, used for the primary action and the current nav item only. Rules are 1 px,
   surfaces are flat, corners are 2 px. Density over decoration: a 2rem row height holds 1,125 companies and still reads.
5. **Numbers are tabular.** `font-variant-numeric: tabular-nums` on every weight, count, and metric so columns align
   without a grid of spans.

## Tokens

Defined once in `app/globals.css` as custom properties, light and dark through `prefers-color-scheme`.

| Token                    | Light                 | Dark                  | Use                              |
| ------------------------ | --------------------- | --------------------- | -------------------------------- |
| `--bg`                   | `#ffffff`             | `#0d1117`             | page                             |
| `--surface`              | `#f6f8f9`             | `#151b22`             | table header, notices            |
| `--fg`                   | `#11181c`             | `#e8edf0`             | body text                        |
| `--muted`                | `#55636b`             | `#9aa7b0`             | labels, notes, secondary values  |
| `--rule`                 | `#d7dde1`             | `#232b33`             | hairlines, table rules           |
| `--accent`               | `#0f6d78`             | `#5ec8d4`             | primary action, current nav item |
| `--warn` / `--warn-soft` | `#7a4b00` / `#fdf3e2` | `#f0b429` / `#2e2413` | warnings, unmapped holdings      |

Type is `system-ui` with an Apple/Segoe/Roboto fallback chain at 16 px base, 0.9–1.05 rem in the ledger, 650 weight for
values. No webfont: one fewer request, no layout shift, no licence question. `--row: 2rem` fixes the row height for the
day-4 windowing pass.

## Open questions — the operator's, not the agent's

- [`open`] **Chart or table only.** The table is the product right now. A treemap or bar strip of the top 10 is a visual
  answer to "what do I own"; it is not in the day-3 scope and would need its own budget line (no chart library on first
  paint).
- [`open`] **Dark theme as a first-class choice.** Dark tokens exist and follow the OS. A visible toggle, a persisted
  preference, and a redesign of the coverage chips for dark are unbuilt.
- [`open`] **Fund-count cap in the builder.** No cap is enforced on day 3; 10–12 funds is the design assumption (plan
  §4.2) and the aggregation is fast enough that a cap would be a product decision, not a technical one.
- [`open`] **The wordmark, favicon, and social card.** The header wordmark is text. Nothing else is designed.

## What is deliberately absent

Ads, cookie banner (no cookies), analytics script, notification prompt, account menu, "upgrade", share sheet. The
portfolio lives in the URL fragment and is never sent anywhere, so there is nothing to persist and nothing to log in to.

## Replacing this

Change the tokens in `app/globals.css`, keep rules 1–3, and re-run the ledger in a real browser at 1280 px and 375 px.
Rules 1–3 are correctness: a redesign that hides the filing period, reframes weight as a share of a fund, or encodes
coverage in colour alone would be a product bug, not a taste difference.
