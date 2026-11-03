# The Unpacking — phase 1 animatic

The 7.5-second first-visit intro for UnpackFund, as a **timing proof**: real DOM,
real fonts, the real GSAP master timeline, plain divs and circles where the
particles will go. No WebGPU in here yet — that starts once the timing is signed
off.

```bash
pnpm --filter @unpackfund/intro dev       # http://localhost:5173
pnpm --filter @unpackfund/intro build     # tsc --noEmit && vite build → dist/
pnpm --filter @unpackfund/intro deploy    # demo Worker: unpackfund-animatic
```

The demo Worker is `wrangler.animatic.jsonc` at the repo root (Cloudflare Worker
with Static Assets, `intro/dist`, `workers_dev` only). It is **not** the product
deploy: nothing here touches `unpackfund.com`.

## Review knobs (query string)

| Knob | Effect |
|---|---|
| `?intro=force` | play even though this browser has seen it (`?again` is the same) |
| `?intro=off` | never play |
| `?t=2.4` | build, then freeze at 2.4 s — for stills |
| `?paused=1` | build and hold on frame 0 for scrubbing |
| `?speed=0.25` | start at a slower playback speed |
| `?theme=dark` | pin the dark palette |
| `?reduced=1` | take the reduced-motion path without changing an OS setting |

`_review.html?set=phones` / `?set=wide` renders the stills grid used for review.

## What is real here, and what is a stand-in

- **Real:** the page (header, h1, prose, builder form, footer notice), the fonts,
  the master timeline and every beat boundary, the caption with both funds'
  filing dates, the odometer counter (818 → 745), the handoff onto the real input,
  the skip and replay controls, first-visit-only storage, reduced-motion path.
- **Stand-in:** the field is 120 sampled holdings packed in JS (`layout.ts`)
  instead of the baked `holdings.bin` and the GPU packing pass; labels are 12
  tickers from the sample; the two funds are hard-coded in `sample.ts`.

`scripts/bake-intro.ts` replaces `sample.ts` in phase 2 and reads the real
N-PORT release. The animatic's numbers are the real pair's numbers (SPY 501 ×
VGT 317, 73 shared, 745 distinct) so the counter and the caption tell the truth
even while the dots are sampled.

## Timing (measured, not asserted)

The readout in the transport is computed from the timeline, not typed in. Each
beat's *content window* is the first and last tween the builder registered for it,
including stagger tails.

| Beat | Brief | Content | Overlap |
|---|---|---|---|
| Paper | 0.000–1.250 | 0.000–1.190 | — |
| Parcel | 1.250–2.500 | 1.000–2.500 | 190 ms |
| Spill | 2.500–3.750 | 2.300–3.750 | 200 ms |
| Merge | 3.750–5.000 | 3.550–5.000 | 200 ms |
| Pull-back | 5.000–6.250 | 4.800–6.250 | 200 ms |
| Handoff | 6.250–7.500 | 6.050–7.500 | 200 ms |

Every overlap sits inside the brief's 150–250 ms band, and the run is 7.5 s.

**Every cue is a fraction of its beat** — `T("spill", 0.4)` is 40% of the way
through the spill beat, and a negative fraction reaches back into the beat
before it, which is how the overlaps are built rather than hoped for. Re-timing
the run is an edit to `STORY` in `src/timeline.ts`; the choreography follows.

## Budgets

| Asset | Raw | Gzipped |
|---|---|---|
| `index.html` | 4.0 kB | 1.7 kB |
| CSS | 17.9 kB | 4.3 kB |
| app JS | 32.2 kB | 11.6 kB |
| GSAP chunk | 98.7 kB | 38.7 kB |
| **JS total** | | **≈ 50 kB** of the 250 kB budget |

Fonts are subset to Latin and preloaded; the intro is a separate code-split chunk
in the real integration.

## Open questions carried forward

1. **GSAP licence — settled 2026-11-03.** The operator confirmed the standard
   GSAP licence covers this use, so `SplitText`, `ScrambleText`, `DrawSVGPlugin`
   and `MorphSVGPlugin` stay.
2. **Which two funds to bake.** The animatic uses SPY × VGT because they share
   73 companies and produce the 745 distinct total; the bake script needs the
   final answer.
3. **On-screen copy.** The run currently shows only the two fund names and their
   filing dates.
