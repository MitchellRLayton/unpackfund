"use client";

import { useId, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { MAX_HOLDINGS, resolveEntry } from "@/lib/holdings";
import { rankFunds } from "@/lib/search";
import type { Catalogue, ReleaseDescriptor } from "@/lib/types";
import type { LoadState } from "@/lib/use-release";

import styles from "./compare.module.css";

interface Message {
  tone: "hint" | "error";
  text: string;
}

/**
 * One input per column: type a ticker or a name, pick from what matches.
 *
 * The list is `search.rankFunds` over the published catalogue — the same ranking
 * the site's search uses, so an exact ticker is always first and a name prefix
 * beats a name fragment. Suggestions are the fast path; the form still resolves
 * whatever was typed, so a share class (`VFIAX`) or an alias lands on the right
 * fund with a sentence saying which fund it became.
 *
 * Keyboard: the input is a combobox, so Arrow Up/Down moves the active option while
 * focus stays in the field, Enter takes the active option (or resolves the text),
 * and Escape closes the list. The options are `role="option"` with `aria-selected`,
 * and `aria-activedescendant` points at the active one, so a screen reader reads the
 * highlighted fund without the focus leaving the input.
 */
export function AddFundForm({
  label,
  present,
  catalog,
  release,
  catalogue,
  catalogueState,
  full,
  onAdd,
  onNeedNames,
}: {
  label: string;
  present: readonly string[];
  catalog: string[];
  release: LoadState<ReleaseDescriptor>;
  catalogue: Catalogue | null;
  catalogueState: LoadState<Catalogue>;
  full: boolean;
  onAdd: (ticker: string) => void;
  onNeedNames: () => void;
}) {
  const inputId = useId();
  const listId = useId();
  const messageId = useId();

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const typed = query.trim();
  const hits = useMemo(
    () =>
      open && catalogue !== null && typed.length > 0
        ? rankFunds(typed, catalogue, 6)
        : [],
    [open, catalogue, typed],
  );
  const activeIndex = hits.length > 0 ? Math.min(active, hits.length - 1) : -1;
  const activeHit = activeIndex >= 0 ? hits[activeIndex] : null;

  function choose(ticker: string, note?: string) {
    setQuery("");
    setOpen(false);
    setActive(0);
    setMessage(note ? { tone: "hint", text: note } : null);
    onAdd(ticker);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || full) return;
    if (activeHit) {
      choose(activeHit.id);
      return;
    }
    if (typed === "") return;
    setBusy(true);
    const decision = await resolveEntry(
      typed,
      {
        catalog,
        release,
        allowSecurities: false,
        allowCash: false,
        where: label,
      },
      present,
    );
    setBusy(false);
    if (decision.ok) {
      const note =
        decision.body ??
        (decision.resolved ? `${decision.label} — ${decision.resolved}` : undefined);
      choose(decision.key, note);
      return;
    }
    setMessage({
      tone: decision.tone === "warn" ? "error" : "hint",
      text: decision.body ? `${decision.title}. ${decision.body}` : decision.title,
    });
  }

  const namesLoading = catalogueState.status === "loading";
  const namesFailed = catalogueState.status === "error";
  const describedBy = message ? messageId : undefined;

  return (
    <form className="field" onSubmit={submit} noValidate>
      <label className="field__label" htmlFor={inputId}>
        Add a fund to {label}
      </label>
      <div className={styles.addRow}>
        <div className={styles.addField}>
          <input
            id={inputId}
            className="field__input"
            type="text"
            role="combobox"
            aria-expanded={open && hits.length > 0}
            aria-controls={open && hits.length > 0 ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
            }
            aria-describedby={describedBy}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={40}
            placeholder="Ticker or name"
            value={query}
            disabled={full}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              setActive(0);
              setOpen(true);
              setMessage(null);
              if (next.trim().length > 0) onNeedNames();
            }}
            onFocus={() => {
              if (typed.length > 0) {
                setOpen(true);
                onNeedNames();
              }
            }}
            onBlur={() => setOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setOpen(false);
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen(true);
                setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              }
            }}
          />
        </div>
        <button
          type="submit"
          className="btn btn--sm"
          disabled={full || busy || typed === ""}
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>

      {open && hits.length > 0 ? (
        <ul
          className="suggest"
          id={listId}
          role="listbox"
          aria-label={`Funds matching ${typed}`}
        >
          {hits.map((hit, index) => {
            const row = catalogue?.funds[hit.id];
            return (
              <li
                key={hit.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className="suggest__item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(hit.id)}
              >
                <span className="suggest__ticker">{hit.label}</span>
                <span className="suggest__name">{row?.[0] ?? ""}</span>
                <span className="suggest__meta">{row?.[1] ?? ""}</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {message ? (
        <p
          id={messageId}
          className={message.tone === "error" ? "field__error" : "field__hint"}
          role="status"
        >
          {message.text}
        </p>
      ) : null}
      {!message && typed !== "" && namesLoading ? (
        <p className="field__hint">Loading fund names…</p>
      ) : null}
      {!message && typed !== "" && namesFailed ? (
        <p className="field__hint">
          Fund names are unavailable, so type the ticker and press Enter.
        </p>
      ) : null}
      {full ? (
        <p className="field__hint">
          A mix holds up to {MAX_HOLDINGS} funds. Remove one to add another.
        </p>
      ) : null}
    </form>
  );
}
