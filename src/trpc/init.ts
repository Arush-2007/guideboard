import { initTRPC, TRPCError } from "@trpc/server";
import { headers } from "next/headers";
import { cache } from "react";
import superjson from "superjson";
import { auth } from "@/lib/auth";
export const createTRPCContext = cache(async () => {
  /**
   * @see: https://trpc.io/docs/server/context
   * Session is attached in `protectedProcedure` via `ctx.auth`.
   */
  return {};
});
// Avoid exporting the entire t-object
// since it's not very descriptive.
// For instance, the use of a t variable
// is common in i18n libraries.
const t = initTRPC.create({
  /**
   * @see https://trpc.io/docs/server/data-transformers
   */
  transformer: superjson,
});
// Base router and procedure helpers
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const baseProcedure = t.procedure;
// TEMPORARY instrumentation — remove once the numbers are read. Splits the two
// costs every protected call pays: the Better Auth session lookup (a DB round
// trip on EVERY procedure, before any real work) and the handler itself. Logging
// them separately is the point; a single total can't tell you which to fix.
export const protectedProcedure = baseProcedure.use(
  async ({ ctx, next, path }) => {
    const t0 = performance.now();

    const session = await auth.api.getSession({
      headers: await headers(),
    });

    const t1 = performance.now();

    if (!session) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      });
    }

    const result = await next({ ctx: { ...ctx, auth: session } });

    const t2 = performance.now();
    console.log(
      `[trpc] ${path} session=${(t1 - t0).toFixed(0)}ms handler=${(t2 - t1).toFixed(0)}ms total=${(t2 - t0).toFixed(0)}ms`,
    );

    return result;
  },
);
// Polar billing is disabled; premium routes now require authentication only.
export const premiumProcedure = protectedProcedure;
