import ky from "ky";
import z from "zod";
import { PAGINATION } from "@/config/constants";
import { CredentialType } from "@/generated/prisma";
import prisma from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { sheetRange } from "@/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { refreshMicrosoftTokenIfNeeded } from "@/lib/microsoft-token";
import {
  GRAPH_BASE,
  getFirstTableOnWorksheet,
  getTableColumnNames,
  graphHeaders,
  workbookUrl,
  XLSX_MIME_TYPE,
} from "@/lib/ms-graph";
import { refreshYoutubeTokenIfNeeded } from "@/lib/youtube-token";
import {
  createTRPCRouter,
  premiumProcedure,
  protectedProcedure,
} from "@/trpc/init";

/**
 * Resolves + decrypts a user's Typeform Personal Access Token by credential id.
 * The single seam the Typeform procedures depend on for auth — swapping PAT for
 * OAuth later means changing only this helper, not the procedures that use it.
 */
async function getTypeformToken(
  credentialId: string,
  userId: string,
): Promise<string> {
  const credential = await prisma.credential.findUnique({
    where: { id: credentialId, userId },
  });
  if (!credential || credential.type !== CredentialType.TYPEFORM) {
    throw new Error("Typeform credential not found or wrong type");
  }
  const token = decrypt(credential.value).trim();
  if (!token) throw new Error("Typeform credential is empty");
  return token;
}

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
  getMicrosoft: protectedProcedure.query(async ({ ctx }) => {
    return prisma.microsoftCredential.findUnique({
      where: { userId: ctx.auth.user.id },
      select: {
        id: true,
        displayName: true,
        email: true,
      },
    });
  }),
  disconnectMicrosoft: protectedProcedure.mutation(async ({ ctx }) => {
    await prisma.microsoftCredential.deleteMany({
      where: { userId: ctx.auth.user.id },
    });
    return { ok: true as const };
  }),
  // Read-only status of the user's linked Google account. Google is connected
  // implicitly via "Sign in with Google" (a database hook mirrors the OAuth
  // tokens into GoogleCredential — see src/lib/auth.ts), so surfacing it here
  // lets users see the dependency that Gmail/Sheets/Drive/Forms nodes rely on.
  // No disconnect is exposed: Google may be the user's sign-in method.
  getGoogle: protectedProcedure.query(async ({ ctx }) => {
    const credential = await prisma.googleCredential.findUnique({
      where: { userId: ctx.auth.user.id },
      select: { id: true },
    });
    if (!credential) {
      return null;
    }
    return { id: credential.id, email: ctx.auth.user.email };
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
  // --- Typeform (PAT auth; OAuth swaps only the token source next session) ---
  // Lists the user's Typeform forms for the trigger's form dropdown.
  getTypeforms: protectedProcedure
    .input(z.object({ credentialId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      type TypeformListResponse = {
        items?: Array<{ id?: string; title?: string }>;
      };
      const token = await getTypeformToken(
        input.credentialId,
        ctx.auth.user.id,
      );
      const data = await ky
        .get("https://api.typeform.com/forms", {
          searchParams: { page_size: "200" },
          headers: { Authorization: `Bearer ${token}` },
        })
        .json<TypeformListResponse>();

      return (data.items ?? [])
        .map((f) => ({ id: f.id ?? "", name: f.title ?? "Untitled form" }))
        .filter((f) => f.id.length > 0);
    }),
  // Reads a form's fields. Each field's `ref` (stable, author-set) is exactly the
  // key the webhook payload uses, so a discovered field maps 1:1 to a reference
  // like `@<typeform.fields.<ref>>@`.
  getTypeformFields: protectedProcedure
    .input(
      z.object({ credentialId: z.string().min(1), formId: z.string().min(1) }),
    )
    .query(async ({ ctx, input }) => {
      type TypeformField = {
        ref?: string;
        title?: string;
        type?: string;
        properties?: { fields?: TypeformField[] };
      };
      type TypeformGetResponse = { fields?: TypeformField[] };
      const token = await getTypeformToken(
        input.credentialId,
        ctx.auth.user.id,
      );
      const data = await ky
        .get(`https://api.typeform.com/forms/${input.formId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        .json<TypeformGetResponse>();

      // Flatten one level of `group` fields (their sub-questions live under
      // properties.fields), then keep every field that has a `ref` — the stable
      // key the webhook payload uses. The title is only a label, so an untitled
      // question gets a usable fallback instead of being dropped.
      const flatten = (fields: TypeformField[] = []): TypeformField[] =>
        fields.flatMap((f) =>
          f.properties?.fields?.length ? flatten(f.properties.fields) : [f],
        );

      return flatten(data.fields ?? [])
        .filter((f) => f.ref)
        .map((f) => ({
          ref: f.ref as string,
          title:
            (f.title ?? "").trim() ||
            `Untitled ${(f.type ?? "question").replace(/_/g, " ")}`,
        }));
    }),
  // Auto-registers (or updates, idempotent per tag) the webhook on Typeform, so
  // the user never touches Typeform's settings. We sign with TYPEFORM_WEBHOOK_SECRET
  // so the existing webhook route verifies it unchanged. Outward-facing → wired to
  // an explicit "Activate webhook" button.
  registerTypeformWebhook: protectedProcedure
    .input(
      z.object({
        credentialId: z.string().min(1),
        formId: z.string().min(1),
        workflowId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const token = await getTypeformToken(
        input.credentialId,
        ctx.auth.user.id,
      );
      const secret = process.env.TYPEFORM_WEBHOOK_SECRET;
      if (!secret) {
        throw new Error(
          "TYPEFORM_WEBHOOK_SECRET is not configured — set it to verify incoming webhooks.",
        );
      }
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL ?? process.env.NGROK_URL ?? "";
      if (!baseUrl) {
        throw new Error(
          "No public app URL configured (NEXT_PUBLIC_APP_URL / NGROK_URL) for the webhook destination.",
        );
      }
      const url = `${baseUrl}/api/webhooks/typeform?workflowId=${input.workflowId}`;
      const tag = `guideboard-${input.workflowId}`;

      await ky.put(
        `https://api.typeform.com/forms/${input.formId}/webhooks/${tag}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          json: { url, enabled: true, secret, verify_ssl: true },
        },
      );

      return { enabled: true, url };
    }),
  // Live status of this workflow's Typeform webhook, so the dialog can show
  // "Webhook active" on reopen instead of relying on in-memory mutation state.
  // Reads the specific tag; any error (404 / not found) → not active.
  getTypeformWebhookStatus: protectedProcedure
    .input(
      z.object({
        credentialId: z.string().min(1),
        formId: z.string().min(1),
        workflowId: z.string().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const token = await getTypeformToken(
          input.credentialId,
          ctx.auth.user.id,
        );
        const tag = `guideboard-${input.workflowId}`;
        const hook = await ky
          .get(
            `https://api.typeform.com/forms/${input.formId}/webhooks/${tag}`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          .json<{ enabled?: boolean }>();
        return { active: hook.enabled === true };
      } catch {
        return { active: false };
      }
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
      const a1Range = sheetRange(input.sheetName, "1:1");

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
  // --- Excel on OneDrive (Microsoft Graph workbook API) ---
  // Lists the user's .xlsx workbooks for the Excel node's workbook dropdown.
  getExcelWorkbooks: protectedProcedure.query(async ({ ctx }) => {
    type DriveSearchResponse = {
      value?: Array<{
        id?: string;
        name?: string;
        file?: { mimeType?: string };
      }>;
    };

    const accessToken = await refreshMicrosoftTokenIfNeeded(ctx.auth.user.id);
    const data = await ky
      .get(`${GRAPH_BASE}/me/drive/root/search(q='.xlsx')`, {
        searchParams: { $select: "id,name,file", $top: "100" },
        headers: graphHeaders(accessToken),
      })
      .json<DriveSearchResponse>();

    return (data.value ?? [])
      .filter((item) => item.file?.mimeType === XLSX_MIME_TYPE)
      .map((item) => ({
        id: item.id ?? "",
        name: item.name ?? "Untitled workbook",
      }))
      .filter((item) => item.id.length > 0);
  }),
  getExcelWorksheets: protectedProcedure
    .input(z.object({ workbookId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      type WorksheetsResponse = {
        value?: Array<{ id?: string; name?: string; position?: number }>;
      };

      const accessToken = await refreshMicrosoftTokenIfNeeded(ctx.auth.user.id);
      const data = await ky
        .get(`${workbookUrl(input.workbookId)}/worksheets`, {
          searchParams: { $select: "id,name,position" },
          headers: graphHeaders(accessToken),
        })
        .json<WorksheetsResponse>();

      return (data.value ?? [])
        .map((sheet) => ({
          id: sheet.id ?? "",
          name: sheet.name ?? "",
          position: sheet.position ?? 0,
        }))
        .filter((sheet) => sheet.name.length > 0)
        .sort((a, b) => a.position - b.position);
    }),
  // Header columns of the first Table on a worksheet. `tableName: null` means
  // the sheet has no Excel Table yet — the dialog shows "format as Table"
  // guidance in that case (the Excel node only writes into Tables).
  getExcelColumns: protectedProcedure
    .input(
      z.object({
        workbookId: z.string().min(1),
        worksheetName: z.string().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      const accessToken = await refreshMicrosoftTokenIfNeeded(ctx.auth.user.id);
      const table = await getFirstTableOnWorksheet({
        accessToken,
        workbookId: input.workbookId,
        worksheetName: input.worksheetName,
      });

      if (!table) {
        return { headers: [] as string[], tableName: null };
      }

      const headers = await getTableColumnNames({
        accessToken,
        workbookId: input.workbookId,
        tableName: table.name,
      });

      return { headers, tableName: table.name };
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
  // Mirrors getNotionPages, but lists DATABASES for the Notion node's
  // "append to database" dropdown. A database's title lives at the top level
  // (`result.title[]`), unlike a page's (`properties.title.title[]`).
  getNotionDatabases: protectedProcedure.query(async ({ ctx }) => {
    type NotionSearchResponse = {
      results?: Array<{
        id?: string;
        title?: Array<{ plain_text?: string }>;
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
            value: "database",
          },
        },
      })
      .json<NotionSearchResponse>();

    return (data.results ?? [])
      .map((db) => ({
        id: db.id ?? "",
        title: db.title?.[0]?.plain_text ?? "Untitled database",
      }))
      .filter((db) => db.id.length > 0);
  }),
});
