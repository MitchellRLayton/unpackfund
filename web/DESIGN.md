# Design direction — provisional

**Status:** provisional, recorded 2026-10-29. Replaceable. The operator owns visual direction (ADR-0006); this file exists
so the next session inherits the reasoning instead of re-deriving it, and so a replacement has something concrete to
replace.

## What the page has to do

Show a number the visitor can check. Everything below follows from that: the ledger is a document, not a dashboard. No
hero, no gradient, no illustration, no marketing voice. One column of content, a table that reads like a table, and the
provenance of every number visible without a click.

## The six rules the build follows

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
6. **A chart is never one flat fill.** Every category a chart draws carries its own hue from a ramp that is gated for
   contrast and for colour-vision deficiency, and every category's number is printed beside it in the legend and in the
   table under the chart. A single grey for the whole bar is a defect, not a style: it asks the reader to decode
   position instead of colour and makes two adjacent categories one shape (operator, 2026-11-07: "I don't want this all
   grey, users need to be able to differentiate"). The hue is reinforcement; the printed name and number are the fact.

## Metadata first, method below the table (operator's instruction, 2026-11-02)

The complaint was about order, not about content: "too much information at the top of the page discussing
methodologies … all I really want are the metadata information you give in tables." The page was answering the right
question with its reasoning in front of its answer — a reader met the benchmark column's rules before the column they
describe, then had to scroll past them to reach the ledger.

`/x` now renders, in this order:

1. the `<h1>`, then one line: how many companies across how many funds (and how many held directly), plus the one fact
   that makes the weights legible — a weight is a share of the whole portfolio, so the column sums to the covered part,
   not to 100%;
2. `FreshnessStrip` and `MetricsList`, together and unchanged: those are the two tables the operator asked to see first;
3. the notices that carry state — unusable symbol, below the coverage floor, partial band, no benchmark — tightened to
   the sentence that matters, because a reader needs them _before_ the weights they qualify;
4. the `Companies` heading and the ledger;
5. one `<details>` ("How to read this page") under the table, holding every explanation that used to open the page: the
   benchmark column's four facts (what the column is, why `0.00%` is not "not owned", which way round the bracket
   subtracts, and that it is computed unrounded and rounded once), the cash sentence, the "what is not traced, and
   why" disclosure, the per-fund source table, and the closing N-PORT note.

Two rules make that an architecture rather than a tidy-up:

- **Nothing is deleted to shorten the page.** The measure of the change is that the first screen is the answer and the
  method is one click from it, not that the copy got smaller. `components/LedgerView.test.tsx` holds both halves — one
  paragraph of prose above the table, and the benchmark explanation inside the first `<details>` after it — so an edit
  that drifts a paragraph back up, or quiet-deletes one while tidying, fails a test instead of shipping.
- **Provenance still sits above the fold where it is the visitor's own data.** Rule 1 is unchanged for the strip
  (release, filing period, lag, coverage, not traced): that is the provenance of the table. What moved below the table
  is the _method_ of the comparison column — the VT filing link and the two-different-wholes reasoning. The table's
  caption still names the benchmark, the bracket's direction and the sign ink, because a caption is read with the
  table, so no row has a meaning that is only available one click away.

## The Companies table's caption is one line (operator's instruction, 2026-11-03)

The Portfolio workspace's `Your companies` table carried its whole method as a `<caption>`: eight sentences between the
section heading and the first row, explaining rank, weight, "Held by", "From your funds", the bar, the VT bracket and
its inks, the market tier, the export's scope and paging. It was accurate, complete, and unread — "too long and no one
is going to read this". The operator asked for it to be moved out of the way, or cut to something like "Benchmark: VT".

What shipped is both halves of that sentence:

- **The caption is one line**: what the table is, how it is sorted, and — when the release publishes one — the
  benchmark's ticker. `One row per company. Sorted by Your weight, largest first. Benchmark: VT.` A test holds it under
  120 characters, so it cannot grow back into a paragraph.
- **The method is a `<details>` under the table**, closed by default, holding the same facts: the column meanings, the
  bracket's direction and sign ink, the tier convention and its vintage, and the export's scope. It is the shape `/x`
  already uses (above), so the two pages teach the same gesture.

The operator accepted the cost in as many words — "It doesn't need to support screen readers either" — so the caption
no longer _is_ the table's description: a screen reader hears the short caption and reads the disclosure only if it
opens it. The disclosure is real, reachable content, keyboard included, and it is the only copy: do not "restore" the
long caption for accessibility. The count line above the table (`1,269 of 1,269 companies…`) and the pager below it
(`Showing rows 1–50 of 1,269 · page 1 of 26`) still say the two facts a reader might otherwise have got from the
caption.

