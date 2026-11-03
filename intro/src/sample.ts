/**
 * Sample holdings for the animatic.
 *
 * Phase 1 draws dots, not the real baked field: the point is to judge the
 * *timing*, so the data only has to be structurally honest. The structure is
 * taken from the real pair the bake will use — SPY × VGT in the 2026-10-30
 * release — and the numbers that appear on screen (501 / 317 / 73 / 745 / 818)
 * are the real ones the subagent measured from `funds/SPY.json` and
 * `funds/VGT.json`, so the counter is not inventing a story.
 *
 * What is *not* real here: the dot list is a 120-dot sample of the 818, the
 * sector ids are assigned, and the weights are a plausible power law rather
 * than the filed basis points. `scripts/bake-intro.ts` replaces this file's
 * exports with the packed artifact after the pair is approved.
 */

import { mulberry32 } from "./util";

export type FundMeta = {
  ticker: string;
  name: string;
  issuer: string;
  /** The N-PORT filing date the caption prints. */
  filedAt: string;
  filedLabel: string;
  /** The period the filing describes. */
  asOf: string;
  holdingsCount: number;
};

export type DotSpec = {
  /** Company identity — the only correct join across funds (a CIK). */
  key: string;
  /** 0 = first card (left/top), 1 = second card (right/bottom). */
  fund: 0 | 1;
  sector: number;
  /** Filed basis points; drives the dot's radius. */
  weightBp: number;
  /** Present in both funds — this dot has a partner and a fusion. */
  shared: boolean;
};

export const FUNDS: readonly [FundMeta, FundMeta] = [
  {
    ticker: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    issuer: "State Street",
    filedAt: "2026-08-28",
    filedLabel: "28 Aug 2026",
    asOf: "2026-06-30",
    holdingsCount: 501,
  },
  {
    ticker: "VGT",
    name: "Vanguard Information Technology Index Fund",
    issuer: "Vanguard",
    filedAt: "2026-10-29",
    filedLabel: "29 Oct 2026",
    asOf: "2026-08-31",
    holdingsCount: 317,
  },
];

/** Real counts from the pair, so the counter tells the true story. */
export const TOTALS = {
  /** SPY's distinct companies. */
  a: 501,
  /** VGT's distinct companies. */
  b: 317,
  /** Held by both. */
  shared: 73,
  /** Distinct after the merge — what the odometer lands on. */
  union: 745,
  /** The count before any fusion: 501 + 317. */
  sum: 818,
} as const;

/** 120 dots animated out of 818; the ratio is in the transport readout. */
const SAMPLE = { a: 68, b: 52, shared: 21 } as const;

/** The names the mono labels scramble to — the largest positions in both funds. */
export const TOP_LABELS = [
  "NVDA",
  "AAPL",
  "MSFT",
  "AVGO",
  "MU",
  "AMD",
  "GOOGL",
  "AMZN",
  "META",
  "TSLA",
  "ORCL",
  "CRM",
] as const;

/** Sector ids 0-10, the eleven hues. Tech-heavy because VGT is half the story. */
const SECTOR_BY_TICKER: Record<string, number> = {
  NVDA: 7,
  AAPL: 4,
  MSFT: 7,
  AVGO: 7,
  MU: 7,
  AMD: 7,
  GOOGL: 6,
  AMZN: 5,
  META: 6,
  TSLA: 0,
  ORCL: 7,
  CRM: 7,
};

export type SampleField = {
  funds: readonly [FundMeta, FundMeta];
  dots: DotSpec[];
  /** Index pairs into `dots`: [fund-0 dot, fund-1 dot]. */
  pairs: Array<[number, number]>;
  /** Indices of the dots that carry a mono label, largest first. */
  labelled: number[];
  /** A dot that leaves the card late and scurries to its sector. */
  tardy: number;
};

/**
 * Build the sample field. Same seed, same field — a resize rebuilds geometry but
 * not the story, and the timeline can be torn down and rebuilt at any progress
 * without the dots jumping.
 */
export function buildSample(): SampleField {
  const rand = mulberry32(0x5eed_1a7);
  const dots: DotSpec[] = [];
  const pairs: Array<[number, number]> = [];

  // Shared companies: same key in both funds, one dot each, fused in the merge.
  for (let i = 0; i < SAMPLE.shared; i += 1) {
    const ticker = TOP_LABELS[i % TOP_LABELS.length] ?? `S${i}`;
    const sector = SECTOR_BY_TICKER[ticker] ?? Math.floor(rand() * 11);
    // A's weight is the larger of the two for the first few, so the fused dot
    // does not look identical to its partner.
    const aWeight = Math.round(760 / (1 + i * 0.42) + rand() * 40);
    const bWeight = Math.round(1780 / (1 + i * 0.55) + rand() * 60);
    const aIndex = dots.length;
    dots.push({ key: ticker, fund: 0, sector, weightBp: aWeight, shared: true });
    const bIndex = dots.length;
    dots.push({ key: ticker, fund: 1, sector, weightBp: bWeight, shared: true });
    pairs.push([aIndex, bIndex]);
  }

  // Each fund's own tail: a power law with a long thin end, like a real filing.
  const addTail = (fund: 0 | 1, count: number, base: number) => {
    for (let i = 0; i < count; i += 1) {
      const weightBp = Math.max(1, Math.round(base / (1 + i * 0.55) ** 1.7));
      dots.push({
        key: `${fund === 0 ? "A" : "B"}${i}`,
        fund,
        sector: Math.floor(rand() * 11),
        weightBp,
        shared: false,
      });
    }
  };
  addTail(0, SAMPLE.a - SAMPLE.shared, 210);
  addTail(1, SAMPLE.b - SAMPLE.shared, 250);

  const labelled = dots
    .map((dot, index) => ({ dot, index }))
    .filter(({ dot }) => dot.shared && dot.fund === 0)
    .sort((x, y) => y.dot.weightBp - x.dot.weightBp)
    .slice(0, 12)
    .map(({ index }) => index);

  // The tardy dot: a mid-weight tail dot, so its late arrival is visible but not
  // a hero. It is the twelfth-largest non-shared company.
  const tardy = dots
    .map((dot, index) => ({ dot, index }))
    .filter(({ dot }) => !dot.shared)
    .sort((x, y) => y.dot.weightBp - x.dot.weightBp)[11]!.index;

  return { funds: FUNDS, dots, pairs, labelled, tardy };
}

/** The two funds and when each one filed the N-PORT this intro is reading. */
export type CaptionRow = { ticker: string; name: string; filed: string };
export function captionLines(funds: readonly [FundMeta, FundMeta]): CaptionRow[] {
  return funds.map((fund) => ({ ticker: fund.ticker, name: fund.name, filed: fund.filedLabel }));
}
