import { afterEach, describe, expect, it } from "vitest";

import { buildScreen, type FilmScreen } from "./screen";
import type { Caption, DotField } from "./types";

const caption: Caption = {
  schema: 1,
  release: "test",
  generated_at: "2026-11-03T00:00:00Z",
  a: {
    ticker: "VTI",
    name: "Vanguard Total Stock Market ETF",
    filed_at: "2026-08-28",
    as_of: "2026-06-30",
    companies: 3446,
  },
  b: {
    ticker: "VOO",
    name: "Vanguard S&P 500 ETF",
    filed_at: "2026-08-28",
    as_of: "2026-06-30",
    companies: 503,
  },
  shared: 501,
  labels: [
    { ticker: "NVDA", name: "NVIDIA", weight: 1211, index: 0 },
    { ticker: "AAPL", name: "Apple", weight: 427, index: 1 },
  ],
  metrics: {
    unitsPerEm: 2000,
    a: { advance: 1.934, ascender: 0.735, descender: -0.265 },
    b: { advance: 2.351, ascender: 0.735, descender: -0.265 },
    rule: { width: 1.934, y: 0.265 },
  },
};

/** Three dots in em units, the first of which is also VOO's. */
function dots(): DotField {
  return {
    count: 3,
    raw: Float32Array.from([
      1, 0.1, 0.2, 0.3, 0.4, 0.1, 0.265, 0.6, 0.5, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  };
}

let screen: FilmScreen | null = null;
let host: HTMLDivElement | null = null;

function build(): { host: HTMLDivElement; screen: FilmScreen } {
  host = document.createElement("div");
  host.id = "curtain";
  document.body.appendChild(host);
  screen = buildScreen(host);
  return { host, screen };
}

afterEach(() => {
  screen?.destroy();
  screen = null;
  host?.remove();
  host = null;
});

describe("the stage", () => {
  it("builds inside the host without data and paints the dark table", () => {
    const built = build();
    expect(built.screen.refs.root.parentElement).toBe(built.host);
    expect(built.screen.refs.root.classList.contains("intro")).toBe(true);
    expect(built.screen.hasData).toBe(false);
    expect(built.screen.hasDots).toBe(false);
    // The stage starts dark and unlit; the curtain behind it is never seen.
    expect(built.screen.refs.root.classList.contains("intro--lit")).toBe(false);
  });

  it("lays the words and the rule out from the bake's metrics once it has them", () => {
    const built = build();
    // Before the bake lands the stage uses the fallback metrics; once it lands, the bake's own.
    built.screen.attach({ caption, dots: null });
    const { a, b, rule, viewport } = built.screen.layout;
    expect(viewport.width).toBeGreaterThan(0);
    expect(a.width).toBeCloseTo(a.advance * a.fontSize, 4);
    expect(a.left).toBeGreaterThan(0);
    // Word B is smaller and below word A.
    expect(b.fontSize).toBeLessThan(a.fontSize);
    expect(b.top).toBeGreaterThan(a.top + a.height);
    // The rule is left-aligned with word A — the collapse maps rx through that origin — and it
    // is exactly as wide as the word, which is what makes the two agree.
    expect(rule.left).toBeCloseTo(a.left, 4);
    expect(rule.width / a.fontSize).toBeCloseTo(1.934, 3);
    expect(rule.width).toBeCloseTo(a.width, 4);
    expect(rule.top).toBeGreaterThan(a.top + a.height * 0.6);
  });

  it("shows the bake's caption and counter once it is attached", () => {
    const built = build();
    built.screen.attach({ caption, dots: null });
    expect(built.screen.hasData).toBe(true);
    expect(built.screen.refs.caption.textContent).toContain("VTI");
    expect(built.screen.refs.caption.textContent).toContain("28 AUG 2026");
    expect(built.screen.refs.counterValue.textContent).toBe("0");
    expect(built.screen.refs.shared.textContent).toBe(
      "501 of VOO's 503 companies are already in VTI",
    );
    // Labels are anchors onto dots, so a film with no dot data has none to show.
    expect(built.screen.refs.labels.children.length).toBe(0);
    // Without a renderer the film still has its word and its caption: dots are optional.
    expect(built.screen.hasDots).toBe(false);
  });

  it("labels the largest companies once dot data is there, renderer or not", () => {
    const built = build();
    built.screen.attach({ caption, dots: dots() });
    // `createDotsField` returns null under jsdom (no WebGL), so this is also the evidence that
    // the labels come from the baked data and not from the renderer.
    expect(built.screen.hasDots).toBe(false);
    expect(built.screen.refs.labels.children.length).toBe(2);
    expect(built.screen.refs.labels.textContent).toContain("NVDA");
    expect(built.screen.refs.labels.textContent).toContain("AAPL");
  });

  it("counts up as the scan runs, without a leading zero and with a separator", () => {
    const built = build();
    built.screen.attach({ caption, dots: null });
    built.screen.setScan(1);
    expect(built.screen.refs.counterValue.textContent).toBe("3,446");
    built.screen.setScan(0);
    expect(built.screen.refs.counterValue.textContent).toBe("0");
  });

  it("takes every value the score sends it, and lights up", () => {
    const built = build();
    built.screen.attach({ caption, dots: dots() });
    expect(() => {
      built.screen.setScan(0.4);
      built.screen.setTwice(0.5);
      built.screen.setCollapse(0.7);
      built.screen.setGlow(1);
      built.screen.setCamera(-0.86);
      built.screen.setCamera(0.26);
      built.screen.setSound(true);
      built.screen.warmSky();
      built.screen.lightUp();
      built.screen.relayout();
      built.screen.render();
    }).not.toThrow();
    expect(built.screen.refs.root.classList.contains("intro--lit")).toBe(true);
    expect(built.screen.refs.sound.getAttribute("aria-pressed")).toBe("true");
  });

  it("takes the page's own headline when there is one", () => {
    const real = document.createElement("h1");
    real.className = "title";
    real.textContent = "See the companies behind your funds";
    document.body.appendChild(real);
    const built = build();
    expect(built.screen.refs.headline.textContent).toBe(real.textContent);
    real.remove();
  });

  it("keeps the controls reachable and the picture out of the accessibility tree", () => {
    const built = build();
    const { root, skip, sound, caption } = built.screen.refs;
    const canvas = root.querySelector("canvas");
    // Skip is the first focusable element of the film, and there are exactly two controls.
    const focusable = root.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusable.length).toBe(2);
    expect(focusable[0]).toBe(skip);
    expect(focusable[1]).toBe(sound);
    expect(skip.textContent).toBe("Skip intro");
    // Neither control sits inside a hidden branch...
    for (const control of [skip, sound]) {
      let node: HTMLElement | null = control;
      while (node !== null) {
        expect(node.getAttribute("aria-hidden")).not.toBe("true");
        node = node.parentElement;
      }
    }
    // ...while the picture — canvas, word, caption, counter — is hidden.
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(caption.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("tears itself down and leaves the host exactly where it was", () => {
    const built = build();
    built.screen.attach({ caption, dots: dots() });
    const root = built.screen.refs.root;
    built.screen.destroy();
    expect(root.isConnected).toBe(false);
    expect(built.host.isConnected).toBe(true);
    expect(built.host.childElementCount).toBe(0);
  });
});
