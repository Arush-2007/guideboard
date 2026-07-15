import z from "zod";
import prisma from "@/lib/db";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

const aiReplySettingsBodySchema = z.object({
  accountDescription: z.string().optional(),
  replyTone: z.string().optional(),
  replyGoal: z.string().optional(),
});

export const aiReplySettingsRouter = createTRPCRouter({
  get: protectedProcedure.query(async ({ ctx }) => {
    return prisma.aiReplySettings.findUnique({
      where: { userId: ctx.auth.user.id },
    });
  }),
  save: protectedProcedure
    .input(aiReplySettingsBodySchema)
    .mutation(async ({ ctx, input }) => {
      const { accountDescription, replyTone, replyGoal } = input;

      return prisma.aiReplySettings.upsert({
        where: { userId: ctx.auth.user.id },
        create: {
          userId: ctx.auth.user.id,
          accountDescription,
          replyTone,
          replyGoal,
        },
        update: {
          accountDescription,
          replyTone,
          replyGoal,
        },
      });
    }),
});
