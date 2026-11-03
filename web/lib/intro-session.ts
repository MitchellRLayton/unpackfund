/**
 * When the first-visit intro plays — one decision, in one place, testable without a browser.
 *
 * The intro is a 7.5-second film that explains the product. That is a good trade on a
 * first visit and a bad one on a refresh, so it plays at most **once per browser session**
 * and at most **once a day**, and it never plays at all for someone who asked for reduced
 * motion or who arrived on a link that already carries a portfolio.
 *
 * Two marks implement it, both first-party, both local, neither transmitted anywhere:
 *
 * - `sessionStorage` — "this tab has already seen it". It dies with the tab, so a refresh,
 *   a back-button, and a second visit in the same tab all stay silent. This is the mark
 *   that answers *"do not play it again over and over"*.
 * - `localStorage` — "the last time it was shown". It survives the tab, so opening a
 *   fresh tab five minutes later does not replay the film. `COOLDOWN_MS` is how long that
 *   silence lasts; after it, a new session gets the film again. This is the mark that
 *   answers *"when may we show it again"*.
 *
 * Neither contains an identifier, a portfolio, or anything derived from the visitor: one
 * key holds a boolean, the other a single timestamp. They are the only two values the site
 * ever writes to storage, and `web/app/privacy/page.tsx` says so.
 *
 * The decision is a pure function of the marks, the clock, and the URL, so the matrix in
 * `intro-session.test.ts` is the specification. The browser half (`read`, `mark`) is a thin
 * adapter that must never throw — Safari in private mode and a locked-down profile both
 * make storage throw on access, and a privacy setting must degrade to "show it once per
 * tab" rather than to a blank page.
 */

/** How long a visitor goes without seeing the film again, at most once a day. */
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const SESSION_KEY = "unpackfund.intro.session";
export const LAST_KEY = "unpackfund.intro.last";

/** Why the film is, or is not, playing. Returned so the mount can log nothing and test everything. */
export type IntroDecision =
  | { play: true; reason: "first-visit" | "cooldown-elapsed" | "forced" }
  | {
      play: false;
      reason: "seen-this-session" | "cooldown" | "reduced-motion" | "deep-link" | "off";
    };

export interface IntroSnapshot {
  /** `null` when the tab has not seen the film, or when storage is unavailable. */
  session: number | null;
  /** `null` when the film has never been shown on this browser, or storage is unavailable. */
  last: number | null;
  now: number;
  /** The visitor asked the operating system for less motion. */
  reduced: boolean;
  /** The URL already carries a portfolio, so this is a return visit with something to see. */
  deepLink: boolean;
  /** `?intro=force` / `?intro=off`, for review. Both are ignored by the decision below. */
  knob: "force" | "off" | null;
}

/**
 * The whole policy, with no browser in it.
 *
 * Order matters and is deliberate: an explicit `off`, a deep link, and a reduced-motion
 * preference each beat a forced replay, because each of them is the visitor speaking and
 * `force` is only ever a reviewer's convenience.
 */
export function decideIntro(snapshot: IntroSnapshot): IntroDecision {
  const { session, last, now, reduced, deepLink, knob } = snapshot;

  if (knob === "off") return { play: false, reason: "off" };
  if (reduced) return { play: false, reason: "reduced-motion" };
  if (deepLink) return { play: false, reason: "deep-link" };

  if (knob === "force") return { play: true, reason: "forced" };

  if (session !== null) return { play: false, reason: "seen-this-session" };

  if (last === null) return { play: true, reason: "first-visit" };

  if (now - last >= COOLDOWN_MS) return { play: true, reason: "cooldown-elapsed" };

  return { play: false, reason: "cooldown" };
}

/** A storage that may throw on every touch, which is exactly what a private window is. */
export interface SafeStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
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
  };
}

/**
 * Read the marks as a number of milliseconds, or `null`.
 *
 * A value that is not a finite positive number is treated as absent rather than as "now":
 * a corrupt value must not silence the film forever, and it must not make it play on a
 * reload either, so `Number.parseFloat` plus `Number.isFinite` is the whole guard.
 */
export function parseStamp(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
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

/** Write both marks. Called once, after the film has finished or been skipped. */
export function markSeen(
  stores: { session: SafeStore; last: SafeStore },
  now: number,
): void {
  stores.session.set(SESSION_KEY, String(now));
  stores.last.set(LAST_KEY, String(now));
}
