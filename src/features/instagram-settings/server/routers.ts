import prisma from "@/lib/db";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";
import z from "zod";

const instagramSettingsBodySchema = z.object({
  accountDescription: z.string().optional(),
  replyTone: z.string().optional(),
  replyGoal: z.string().optional(),
});

export const instagramSettingsRouter = createTRPCRouter({
  get: protectedProcedure.query(async ({ ctx }) => {
    return prisma.instagramSettings.findUnique({
      where: { userId: ctx.auth.user.id },
    });
  }),
  save: protectedProcedure
    .input(instagramSettingsBodySchema)
    .mutation(async ({ ctx, input }) => {
      const { accountDescription, replyTone, replyGoal } = input;

      return prisma.instagramSettings.upsert({
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
