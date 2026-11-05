/**
 * The answer strip: three to five sentences that say what the portfolio owns.
 *
 * Every sentence here is a fixed template filled with numbers the ledger produced. There
 * is no generated text anywhere in this app, and this module is where that rule is
 * easiest to break by accident, so the sentences are built as spans of text and
 * emphasised numbers rather than as interpolated prose. A reader can check each number
 * against the table under it; a writer cannot make the sentence say something the ledger
 * does not.
 *
 * The four things the strip says, in order, and why that order:
 *
 * 1. **How many companies, through how many funds** — the fact the whole page exists to
 *    deliver.
 * 2. **How concentrated it is** — the ten largest, the single largest, and where the
 *    largest part of the largest one comes from. Withheld entirely when a fund is below
 *    the 60% coverage floor, because a concentration figure computed over the part that
 *    resolved would describe a different portfolio (`lookthrough-math-and-qa` §5).
 * 3. **The market split** — the United States, international developed ex-US, emerging,
 *    and the remainder honestly named as outside the bar rather than folded into a tier.
 * 4. **The highest pairwise fund overlap**, only when it is high enough to be worth a
 *    sentence. It describes; it never judges, and there is no "too concentrated".
 *
 * The coverage line is a *note* rather than a sentence because it qualifies the numbers
 * instead of adding one: coverage, the share not traced to a company, and the three
 * dates (reporting period, filed date, age) belong beside the figures they qualify, at
 * the same weight. `formatPct1` rounds prose to one decimal; the tables keep two.
 *
 * Everything degrades: an empty portfolio, a portfolio still being read, and a
 * percentage portfolio that does not add up each produce their own true sentences and no
 * number the ledger cannot support.
 */

import { tierOf, type CountryTier } from "@/lib/country-tier";
import {
  coverageBand,
  coverageChip,
  formatCount,
  formatDateLong,
  formatDays,
  formatPct1,
  formatShare,
  formatWeightBp,
} from "@/lib/format";
import {
  FULL_ALLOCATION_BP,
  type EntryMode,
  type FundDocument,
  type Ledger,
  type LedgerRow,
} from "@/lib/types";

/** How much two funds must share before the strip mentions it, as a fraction of NAV. */
export const OVERLAP_NOTABLE = 0.5;

/** One run of text in a sentence: a number is emphasised, the words are not. */
export interface AnswerPart {
  text?: string;
  strong?: string;
}

export interface AnswerSentence {
  parts: AnswerPart[];
}

export interface Answer {
  sentences: AnswerSentence[];
  /** Coverage and the filing dates, or `null` when there is nothing to qualify. */
  note: AnswerPart[] | null;
}

export type AnswerInput =
  | { kind: "empty" }
  | {
      kind: "loading";
      /** Tickers whose filings are still arriving. */
      pending: readonly string[];
      /** How many filings are being read in total, named when none are pending. */
      fundCount: number;
    }
  | {
      kind: "incomplete";
      mode: EntryMode;
      totalBp: number;
      unallocatedBp: number;
      overBp: number;
    }
  | {
      kind: "ready";
      ledger: Ledger;
      /** The fund documents behind the ledger, for the pairwise overlap. */
      funds: readonly FundDocument[];
      /**
       * The release's second answer for a company the vote could not decide. The
       * sentence below has to place the same weight the Markets lens places, or the
       * two surfaces disagree about the same portfolio.
       */
      contested?: Record<string, string>;
    };

const text = (value: string): AnswerPart => ({ text: value });
const strong = (value: string): AnswerPart => ({ strong: value });

/** `VTI`, `VTI and VXUS`, `VTI, VXUS and BND`. */
function nameList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The weight a fund's filing puts in each company, in basis points, by company id. */
function vectorOf(fund: FundDocument): Map<string, number> {
  const vector = new Map<string, number>();
  for (const holding of fund.holdings) {
    if (!holding.company_id || holding.weight_bp === 0) continue;
    vector.set(
      holding.company_id,
      (vector.get(holding.company_id) ?? 0) + holding.weight_bp,
    );
  }
  return vector;
}

