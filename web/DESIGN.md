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
4. **Quiet chrome.** One accent colour, used for the primary action only. Rules are 1 px, surfaces are flat, corners
   are 2 px. Density over decoration: a 2rem row height holds 1,125 companies and still reads.
   The one exception is attribution: a company row always names every fund that holds it, as chips that wrap, so a
   portfolio with five or more funds grows the row by a line instead of truncating to `+N more`. Attribution outranks
   uniform density — a hidden fund is a wrong answer, a taller row is not.
   The second is the current-section pill in the header — a light grey block with a soft shadow and a 0.4 rem radius
   (see _The frozen header_): "which part of the app am I in" is a location, and a location is worth a shape rather than
   a bolder font.
5. **Numbers are tabular.** `font-variant-numeric: tabular-nums` on every weight, count, and metric so columns align
   without a grid of spans.

## Tokens

Defined once in `app/globals.css` as custom properties, light and dark through `prefers-color-scheme`.

| Token                                   | Light                       | Dark                         | Use                                                  |
| --------------------------------------- | --------------------------- | ---------------------------- | ---------------------------------------------------- |
| `--bg`                                  | `#ffffff`                   | `#0d1117`                    | page                                                 |
| `--surface`                             | `#f6f8f9`                   | `#151b22`                    | table header, notices                                |
| `--fg`                                  | `#11181c`                   | `#e8edf0`                    | body text                                            |
| `--muted`                               | `#55636b`                   | `#9aa7b0`                    | labels, notes, secondary values                      |
| `--rule`                                | `#d7dde1`                   | `#232b33`                    | hairlines, table rules                               |
| `--accent`                              | `#0f6d78`                   | `#5ec8d4`                    | primary action                                       |
| `--warn` / `--warn-soft`                | `#7a4b00` / `#fdf3e2`       | `#f0b429` / `#2e2413`        | warnings, partial coverage                           |
| `--ok`                                  | `#17693a`                   | `#6fce8f`                    | the ledger gate once the total is exactly 100%       |
| `--tint-direct` / `--tint-direct-hover` | `#f2ecff` / `#e9e0fd`       | `#1d1930` / `#262038`        | the ledger row of a stock you hold directly          |
| `--country-us`                          | `#3b6ea5`                   | `#6c9bd2`                    | the row's left edge for a US-domiciled company       |
| `--country-dm`                          | `#9c7025`                   | `#d9a54a`                    | the edge for a developed market outside the US       |
| `--country-em`                          | `#4a3410`                   | `#8b6d40`                    | the edge for an emerging market                      |
| `--country-other`                       | `#74746b`                   | `#b0b0a6`                    | the edge for the two states that have no market tier |
| `--country-us-ink`                      | `#35638f`                   | `#6c9bd2`                    | the `In VT` bracket on a US company's row (text)     |
| `--country-intl-ink`                    | `#7f5a1c`                   | `#d9a54a`                    | the same bracket for any other domicile              |
| `--pill-bg`                             | `#c5c6c7`                   | `#192028`                    | the current section's pill (20% off `--surface`)     |
| `--pill-shadow`                         | `0 1px 2px rgb(0 0 0 / 8%)` | `0 1px 2px rgb(0 0 0 / 45%)` | the current section's pill, under the bar            |

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
and geography is drawn as a **6 px left edge on the row's first cell** plus the two-letter country code as **text** in
the row's second line. The rules:

- **Text carries the meaning; colour reinforces it.** The code is real text in the row (`US`, `TW`), so a screen
  reader reads it and a printed page keeps it, and the table's caption gains one sentence saying what the tag and the
  edge mean. The edge repeats the code in colour so a reader scanning rows can find a domicile at a glance (rule 3).
  Blue is the United States, ochre for the developed markets elsewhere, and a deeper ochre for emerging
  markets; that mapping is stated in the caption, never implied by hue.
- **A row can be both.** A stock held directly that also has a decided domicile keeps its purple background and gains
  the edge: `data-direct` and `data-tier` sit side by side on the same `<tr>`, and neither channel borrows the
  other's encoding. The stripe is an inset `box-shadow` on the first cell rather than a `tr` border, which is
  unreliable under `border-collapse: separate`, and inset shadow costs no layout.
