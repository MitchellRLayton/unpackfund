import { defineConfig } from "vite";

/**
 * The animatic builds to plain static files. `ANIMATIC_BASE` lets the same
 * commit be served from a sub-path (Cloudflare preview URL, a branch alias)
 * without a second build script.
 */
const base = process.env.ANIMATIC_BASE || "/";

export default defineConfig({
  base,
  server: { port: 4319, strictPort: false },
  preview: { port: 4320 },
  build: {
    target: "es2022",
    cssTarget: "safari16",
    assetsInlineLimit: 0,
    sourcemap: true,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // GSAP and the plugins never change between deploys; keeping them in
        // their own chunk means the reviewable code stays small and cacheable.
        manualChunks(id) {
          if (id.includes("node_modules/gsap")) return "gsap";
          return undefined;
        },
      },
    },
  },
});
