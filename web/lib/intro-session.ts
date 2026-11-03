/**
 * When the first-visit film plays — one decision, in one place, testable without a browser.
 *
 * The film is nine seconds that explain the product. That is a good trade on a first visit
 * and a bad one on a refresh, so the rule is **once per calendar day, per browser**: a
 * visitor who comes back after lunch sees the site, and a visitor who comes back tomorrow
 * sees the film again.
 *
 * Two marks implement it, both first-party, both local, neither transmitted anywhere:
 *
 * - `sessionStorage` — "this session has already decided". It dies with the tab, so a
 *   refresh, a back-button and a second visit in the same tab all stay silent, and a
 *   session that runs past midnight does not replay.
 * - `localStorage` — the **local date** of the last play, `YYYY-MM-DD`. A date, not a
 *   timestamp: a rolling 24 hours would mean a visit at 11 pm blocks the next evening,
 *   which is not what "once a day" means to anyone. It is also less data than a timestamp.
 *
 * Neither contains an identifier, a portfolio, or anything derived from the visitor. They
 * are the only two values the site ever writes to storage, and `web/app/privacy/page.tsx`
 * says so.
 *
 * The decision is a pure function of the marks, the date, the URL and the tab's visibility,
 * so the matrix in `intro-session.test.ts` is the specification. The browser half is a thin
 * adapter that must never throw — Safari in private mode and a locked-down profile both
 * make storage throw on access, and a privacy setting must degrade to "no film" rather than
 * to a blank page.
 */

export const DAY_KEY = "unpackfund.intro.day";
export const SESSION_KEY = "unpackfund.intro.session";
/** The rolling-timestamp key this replaced. Deleted on first run. */
export const LEGACY_LAST_KEY = "unpackfund.intro.last";

/** Why the film is, or is not, playing. Returned so the mount can log nothing and test everything. */
export type IntroDecision =
  | { play: true; reason: "first-visit" | "new-day" | "forced"; writeSession: boolean }
  | {
      play: false;
      reason:
        | "off"
        | "reduced-motion"
        | "deep-link"
        | "hidden"
        | "seen-this-session"
        | "storage-blocked"
        | "already-today";
    };

export interface IntroSnapshot {
  /** The raw session mark, or `null`. */
  session: string | null;
  /** The raw stored day, or `null`. */
  day: string | null;
  /** Today, as the visitor's own calendar sees it. */
  today: string;
  /** The visitor asked the operating system for less motion. */
  reduced: boolean;
  /** The URL already carries a portfolio, so this is a return visit with something to see. */
  deepLink: boolean;
  /** The tab was in the background when the page loaded. */
  hidden: boolean;
  /** `?intro=force` / `?intro=off`, for review. */
  knob: "force" | "off" | null;
  /** `false` when localStorage throws on read — a private window, a locked-down profile. */
  storageReadable: boolean;
}

/**
 * The whole policy, with no browser in it.
 *
 * The order is the brief's, and each step is there for a reason:
 *
 * 1. The bypasses come first and write nothing, so a visitor who asked for less motion, or
 *    who arrived on a link with a portfolio in it, does not burn the day's one showing.
 * 2. A session that has already decided stays decided — that is what stops a refresh.
 * 3. The session mark is written *before* the day is read, so two tabs opened at the same
 *    moment cannot both play. The caller undoes it if the film never starts.
 * 4. Unreadable storage means no film, not a film on every page load.
 * 5. The day is the only thing that decides between "today" and "not today".
 *
 * A forced play (the review knob, or the U key) reads and writes neither key.
 */
export function decideIntro(snapshot: IntroSnapshot): IntroDecision {
  const { session, day, today, reduced, deepLink, hidden, knob, storageReadable } =
    snapshot;

  if (knob === "off") return { play: false, reason: "off" };
  if (reduced) return { play: false, reason: "reduced-motion" };
  if (deepLink) return { play: false, reason: "deep-link" };
  if (hidden) return { play: false, reason: "hidden" };

  if (knob === "force") return { play: true, reason: "forced", writeSession: false };

  if (session !== null) return { play: false, reason: "seen-this-session" };

  if (!storageReadable) return { play: false, reason: "storage-blocked" };

  if (day === today) return { play: false, reason: "already-today" };

  return {
    play: true,
    reason: day === null ? "first-visit" : "new-day",
    writeSession: true,
  };
}

/**
 * Today as the visitor's own calendar sees it, `YYYY-MM-DD`.
 *
 * Built from the local getters, never `toISOString()`: that is UTC, and a visitor in
 * Auckland at 9 am would be told it is still yesterday, so the film would play twice in
 * one of their days and not at all in another.
 */
export function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** A storage that may throw on every touch, which is exactly what a private window is. */
export interface SafeStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** `false` when the store throws on a read, which is what a private window does. */
  readable(): boolean;
}

export function safeStore(read: () => Storage | undefined): SafeStore {
  return {
    get(key) {
      try {
        return read()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        read()?.setItem(key, value);
      } catch {
        // A full quota or a private window: the film simply plays once per tab instead.
      }
    },
    remove(key) {
      try {
        read()?.removeItem(key);
      } catch {
        // Nothing to do; the mark was never written.
      }
    },
    readable() {
      try {
        const store = read();
        if (!store) return false;
        // A read is the only way to tell a blocked store from an empty one.
        store.getItem(DAY_KEY);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The URL the visitor landed on decides whether a portfolio is already in view. */
export function isDeepLink(search: string, hash: string): boolean {
  if (hash.length > 1) return true;
  const params = new URLSearchParams(search);
  return params.has("portfolio") || params.has("p");
}

/** `?intro=force|off` — review knobs, never a visitor-facing feature. */
export function readKnob(search: string): "force" | "off" | null {
  const value = new URLSearchParams(search).get("intro");
  return value === "force" || value === "off" ? value : null;
}

/** Step 3 of the decision: this session has now decided, whatever it decided. */
export function markSession(store: SafeStore): void {
  store.set(SESSION_KEY, "1");
}

/** Undo step 3 when the film never started, so a slow load does not burn the session. */
export function clearSession(store: SafeStore): void {
  store.remove(SESSION_KEY);
}

/** Written when playback starts, not when it ends: a visitor who closes the tab halfway
 * through has still seen it, and replaying it on the next load is what this prevents. */
export function markDay(store: SafeStore, today: string): void {
  store.set(DAY_KEY, today);
}

/** The rolling-timestamp key from the previous build. One line, once, on first run. */
export function clearLegacy(store: SafeStore): void {
  store.remove(LEGACY_LAST_KEY);
}