export interface FundOverlap {
  a: string;
  b: string;
  /** `Σ min(w_A, w_B)` over the companies both funds resolved, as a fraction. */
  shared: number;
}

/**
 * The most overlapped pair of funds in the portfolio, or `null` when it cannot be told.
 *
 * This is the math skill's overlap identity (`Σ min(w_A, w_B)`, a share of NAV) computed
 * on the filed vectors directly rather than through `buildOverlap`, which builds two
 * whole ledgers per pair — correct, but 66 ledger builds for a twelve-fund portfolio on
 * every render. The arithmetic is the same two loops, over resolved companies only:
 * a company either filing failed to identify cannot be compared, so it is not counted
 * on one side only (`lookthrough-math-and-qa` §4).
 *
 * A fund with no holdings contributes nothing and is skipped, so the pair named is always
 * one the numbers describe.
 */
export function highestOverlap(funds: readonly FundDocument[]): FundOverlap | null {
  const vectors = funds
    .map((fund) => ({ ticker: fund.ticker, vector: vectorOf(fund) }))
    .filter((entry) => entry.vector.size > 0);
  if (vectors.length < 2) return null;

  let best: FundOverlap | null = null;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const left = vectors[i];
      const right = vectors[j];
      if (!left || !right) continue;
      // Walk the smaller filing: the sum is symmetric, and this halves the lookups.
      const [small, large] =
        left.vector.size <= right.vector.size
          ? [left.vector, right.vector]
          : [right.vector, left.vector];
      let sharedBp = 0;
      for (const [companyId, weightBp] of small) {
        const other = large.get(companyId);
        if (other !== undefined) sharedBp += Math.min(weightBp, other);
      }
      const shared = sharedBp / FULL_ALLOCATION_BP;
      if (best === null || shared > best.shared) {
        best = { a: left.ticker, b: right.ticker, shared };
      }
    }
  }
  return best;
}

/** The largest row by weight. `rows` are sorted by the aggregate, but this does not rely on it. */
function largestRow(rows: readonly LedgerRow[]): LedgerRow | null {
  let best: LedgerRow | null = null;
  for (const row of rows) {
    if (best === null || row.weight > best.weight) best = row;
  }
  return best;
}

/**
 * US / international developed ex-US / emerging weights over the weight the release
 * placed, in the same order the Markets lens places it: the decided country, then the
 * contested one, then — for a position that resolved to no company — the country its
 * own filing states.
 *
 * The third source is why this cannot be a loop over `ledger.rows` alone. Those
 * positions carry weight and no company, so they are not rows; they live in
 * `unmapped.securities_by_country`. Leaving them out made this sentence disagree with
 * the Markets lens on the same page by 2.3 points of developed ex-US.
 */
function marketSplit(
  ledger: Ledger,
  contested: Record<string, string>,
): {
  us: number;
  dm: number;
  em: number;
  placed: number;
} {
  let us = 0;
  let dm = 0;
  let em = 0;
  const add = (tier: CountryTier | null, weight: number): void => {
    if (tier === "US") us += weight;
    else if (tier === "DM") dm += weight;
    else if (tier === "EM") em += weight;
  };
  for (const row of ledger.rows) {
    add(tierOf(row.country ?? contested[row.company_id]), row.weight);
  }
  for (const [code, weight] of Object.entries(ledger.unmapped.securities_by_country)) {
    add(tierOf(code), weight);
  }
  return { us, dm, em, placed: us + dm + em };
}

