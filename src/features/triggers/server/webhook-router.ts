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
        select: { token: true, secret: true },
      });
      if (!row) return null;
      return { token: row.token, secret: decrypt(row.secret) };
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
