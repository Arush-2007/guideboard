import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/test/integration-setup.ts"],
    // A real Postgres container shares state across files, so run everything
    // serially in a single worker (fileParallelism:false forces maxWorkers to
    // 1) and give generous timeouts for container startup + migrations.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `server-only` throws unless imported from an RSC; stub it to a no-op so
      // integration tests can pull in server-side modules reached via the
      // executor registry (blob, media-convert). Mirrors vitest.config.ts.
      "server-only": path.resolve(__dirname, "./src/test/server-only-stub.ts"),
    },
  },
});
