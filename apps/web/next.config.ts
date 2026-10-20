import type { NextConfig } from "next";

// User docs (apps/user-docs) are mounted under the SAME domain at /help —
// locally this app rewrites to the docs dev server; production nginx proxies
// the identical path to the docs container. Users never see a second domain.
const helpDocsUrl = process.env.HELP_DOCS_URL ?? "http://localhost:3020";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/help", destination: `${helpDocsUrl}/help` },
        { source: "/help/:path*", destination: `${helpDocsUrl}/help/:path*` }
      ]
    };
  }
};

export default nextConfig;
