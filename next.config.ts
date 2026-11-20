import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["onnxruntime-node"],
  reactStrictMode: false,
};

export default nextConfig;
