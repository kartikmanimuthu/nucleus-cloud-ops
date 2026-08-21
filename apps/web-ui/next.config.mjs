import dotenv from "dotenv";
import { createMDX } from "fumadocs-mdx/next";

// Load the single root .env (../../.env from apps/web-ui/).
// Nx runs the web-ui targets with cwd=apps/web-ui; Bun auto-loads .env from the
// process cwd only (not parent dirs), so the root .env is not auto-loaded there.
// This explicit load picks it up. No-op when the file is absent — e.g. inside the
// Docker build, which injects env vars via Dockerfile ENV / ECS task env instead.
dotenv.config({ path: "../../.env" });

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // @nucleus/rbac ships TypeScript source (it is framework-free by contract and
  // has no build step), so Next must transpile it like first-party code.
  transpilePackages: ["@nucleus/rbac"],
  images: {
    unoptimized: true,
  },
  compress: false, // Let Lambda Web Adapter handle compression
  poweredByHeader: false,
  instrumentationHook: true,
  typescript: {
    // !! WARN !!
    // Dangerously allow production builds to successfully complete even if
    // your project has type errors.
    // !! WARN !!
    ignoreBuildErrors: true,
  },
  eslint: {
    // Disable ESLint during builds to bypass compilation errors
    ignoreDuringBuilds: true,
  },
  async redirects() {
    return [
      {
        // Spot Guard moved under Cost Optimization, which is where the sidebar has always
        // grouped it. Permanent so existing bookmarks keep working. Only the UI route moved —
        // /api/spot-guard/* is untouched.
        source: "/app/spot-guard/:path*",
        destination: "/app/cost-optimization/spot-guard/:path*",
        permanent: true,
      },
      {
        // Scale Sentinel moved under Cloud Operations, matching the Spot Guard
        // precedent above: the sidebar has always grouped it there. Permanent so
        // bookmarks from the sbx rollout keep working. Only the UI route moved —
        // /api/scaling-audit/* is untouched, so no client or export breaks.
        source: "/app/scaling-audit/:path*",
        destination: "/app/cloud-operations/scale-sentinel/:path*",
        permanent: true,
      },
    ];
  },
};

export default withMDX(nextConfig);
