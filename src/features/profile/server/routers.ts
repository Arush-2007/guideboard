import { TRPCError } from "@trpc/server";
import { isAPIError } from "better-auth/api";
import { headers } from "next/headers";
import z from "zod";
import { NodeType } from "@/generated/prisma";
import { auth } from "@/lib/auth";
import { isBlobConfigured } from "@/lib/blob";
import prisma from "@/lib/db";
import { describeUserAgent } from "@/lib/user-agent";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

/**
 * Backs the /profile page.
 *
 * **Reads live here; most writes deliberately do not.** `updateUser`,
 * `changePassword`, `changeEmail`, `revokeSession` and friends rotate the
 * session cookie as a side effect, so they are called from the browser through
 * `authClient` where Better Auth can set that cookie on the response. Routing
 * them through tRPC would leave the caller holding a stale session. Reads come
 * back through here instead so the page keeps the repo's
 * prefetch-on-server / suspense-on-client shape and can compare each session
 * against the *current* one.
 *
 * `disconnectAccount` is the one write that belongs here, because unlinking
 * Google has to clean up a Guideboard-owned table that Better Auth knows
 * nothing about.
 */

/**
 * Node types that cannot run without the Google OAuth grant. Used to tell the
 * user, concretely, what disconnecting Google will break.
 */
const GOOGLE_DEPENDENT_NODE_TYPES: NodeType[] = [
  NodeType.GMAIL_TRIGGER,
  NodeType.GMAIL_ACTION,
  NodeType.GOOGLE_SHEETS_TRIGGER,
  NodeType.GOOGLE_SHEETS_ACTION,
  NodeType.GOOGLE_FORM_TRIGGER,
];

/** Better Auth's row for an email+password login, as opposed to an OAuth one. */
const CREDENTIAL_PROVIDER_ID = "credential";

export const profileRouter = createTRPCRouter({
  /**
   * The account's own details. Read from the database rather than from
   * `ctx.auth.user` because the session is served from a 5-minute signed cookie
   * cache (see `session.cookieCache` in `src/lib/auth.ts`) — a rename would
   * otherwise appear not to have saved.
   */
  get: protectedProcedure.query(async ({ ctx }) => {
    const [user, credentialAccount] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: ctx.auth.user.id },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          image: true,
          createdAt: true,
        },
      }),
      prisma.account.findFirst({
        where: {
          userId: ctx.auth.user.id,
          providerId: CREDENTIAL_PROVIDER_ID,
        },
        select: { id: true },
      }),
    ]);

    return {
      ...user,
      /** False for OAuth-only accounts — they get "Set a password" instead. */
      hasPassword: Boolean(credentialAccount),
      /** Avatar upload needs R2; without it the UI degrades to initials. */
      avatarUploadEnabled: isBlobConfigured(),
    };
  }),

  listSessions: protectedProcedure.query(async ({ ctx }) => {
    const sessions = await auth.api.listSessions({ headers: await headers() });

    return sessions
      .map((session) => ({
        id: session.id,
        token: session.token,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress ?? null,
        device: describeUserAgent(session.userAgent),
        isCurrent: session.token === ctx.auth.session.token,
      }))
      .sort((a, b) => {
        // The device you're reading this on goes first; the rest by recency.
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return b.updatedAt.getTime() - a.updatedAt.getTime();
      });
  }),

  listConnectedAccounts: protectedProcedure.query(async () => {
    const accounts = await auth.api.listUserAccounts({
      headers: await headers(),
    });

    return accounts
      .filter((account) => account.providerId !== CREDENTIAL_PROVIDER_ID)
      .map((account) => ({
        id: account.id,
        providerId: account.providerId,
        accountId: account.accountId,
        createdAt: account.createdAt,
        scopes: account.scopes ?? [],
      }))
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }),

  /**
   * How many of the user's workflows contain a node that needs the Google
   * grant. Shown in the disconnect confirmation so the choice is informed
   * rather than a shrug.
   */
  googleDependentWorkflowCount: protectedProcedure.query(async ({ ctx }) => {
    return prisma.workflow.count({
      where: {
        userId: ctx.auth.user.id,
        nodes: { some: { type: { in: GOOGLE_DEPENDENT_NODE_TYPES } } },
      },
    });
  }),

  /**
   * Unlinks an OAuth provider. Better Auth removes the `Account` row; for
   * Google we must also drop the mirrored `GoogleCredential`, otherwise the
   * Sheets/Gmail executors keep finding a stale encrypted token and fail with a
   * confusing API error instead of an honest "not connected".
   */
  disconnectAccount: protectedProcedure
    .input(z.object({ providerId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (input.providerId === CREDENTIAL_PROVIDER_ID) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Your email and password sign-in can't be disconnected.",
        });
      }

      try {
        await auth.api.unlinkAccount({
          headers: await headers(),
          body: { providerId: input.providerId },
        });
      } catch (error) {
        // Better Auth refuses to unlink the only remaining sign-in method, and
        // says so with a 4xx APIError. That is user-fixable ("set a password
        // first"), so it becomes a BAD_REQUEST the UI can show verbatim.
        //
        // Anything else — a 5xx, a dropped database connection, a bug — is NOT
        // the user's fault and must keep its own status: dressing it up as a
        // 400 hides a real outage behind a message that reads like validation,
        // and loses the 5xx that alerting keys on.
        if (isAPIError(error) && error.statusCode < 500) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.body?.message ?? "Couldn't disconnect that account.",
          });
        }
        throw error;
      }

      if (input.providerId === "google") {
        await prisma.googleCredential.deleteMany({
          where: { userId: ctx.auth.user.id },
        });
      }

      return { success: true };
    }),
});
