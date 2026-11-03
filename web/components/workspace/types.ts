/**
 * The contract between the workspace shell and its lenses.
 *
 * A lens is a pure function of the workspace model: it reads numbers, it never
 * loads data and never writes the fragment. That is what lets five lenses be
 * built independently and still agree — there is one portfolio, one ledger and
 * one set of fund documents, and every lens is looking at them.
 *
 * `model` is the whole `WorkspaceModel` rather than a hand-picked subset, because
 * a lens that needs one more field should not have to change the shell's props
 * and every other lens with it.
 */

import type { WorkspaceModel } from "@/lib/use-workspace";
import type { Lens } from "@/lib/view-fragment";

export interface LensProps {
  model: WorkspaceModel;
}

export interface LensDefinition {
  id: Lens;
  /** The tab's words. A question, not a noun, where the noun is internal. */
  label: string;
}

/** The five lenses, in the order the tabs show them. */
export const LENS_TABS: LensDefinition[] = [
  { id: "companies", label: "Companies" },
  { id: "markets", label: "Markets" },
  { id: "funds", label: "Funds" },
  { id: "overlap", label: "Overlap" },
  { id: "quality", label: "Data quality" },
];
