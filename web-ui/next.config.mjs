/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  images: {
    unoptimized: true,
  },
  compress: false, // Let Lambda Web Adapter handle compression
  poweredByHeader: false,
  experimental: {
    instrumentationHook: true,
  },
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
  serverExternalPackages: ['aws-sdk'],
};

export default nextConfig;
