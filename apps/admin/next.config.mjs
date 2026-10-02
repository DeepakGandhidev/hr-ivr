/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript/ESM that Next must compile itself.
  transpilePackages: ["@pratibha/shared", "@pratibha/prisma"],
  poweredByHeader: false,
  // instrumentation.ts runs the hourly sweep (coupon dates, deletion holds).
  experimental: { instrumentationHook: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // An internal tool: never framed, never indexed, never cached by a proxy.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
