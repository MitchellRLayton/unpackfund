/** Tiny helpers. No dependency, no hidden state, everything deterministic. */

/** Seeded PRNG — the animatic must render identically on every load. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** HTML element with an optional class and parent, in one line. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: Element,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** `1.243` — three decimals, which is the precision a timing review needs. */
export function secs(t: number): string {
  return t.toFixed(3);
}

/** `420ms` / `1.24s` — how a human reads a duration in the readout. */
export function dur(t: number): string {
  return t < 1 ? `${Math.round(t * 1000)}ms` : `${t.toFixed(2)}s`;
}

export function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
