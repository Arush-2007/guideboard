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
    },
  },
});
