import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Never advertise the framework; this app is meant to run on localhost only.
  poweredByHeader: false,
  // Keep the dev badge clear of the sidebar's model-status card.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
