import next from "eslint-config-next/core-web-vitals";

/**
 * Flat config. `eslint-config-next` v16 exports a flat-config array, so it is
 * spread rather than extended. Generated output is ignored, never linted.
 */
const config = [
  {
    ignores: ["out/**", ".next/**", "next-env.d.ts", "node_modules/**"],
  },
  ...next,
];

export default config;
