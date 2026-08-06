import { PrismaClient } from "@/generated/prisma";
import { env } from "@/lib/env";

/**
 * The worker's CONTROL-PLANE database client: the claim loop, the heartbeat,
 * the reaper and the metrics reader — and nothing else.
 *
 * ## Why this is not a tuning knob
 *
 * Runs and the heartbeat compete for connections, and they fail in opposite
 * directions. A run is allowed to wait for a connection; **a heartbeat is not**.
 * If the execution pool saturates — four concurrent runs, each issuing step
 * writes, node-execution records and executor queries — a heartbeat sharing that
 * pool waits behind them. Wait longer than the lease and the reaper hands this
 * worker's job to another one, while this process is still happily executing it.
 *
 * That is the fencing failure arriving through the one door fencing does not
 * watch: not a partition, not a GC pause, but the worker starving *itself*. It
 * presents as a mystery abort under load, which is the hardest kind of incident
 * to read, and load is exactly when it happens.
 *
 * So the control plane gets its own pool, deliberately tiny. Two connections is
 * enough because the loops it serves are strictly serial per tick and each one
 * is a single indexed statement.
 *
 * ## Everything else keeps using `@/lib/db`
 *
 * The engine, the executors, `runExecution` and the step store all import the
 * singleton, and must keep doing so — that IS the execution pool, and its size
 * comes from `connection_limit` on the worker's own `DATABASE_URL` (see
 * DEPLOYMENT notes; the derivation is the parent plan's §6.3). Two clients, two
 * pools, one process.
 *
 * ⚠️ **Do not import this from anything under `src/queue/` or `src/features/`.**
 * `src/queue/` is shared with the Next app, where a second pool per serverless
 * invocation would be a straightforward way to exhaust Postgres' connection
 * limit. The queue functions take a `client?` parameter precisely so this stays
 * a worker-only concern that is passed IN, rather than a module the queue
 * reaches out for.
 */

/**
 * How many connections the control plane may hold.
 *
 * Two, not one: the heartbeat must not queue behind a reaper tick or a metrics
 * read that happens to be in flight. Two, not more: this pool exists to be
 * un-saturatable, and every connection it holds is one the runs cannot use.
 */
const CONTROL_PLANE_CONNECTIONS = 2;

/**
 * `DATABASE_URL` with the control plane's pool size forced onto it.
 *
 * Prisma reads `connection_limit` from the URL and nowhere else, so overriding
 * it means rewriting the string. `URL` rather than string concatenation because
 * the deployed URL already carries query parameters (`sslmode`, and the
 * execution pool's own `connection_limit`/`pool_timeout`), and appending `?…` to
 * a URL that already has a `?` produces a string Postgres rejects with an error
 * that names none of this.
 *
 * `pool_timeout` is deliberately left alone. If these two connections are ever
 * genuinely busy, the right behaviour is the same as everywhere else — wait
 * briefly, then throw `P2024` loudly — and the heartbeat's caller treats a throw
 * as "could not renew", which is already correct.
 */
function controlPlaneUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.searchParams.set("connection_limit", String(CONTROL_PLANE_CONNECTIONS));
    return url.toString();
  } catch {
    // A `DATABASE_URL` that will not parse is a problem, but it is not THIS
    // module's problem to report: `assertWorkerConfig` has already checked the
    // variable is set, and Prisma's own connection error names the URL far
    // better than anything guessed here. Hand it through unchanged and let the
    // pool default apply.
    return raw;
  }
}

/**
 * Constructed at import, like `@/lib/db`'s singleton. No dev-mode `globalThis`
 * caching: that exists in the app to survive Next's hot-reload module churn,
 * and the worker has neither hot reload nor more than one module instance.
 */
export const controlPlaneDb = new PrismaClient({
  datasources: {
    // Through `env()` so the unedited `.env.example`
    // `postgresql://USER:PASSWORD@HOST` reads as "not set" rather than being
    // parsed into a real-looking connection string. `assertWorkerConfig` has
    // already refused to boot in that case; agreeing with it here is what stops
    // the two disagreeing about what "configured" means.
    db: { url: controlPlaneUrl(env(process.env.DATABASE_URL) ?? "") },
  },
});
