import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  devIndicators: false,
  output: "export",
  trailingSlash: true,
  // This workspace path contains a colon, which breaks Next's internal
  // npm-based TypeScript subprocess. `npm run typecheck` runs it directly.
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
