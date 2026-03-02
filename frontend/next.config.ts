import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    typedRoutes: true,
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    config.resolve.alias.encoding = false;
    return config;
  },
  async rewrites() {
    return [
      { source: "/documents", destination: "/" },
      { source: "/clause-library", destination: "/" },
      { source: "/workflows", destination: "/" },
      { source: "/sentinel", destination: "/" },
      { source: "/autopilot", destination: "/" },
      { source: "/tools", destination: "/" },
      { source: "/insights", destination: "/" },
      { source: "/contracts/:id", destination: "/" },
      {
        source: "/api/v1/:path*",
        destination: "http://127.0.0.1:8000/api/v1/:path*",
      },
    ];
  },
};

export default nextConfig;
