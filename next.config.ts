import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  devIndicators: false,
  output: "export",
  trailingSlash: true,
};

export default nextConfig;
