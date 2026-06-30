import ky from "ky";
import z from "zod";
import { PAGINATION } from "@/config/constants";
import { CredentialType } from "@/generated/prisma";
import prisma from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { refreshYoutubeTokenIfNeeded } from "@/lib/youtube-token";
import {
  createTRPCRouter,
  premiumProcedure,
  protectedProcedure,
} from "@/trpc/init";

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
    } else if (data.type === CredentialType.WHATSAPP) {
      const value = data.value?.trim();
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Value is required",
          path: ["value"],
        });
        return;
      }
      try {
        const parsed = JSON.parse(value) as {
          accessToken?: string;
          phoneNumberId?: string;
        };
        if (!parsed.accessToken?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "accessToken is required in JSON value",
            path: ["value"],
          });
        }
        if (!parsed.phoneNumberId?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "phoneNumberId is required in JSON value",
            path: ["value"],
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Value must be valid JSON: {"accessToken":"...","phoneNumberId":"..."}',
          path: ["value"],
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

      // Return the decrypted secret so the edit form shows the real value.
      // Without this the form would pre-fill the ciphertext and a subsequent
      // save would re-encrypt it (double-encryption corrupts the credential).
      try {
        return { ...credential, value: decrypt(credential.value) };
      } catch {
        // Legacy/corrupted (e.g. double-encrypted) values can't be decrypted;
        // return empty so the user can re-enter the key cleanly.
        return { ...credential, value: "" };
      }
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
        tokenExpiresAt: true,
      },
    });
  }),
  disconnectInstagram: protectedProcedure.mutation(async ({ ctx }) => {
    await prisma.instagramCredential.deleteMany({
      where: { userId: ctx.auth.user.id },
    });
    return { ok: true as const };
  }),
  getYoutube: protectedProcedure.query(async ({ ctx }) => {
    return prisma.youtubeCredential.findFirst({
      where: { userId: ctx.auth.user.id },
      select: {
        id: true,
        channelTitle: true,
        channelId: true,
      },
    });
  }),
  disconnectYoutube: protectedProcedure.mutation(async ({ ctx }) => {
    await prisma.youtubeCredential.deleteMany({
      where: { userId: ctx.auth.user.id },
    });
    return { ok: true as const };
  }),
  getYoutubeVideos: protectedProcedure.query(async ({ ctx }) => {
    type YoutubeVideosResponse = {
      items?: Array<{
        id?: { videoId?: string };
        snippet?: { title?: string };
      }>;
    };

    const accessToken = await refreshYoutubeTokenIfNeeded(ctx.auth.user.id);
    const data = await ky
      .get("https://www.googleapis.com/youtube/v3/search", {
        searchParams: {
          part: "snippet",
          forMine: "true",
          type: "video",
          maxResults: "25",
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
      .json<YoutubeVideosResponse>();

    return (data.items ?? [])
      .map((item) => ({
        videoId: item.id?.videoId ?? "",
        title: item.snippet?.title ?? "Untitled video",
      }))
      .filter((item) => item.videoId.length > 0);
  }),
  getGoogleSheets: protectedProcedure.query(async ({ ctx }) => {
    type GoogleSheetsResponse = {
      files?: Array<{
        id?: string;
        name?: string;
      }>;
    };

    const accessToken = await refreshGoogleTokenIfNeeded(ctx.auth.user.id);
    const data = await ky
      .get("https://www.googleapis.com/drive/v3/files", {
        searchParams: {
          q: "mimeType='application/vnd.google-apps.spreadsheet'",
          fields: "files(id,name)",
          pageSize: "100",
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
      .json<GoogleSheetsResponse>();

    return (data.files ?? [])
      .map((file) => ({
        id: file.id ?? "",
        name: file.name ?? "Untitled spreadsheet",
      }))
      .filter((file) => file.id.length > 0);
  }),
  // Lists the user's Google Forms (mirrors getGoogleSheets — Drive file list).
  getGoogleForms: protectedProcedure.query(async ({ ctx }) => {
    type DriveFilesResponse = {
      files?: Array<{ id?: string; name?: string }>;
    };

    const accessToken = await refreshGoogleTokenIfNeeded(ctx.auth.user.id);
    const data = await ky
      .get("https://www.googleapis.com/drive/v3/files", {
        searchParams: {
          q: "mimeType='application/vnd.google-apps.form'",
          fields: "files(id,name)",
          pageSize: "100",
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .json<DriveFilesResponse>();

    return (data.files ?? [])
      .map((file) => ({
        id: file.id ?? "",
        name: file.name ?? "Untitled form",
      }))
      .filter((file) => file.id.length > 0);
  }),
  // Reads a form's questions via the Forms API (needs the forms.body.readonly
  // scope). Each question's title is exactly the key the Apps Script webhook
  // uses in `responses`, so a discovered field maps 1:1 to a reference like
  // `@<googleForm.responses.<title>>@`.
  getGoogleFormQuestions: protectedProcedure
    .input(z.object({ formId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      type FormsGetResponse = {
        items?: Array<{
          title?: string;
          questionItem?: unknown;
          questionGroupItem?: unknown;
        }>;
      };

      const accessToken = await refreshGoogleTokenIfNeeded(ctx.auth.user.id);
      const data = await ky
        .get(`https://forms.googleapis.com/v1/forms/${input.formId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        .json<FormsGetResponse>();

      return (data.items ?? [])
        .filter((item) => item.questionItem || item.questionGroupItem)
        .map((item) => (item.title ?? "").trim())
        .filter((title) => title.length > 0)
        .map((title) => ({ title }));
    }),
  getSheetColumns: protectedProcedure
    .input(
      z.object({
        spreadsheetId: z.string().min(1),
        sheetName: z.string().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      type SheetValuesResponse = { values?: string[][] };

      const accessToken = await refreshGoogleTokenIfNeeded(ctx.auth.user.id);
      const a1Range = `${input.sheetName}!1:1`;

      const data = await ky
        .get(
          `https://sheets.googleapis.com/v4/spreadsheets/${input.spreadsheetId}/values/${encodeURIComponent(a1Range)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        .json<SheetValuesResponse>();

      const headers = (data.values?.[0] ?? [])
        .map((h) => String(h ?? "").trim())
        .filter((h) => h.length > 0);

      return { headers };
    }),
  getNotionPages: protectedProcedure.query(async ({ ctx }) => {
    type NotionSearchResponse = {
      results?: Array<{
        id?: string;
        properties?: {
          title?: {
            title?: Array<{
              plain_text?: string;
            }>;
          };
        };
      }>;
    };

    const credential = await prisma.credential.findFirst({
      where: {
        userId: ctx.auth.user.id,
        type: CredentialType.NOTION,
      },
      orderBy: {
        updatedAt: "desc",
      },
      select: {
        value: true,
      },
    });

    if (!credential) {
      return [] as Array<{ id: string; title: string }>;
    }

    let token = "";
    try {
      token = decrypt(credential.value).trim();
    } catch {
      return [] as Array<{ id: string; title: string }>;
    }

    if (!token) {
      return [] as Array<{ id: string; title: string }>;
    }

    const data = await ky
      .post("https://api.notion.com/v1/search", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        json: {
          filter: {
            property: "object",
            value: "page",
          },
        },
      })
      .json<NotionSearchResponse>();

    return (data.results ?? [])
      .map((page) => ({
        id: page.id ?? "",
        title:
          page.properties?.title?.title?.[0]?.plain_text ?? "Untitled page",
      }))
      .filter((page) => page.id.length > 0);
  }),
});