## The table's scrollbar follows the viewport (operator's instruction, 2026-11-07)

The `Your funds` table is eight columns wide and does not fit the lens column, so it scrolls sideways. Its only
horizontal scrollbar was the native one at the bottom of the scroll box — and on a portfolio of more than a few funds
that box is taller than the screen, so the control sat below the fold. The operator, on a Windows machine with a
traditional mouse and no touchpad, had no way to move the table sideways except to drag a text selection across it:
"there is no easy way for me to trigger the scroll … the only user experience tool that exists today is a click-able
scroller (left-to-right) at the bottom, but it's buried very bottom where people might not see."

`components/TableScroll.tsx` replaces that scrollbar with one that sticks to the bottom of the viewport for as long as
the table is on screen, so the control is where the reader is looking rather than where the table ends. Measured on the
built export at 1280×800 with an eight-fund portfolio: the table is 956 px wide in a 785 px box, its bottom edge is
1,670 px down, and the rail sits at 774–792 px — 8 px off the viewport's own edge — from the first row to the last.

Four rules, because a scrollbar in the wrong place is easy to get wrong:

- **The native scrollbar is hidden, not duplicated.** The first version left it visible and added the rail beside it.
  On Windows, where a classic scrollbar takes real layout space and never fades, that put two horizontal bars one above
  the other at the end of the table — the operator saw it and asked whether both were needed. They were not: the scroll
  box now carries `scrollbar-width: none` plus `::-webkit-scrollbar { display: none }`, the same pair `.site-nav`
  already uses for its own horizontal overflow. The box stays a scroll container in every other respect, so a wheel, a
  trackpad gesture and the arrow keys all still move it.
- **It is a second control for one scroll box, not a second scroll box.** The rail drives the same `scrollLeft` as the
  table; there is one scroll position. It is `aria-hidden`, so a screen reader gets one scrollable region rather than
  two.
- **The table's own box is focusable** (`tabindex="0"`, `role="region"`, named), which is what makes the arrow keys
  scroll it. A scroll box a keyboard cannot reach is a scroll box half the readers cannot use (WCAG 2.1.1), and the
  rail is not a substitute for it — it matters more now that the browser draws no scrollbar to focus.
- **The thumb is a graphic that carries a distinction** — how much of the table is off screen — so it answers to the
  3:1 non-text floor, not to taste. It is `--graphite` on `--surface`, and `lib/theme.test.ts` holds that pair in both
  schemes. No new token: the palette is the operator's.
- **It appears only when there is something to scroll to.** A table that fits draws no rail, and the rail is hidden in
  print, where the whole table is the artefact.

The rail is applied to the `Your funds` table only. The other lenses' tables are unchanged; the component is generic so
that a second table can adopt it without a second implementation.

## Tokens

One palette, defined once in `app/globals.css` as OKLCH custom properties and re-declared for the dark scheme inside
`@media (prefers-color-scheme: dark)`. The app and the generated fund pages read that one file — `pipeline.fund_pages`
copies `globals.css` verbatim into every page's `fund-page.css` — so a token that moves in the app moves on the static
page at its next build, and the two surfaces cannot drift into different palettes.

The operator's palette, recorded 2026-11-07, is the table in _Tokens_ below — values for both schemes, one row per
token, checked against `app/globals.css` on 2026-11-09. **This section carried a second, inline copy of those numbers
until then and the two had drifted**: the copy named graphite `55% 0.01 260`, tier-us `55% 0.13 250`, tier-dm
`76% 0.11 85`, tier-em `58% 0.12 60` and tier-none `70% 0 0`, while the stylesheet shipped `48%`, `50%`, `60% 0.12 85`,
`38% 0.15 55` and `50% 0 0`. A palette written twice is a palette that disagrees with itself; the table is now the only
record in this document, and `app/globals.css` is the only record anywhere.

**The stylesheet moves every value that has to move, and both schemes have moved, because a token is a value with a job
and the job is measured.** Words answer to WCAG AA 4.5:1, a 6 px edge or a bar fill answers to 3:1 as a graphical
object, and two hues a reader has to tell apart answer to a dE floor. On paper the contrast floor does the moving:
`graphite` 55% measures 4.45:1, a hair under the text floor, so it ships at 48%; `tier-us` 55% (4.43:1) and `tier-em`
58% (4.07:1) ship at 50% and 38%; `tier-none` 70% (2.46:1) and `tier-dm`'s 76% sand (1.98:1) ship at 50% and 60%. On the
dark page that floor passes the spec's own values — graphite 68% measures 6.60:1, tier-us 6.66:1, tier-dm 7.66:1,
tier-em 5.51:1, and only tier-none 55% fails at 3.91:1 — so the dark moves answer the separation floor instead: two pale
ochres on a 17% page had to be pulled apart, which is why dark ships graphite 70%, tier-us 70%, tier-dm 84%, tier-em 60%
at hue 50, tier-none 66%. `web/lib/theme.test.ts` recomputes those pairs from the stylesheet itself in both schemes; the
measured pairs are the test, not this paragraph.

