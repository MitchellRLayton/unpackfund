"use client";

/**
 * Whether the visitor has folded the sidebar down to its icon rail (operator, 2026-11-24).
 *
 * A view preference, not portfolio state: it lives in this browser's `localStorage`, is
 * never sent anywhere, and losing it loses nothing but the fold. Read through
 * `useSyncExternalStore` so the first render is the server's (expanded) and the stored
 * choice arrives without a setState-in-effect. A browser that refuses storage still gets
 * a working toggle for the page's lifetime, from the in-memory copy.
 */

import { useCallback, useSyncExternalStore } from "react";

const KEY = "unpackfund:nav";
const listeners = new Set<() => void>();
let memory: boolean | null = null;

function read(): boolean {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(KEY) === "collapsed";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab folding the sidebar folds this one too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    memory = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** `[collapsed, toggle]`. Expanded on the server and on a first visit. */
export function useNavCollapsed(): [boolean, () => void] {
  const collapsed = useSyncExternalStore(subscribe, read, () => false);
  const toggle = useCallback(() => {
    const next = !read();
    memory = next;
    try {
      window.localStorage.setItem(KEY, next ? "collapsed" : "expanded");
    } catch {
      // Storage refused: the in-memory copy carries the choice for this page.
    }
    for (const listener of listeners) listener();
  }, []);
  return [collapsed, toggle];
}
