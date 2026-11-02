# Design direction — provisional

**Status:** provisional, recorded 2026-10-29. Replaceable. The operator owns visual direction (ADR-0006); this file exists
so the next session inherits the reasoning instead of re-deriving it, and so a replacement has something concrete to
replace.

## What the page has to do

Show a number the visitor can check. Everything below follows from that: the ledger is a document, not a dashboard. No
hero, no gradient, no illustration, no marketing voice. One column of content, a table that reads like a table, and the
provenance of every number visible without a click.

## The five rules the build follows

1. **Provenance is part of the number.** The freshness strip (release, filing period, longest lag, coverage, the share
   of money not traced, company count) sits above the metrics, not in a footnote. A fund's filing period is shown per fund because five funds can span
   three different quarters — the strip says `2026-05-31 – 2026-07-31` rather than picking one.
2. **Weight is a share of the portfolio, never of a fund** — with one deliberate exception, which is why the rule is
   written down. The H1 subtitle and the table caption both say so in words, because a reader who assumes otherwise
   misreads every row. The exception is the benchmark column: a company's weight _inside VT_ is a share of VT's own NAV,
   so it is a separate column, immediately right of the portfolio weight, with its own caption sentence and its own
   provenance beside the table. The two are never added, subtracted, or put in one cell — the page shows the comparison
   and does not score it ([ADR-0015](../../docs/04-decisions/ADR-0015-vt-benchmark.md)).
3. **No colour-only meaning.** Coverage bands are text (`93.3% of weight covered`) with a chip as reinforcement; the
   sorted column is marked with `aria-sort` and a drawn arrow.
4. **Quiet chrome.** One accent colour, used for the primary action and the current nav item only. Rules are 1 px,
   surfaces are flat, corners are 2 px. Density over decoration: a 2rem row height holds 1,125 companies and still reads.
   The one exception is attribution: a company row always names every fund that holds it, as chips that wrap, so a
   portfolio with five or more funds grows the row by a line instead of truncating to `+N more`. Attribution outranks
   uniform density — a hidden fund is a wrong answer, a taller row is not.
5. **Numbers are tabular.** `font-variant-numeric: tabular-nums` on every weight, count, and metric so columns align
   without a grid of spans.

## Tokens

Defined once in `app/globals.css` as custom properties, light and dark through `prefers-color-scheme`.

| Token                                   | Light                 | Dark                  | Use                                            |
| --------------------------------------- | --------------------- | --------------------- | ---------------------------------------------- |
| `--bg`                                  | `#ffffff`             | `#0d1117`             | page                                           |
| `--surface`                             | `#f6f8f9`             | `#151b22`             | table header, notices                          |
| `--fg`                                  | `#11181c`             | `#e8edf0`             | body text                                      |
| `--muted`                               | `#55636b`             | `#9aa7b0`             | labels, notes, secondary values                |
| `--rule`                                | `#d7dde1`             | `#232b33`             | hairlines, table rules                         |
| `--accent`                              | `#0f6d78`             | `#5ec8d4`             | primary action, current nav item               |
| `--warn` / `--warn-soft`                | `#7a4b00` / `#fdf3e2` | `#f0b429` / `#2e2413` | warnings, partial coverage                     |
| `--tint-direct` / `--tint-direct-hover` | `#f2ecff` / `#e9e0fd` | `#1d1930` / `#262038` | the ledger row of a stock you hold directly    |
| `--country-us`                          | `#9dc2ea`             | `#2b4a6d`             | the row's left edge for a US-domiciled company |
| `--country-intl`                        | `#8d9fe0`             | `#2f3a6e`             | the row's left edge for any other domicile     |

