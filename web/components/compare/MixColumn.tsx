"use client";

import { coverageBand, coverageChip, formatCount, formatWeightBp } from "@/lib/format";
import { MAX_HOLDINGS, type Tally } from "@/lib/holdings";
import type { Catalogue, FundWeight, ReleaseDescriptor } from "@/lib/types";
import type { LoadState } from "@/lib/use-release";

import { AddFundForm } from "./AddFundForm";
import { AmountField } from "./AmountField";
import styles from "./compare.module.css";
import { isSplitEvenly } from "./sides";

/**
 * One mix: its funds, their shares, and the two buttons that make it whole.
 *
 * Both sides of the page are this component, which is the point — the add field,
 * the amount field and the 100% meter behave identically on either side, so there
 * is no "first" and "second" column to learn. The side is passed in as a label and
 * a set of callbacks; nothing in here knows whether it is A or B.
 *
 * The meter is `tallyOf`, the same function that prints the sentence above it and
 * that the comparison's own gate reads, so a side can never look complete here and
 * be incomplete to the answer.
 */
export function MixColumn({
  headingId,
  label,
  entries,
  tally,
  names,
  coverage,
  present,
  catalog,
  release,
  catalogue,
  catalogueState,
  onNeedNames,
  onAdd,
  onRemove,
  onWeight,
  onScale,
  onSplit,
  onClear,
}: {
  headingId: string;
  label: string;
  entries: FundWeight[];
  tally: Tally;
  names: Map<string, string>;
  coverage: Map<string, number>;
  present: string[];
  catalog: string[];
  release: LoadState<ReleaseDescriptor>;
  catalogue: Catalogue | null;
  catalogueState: LoadState<Catalogue>;
  onNeedNames: () => void;
  onAdd: (ticker: string) => void;
  onRemove: (ticker: string) => void;
  onWeight: (ticker: string, weightBp: number) => void;
  onScale: () => void;
  onSplit: () => void;
  onClear: () => void;
}) {
  return (
    <section className={`panel ${styles.column}`} aria-labelledby={headingId}>
      <div className="panel__head">
        <h2 className="subtitle" id={headingId}>
          {label}
        </h2>
        <span className="chip">
          {entries.length === 1 ? "1 fund" : `${formatCount(entries.length)} funds`}
        </span>
      </div>

      <div className="panel__body stack stack--tight">
        <div className="meter">
          <span className="meter__track" aria-hidden="true">
            <span
              className={
                tally.overBp > 0 ? "meter__fill meter__fill--over" : "meter__fill"
              }
              style={{ width: `${Math.min(100, tally.total / 100)}%` }}
            />
          </span>
          <span className="meter__label" role="status">
            <span>Total {formatWeightBp(tally.total)}</span>
            <span>{tally.sentence}</span>
          </span>
        </div>

        {entries.length === 0 ? (
          <p className="small muted">No funds on this side yet.</p>
        ) : (
          <ul className={styles.holdings}>
            {entries.map((entry) => {
              const coveragePct = coverage.get(entry.ticker);
              const band = coveragePct === undefined ? "full" : coverageBand(coveragePct);
              return (
                <li key={entry.ticker} className={styles.holding}>
                  <span className={`mono ${styles.ticker}`}>{entry.ticker}</span>
                  <span className={styles.fundName}>{names.get(entry.ticker) ?? ""}</span>
                  {band !== "full" && coveragePct !== undefined ? (
                    <span
                      className={
                        band === "none" ? "chip chip--none" : "chip chip--partial"
                      }
                    >
                      {coverageChip(coveragePct)}
                    </span>
                  ) : null}
                  <AmountField
                    label={`Weight of ${entry.ticker} in ${label}`}
                    weightBp={entry.weight_bp}
                    onChange={(weightBp) => onWeight(entry.ticker, weightBp)}
                  />
                  <button
                    type="button"
                    className="btn btn--icon btn--sm"
                    aria-label={`Remove ${entry.ticker} from ${label}`}
                    onClick={() => onRemove(entry.ticker)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {entries.length > 0 ? (
          <div className={styles.actions}>
            <button
              type="button"
              className="btn btn--sm"
              onClick={onScale}
              disabled={tally.complete}
            >
              Scale to 100%
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={onSplit}
              disabled={isSplitEvenly(entries)}
            >
              Split equally
            </button>
            <button type="button" className="btn btn--sm btn--quiet" onClick={onClear}>
              Clear {label}
            </button>
          </div>
        ) : null}

        <AddFundForm
          label={label}
          present={present}
          catalog={catalog}
          release={release}
          catalogue={catalogue}
          catalogueState={catalogueState}
          full={entries.length >= MAX_HOLDINGS}
          onAdd={onAdd}
          onNeedNames={onNeedNames}
        />
      </div>
    </section>
  );
}
