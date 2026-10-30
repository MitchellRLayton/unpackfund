/**
 * The `/funds/` directory's default order: the funds most people actually hold, first.
 *
 * Alphabetical order leads with AAAA, AAAAX, AAAC — real tickers, and a useless
 * front page. So the release's rows are ordered by this curated list instead.
 *
 * It is a curation, not a ranking. The release carries no assets under management,
 * so nothing here is a size claim and nothing may be presented as one; the
 * directory says that in words rather than implying an ordering it cannot support.
 *
 * `POPULAR_ORDER` is editorial and may name a ticker the release does not publish.
 * That is safe: `popularRank` only positions rows that exist, and an unknown
 * ticker sorts after every curated one — it is never invented into a row.
 */

export const POPULAR_ORDER: readonly string[] = [
  "VTI",
  "VOO",
  "SPY",
  "IVV",
  "QQQ",
  "VEA",
  "IEFA",
  "VWO",
  "IEMG",
  "VTV",
  "VUG",
  "IWF",
  "IWD",
  "IWM",
  "IJR",
  "IJH",
  "IJS",
  "VO",
  "VB",
  "VBR",
  "VBK",
  "VOE",
  "VOT",
  "VYM",
  "VIG",
  "SCHD",
  "SCHX",
  "SCHB",
  "SCHG",
  "SCHF",
  "SCHC",
  "SCHE",
  "SPLG",
  "ITOT",
  "RSP",
  "MDY",
  "DIA",
  "XLK",
  "XLF",
  "XLV",
  "XLE",
  "XLI",
  "XLY",
  "XLP",
  "XLU",
  "XLB",
  "XLRE",
  "XLC",
  "SMH",
  "SOXX",
  "ARKK",
  "JEPI",
  "JEPQ",
  "AVUV",
  "AVDV",
  "AVUS",
  "AVEM",
  "AVES",
  "AVSC",
  "AVLV",
  "DFAC",
  "DFUS",
  "DFAU",
  "DFIV",
  "TLT",
  "LQD",
  "HYG",
  "BND",
  "AGG",
  "BNDX",
  "VXUS",
  "VNQ",
  "GLD",
  "SLV",
  "IAU",
  "VGIT",
  "VTIP",
  "SCHP",
  "VTSAX",
  "VFIAX",
  "FXAIX",
];

/** Built once: a linear `indexOf` per row would be ~8,983 × 81 checks per sort. */
const RANK = new Map(POPULAR_ORDER.map((ticker, index) => [ticker, index]));

/** Position in `POPULAR_ORDER`, or `Infinity` for a ticker the list does not name. */
export function popularRank(ticker: string): number {
  return RANK.get(ticker.toUpperCase()) ?? Infinity;
}
