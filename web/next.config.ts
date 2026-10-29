import type { NextConfig } from "next";

/**
 * Static export only. The product has no server: every number is precomputed by
 * the pipeline, so a Node runtime in the request path would be a bug, not a
 * convenience. `next build` must fail rather than silently emit a server bundle.
 */
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
