import { execSync } from "node:child_process";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Vitest `globalSetup` for integration tests.
 *
 * Provisions a real Postgres so tests run against the same engine as
 * production (no SQLite provider drift). Two modes:
 *
 * - CI: set `DATABASE_URL_TEST` (e.g. a GitHub Actions `postgres` service
 *   container). We reuse it and skip spinning up our own container.
 * - Local: no env provided, so we start a disposable Postgres via
 *   testcontainers (requires Docker, already used by the dev DB).
 *
 * In both cases we apply the committed migrations with `prisma migrate
 * deploy`, then expose the URL as `DATABASE_URL` so the `@/lib/db` singleton
 * connects to the test database when the test workers import it.
 */

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  let databaseUrl = process.env.DATABASE_URL_TEST;

  if (!databaseUrl) {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    databaseUrl = container.getConnectionUri();
  }

  // The Prisma singleton and the migration CLI both read DATABASE_URL.
  process.env.DATABASE_URL = databaseUrl;
  // …and the CLI reads DIRECT_URL, which the schema declares. Pointing it at
  // the test database is not a convenience: an inherited DIRECT_URL from the
  // developer's `.env` is what `migrate deploy` would actually connect to, so
  // leaving it alone would apply migrations to the DEV database while the tests
  // ran against an unmigrated container. Unset, it fails schema validation
  // outright. Both modes want "the direct connection is this database".
  process.env.DIRECT_URL = databaseUrl;

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
  });
}

export async function teardown() {
  await container?.stop();
}
