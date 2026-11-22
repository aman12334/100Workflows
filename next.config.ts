import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Never advertise the framework; this app is meant to run on localhost only.
  poweredByHeader: false,
  // Keep the dev badge clear of the sidebar's model-status card.
  devIndicators: { position: "bottom-right" },
  // Pages carry approve/reject buttons for real external actions: never allow framing (clickjacking).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
