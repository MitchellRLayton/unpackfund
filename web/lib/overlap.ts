/**
 * Overlap between two portfolios, and the company-by-company difference.
 *
 * The definition is the math skill's (§4), not an invention:
 *
 *     overlap = Σ_i min(w_{i,A}, w_{i,B})
 *
 * a fraction of value held in the same companies on both sides. It is deliberately
 * *not* "how many tickers do both portfolios hold" — two portfolios can share every
 * fund and still differ once look-through is done, and they can share no fund and
 * still hold 90% of the same companies.
 *
 * Both sides are aggregated with the same function the ledger uses (`buildLedger`),
 * so a comparison cannot disagree with either ledger it compares: the weights here
 * are the same numbers, from the same rules, including the rule that an unmapped
 * holding is disclosed rather than redistributed.
 *
 * `onlyA` and `onlyB` are the complements of the overlap — the weight each side
 * holds that the other does not:
 *
 *     onlyA = Σ_i max(0, w_{i,A} − w_{i,B})
 *
 * and by construction `overlap + onlyA` is the first portfolio's resolved weight.
 */

import { buildLedger } from "./aggregate";
import type { FundDocument, Ledger } from "./types";

export interface OverlapSide {
  funds: FundDocument[];
  weightsBp: Record<string, number>;
}

export interface OverlapRow {
  company_id: string;
  name: string;
  ticker: string | null;
  /** Fraction of each portfolio, never basis points. */
  weightA: number;
  weightB: number;
  /** `weightA − weightB`: positive means the first portfolio holds more. */
  delta: number;
  /** True when both portfolios hold the company. */
  inBoth: boolean;
}

export interface Overlap {
  rows: OverlapRow[];
  /** `Σ min(w_A, w_B)`, a fraction of portfolio value. */
  overlap: number;
  onlyA: number;
  onlyB: number;
  sharedCount: number;
  unionCount: number;
  ledgerA: Ledger;
  ledgerB: Ledger;
}

export function buildOverlap({ a, b }: { a: OverlapSide; b: OverlapSide }): Overlap {
  const ledgerA = buildLedger({ funds: a.funds, weightsBp: a.weightsBp });
  const ledgerB = buildLedger({ funds: b.funds, weightsBp: b.weightsBp });

  const byCompany = new Map<string, OverlapRow>();
  for (const row of ledgerA.rows) {
    byCompany.set(row.company_id, {
      company_id: row.company_id,
      name: row.name,
      ticker: row.ticker,
      weightA: row.weight,
      weightB: 0,
      delta: 0,
      inBoth: false,
    });
  }
  for (const row of ledgerB.rows) {
    const existing = byCompany.get(row.company_id);
    if (existing) {
      existing.weightB = row.weight;
      // The label comes from whichever side holds more, so a company whose name
      // differs between filings does not depend on which portfolio was read first.
      if (row.weight > existing.weightA) {
        existing.name = row.name;
        existing.ticker = row.ticker ?? existing.ticker;
      }
    } else {
      byCompany.set(row.company_id, {
        company_id: row.company_id,
        name: row.name,
        ticker: row.ticker,
        weightA: 0,
        weightB: row.weight,
        delta: 0,
        inBoth: false,
      });
    }
  }

  let overlap = 0;
  let onlyA = 0;
  let onlyB = 0;
  let sharedCount = 0;

  for (const row of byCompany.values()) {
    const shared = Math.min(row.weightA, row.weightB);
    overlap += shared;
    onlyA += Math.max(0, row.weightA - row.weightB);
    onlyB += Math.max(0, row.weightB - row.weightA);
    row.delta = row.weightA - row.weightB;
    row.inBoth = row.weightA > 0 && row.weightB > 0;
    if (row.inBoth) sharedCount += 1;
  }

  const rows = [...byCompany.values()].sort(
    (left, right) =>
      Math.max(right.weightA, right.weightB) - Math.max(left.weightA, left.weightB) ||
      (left.company_id < right.company_id ? -1 : 1),
  );

  return {
    rows,
    overlap,
    onlyA,
    onlyB,
    sharedCount,
    unionCount: rows.length,
    ledgerA,
    ledgerB,
  };
}
