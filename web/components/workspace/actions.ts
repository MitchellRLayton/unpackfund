"use client";

/**
 * The four things a visitor does with a finished portfolio, as one hook.
 *
 * They live here rather than in `ActionsRow` because the docked lens strip shows three
 * of them (share, export, print) in the top bar, and a second copy of the clipboard
 * fallback, the CSV name and the print call would be a second set of failure stories to
 * keep in step. `ActionsRow` renders the full row; the docked strip renders the three
 * that fit. Both call this.
 *
 * The share link is built from the current URL and the current state through
 * `viewUrl`/`encodeView`, never by writing `location.hash` — the store owns the
 * fragment, and a second writer would be a second source of truth.
 */

import { useEffect, useRef, useState } from "react";

import { ledgerCsv, ledgerCsvName, saveCsv } from "@/lib/export";
import { encodeComparison, fundWeights } from "@/lib/fragment";
import { viewUrl } from "@/lib/view-fragment";
import type { WorkspaceModel } from "@/lib/use-workspace";

export interface WorkspaceActions {
  copied: boolean;
  shareLink: string | null;
  copyFailed: boolean;
  /** The read-only field the link is printed in when the clipboard refuses. */
  fallback: React.RefObject<HTMLInputElement | null>;
  copy: () => Promise<void>;
  exportCsv: () => void;
  print: () => void;
  compareHref: string;
}

export function useWorkspaceActions(model: WorkspaceModel): WorkspaceActions {
  const [copied, setCopied] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const fallback = useRef<HTMLInputElement | null>(null);

  // Focus and select the fallback the moment it appears: a visitor who pressed "Copy"
  // wants the link selected, not a message about why they cannot have it.
  useEffect(() => {
    if (copyFailed) fallback.current?.select();
  }, [copyFailed]);

  const buildLink = (): string => {
    const base = `${window.location.origin}${window.location.pathname}`;
    return viewUrl(base, {
      portfolio: model.portfolio,
      lens: model.lens,
      companyId: model.companyId,
    });
  };

  const copy = async () => {
    const link = buildLink();
    setShareLink(link);
    setCopied(false);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 4000);
    } catch {
      setCopyFailed(true);
    }
  };

  const exportCsv = () => {
    const ledger = model.ledger;
    if (!ledger) return;
    const asOf = model.releaseAsOf ?? "unknown";
    saveCsv(ledgerCsv(ledger, { as_of: asOf }), ledgerCsvName(new Date(), asOf));
  };

  const print = () => window.print();

  const compareHref = `/compare/#${encodeComparison(fundWeights(model.portfolio), [])}`;

  return { copied, shareLink, copyFailed, fallback, copy, exportCsv, print, compareHref };
}
