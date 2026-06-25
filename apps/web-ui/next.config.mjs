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
};

export default withMDX(nextConfig);
