/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The workspace packages ship TypeScript/ESM that Next must compile itself.
  transpilePackages: ["@pratibha/shared", "@pratibha/prisma", "@pratibha/worker"],

  experimental: {
    typedRoutes: false,
    // The CV upload route reuses the worker's parser, which loads pdf.js.
    // Webpack cannot bundle it: pdf.js resolves its own worker at runtime and
    // pulls in Node built-ins, so bundling yields a route that throws on the
    // first PDF. Leaving it external makes it a plain require at runtime.
    serverComponentsExternalPackages: ["pdf-parse"],
  },
};

export default nextConfig;
