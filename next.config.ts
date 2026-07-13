import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/sm/:path*',
        destination: '/api/sm?path=:path*',
      },
    ];
  },
};

export default nextConfig;
