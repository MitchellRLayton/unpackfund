"use client";

/**
 * Header search: one box that jumps to any fund or company.
 *
 * A native `<dialog>` rather than a hand-rolled overlay, because the browser
 * already owns focus trapping, Escape, and the inert background — three things a
 * custom modal gets wrong in a way that only a keyboard user notices.
 *
 * The catalogue (8,531 funds) and the company index (10,423 companies) are read
 * when the dialog first opens, not on page load: a reader who came to read their
 * own ledger should not download a directory to do it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { searchAll, type SearchHit } from "@/lib/search";
import { useCatalogue, useCompanyIndex, useRelease } from "@/lib/use-release";

export function SearchPalette() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();

  const release = useRelease();
  const releaseData = release.status === "ready" ? release.data : null;
  // Both are `null` until the dialog opens, which is what keeps them off the
  // critical path of every other page.
  const catalogue = useCatalogue(open ? releaseData : null);
  const companies = useCompanyIndex(open ? releaseData : null);

  const hits = useMemo(
    () =>
      searchAll(query, {
        catalogue: catalogue.data,
        companies: companies.data,
      }),
    [query, catalogue.data, companies.data],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // The input is inside the dialog, so it exists by the time the dialog is open.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function go(hit: SearchHit) {
    setOpen(false);
    setQuery("");
    router.push(hit.href);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      const hit = hits[active];
      if (hit) {
        event.preventDefault();
        go(hit);
      }
    }
  }

  const loading =
    open &&
    query.trim().length > 0 &&
    (catalogue.status === "loading" || companies.status === "loading");

  return (
    <>
      <button
        type="button"
        className="search-trigger"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span aria-hidden="true">⌕</span>
        <span className="search-trigger__label">Search</span>
        <kbd className="kbd">⌘K</kbd>
      </button>

      <dialog
        ref={dialogRef}
        className="search-dialog"
        aria-label="Search funds and companies"
        onClose={() => setOpen(false)}
        onClick={(event) => {
          // A click on the backdrop (the dialog element itself, outside its panel)
          // closes it, which is what every reader expects of a modal.
          if (event.target === dialogRef.current) setOpen(false);
        }}
      >
        <div className="search-panel">
          <label className="visually-hidden" htmlFor="site-search">
            Search funds and companies
          </label>
          <input
            id="site-search"
            ref={inputRef}
            className="search-input"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Ticker, fund name, issuer, or company"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              // A new query is a new list, so the highlight starts at the top again.
              // Done here rather than in an effect: an effect would render the old
              // highlight against the new list for one frame first.
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
          />
          <div className="search-results" role="listbox" aria-label="Results">
            {query.trim().length === 0 ? (
              <p className="search-hint">
                Type a ticker like <span className="mono">VTI</span>, a fund name, an
                issuer, or a company.
              </p>
            ) : loading && hits.length === 0 ? (
              <p className="search-hint">Reading the directory…</p>
            ) : hits.length === 0 ? (
              <p className="search-hint">
                Nothing matches “{query.trim()}”. The directory lists every fund and
                company in the current release.
              </p>
            ) : (
              hits.map((hit, index) => (
                <button
                  key={`${hit.kind}:${hit.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className="search-hit"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => go(hit)}
                >
                  <span className="search-hit__kind">
                    {hit.kind === "fund" ? "Fund" : "Company"}
                  </span>
                  <span className="search-hit__label mono">{hit.label}</span>
                  <span className="search-hit__detail">{hit.detail}</span>
                </button>
              ))
            )}
          </div>
          <p className="search-foot">
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to move ·{" "}
            <kbd className="kbd">Enter</kbd> to open · <kbd className="kbd">Esc</kbd> to
            close
          </p>
        </div>
      </dialog>
    </>
  );
}
