import { describe, expect, it } from "vitest";

import {
  DAY_KEY,
  LEGACY_LAST_KEY,
  SESSION_KEY,
  clearLegacy,
  clearSession,
  decideIntro,
  isDeepLink,
  localDay,
  markDay,
  markSession,
  readKnob,
  safeStore,
  type IntroSnapshot,
  type SafeStore,
} from "./intro-session";

/** A storage that behaves, so the tests can assert on what was written. */
function memoryStore(
  initial: Record<string, string> = {},
): SafeStore & { data: Map<string, string>; getItem(k: string): string | null } {
  const data = new Map(Object.entries(initial));
  const store = {
    data,
    // The `SafeStore` shape the marks use…
    get: (key: string) => data.get(key) ?? null,
    set: (key: string, value: string) => void data.set(key, value),
    remove: (key: string) => void data.delete(key),
    readable: () => true,
    // …and the `Storage` shape `safeStore` wraps.
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  return store;
}

/** A storage that throws on every touch, which is what a private window does. */
const blocked = () => {
  throw new Error("blocked");
};

/** Throws on every touch, in both shapes: what a private window does. */
const hostile: SafeStore = {
  get: blocked,
  set: blocked,
  remove: blocked,
  readable: blocked,
};

const hostileStorage = {
  getItem: blocked,
  setItem: blocked,
  removeItem: blocked,
} as unknown as Storage;

const base: IntroSnapshot = {
  session: null,
  day: null,
  today: "2026-11-03",
  reduced: false,
  deepLink: false,
  hidden: false,
  knob: null,
  storageReadable: true,
};

const decide = (patch: Partial<IntroSnapshot> = {}) => decideIntro({ ...base, ...patch });

describe("decideIntro", () => {
  it("plays for a first visit and asks for the session mark", () => {
    expect(decide()).toEqual({ play: true, reason: "first-visit", writeSession: true });
  });

  it("plays again on a new day", () => {
    expect(decide({ day: "2026-11-02" })).toEqual({
      play: true,
      reason: "new-day",
      writeSession: true,
    });
  });

  it("stays silent when the stored day is today", () => {
    expect(decide({ day: "2026-11-03" })).toEqual({
      play: false,
      reason: "already-today",
    });
  });

  it("stays silent for the rest of a session, even past midnight", () => {
    // The session mark is what a refresh, a back-button and a session running past
    // midnight all hit; the day is irrelevant once it is set.
    expect(decide({ session: "1", day: "2026-11-02" })).toEqual({
      play: false,
      reason: "seen-this-session",
    });
  });

  it("does not play in a hidden tab, and writes nothing", () => {
    expect(decide({ hidden: true })).toEqual({ play: false, reason: "hidden" });
  });

  it("does not play when storage cannot be read", () => {
    expect(decide({ storageReadable: false })).toEqual({
      play: false,
      reason: "storage-blocked",
    });
  });

  it("lets the bypasses win over a forced play", () => {
    expect(decide({ knob: "off" })).toEqual({ play: false, reason: "off" });
    expect(decide({ knob: "force", reduced: true })).toEqual({
      play: false,
      reason: "reduced-motion",
    });
    expect(decide({ knob: "force", deepLink: true })).toEqual({
      play: false,
      reason: "deep-link",
    });
    expect(decide({ knob: "force", hidden: true })).toEqual({
      play: false,
      reason: "hidden",
    });
  });

  it("forces a play without touching either key", () => {
    expect(decide({ knob: "force", session: "1", day: "2026-11-03" })).toEqual({
      play: true,
      reason: "forced",
      writeSession: false,
    });
  });

  it("treats a corrupt day as absent rather than as today", () => {
    expect(decide({ day: "not-a-date" })).toEqual({
      play: true,
      reason: "new-day",
      writeSession: true,
    });
  });
});

describe("localDay", () => {
  it("uses the local calendar, not UTC", () => {
    // 2026-11-03T23:30 in Los Angeles is 2026-11-04 in UTC. The visitor's day is the 3rd.
    const evening = new Date(2026, 10, 3, 23, 30);
    expect(localDay(evening)).toBe("2026-11-03");
  });

  it("pads month and day", () => {
    expect(localDay(new Date(2026, 0, 5, 9, 0))).toBe("2026-01-05");
  });

  it("rolls over at local midnight", () => {
    expect(localDay(new Date(2026, 10, 3, 23, 59, 59))).toBe("2026-11-03");
    expect(localDay(new Date(2026, 10, 4, 0, 0, 1))).toBe("2026-11-04");
  });
});

describe("the marks", () => {
  it("writes the session mark and the day, and clears the legacy timestamp", () => {
    const store = memoryStore({ [LEGACY_LAST_KEY]: "1793729629584" });
    markSession(store);
    markDay(store, "2026-11-03");
    clearLegacy(store);

    expect(store.data.get(SESSION_KEY)).toBe("1");
    expect(store.data.get(DAY_KEY)).toBe("2026-11-03");
    expect(store.data.has(LEGACY_LAST_KEY)).toBe(false);
  });

  it("undoes the session mark when the film never started", () => {
    const store = memoryStore();
    markSession(store);
    clearSession(store);
    expect(store.data.has(SESSION_KEY)).toBe(false);
  });

  it("survives a storage that throws on every touch", () => {
    // In production the marks are only ever handed a `safeStore`; this is that pairing.
    const safe = safeStore(() => hostileStorage);
    expect(() => {
      markSession(safe);
      markDay(safe, "2026-11-03");
      clearSession(safe);
      clearLegacy(safe);
    }).not.toThrow();
    expect(safe.readable()).toBe(false);
  });
});

describe("safeStore", () => {
  it("reads and writes through to the real storage", () => {
    const store = memoryStore();
    const safe = safeStore(() => store as unknown as Storage);
    safe.set("k", "v");
    expect(safe.get("k")).toBe("v");
    safe.remove("k");
    expect(safe.get("k")).toBeNull();
  });

  it("returns null and swallows writes when storage is absent", () => {
    const safe = safeStore(() => undefined);
    expect(safe.get("k")).toBeNull();
    expect(() => safe.set("k", "v")).not.toThrow();
    expect(() => safe.remove("k")).not.toThrow();
  });

  it("swallows a storage that throws", () => {
    const safe = safeStore(() => hostileStorage);
    expect(safe.get("k")).toBeNull();
    expect(() => safe.set("k", "v")).not.toThrow();
  });
});

describe("isDeepLink", () => {
  it("is true when the fragment carries a portfolio", () => {
    expect(isDeepLink("", "#v3.eyJhIjoxfQ")).toBe(true);
  });

  it("is true for the query forms", () => {
    expect(isDeepLink("?portfolio=abc", "")).toBe(true);
    expect(isDeepLink("?p=abc", "")).toBe(true);
  });

  it("is false for a bare landing", () => {
    expect(isDeepLink("", "")).toBe(false);
    expect(isDeepLink("?intro=force", "")).toBe(false);
    expect(isDeepLink("", "#")).toBe(false);
  });
});

describe("readKnob", () => {
  it("reads the two review values", () => {
    expect(readKnob("?intro=force")).toBe("force");
    expect(readKnob("?intro=off")).toBe("off");
  });

  it("ignores anything else", () => {
    expect(readKnob("")).toBeNull();
    expect(readKnob("?intro=maybe")).toBeNull();
    expect(readKnob("?other=force")).toBeNull();
  });
});
