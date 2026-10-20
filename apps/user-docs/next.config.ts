import { createMDX } from 'fumadocs-mdx/next'
import type { NextConfig } from 'next'

// Pages that were merged or renamed. Keeps old bookmarks and external links working.
const moved: Record<string, string> = {
  '/docs/getting-started/signing-in-and-out': '/docs/getting-started/account-access',
  '/docs/getting-started/resetting-your-password': '/docs/getting-started/account-access',
  '/docs/getting-started/choosing-a-plan': '/docs/billing/plans-and-intervals',
  '/docs/dashboard/running-the-approved-suite': '/docs/executions/running-tests',
  '/docs/test-cases/running-selected-tests': '/docs/executions/running-tests',
  '/docs/test-cases/bulk-actions': '/docs/test-cases/organizing-tests',
  '/docs/test-cases/modules-and-tags': '/docs/test-cases/organizing-tests',
  '/docs/test-cases/color-checks': '/docs/reference/test-steps',
  '/docs/executions/screenshots-and-logs': '/docs/executions/viewing-results',
  '/docs/executions/rerun-and-cancel': '/docs/executions/viewing-results',
  '/docs/executions/run-status-reference': '/docs/executions/viewing-results',
  '/docs/settings/organization-profile': '/docs/settings/account',
  '/docs/settings/personal-settings': '/docs/settings/account',
  '/docs/settings/connected-accounts': '/docs/settings/repository-providers',
  '/docs/team/inviting-teammates': '/docs/team/managing-members',
  '/docs/help/getting-help': '/docs/help',
  '/docs/ci-cd/connecting-your-pipeline': '/docs/ci-cd/setting-up-ci',
  '/docs/ci-cd/creating-pipeline-tokens': '/docs/ci-cd/how-ci-works',
  '/docs/ci-cd/managing-connections': '/docs/ci-cd/provider-setup',
}

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Mounted under the main app's domain: apps/web rewrites /help/* to this app,
  // and nginx proxies the same path in production. All routes and assets here
  // resolve under /help (e.g. /help/docs/getting-started, /help/api/search).
  basePath: "/help",
  // Docs screenshots are pre-optimized 2x retina PNGs — serve them untouched
  // so next/image never downsamples them back to a blurry 1x.
  images: {
    unoptimized: true,
  },
  async redirects() {
    return Object.entries(moved).map(([source, destination]) => ({
      source,
      destination,
      permanent: true,
    }))
  },
}

export default createMDX()(config)