**Row shading (operator's instruction, 2026-11-02).** A company the visitor holds as a stock, not only through a fund, gets
a pastel light-purple row — quiet enough that the numbers still lead, distinct enough to find the single-stock positions at
a glance. Three constraints, each with a check behind it:

- **Reinforcement, not the message.** The row already names the direct position in words — `You · NVDA` in the attribution,
  and `direct` in the Funds column when no fund holds it — and the table's caption gains one sentence saying what the
  shading means. Colour is never the only carrier (rule 3), so a forced-colours, monochrome, or screen-reader reader loses
  nothing.
- **A solid tint, not a low-alpha layer.** Declared per scheme in `app/globals.css`, so it composites the same over the page,
  over the hover, and in dark mode, where a light pastel over `#0d1117` would glow instead of shade.
- **Contrast is a gate.** `lib/theme.test.ts` checks `--fg` and `--muted` against both tints in both schemes; the tightest
  pair is 4.89:1 (light hover, secondary text), above the 4.5:1 AA floor.

Type is `system-ui` with an Apple/Segoe/Roboto fallback chain at 16 px base, 0.9–1.05 rem in the ledger, 650 weight for
values. No webfont: one fewer request, no layout shift, no licence question. `--row: 2rem` fixes the row height for the
day-4 windowing pass.

## Country edge (operator's instruction, 2026-11-02)

Geography is a second axis on the ledger, and it is a **separate channel** because one background cannot carry two
meanings: the row _background_ keeps meaning position kind — a company the visitor holds directly as a stock, purple —
and geography is drawn as a 3 px **left edge on the row's first cell** plus the two-letter country code as **text** in
the row's second line. The rules:

- **Text carries the meaning; colour reinforces it.** The code is real text in the row (`US`, `TW`), so a screen
  reader reads it and a printed page keeps it, and the table's caption gains one sentence saying what the tag and the
  edge mean. The edge repeats the code in colour so a reader scanning rows can find a domicile at a glance (rule 3).
  Blue is the United States, periwinkle everywhere else; that mapping is stated in the caption, never implied by hue.
- **A row can be both.** A stock held directly that also has a decided domicile keeps its purple background and gains
  the edge: `data-direct` and `data-country` sit side by side on the same `<tr>`, and neither channel borrows the
  other's encoding. The 3 px stripe is an inset `box-shadow` on the first cell rather than a `tr` border, which is
  unreliable under `border-collapse: separate`, and inset shadow costs no layout.
- **Absence means no answer.** A company the filings disagree about — or one held only by funds that file no country —
  is absent from the map, and its row carries no edge and no tag. A default would be a guess. The caption sentence
  appears only when a row actually carries a code, and a release that publishes no country object renders exactly as
  it did before the channel existed: no tag, no edge, no sentence, no extra fetch.
- **Where the codes come from.** The pipeline's `companies/countries.json`: each code is the `invCountry` of the
  company's holders' N-PORT filings decided by **value-weighted majority**, published only at ≥ 80% agreement. The
  browser does not aggregate, vote, or infer one — it looks the code up (`web/lib/aggregate.ts`), because the rule that
  decided it lives in the pipeline and only there.

## Allocation: 100% is a statement, not a clamp (operator's instruction, 2026-11-02)

The builder used to enforce the whole in both directions: a row that would push the total past 100% was capped at the
room the other rows left, the notice explained it, and the fragment decoder refused any link whose percentages summed
above 100 — so an over-100 portfolio could not even be reloaded. The operator's instruction replaced that: **say what the
total is, never rebalance the fields relative to each other, and open the ledger only at exactly 100%.**

- **Rows hold what was typed.** The only ceiling left is a single row's own (100%, or $1bn in dollars). Editing one row
  never moves another; overshooting is a normal step on the way to a total, not an error.
- **The tally states the total in words**: `fully allocated`, `12.00% unallocated`, or `5.00% over 100%`. It is a live
  region, so a screen reader hears the total change as the visitor types.
- **"View the ledger" is inert until the total is exactly 100%**, with the reason beside it in words. It stays a link
  with `aria-disabled="true"` and a prevented click rather than a `disabled` button, because a control that disappears
  takes its explanation with it.
- **The URL keeps the number.** `fragment.ts` reads an over-100 total instead of refusing it, so a reload restores what
  is on screen. What an over-100 portfolio may not do is _answer for_ the numbers: `isComplete` is exact, so the ledger
  shows "these percentages do not add up to 100%" and computes no table from them.
- **Dollars are their own total**, so the ledger link is always live in dollar mode; an unfilled portfolio is not short
  of anything.

## Open questions — the operator's, not the agent's

- [`open`] **Chart or table only.** The table is the product right now. A treemap or bar strip of the top 10 is a visual
  answer to "what do I own"; it is not in the day-3 scope and would need its own budget line (no chart library on first
  paint).
- [`open`] **A manual theme override.** Automatic light/dark follows the OS on every surface — the app and the
  generated fund pages, which copy the same tokens — and `web/lib/theme.test.ts` now fails if either palette drops
  below WCAG AA text contrast, so the two schemes cannot drift apart silently. A visible toggle and a persisted
  preference are unbuilt, and no control for them appears anywhere; the operator did not ask for one, and a toggle
  over a working automatic setting would be a second place to get the theme wrong.
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
