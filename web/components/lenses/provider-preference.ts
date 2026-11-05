"use client";

/**
 * Which country classification the reader is looking at.
 *
 * The choice is a **display preference**, not portfolio state: it says which publisher's
 * convention decides whether a domicile is developed or emerging, and it carries no
 * weight, ticker or total. So it lives in the query string — `?cls=ftse` — and never in
 * the fragment, which is the portfolio's alone (invariant I3).
 *
 * MSCI is the default, so the default URL is unchanged: `?cls=msci` is never written, and
 * the parameter is removed when the reader goes back to it. The choice is written with
 * `history.replaceState`, not `pushState`, so flipping the toggle does not fill the back
 * button with states of a view.
 *
 * **Nothing is stored.** `lib/legal.ts` tells the reader the site writes nothing to
 * localStorage or sessionStorage, and that sentence is a legal statement rather than a
 * preference: a display toggle is not worth making it false. The query string is the
 * better mechanism anyway — it survives a reload, it is shareable, and it puts the
 * convention in the URL where a reader can see it.
 *
 * One module-level store, read through `useSyncExternalStore`, so the Markets lens, the
 * ledger, the compare page and the company page cannot disagree about which convention is
 * on screen. The server snapshot is the default, because a static export is prerendered
 * without a query string; the URL is read in an effect, after hydration.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { DEFAULT_PROVIDER, PROVIDERS, type Provider } from "@/lib/country-tier";

/** The query-string key: `?cls=ftse`. MSCI is the default and is never written. */
export const PROVIDER_PARAM = "cls";

/** A provider named by a query-string value, or `null` when the value names none. */
export function parseProvider(value: string | null | undefined): Provider | null {
  if (!value) return null;
  const wanted = value.trim().toLowerCase();
  for (const provider of PROVIDERS) {
    if (provider.toLowerCase() === wanted) return provider;
  }
  return null;
}

/** The provider a query string names, or `null` when it names none. */
export function providerFromSearch(search: string): Provider | null {
  return parseProvider(new URLSearchParams(search).get(PROVIDER_PARAM));
}

/**
 * The query string for a provider, keeping every other parameter.
 *
 * The default writes nothing, so a reader who never touches the toggle keeps the URL they
 * arrived with. The fragment is not this function's business: `URL` keeps it, and it is
 * the portfolio's.
 */
export function providerSearch(search: string, provider: Provider): string {
  const params = new URLSearchParams(search);
  if (provider === DEFAULT_PROVIDER) params.delete(PROVIDER_PARAM);
  else params.set(PROVIDER_PARAM, provider.toLowerCase());
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

let current: Provider = DEFAULT_PROVIDER;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): Provider {
  return current;
}

function serverSnapshot(): Provider {
  return DEFAULT_PROVIDER;
}

/** Read the URL once, after hydration: a static export is prerendered without one. */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const named = providerFromSearch(window.location.search);
  if (named !== null && named !== current) {
    current = named;
    emit();
  }
}

/**
 * Choose a convention: the URL, then the store.
 *
 * `replaceState` rather than `pushState` — a toggle is a view, and the back button should
 * leave the page rather than walk back through conventions. The fragment is untouched.
 */
export function chooseProvider(provider: Provider): void {
  hydrated = true;
  const url = new URL(window.location.href);
  url.search = providerSearch(url.search, provider);
  window.history.replaceState(window.history.state, "", url);
  if (provider === current) return;
  current = provider;
  emit();
}

/** The convention on screen, and the way to change it. */
export function useProvider(): {
  provider: Provider;
  setProvider: (provider: Provider) => void;
} {
  const provider = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    hydrate();
  }, []);
  const setProvider = useCallback((next: Provider) => chooseProvider(next), []);
  return { provider, setProvider };
}

/** Test seam: forget the URL's answer and go back to the default. */
export function resetProviderPreference(): void {
  hydrated = false;
  if (current === DEFAULT_PROVIDER) return;
  current = DEFAULT_PROVIDER;
  emit();
}
