import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit tests for the app's own logic: the fragment codec, the aggregator, the
 * number formatter, and the loader. jsdom by default because some of them render
 * components; the loader opts into `node` for `crypto.subtle`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "out/**", ".next/**"],
    globals: false,
  },
});
