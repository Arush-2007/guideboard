import prisma from "@/lib/db";
import { createTRPCRouter, premiumProcedure, protectedProcedure } from "@/trpc/init";
import z from "zod";
import { PAGINATION } from "@/config/constants";
import { CredentialType } from "@/generated/prisma";
import { encrypt, decrypt } from "@/lib/encryption";

const credentialBodySchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    type: z.nativeEnum(CredentialType),
    value: z.string().optional(),
    accessToken: z.string().optional(),
    instagramAccountId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === CredentialType.INSTAGRAM) {
      if (!data.accessToken?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Access token is required",
          path: ["accessToken"],
        });
      }
      if (!data.instagramAccountId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Instagram Account ID is required",
          path: ["instagramAccountId"],
        });
      }
    } else if (!data.value?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Value is required",
        path: ["value"],
      });
    }
  });

const credentialUpdateInput = z
  .object({
    id: z.string(),
  })
  .merge(credentialBodySchema);

function buildStoredValue(input: {
  type: CredentialType;
  value?: string;
  accessToken?: string;
  instagramAccountId?: string;
}): string {
  if (input.type === CredentialType.INSTAGRAM) {
    return encrypt(
      JSON.stringify({
        accessToken: input.accessToken!.trim(),
        instagramAccountId: input.instagramAccountId!.trim(),
      }),
    );
  }
  return encrypt(input.value!.trim());
}

export const credentialsRouter = createTRPCRouter({
  create: premiumProcedure
    .input(credentialBodySchema)
    .mutation(({ ctx, input }) => {
      const { name, type } = input;

      return prisma.credential.create({
        data: {
          name,
          userId: ctx.auth.user.id,
          type,
          value: buildStoredValue(input),
        },
      });
    }),
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      return prisma.credential.delete({
        where: {
          id: input.id,
          userId: ctx.auth.user.id,
        },
      });
    }),
  update: protectedProcedure
    .input(credentialUpdateInput)
    .mutation(({ ctx, input }) => {
      const { id, name, type } = input;

      return prisma.credential.update({
        where: { id, userId: ctx.auth.user.id },
        data: {
          name,
          type,
          value: buildStoredValue(input),
        },
      });
    }),
  getOne: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const credential = await prisma.credential.findUniqueOrThrow({
        where: { id: input.id, userId: ctx.auth.user.id },
      });

      if (credential.type === CredentialType.INSTAGRAM) {
        try {
          const plain = decrypt(credential.value);
          const parsed = JSON.parse(plain) as {
            accessToken: string;
            instagramAccountId: string;
          };
          return {
            ...credential,
            accessToken: parsed.accessToken,
            instagramAccountId: parsed.instagramAccountId,
            value: "",
          };
        } catch {
          return {
            ...credential,
            accessToken: "",
            instagramAccountId: "",
            value: "",
          };
        }
      }

      return credential;
    }),
  getMany: protectedProcedure
    .input(
      z.object({
        page: z.number().default(PAGINATION.DEFAULT_PAGE),
        pageSize: z
          .number()
          .min(PAGINATION.MIN_PAGE_SIZE)
          .max(PAGINATION.MAX_PAGE_SIZE)
          .default(PAGINATION.DEFAULT_PAGE_SIZE),
        search: z.string().default(""),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { page, pageSize, search } = input;

      const [items, totalCount] = await Promise.all([
        prisma.credential.findMany({
          skip: (page - 1) * pageSize,
          take: pageSize,
          where: {
            userId: ctx.auth.user.id,
            name: {
              contains: search,
              mode: "insensitive",
            },
          },
          orderBy: {
            updatedAt: "desc",
          },
        }),
        prisma.credential.count({
          where: {
            userId: ctx.auth.user.id,
            name: {
              contains: search,
              mode: "insensitive",
            },
          },
        }),
      ]);

      const totalPages = Math.ceil(totalCount / pageSize);
      const hasNextPage = page < totalPages;
      const hasPreviousPage = page > 1;

      return {
        items,
        page,
        pageSize,
        totalCount,
        totalPages,
        hasNextPage,
        hasPreviousPage,
      };
    }),
  getByType: protectedProcedure
    .input(
      z.object({
        type: z.nativeEnum(CredentialType),
      }),
    )
    .query(({ input, ctx }) => {
      const { type } = input;

      return prisma.credential.findMany({
        where: { type, userId: ctx.auth.user.id },
        orderBy: {
          updatedAt: "desc",
        },
      });
    }),
  getInstagram: protectedProcedure.query(async ({ ctx }) => {
    return prisma.instagramCredential.findFirst({
      where: { userId: ctx.auth.user.id },
      select: {
        id: true,
        instagramUsername: true,
        instagramAccountId: true,
      },
    });
  }),
  disconnectInstagram: protectedProcedure.mutation(async ({ ctx }) => {
    await prisma.instagramCredential.deleteMany({
      where: { userId: ctx.auth.user.id },
    });
    return { ok: true as const };
  }),
});
