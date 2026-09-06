import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    /**
     * Pin the workspace root to this folder. Without it Turbopack walks up to the
     * repository root and warns about the backend's package-lock.json, which is a
     * separate npm project.
     */
    root: dirname(fileURLToPath(import.meta.url)),
  },
  /**
   * Same-origin API proxy for the browser pages (analytics.html fetches
   * /api/analytics/live, etc.). The engine REST API lives on :4000; the browser
   * must not need CORS, so /api/* on :3000 is proxied there.
   *
   * History: this used to live in next.config.mjs as source '/:path*' →
   * :4000/api/:path*, which DOUBLE-prefixed real API calls (/api/analytics/live
   * became /api/api/analytics/live → engine 404 → the analytics page reported
   * "engine offline"). Deleted 6 Sep 2026 in favour of this scoped rule.
   */
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:4000/api/:path*",
      },
    ];
  },
};

export default nextConfig;
