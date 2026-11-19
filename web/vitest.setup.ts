/**
 * jsdom does no layout and ships no ResizeObserver, which `TableScroll` (every table
 * in the app) constructs on mount. A no-op stands in; tests that care about geometry
 * (`TableScroll.test.tsx`) define the numbers themselves.
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
