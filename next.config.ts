import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  async redirects() {
    return [
      {
        source: "/",
        destination: "/workflows",
        permanent: false,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Source-map upload only runs when an auth token is present (CI). Local
  // builds have no token, so the plugin skips upload and stays a no-op.
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  // Strip the Sentry SDK's own debug logging from the production bundle.
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
  },
  widenClientFileUpload: true,
});
