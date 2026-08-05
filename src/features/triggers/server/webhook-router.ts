import { randomBytes } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import z from "zod";
import prisma from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

/**
 * Management endpoints for the generic webhook trigger. The token + secret are
 * server-owned (provisioned by `syncTriggerPollsForWorkflow`), so the editor
 * dialog reads them here rather than from node data, and rotates them via
 * `regenerate`. Both procedures scope to the caller's own workflow.
 *
 * The full URL is composed client-side from the token (same `NEXT_PUBLIC_APP_URL`
 * convention the Telegram trigger dialog uses), so URL construction stays
 * consistent across the webhook dialogs.
 */
export const webhookRouter = createTRPCRouter({
  // Returns null until the workflow (with the webhook node) has been saved, so
  // the dialog can prompt the user to save first.
  get: protectedProcedure
    .input(z.object({ workflowId: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await prisma.webhookTrigger.findFirst({
        where: { workflowId: input.workflowId, userId: ctx.auth.user.id },
        select: { token: true, secret: true, requireSignature: true },
      });
      if (!row) return null;
      return {
        token: row.token,
        secret: decrypt(row.secret),
        requireSignature: row.requireSignature,
      };
    }),

  // Turns signature enforcement on or off for this workflow's webhook.
  //
  // Both directions are legitimate. Turning it ON is the recommendation, but a
  // user whose sender genuinely cannot compute an HMAC — a no-code form tool, a
  // device posting fixed JSON — must be able to turn it back off rather than be
  // locked out of their own integration. The URL token remains the baseline in
  // that case, which is what every existing row already relies on.
  setRequireSignature: protectedProcedure
    .input(z.object({ workflowId: z.string(), requireSignature: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // Scoped by userId in the WHERE, not checked afterwards, so another
      // user's row can never be the one updated.
      const { count } = await prisma.webhookTrigger.updateMany({
        where: { workflowId: input.workflowId, userId: ctx.auth.user.id },
        data: { requireSignature: input.requireSignature },
      });

      if (count === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "No webhook for this workflow yet — save the workflow first.",
        });
      }

      return { requireSignature: input.requireSignature };
    }),

  // Rotates the token + secret, invalidating the old URL. Returns the new pair.
  regenerate: protectedProcedure
    .input(z.object({ workflowId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.webhookTrigger.findFirst({
        where: { workflowId: input.workflowId, userId: ctx.auth.user.id },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "No webhook for this workflow yet — save the workflow first.",
        });
      }

      const token = createId();
      const secret = randomBytes(32).toString("hex");
      await prisma.webhookTrigger.update({
        where: { id: existing.id },
        data: { token, secret: encrypt(secret) },
      });

      return { token, secret };
    }),
});
