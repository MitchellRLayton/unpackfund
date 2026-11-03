/**
 * A ledger with its effective-holdings pair already computed.
 *
 * Components read `ledger.effective`; a fixture that hand-wrote the pair would be
 * asserting against numbers it invented rather than the ones the look-through derives,
 * so tests build through this and the real function does the arithmetic.
 */

import { effectiveHoldingsForLedger } from "../effective-holdings";
import type { Ledger } from "../types";

export function withEffective(ledger: Omit<Ledger, "effective">): Ledger {
  return { ...ledger, effective: effectiveHoldingsForLedger(ledger) };
}
