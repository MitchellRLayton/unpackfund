/**
 * Scroll the page so `element`'s top edge sits just under the frozen top bar.
 *
 * The bar is sticky, so "in view" means "below the bar", not "below the viewport's top
 * edge": the browser's own `scrollIntoView` and `focus()` put an element at y = 0, which
 * is behind the bar. That is what docked the lens strip the moment results opened
 * (operator, 2026-11-24) — the strip went under the bar before the visitor had scrolled
 * at all. Smooth unless the visitor asked for reduced motion.
 */
export function scrollBelowTopBar(element: HTMLElement): void {
  const bar = document.querySelector(".app-topbar");
  const barHeight = bar ? bar.getBoundingClientRect().height : 0;
  const top = element.getBoundingClientRect().top + window.scrollY - barHeight - 8;
  const reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
}
