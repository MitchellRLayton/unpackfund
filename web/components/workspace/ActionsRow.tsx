"use client";

/**
 * What a visitor does once the numbers are on screen: keep the link, hand it to someone,
 * take the file, or put it on paper.
 *
 * Four actions, and each one has a failure story, because this is the bottom of the page
 * where a dead button is discovered:
 *
 * - **Copy** can fail — the clipboard API is missing on some browsers, refuses on an
 *   insecure origin, and can be blocked without a gesture. When it does, the link is
 *   printed in a read-only field that is already focused and selected, so the visitor gets
 *   the URL they asked for either way. The "Copied" state is in the DOM, not only in a
 *   colour change.
 * - **Compare** is a real link, not a button that runs script: it can be opened in a new
 *   tab, copied, or followed by a keyboard. It carries the portfolio's fund weights in the
 *   fragment, so the destination is the same comparison this page describes.
 * - **Export** writes the ledger, not the filtered view of any lens: one file per page, so
 *   two lenses cannot disagree about what "the export" contains.
 * - **Print** calls `window.print()`. The print stylesheet hides the chrome and the pane
 *   and shows the one-page summary that `PrintSummary` renders, so what comes out is a
 *   summary rather than a screenshot with a navigation bar on it.
 *
 * The share link is built from the current URL and the current state through
 * `viewUrl`/`encodeView`, never by writing `location.hash` — the store owns the fragment,
 * and a second writer would be a second source of truth.
 */

import { useEffect, useRef, useState } from "react";

import { ledgerCsv, ledgerCsvName, saveCsv } from "@/lib/export";
import { encodeComparison, fundWeights } from "@/lib/fragment";
import { useWorkspace } from "@/lib/use-workspace";

import { viewUrl } from "@/lib/view-fragment";
import styles from "./Workspace.module.css";

export function ActionsRow({ model }: { model: ReturnType<typeof useWorkspace> }) {
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

  const compareHref = `/compare/#${encodeComparison(fundWeights(model.portfolio), [])}`;

  return (
    <div className="stack stack--tight no-print">
      <div className={styles.actions}>
        <button type="button" className="btn btn--sm" onClick={() => void copy()}>
          Copy share link
        </button>
        <span role="status" className="small muted">
          {copied
            ? "Copied — the link carries the portfolio, the lens and the open company."
            : ""}
        </span>
        <a className="btn btn--sm" href={compareHref}>
          Compare with another portfolio
        </a>
        <button
          type="button"
          className="btn btn--sm"
          onClick={exportCsv}
          disabled={model.ledger === null}
          aria-label="Export CSV: the whole look-through ledger"
        >
          Export CSV
        </button>
        <button type="button" className="btn btn--sm" onClick={() => window.print()}>
          Print summary
        </button>
      </div>
      {copyFailed && shareLink ? (
        <div className={styles.copyFallback}>
          <label className="small muted" htmlFor="share-link-fallback">
            Copy this link:
          </label>
          <input
            id="share-link-fallback"
            ref={fallback}
            className="field__input"
            type="text"
            readOnly
            value={shareLink}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
      <p className="small muted">
        The link is the whole state: nothing about this portfolio is stored on a server,
        and nothing is remembered between visits except what is in the address bar.
      </p>
    </div>
  );
}