| Token                                                   | Light (dark)                                                                                                                 | Job                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `--paper`                                               | `oklch(97% 0.012 85)` (`17% 0.015 260`)                                                                                      | the page                                                |
| `--surface`                                             | `oklch(99% 0.006 85)` (`21% 0.015 260`)                                                                                      | a flat block raised off it: table header, notices       |
| `--ink`                                                 | `oklch(22% 0.02 260)` (`93% 0.012 85`)                                                                                       | body text                                               |
| `--graphite`                                            | `oklch(48% 0.01 260)` (`70% 0.01 260`)                                                                                       | labels, notes, secondary values                         |
| `--rule` / `--rule-strong`                              | `--graphite` at 24% / 45%                                                                                                    | hairlines and table rules                               |
| `--wash` / `--wash-strong`                              | `--graphite` at 7% / 13%                                                                                                     | an empty track, a quiet fill                            |
| `--tier-us` / `--tier-dm` / `--tier-em` / `--tier-none` | `50% 0.13 250` / `60% 0.12 85` / `38% 0.15 55` / `50% 0 0` (dark: `70% 0.12 250` / `84% 0.1 85` / `60% 0.13 50` / `66% 0 0`) | the only hues with a geographic meaning                 |
| `--tier-us-ink` … `--tier-none-ink`                     | the same hues, darker in light and brighter in dark                                                                          | a tier's words, where text answers to 4.5:1             |
| `--alert` / `--alert-ink` / `--alert-wash`              | `58% 0.19 30` and relatives (`68% 0.17 30`)                                                                                  | errors only, and never without an icon and words        |
| `--whole`                                               | `55% 0.18 264` (`74% 0.15 264`)                                                                                              | the holdings meter's bar at exactly 100%                |
| `--delta-up` / `--delta-down`                           | green / red, each adjusted until it clears its floor                                                                         | the `In VT` bracket's sign — the sign is always printed |
| `--tint-direct` / `--tint-direct-hover`                 | pale violet, deepened in the dark scheme                                                                                     | the ledger row of a stock the visitor holds directly    |
| `--band-giant` … `--band-micro`                         | five-step ordered ramp — see _Charts and the size-band ramp_                                                                 | the Company size bar's five bands, largest to smallest  |

The coverage chips, the sorted column and the direct-row tint are all reinforcement over text that already says the
fact. Nothing in the palette carries a meaning on its own (rule 3).

## Charts and the size-band ramp (operator's instruction, 2026-11-07)

The operator's rules for charts, recorded with the tokens above: **stacked horizontal bars for parts of a whole — no
pies; inline row bars on one scale; overlap as printed-number tables; every chart has its table, and the table is what
prints.** A chart is the glance; the table under it is the record. A chart with no table is an unverifiable number.

The rule that made this section necessary is rule 6: **a chart is never one flat fill.** The Company size bar shipped
with every band painted `--tier-none` — one grey bar, separated only by position — and the operator could not tell the
bands apart ("I don't want this all grey, users need to be able to differentiate"). It now draws five hues from the
`--band-giant` … `--band-micro` ramp, one per band, and the legend under it repeats each band's name and share. The
country bar keeps the tier hues because there the hue _is_ the geography.

The ramp is an **ordered** categorical ramp — one step per band, largest to smallest — and it is deliberately **not** the
tier hues: a band is a size class and a tier is a geography, and one palette for both would imply a company's country
from its size. Two measured constraints shaped the values:

- **Every fill clears 3:1 on the page.** A segment is a graphic a reader has to find; a pale fill on cream is not a
  band. This caps how light a light-scheme fill can be, which is why the five steps alternate deep and light rather than
  running one lightness ramp.
- **Every pair that touches clears 28 dE of separation, and 25 after simulating deuteranopia, protanopia and
  tritanopia.** Inside that 3:1 cap there is not enough lightness range for five steps of one hue to be far enough
  apart, so the ramp changes hue as it goes; a pair that is close in lightness is never adjacent. `giant` and `mid` are
  both deep and sit two steps apart, which is the arrangement the test permits.

