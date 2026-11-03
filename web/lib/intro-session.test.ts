import { describe, expect, it } from "vitest";

import {
  COOLDOWN_MS,
  decideIntro,
  isDeepLink,
  markSeen,
  parseStamp,
  readKnob,
  safeStore,
  type IntroSnapshot,
  type SafeStore,
} from "./intro-session";

const NOW = 1_800_000_000_000;

/** The empty case, so each test names only the field it is about. */
function snapshot(over: Partial<IntroSnapshot> = {}): IntroSnapshot {
  return {
    session: null,
    last: null,
    now: NOW,
    reduced: false,
    deepLink: false,
    knob: null,
    ...over,
  };
}

describe("decideIntro", () => {
  it("plays on a first visit", () => {
    expect(decideIntro(snapshot())).toEqual({ play: true, reason: "first-visit" });
  });

  it("does not play again in the same tab, however many refreshes", () => {
    // The mark is a timestamp, not a boolean, and any value means "seen this tab".
    for (const session of [NOW, NOW - 1, NOW - 60 * 60 * 1000, 1]) {
      expect(decideIntro(snapshot({ session }))).toEqual({
        play: false,
        reason: "seen-this-session",
      });
    }
  });

  it("stays silent in a new tab while the cooldown holds", () => {
    expect(decideIntro(snapshot({ last: NOW - COOLDOWN_MS + 1 }))).toEqual({
      play: false,
      reason: "cooldown",
    });
    expect(decideIntro(snapshot({ last: NOW - 60_000 }))).toEqual({
      play: false,
      reason: "cooldown",
    });
  });

  it("plays again once the cooldown has elapsed", () => {
    expect(decideIntro(snapshot({ last: NOW - COOLDOWN_MS }))).toEqual({
      play: true,
      reason: "cooldown-elapsed",
    });
    expect(decideIntro(snapshot({ last: NOW - COOLDOWN_MS * 3 }))).toEqual({
      play: true,
      reason: "cooldown-elapsed",
    });
  });

  it("never plays for reduced motion, even when forced", () => {
    expect(decideIntro(snapshot({ reduced: true }))).toEqual({
      play: false,
      reason: "reduced-motion",
    });
    expect(decideIntro(snapshot({ reduced: true, knob: "force" }))).toEqual({
      play: false,
      reason: "reduced-motion",
    });
  });

  it("never plays over a link that already carries a portfolio", () => {
    expect(decideIntro(snapshot({ deepLink: true }))).toEqual({
      play: false,
      reason: "deep-link",
    });
    expect(decideIntro(snapshot({ deepLink: true, last: 1 }))).toEqual({
      play: false,
      reason: "deep-link",
    });
  });

  it("obeys the review knobs, and off wins", () => {
    expect(decideIntro(snapshot({ knob: "force" }))).toEqual({
      play: true,
      reason: "forced",
    });
    expect(decideIntro(snapshot({ knob: "force", session: NOW }))).toEqual({
      play: true,
      reason: "forced",
    });
    expect(decideIntro(snapshot({ knob: "off" }))).toEqual({
      play: false,
      reason: "off",
    });
    expect(decideIntro(snapshot({ knob: "off", last: NOW }))).toEqual({
      play: false,
      reason: "off",
    });
  });

  it("is silent on every refresh inside the cooldown, in order", () => {
    // The whole point of two marks: the first visit plays, and nothing after it does
    // until the clock has moved on.
    const marks = { session: null as number | null, last: null as number | null };
    expect(decideIntro(snapshot(marks)).play).toBe(true);
    // tab closed and reopened one second later: a new session, but inside the cooldown.
    expect(decideIntro(snapshot({ ...marks, session: null, last: NOW })).play).toBe(
      false,
    );
    // and the same tab refreshing:
    expect(decideIntro(snapshot({ ...marks, session: NOW, last: NOW })).play).toBe(false);
    // a day later, a new session:
    expect(
      decideIntro(
        snapshot({ ...marks, now: NOW + COOLDOWN_MS, session: null, last: NOW }),
      ).play,
    ).toBe(true);
  });
});

describe("parseStamp", () => {
  it("reads a millisecond stamp", () => {
    expect(parseStamp("1800000000000")).toBe(NOW);
  });

  it("treats junk, zero, negative and infinite as absent", () => {
    for (const raw of [null, "", "abc", "0", "-5", "Infinity", "NaN"]) {
      expect(parseStamp(raw)).toBeNull();
    }
  });
});

describe("isDeepLink", () => {
  it("sees a portfolio in the fragment", () => {
    expect(isDeepLink("", "#v3.WyJicCIsW1siZiIsIlZUSSIsMTAwMDBdXV0")).toBe(true);
  });

  it("ignores an empty fragment", () => {
    expect(isDeepLink("", "")).toBe(false);
    expect(isDeepLink("", "#")).toBe(false);
  });

  it("sees the query-string forms too", () => {
    expect(isDeepLink("?portfolio=VTI", "")).toBe(true);
    expect(isDeepLink("?p=VTI", "")).toBe(true);
    expect(isDeepLink("?utm_source=hn", "")).toBe(false);
  });
});

describe("readKnob", () => {
  it("accepts only the two documented values", () => {
    expect(readKnob("?intro=force")).toBe("force");
    expect(readKnob("?intro=off")).toBe("off");
    expect(readKnob("?intro=maybe")).toBeNull();
    expect(readKnob("")).toBeNull();
  });
});

describe("safeStore", () => {
  it("survives a storage that throws on every touch", () => {
    const hostile = () => {
      throw new Error("SecurityError: the operation is insecure");
    };
    const store = safeStore(hostile);
    expect(store.get("k")).toBeNull();
    expect(() => store.set("k", "v")).not.toThrow();
  });

  it("survives storage being absent", () => {
    const store = safeStore(() => undefined);
    expect(store.get("k")).toBeNull();
    expect(() => store.set("k", "v")).not.toThrow();
  });

  it("reads and writes a real map", () => {
    const map = new Map<string, string>();
    const store = safeStore(
      () =>
        ({
          getItem: (key: string) => map.get(key) ?? null,
          setItem: (key: string, value: string) => void map.set(key, value),
        }) as unknown as Storage,
    );
    store.set("k", "1800000000000");
    expect(store.get("k")).toBe("1800000000000");
  });
});

describe("markSeen", () => {
  it("writes both marks, so a refresh in this tab stays silent", () => {
    const written = new Map<string, string>();
    const store: SafeStore = {
      get: () => null,
      set: (key, value) => void written.set(key, value),
    };
    markSeen({ session: store, last: store }, NOW);
    expect(written.get("unpackfund.intro.session")).toBe(String(NOW));
    expect(written.get("unpackfund.intro.last")).toBe(String(NOW));
  });
});