/** Sentences 1–4 for a portfolio the ledger has actually produced. */
function readySentences(
  ledger: Ledger,
  funds: readonly FundDocument[],
  contested: Record<string, string>,
): AnswerSentence[] {
  const sentences: AnswerSentence[] = [];
  const companyCount = ledger.rows.length;
  if (companyCount === 0) return sentences;

  // 1. How many companies, through how many funds, and how many held directly.
  const fundCount = ledger.funds.length;
  const directCount = ledger.rows.filter((row) => row.held_directly).length;
  const first: AnswerPart[] = [
    text("You own "),
    strong(
      `${formatCount(companyCount)} ${plural(companyCount, "company", "companies")}`,
    ),
  ];
  if (fundCount > 0) {
    first.push(
      text(" through "),
      strong(`${formatCount(fundCount)} ${plural(fundCount, "fund", "funds")}`),
    );
  }
  if (directCount > 0) {
    first.push(
      text(fundCount > 0 ? ", " : " "),
      strong(`${formatCount(directCount)}`),
      text(
        ` of ${fundCount > 0 ? "them" : "these"} ${
          directCount === 1 ? "is" : "are"
        } held directly by you`,
      ),
    );
  }
  first.push(text("."));
  sentences.push({ parts: first });

  // 2. Concentration — withheld entirely when a fund is below the 60% coverage floor.
  const suppressed = ledger.funds.filter(
    (fund) => coverageBand(fund.coverage_pct) === "none",
  );
  const largest = largestRow(ledger.rows);
  if (suppressed.length > 0) {
    sentences.push({
      parts: [
        strong(suppressed.map((fund) => fund.ticker).join(", ")),
        text(
          suppressed.length === 1
            ? " covers less than 60% of its own weight, so no concentration figure is shown here: one computed over the part that resolved would describe a different portfolio."
            : " cover less than 60% of their own weight, so no concentration figure is shown here: one computed over the part that resolved would describe a different portfolio.",
        ),
      ],
    });
  } else if (largest !== null && ledger.metrics.top10 !== null) {
    const parts: AnswerPart[] = [];
    if (companyCount >= 10) {
      parts.push(
        text("Your "),
        strong("10 largest companies"),
        text(" are "),
        strong(formatPct1(ledger.metrics.top10)),
        text(" of the mix; the largest is "),
      );
    } else {
      parts.push(
        text("Your "),
        strong(
          `${formatCount(companyCount)} ${plural(companyCount, "company", "companies")}`,
        ),
        text(" together are "),
        strong(formatPct1(ledger.metrics.top10)),
        text(" of the mix; the largest is "),
      );
    }
    parts.push(strong(largest.name), text(" at "), strong(formatShare(largest.weight)));
    const direct = largest.held_directly;
    if (largest.holder_count > 0) {
      parts.push(
        text(", held by "),
        strong(
          `${formatCount(largest.holder_count)} ${plural(
            largest.holder_count,
            "fund",
            "funds",
          )}`,
        ),
        text(direct ? " and by you directly" : ""),
      );
    } else {
      parts.push(text(", held directly by you"));
    }
    const source = largest.sources[0];
    if (source && largest.holder_count > 0) {
      parts.push(
        text(", the largest part of it through "),
        strong(source.ref),
        text(" ("),
        strong(formatShare(source.weight)),
        text(" of your mix)"),
      );
    }
    parts.push(text("."));
    sentences.push({ parts });
  }

  // 3. The market split, only when the release placed at least one company — otherwise
  //    there is no split to describe, and a row of zeroes would read like a finding.
  const split = marketSplit(ledger, contested);
  if (split.placed > 0) {
    const unplaced = Math.max(0, 1 - split.placed);
    const parts: AnswerPart[] = [
      text("By market: "),
      strong(formatPct1(split.us)),
      text(" in the United States, "),
      strong(formatPct1(split.dm)),
      text(" in international developed markets outside it, "),
      strong(formatPct1(split.em)),
      text(" in emerging markets"),
    ];
    if (unplaced > 0.0005) {
      parts.push(
        text(", and "),
        strong(formatPct1(unplaced)),
        text(
          " that is not placed in a market — untraced weight, cash, or a company with no country answer.",
        ),
      );
    } else {
      parts.push(text("."));
    }
    sentences.push({ parts });
  }

  // 4. The highest pairwise overlap, when it is worth a sentence.
  const contributing = funds.filter((fund) =>
    ledger.funds.some((entry) => entry.ticker === fund.ticker),
  );
  const overlap = highestOverlap(contributing);
  if (overlap !== null && overlap.shared >= OVERLAP_NOTABLE) {
    sentences.push({
      parts: [
        strong(overlap.a),
        text(" and "),
        strong(overlap.b),
        text(" share "),
        strong(formatPct1(overlap.shared)),
        text(" of their holdings by weight."),
      ],
    });
  }

  return sentences;
}

