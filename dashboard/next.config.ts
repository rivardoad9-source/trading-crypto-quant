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
};

export default nextConfig;
