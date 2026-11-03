/**
 * A fund's filed net assets, in the compact form a directory column can carry.
 *
 * The catalogue stores dollars (`278318309`), which is the wrong width for a table
 * cell and the wrong unit for a reader scanning sizes: `$278.3M` says the same
 * thing and stays in one line at 320px. This is presentation of a number the
 * release publishes — the fund's own filed total net assets, not a market value we
 * computed, and never a price or a return.
 *
 * Significant figures are kept where they matter: trillions and billions print two
 * decimals, millions one, thousands none, so `$1.24T` and `$278.3M` are both about
 * as precise as the underlying filing is useful. A trailing `.0` is dropped.
 */

const UNITS: Array<{ floor: number; suffix: string; digits: number }> = [
  { floor: 1_000_000_000_000, suffix: "T", digits: 2 },
  { floor: 1_000_000_000, suffix: "B", digits: 2 },
  { floor: 1_000_000, suffix: "M", digits: 1 },
  { floor: 1_000, suffix: "K", digits: 0 },
];

const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatDollarsCompact(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  for (const unit of UNITS) {
    if (value >= unit.floor) {
      const scaled = value / unit.floor;
      const text = new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: unit.digits,
      }).format(scaled);
      return `$${text}${unit.suffix}`;
    }
  }
  return `$${plain.format(value)}`;
}