/**
 * The note under the sentences: what the numbers are a share of, and how old they are.
 *
 * Coverage and the three dates are not decoration — a weight with no filing date is a
 * number a reader cannot check — so they stay one line below the answer rather than in a
 * method page. A direct-only portfolio has no filing at all, and says so instead of
 * printing three dashes.
 */
function readyNote(ledger: Ledger): AnswerPart[] | null {
  if (ledger.funds.length === 0) {
    return [
      text(
        "Direct holdings only: no fund filing is involved, so there is no coverage figure or filing date behind these weights.",
      ),
    ];
  }

  const covered = Math.max(0, Math.min(100, ledger.metrics.covered_weight_pct));
  const notTraced =
    Math.max(0, 1 - covered / 100) * Math.max(0, ledger.metrics.invested_weight);

  const parts: AnswerPart[] = [
    text("Coverage "),
    // `coverageChip` carries the band, not just the percentage: below the threshold it
    // reads "partial X%" or "X% not covered", which is the signal that a concentration
    // figure computed over the traced part would describe a different portfolio. The
    // strip's own "not traced to a company" is what ties "covered" to the company test,
    // so this sentence keeps its wording rather than borrowing the fund row's label.
    strong(coverageChip(covered)),
    text(" of invested money · "),
    strong(formatPct1(notTraced)),
    text(" not traced to a company"),
  ];

  const oldest = ledger.funds.find((fund) => fund.as_of === ledger.oldest_as_of);
  if (ledger.oldest_as_of !== null && oldest) {
    parts.push(
      text(" · oldest reporting period "),
      strong(formatDateLong(ledger.oldest_as_of)),
      text(", filed "),
      strong(formatDateLong(oldest.filed_at)),
    );
    if (ledger.max_lag_days !== null) {
      parts.push(text(", "), strong(formatDays(ledger.max_lag_days)), text(" old"));
    }
  }
  parts.push(text("."));
  return parts;
}

/**
 * The whole answer for the model's current state.
 *
 * One entry point rather than four, because the four states are one question ("what can
 * this portfolio honestly say?") and a caller that picked between them could pick the
 * wrong one — showing a loading sentence over a portfolio it did not read.
 */
export function buildAnswer(input: AnswerInput): Answer {
  switch (input.kind) {
    case "empty":
      return { sentences: [], note: null };

    case "loading": {
      const pending = input.pending;
      if (pending.length > 0) {
        return {
          sentences: [
            {
              parts: [
                text("Reading "),
                strong(
                  `${formatCount(pending.length)} ${plural(pending.length, "filing", "filings")}`,
                ),
                text(`: ${nameList(pending)}.`),
              ],
            },
          ],
          note: null,
        };
      }
      if (input.fundCount === 0) return { sentences: [], note: null };
      return {
        sentences: [
          {
            parts: [
              text("Adding up "),
              strong(
                `${formatCount(input.fundCount)} ${plural(input.fundCount, "filing", "filings")}`,
              ),
              text("…"),
            ],
          },
        ],
        note: null,
      };
    }

    case "incomplete": {
      if (input.mode === "usd" || input.totalBp === 0) {
        return {
          sentences: [
            {
              parts: [text("Set an amount on at least one row to see the look-through.")],
            },
          ],
          note: null,
        };
      }
      const over = input.overBp > 0;
      return {
        sentences: [
          {
            parts: over
              ? [
                  text("Your percentages add up to "),
                  strong(formatWeightBp(input.totalBp)),
                  text(" — "),
                  strong(formatWeightBp(input.overBp)),
                  text(" more than the whole, so no company weights are shown yet."),
                ]
              : [
                  text("Your percentages add up to "),
                  strong(formatWeightBp(input.totalBp)),
                  text(", with "),
                  strong(formatWeightBp(input.unallocatedBp)),
                  text(" accounting for nothing, so no company weights are shown yet."),
                ],
          },
          {
            parts: [
              text(
                "A look-through weight is a share of the whole, and the whole is everything you own.",
              ),
            ],
          },
        ],
        note: null,
      };
    }

    case "ready":
      return {
        sentences: readySentences(input.ledger, input.funds, input.contested ?? {}),
        note: readyNote(input.ledger),
      };
  }
}