`web/lib/theme.test.ts` holds both floors in both schemes, and `pipeline/tests/test_fund_pages_size.py` holds the page's
half: every band draws its own segment class, the legend swatch reuses it, and a computed bar still prints every name
and number. Colour is reinforcement in both — remove it and the page still reads.

**Row shading (operator's instruction, 2026-11-02).** A company the visitor holds as a stock, not only through a fund, gets
a pastel light-purple row — quiet enough that the numbers still lead, distinct enough to find the single-stock positions at
a glance. Three constraints, each with a check behind it:

- **Reinforcement, not the message.** The row already names the direct position in words — `You · NVDA` in the attribution,
  and `direct` in the Funds column when no fund holds it — and the table's caption gains one sentence saying what the
  shading means. Colour is never the only carrier (rule 3), so a forced-colours, monochrome, or screen-reader reader loses
  nothing.
- **A solid tint, not a low-alpha layer.** Declared per scheme in `app/globals.css`, so it composites the same over the page,
  over the hover, and in dark mode, where a light pastel over `oklch(17% 0.015 260)` would glow instead of shade.
- **Contrast is a gate.** `lib/theme.test.ts` checks `--fg` and `--muted` against both tints in both schemes; the tightest
  pair is 4.89:1 (light hover, secondary text), above the 4.5:1 AA floor.

Type is three self-hosted faces, subset to Latin and loaded with `font-display: swap`, with their OFL licences beside
them in `public/fonts/`: **Inter** for the interface and every table, with tabular figures wherever two numbers are
compared; **Newsreader** for page titles and the answer strip only, so the sentence a page exists to say is the one
thing that looks like a headline; **IBM Plex Mono** for tickers and codes. The scale is six steps —
`--text-12/14/16/20/28/40` — with the ledger at 12–14 px, body at 16 and a page title at 28. `--row: 2rem` fixes the row
height for the day-4 windowing pass.

## Country edge (operator's instruction, 2026-11-02)

The measurements quoted below are the ones taken when each step was tested, so they name the hex values that were current
then; the tokens that ship are the OKLCH values in the table above, and `lib/theme.test.ts` measures those, not these.

Geography is a second axis on the ledger, and it is a **separate channel** because one background cannot carry two
meanings: the row _background_ keeps meaning position kind — a company the visitor holds directly as a stock, purple —
and geography is drawn as a **6 px left edge on the row's first cell** plus the country's **flag** in the row's second
line. The rules:

- **The tag prints the flag and the code, and the code is the fact.** The tag is `🇺🇸 US` — the country's flag, then
  the two-letter code the tag has always printed. The flag is a _derivation_, not data: each letter of the code becomes
  its Unicode "regional indicator" symbol, so the mark needs no table, no fetch and no pipeline step, and a code that
  arrives tomorrow gets its flag for free (`lib/country-flag.ts`). The operator's instruction on 2026-11-02 was both
  marks, not the flag instead of the code ("I do want the flag and the country code displayed for each, even with the
  awkward screen reader behavior it is fine"), so the glyph is **decoration and the code is the fact**: the flag is set
  `aria-hidden`, a screen reader hears `US` exactly as it did before the flag existed, and a monochrome print still
  carries the code. The caption gains one sentence saying what the pair and the edge mean, and the edge repeats the
  domicile in colour so a reader scanning rows can find it at a glance (rule 3). Blue is the United States, ochre for
  the developed markets elsewhere, and a deeper ochre for emerging markets; that mapping is stated in the caption,
  never implied by hue.
- **On Windows the flag is the code twice, and that is the accepted cost.** Windows' Segoe UI Emoji ships no flag
  glyphs, so Chrome and Edge there draw the regional-indicator pair as two boxed letters — a Windows tag reads `US US`.
  The alternative was printing only what the platform can draw, which would make the tag's contents differ per
  platform; printing both and letting the duplicate show is the honest version, and the caption names the pair rather
  than promising a flag. Recorded, not hidden: this is the one rendering the operator accepted knowing it.
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
- **The difference against the benchmark is green above and red below** (operator's instruction, 2026-11-02, after
  seeing this cell in the geography ink: "I prefer the green and red indicators as a positive or negative relative to
  VT benchmark … use those neon green and neon red colorations"). The bracket in `In VT` — `4.06% (-2.54%)` — now reads
  as an indicator: `--delta-up` when you hold more of the company than the benchmark does, `--delta-down` when you hold
  less, and `--muted` at an exact match, because a difference of zero has no side to be on and an ink for "level" would
  be a default. The hues are the searched neon pair, [neon green `#39ff14`](https://en.wikipedia.org/wiki/Shades_of_green)
  and [neon red `#ff073a`](https://htmlcolorcodes.com/colors/neon-red/), and each scheme takes the value it can carry:
  the light scheme keeps the hue and the saturation but darkens until the text floor clears — `#39ff14` measures
  **1.36:1** on the page and 1.07:1 on the direct-position hover tint, `#ff073a` 3.93:1 and 3.10:1, all under 4.5:1 —
  so it ships `#0a6f1c` (6.36:1 on the page, **5.01:1** at worst) and `#c4002b` (6.21:1, **4.89:1**); the dark scheme
  takes the neon itself, where `#39ff14` is 13.96:1 and needs no lifting, and the red is raised one step with its hue
  unchanged (`#ff4d5e`, 5.84:1 on the page and 4.81:1 on the tinted row) because `#ff073a` is 3.97:1 on the tint.
- **Green against red is the one pair this palette allows to fail the colour-vision gate, and only because it is never
  the carrier.** The gate exists to catch a _distinction that would otherwise be lost_; here the sign is printed —
  `formatSignedShare` always renders `+` or `-`, an exact match prints none — the caption states green-for-more and
  red-for-less in words, and a component test asserts that every coloured bracket carries its sign. So a deuteranope
  reads the same table as everyone else, and the ink is reinforcement rather than information. `lib/theme.test.ts`
  lists the reason beside the gate so the exclusion is not mistaken for an omission, and the rule that the colour never
  carries the fact alone is the condition of the exception (`static-xray-frontend` §4a, §8).

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
- **The bracket left the geography channel, so its tier question is closed** (2026-11-02). While the bracket wore the
  domicile ink it stayed American-or-not, because a third _text_ ink could not clear both floors at once: above 4.5:1 the
  two ochre inks are confined to L\* 18-42, capping their separation at dE ~22, under the 25 the gate requires, and the
  emerging stripe is itself 3.24:1 in the dark scheme. The operator then asked for a sign indicator instead, so the ink
  now answers to the arithmetic and the geography axis belongs to the 6 px edge alone — one channel per meaning, no
  shared cell, and no third tier to design.
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
  colourless hid a decision that _was_ made, so it is not nothing either. The row keeps its flag (and its code, on a
  platform that draws letters), gets `data-tier="OTHER"` and the **solid** neutral edge, and the caption names both
  neutral states. The tone is a
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

### The total's number and its bar (operator's instruction, 2026-11-06)

Three changes to the same block, on one instruction: "a bigger number for indicating percentage and a red / royal blue
status indicator of the bar itself, blue completes it fully at 100% and red for either over or under shooting it", plus
"the green/red validator … isn't there anymore, can you add it again".

- **The percentage is the pane's big number.** `70.00%` is set at `--text-28` (28px) and the whole it is a share of —
  `of 100.00%` — stays at label size beside it. The number is what the visitor is steering; at label size it read as a
  caption about the word `Total` rather than the total itself.
- **The bar is the state.** `meter__fill` is `--alert` (red) whenever the portfolio is not exactly 100% — short _or_
  over — and `--whole` (a royal blue, `oklch(55% 0.18 264)`, `oklch(74% 0.15 264)` in the dark scheme) at exactly 100%.
  Over-100 still fills the track rather than overflowing it: the width is clamped, and the red plus the words carry the
  direction.
- **The validator's ink is back.** The workspace redesign dropped the red/green tally the old builder had; the sentence
  `fully allocated` / `10.00% unallocated` / `20.00% over 100%` now wears `--danger` while short or over and `--ok` at
  exactly 100%, exactly as the 2026-11-02 instruction described. Colour is reinforcement again, never the only carrier:
  the sentence says the state in words in both cases, and `Workspace.test.tsx` pins all three states (whole, short,
  over) on the bar and on the ink.

## Open questions — the operator's, not the agent's

- [`open`] **Charts in `/x`.** The ledger is a table, and the fund pages now carry two bars (market split, Company
  size) under the rules above. A chart inside the portfolio workspace — a bar strip of the top 10, a treemap — is still
  unbuilt and still a separate budget line; when it is built it inherits rule 6 rather than starting a new palette.
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

Change the tokens in `app/globals.css`, keep rules 1–3 and 6, and re-run the ledger in a real browser at 1280 px and
375 px. Rules 1–3 and 6 are correctness: a redesign that hides the filing period, reframes weight as a share of a fund,
encodes coverage in colour alone, or paints a chart in one flat fill would be a product bug, not a taste difference.
