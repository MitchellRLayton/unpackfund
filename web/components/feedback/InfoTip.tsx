"use client";

/**
 * The one tooltip component.
 *
 * It exists because the same three things went wrong every time a tooltip was hand-rolled: it
 * opened on hover only, so a keyboard reader never saw it; two could be open at once; and its
 * text was reachable by nobody, because the trigger had no `aria-describedby`.
 *
 * So: hover, focus and click all open it; Esc and blur close it; opening one closes the rest,
 * through a module-level registry rather than React context, because the strip, the table
 * header and the holdings pane are three separate trees and a context would have to be
 * threaded through all of them for a piece of state that only ever has one value.
 *
 * The trigger is a real `<button>` with an accessible name of "About {label}". When the label
 * is already a sort button, this sits *beside* it — a button is never nested in a button.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import styles from "./InfoTip.module.css";

/**
 * Exactly one tip open at a time.
 *
 * A module-scope registry, not context: the alternative is a provider above every surface that
 * uses a tip, which buys nothing for a single boolean.
 */
const openTips = new Set<() => void>();

function closeOthers(except: () => void) {
  for (const close of openTips) {
    if (close !== except) close();
  }
}

export function InfoTip({
  label,
  children,
  /** Rendered instead of the ⓘ when the header is itself a control. */
  inline = false,
}: {
  /** What the tip is about, for "About {label}". */
  label: string;
  /** The tip text: plain text, at most 30 words, no links. */
  children: string;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    openTips.add(close);
    return () => {
      openTips.delete(close);
    };
  }, [open, close]);

  // Esc anywhere while this tip is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const show = () => {
    closeOthers(close);
    setOpen(true);
  };

  return (
    <span className={inline ? styles.inline : styles.wrap}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label={`About ${label}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={show}
        onFocus={show}
        onClick={() => (open ? setOpen(false) : show())}
        onMouseLeave={() => setOpen(false)}
        onBlur={() => setOpen(false)}
      >
        <span aria-hidden="true">i</span>
      </button>
      {open ? (
        <span id={id} role="tooltip" className={styles.tip}>
          {children}
        </span>
      ) : null}
    </span>
  );
}