- **Wide and strong enough to be found (operator's instruction, 2026-11-02, "slightly wider … more prominent").** The
  channel first shipped as a 3 px pastel edge, and the operator could not tell the domiciles apart. The measurement
  agreed: `#9dc2ea` on the page is **1.85:1**, under the 3:1 non-text floor, so at 3 px the edge was a suggestion
  rather than a signal. The edge is **6 px** (the cell's own 0.75 rem left padding leaves 6 px of gap to the company
  name, so nothing moves) and `lib/theme.test.ts` holds every edge to 3:1 on every background a row can have — `--bg`,
  `--surface`, both direct tints — in both schemes, so it cannot silently fade again.
- **Slate blue against ochre (operator's instruction, 2026-11-02, adopting a recommended palette).** Blue against
  yellow is the one colour pair that survives every common colour-vision deficiency, and neither hue means gain, loss,
  or warning in portfolio software — which a green, a red, or a bright orange would. The pair this replaces was blue
  against periwinkle-violet, and it collapsed for deuteranopes: simulated, the two inks sit 35.9 apart in CIE Lab
  normally but only **7.5** for deuteranopia (14.7 protanopia) — one colour to those readers. The ochre pair holds
  **81.7 / 83.4 / 79.8** (normal / deuteranopia / protanopia) and 87.3 / 89.6 / 84.9 in the dark scheme. Light:
  `#3b6ea5` 5.30:1 on the page, 4.18:1 at worst; `#9c7025` 4.41:1 and 3.48:1. Dark: `#6c9bd2` 6.54:1 / 5.39:1 and
  `#d9a54a` 8.50:1 / 7.01:1.
- **One value deviates from the recommendation, and that is recorded here rather than hidden.** The recommended light
  ochre `#c08a2e` measures 3.04:1 on white but **2.85:1** on `--surface` and **2.39:1** on the direct-position hover
  tint — under the floor on a hovered row, the same defect the widening fixed. `#9c7025` is the same hue and
  saturation one step darker, 4.41:1 on the page and 3.48:1 at worst, and at L\* 50.4 it sits closer to the blue's
  45.4 than the recommendation's ochre did (61.3, visibly paler than the blue it was paired with). Dark-scheme values
  are the recommendation's, unchanged: both pass with room to spare.
- **The difference against the benchmark wears the same ink** (operator's instruction, 2026-11-02: "the delta of
  plus or minus against benchmark VT … in the same color code as the US vs international"). The bracket in `In VT`
  — `4.06% (-2.54%)` — is the one cell where a reader compares two numbers rather than reading one, so it is where the
  domicile is worth repeating: the row's ink at the start and at the comparison, and "which names am I light on, and
  are they American or not" can be scanned down a column instead of across every row. It is a second use of the pair,
  not a new hue, a new column or a new metric, and the meaning is still in words: the sign is rendered, the caption says
  which way round it is, and the code is spelled out. The inks (`--country-*-ink`) are **one step darker than the
  stripes** because text answers to 4.5:1 where a 6 px bar answers to 3:1 — the stripe values measure 4.18:1 (blue) and
  3.48:1 (ochre) on the darkest row background and would fail as text, which `lib/theme.test.ts` proves by listing them
  in `TEXT_PAIRS` rather than `UI_PAIRS`. `#35638f` is 6.30:1 on the page and 4.96:1 at worst, `#7f5a1c` 6.21:1 and
  4.89:1; separation survives the darkening (69.6 dE, and 70.8 / 67.9 / 53.3 simulated). In the dark scheme the blue and
  the developed ochre already clear 4.5:1, so there the ink and the edge are the same value. A row with no agreed
  domicile keeps `--muted`: an ink for "unknown" would be a default, which is the one thing this channel refuses to do.
- **The developed/emerging split is two shades of the ochre, never a third hue** (shipped 2026-11-02 on the
  operator's instruction). A third hue would make the reader compare three colours instead of two and lose the
  US-versus-international read at a glance. The binding constraint is the 3:1 floor: two ochres that each clear it on
  every row background are confined to roughly L\* 18-54 in the light scheme, which caps their separation near dE 37.
  The shipped pair sits at the ends of that band — `#4a3410` at L\* 23.5 against `#9c7025` at 50.4 — measuring
  **dE 34.2 normally and 30.0 at worst in simulation** (deuteranopia 34.2, protanopia 33.6, tritanopia 30.0), at
  9.24:1 on the darkest row background. Dark: `#8b6d40` against `#d9a54a`, **33.2 / 26.4**, 3.24:1 at worst. Emerging
  is the deeper shade in both schemes, so the meaning does not flip at night. `lib/theme.test.ts` holds all three edges
  and all three pairs: 40 uncorrected between blue and either ochre, 30 between the two ochres (40 is unreachable at
  this contrast budget, not waived), and 25 after simulation for every pair.
- **The bracket ink did not gain a third tier** (decided with the split, 2026-11-02). It stays American-or-not: a third
  text ink cannot clear both floors at once — above 4.5:1 the two ochre inks are confined to L\* 18-42, which caps their
  separation at dE ~22, under the 25 the colour-vision gate requires — and the emerging stripe is itself 3.24:1 in the
  dark scheme, so a matching ink could not be text at all. So the bracket reinforces the primary axis and the 6 px edge
  carries the developed/emerging one, which is the axis a reader scans for. The token comment records the same reason.
- **Absence still means no answer — but it now says so.** A company the filings disagree about, or one held only by
  funds that file no country, is absent from the map: no tag, no tier, no invented domicile. What changed on
  2026-11-02 is the _rendering_: the operator's report was a list of holdings that "don't have a color to them", and a
  blank edge is indistinguishable from a rendering failure. So an unplaced row carries
  `data-country-missing="true"` and draws the neutral ink **dashed** — same 6 px channel, same token as `OTHER`, so
  the two unclassified states are one idea told apart by pattern rather than by a fourth colour. The caption sentence
  still appears only when a row actually carries a code, and a release that publishes no country object renders
  exactly as it did before the channel existed: no tag, no edge, no sentence, no extra fetch.
- **`OTHER` keeps the code and takes the neutral edge.** A domicile neither provider calls developed or emerging —
  Cayman, Bermuda, the British Virgin Islands, Argentina, Russia, frontier Europe — is 4.2% of the release's
  classified companies. Colouring those as emerging would be an invention, so it is not a tier; leaving them
  colourless hid a decision that _was_ made, so it is not nothing either. The row keeps its two-letter code (text),
  gets `data-tier="OTHER"` and the **solid** neutral edge, and the caption names both neutral states. The tone is a
  measured warm grey — 3.82:1 on the darkest row background, ΔE 29.8+ from every tier ink in both schemes, simulated
  worst case — because a grey that sat closer to the ochre would read as a third ochre.
- **The classification is a convention, and the convention is named** (`web/lib/country-tier.ts`). The edge answers
  "developed or emerging?", which is a publisher's judgement rather than a fact: FTSE, MSCI, S&P DJI and the IMF
  disagree about nine countries. This site follows the **FTSE Russell equity country classification as of 2026-11-02**,
  because VTI, VT and VXUS are FTSE-indexed, so the label means what it means on the fund's own page — Korea and Poland
  developed, Taiwan emerging, Greece developed since 21 September 2026, Peru frontier. The table is written for this
  site to FTSE's published criteria and cross-checked against the IMF's October 2026 advanced list and MSCI's
  classification; no FTSE document, table or data file is reproduced, nothing is fetched at build or run time, and the
  divergences are recorded in the module rather than resolved silently. `lib/country-tier.test.ts` pins the published
  counts (26 developed, 23 emerging), the disjointness, the nine disputed countries, and the offshore domiciles that
  must stay `OTHER`.
- **Where the codes come from.** The pipeline's `companies/countries.json`: each code is the `invCountry` of the
  company's holders' N-PORT filings decided by **value-weighted majority**, published only at ≥ 80% agreement. The
  browser does not aggregate, vote, or infer one — it looks the code up (`web/lib/aggregate.ts`), because the rule that
  decided it lives in the pipeline and only there.

## The frozen header (operator's instruction, 2026-11-02)

The header is `position: sticky; top: 0` on **every** screen: the section you are in is a location, so it stays on
screen while the page scrolls under it. The rules that keep it from becoming decoration:

- **Opaque, with a rule and nothing else.** `--bg` plus the 1 px `--rule` seam. No translucency, no blur, no shadow: a
  bar that tints the rows of a dense table as they pass reads as a rendering fault, and on a page whose whole job is
  legible numbers a stray tint is one more thing to doubt.
- **The current section is a block, not a bold word.** `aria-current="page"` (unchanged, so a screen reader still
  announces it), `--fg` at weight 600, `--pill-bg` behind it, `--pill-shadow` under it, 0.4 rem corners. The colour is
  reinforcement; the attribute is the meaning (rule 3).
- **The pill is a step off `--surface`, not `--surface` itself** (operator's instruction, 2026-11-02: "20% darker
  pill"). `--pill-bg` is `--surface` mixed 80/20 with black — `#f6f8f9` → `#c5c6c7`, which is 1.71:1 against the page
  instead of 1.04:1, so the block is visible without becoming a second accent; body text on it measures 10.48:1. Table
  headers and notices keep the quiet `--surface`. In the dark scheme the 20% goes the other way (`#151b22` → `#192028`):
  darkening a pill on a `#0d1117` page moves it _toward_ the page and erases the block, so the same distance away from
  `--surface` is the faithful translation, and `lib/theme.test.ts` checks `--fg` on `--pill-bg` in both schemes.
- **Every label carries the pill's padding.** Otherwise the row shifts sideways the moment you change section, and the
  nav overflows at 320 px. With the padding and `flex-wrap` the bar takes two rows on a narrow phone and holds one line
  above 400 px.
- **One segment, one pill.** A section matches a path _segment_ (`/c` must not claim `/compare`), which the background
  makes non-negotiable: two lit labels would say the visitor is in two places at once. `components/SiteNav.test.tsx`
  holds it.
- **The skip link sits above the bar** (`z-index: 30` against the header's `20`), or the first Tab would land behind it.

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
- **The reason is red until the portfolio is whole and green once it is** (operator's instruction, 2026-11-02). Same
  sentence in both states — `The ledger opens at exactly 100%.` — so it reads as the rule it is, and only the ink
  changes: `--danger` (#8c1d18, 9.11:1 on white) while short or over, `--ok` (#17693a, 6.73:1) at exactly 100%, with
  `#ff9c96` / `#6fce8f` in the dark scheme. Colour is reinforcement here, never the only carrier: the tally already says
  `5.00% over 100%` or `fully allocated`, and the link itself is inert or live (rule 3). `lib/theme.test.ts` checks both
  inks against the page in both schemes.
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
