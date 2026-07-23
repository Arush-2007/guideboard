import z from "zod";
import { NodeType } from "@/generated/prisma";
import { compareOptionsSchemaFields as compareOptionFields } from "@/lib/compare-options-schema";
import { SOURCE_FORMATS, TARGET_FORMATS } from "@/lib/conversions";
// `http-budget`, NOT `http` — this module runs in the browser (the dialogs validate
// against it), and `http.ts` imports ky.
import { MAX_USER_TIMEOUT_SECONDS } from "@/lib/http-budget";
import { multiMatchConfigFields } from "@/lib/multi-match";
import {
  hasActiveRowCondition,
  ROW_MATCH_OPERATORS,
  type RowMatchOperator,
} from "@/lib/row-match-operators";
import {
  headingColorSchema,
  headingFilterSchema,
  headingFormatSchema,
  ROW_SCOPES,
} from "@/lib/sheet-heading";
import { sheetsTriggerOptionsSchemaFields } from "@/lib/sheets-trigger-options";

type AnyZodSchema = z.ZodTypeAny;

const emptyPassthroughSchema = z.object({}).passthrough();

// Shared validation rules (copied from the corresponding dialog.tsx forms)
const plainTextSchema = z.string().min(1, { message: "Field is required" });

const apiPromptSchema = z.object({
  credentialId: z.string().min(1, "Credential is required"),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().min(1, "User prompt is required"),
});

const aiReplyGeneratorSchema = z
  .object({
    keyword: z.string().optional(),
    replyToKeywordComments: z.boolean().optional(),
    keywordPrompt: z.string().optional(),
    replyToNonKeywordComments: z.boolean().optional(),
    defaultPrompt: z.string().optional(),
    postDescription: z.string().optional(),
    xaiCredentialId: z.string().optional(),
    geminiCredentialId: z.string().optional(),
    openaiCredentialId: z.string().optional(),
    groqCredentialId: z.string().optional(),
  })
  .passthrough();

const httpRequestSchema = z
  .object({
    endpoint: z.string().min(1, { message: "Please enter a valid URL" }),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    body: z.string().optional(),
    // Seconds in the UI (what a user thinks in), milliseconds everywhere else.
    // The executor CLAMPS this to the platform's step budget — a user must not be
    // able to ask for a clock the platform will not honour, because that yields an
    // opaque platform kill instead of a clean node failure. See `clampUserTimeout`.
    timeoutSeconds: z.coerce
      .number()
      .int()
      .min(1, "Timeout must be at least 1 second")
      .max(MAX_USER_TIMEOUT_SECONDS, {
        message: `This deployment cannot run a request longer than ${MAX_USER_TIMEOUT_SECONDS}s`,
      })
      .optional(),
  })
  .passthrough();

const conditionSchema = z
  .object({
    field: z.string().min(1, "Field is required"),
    operator: z.enum([
      "contains",
      "not_contains",
      "equals",
      "not_equals",
      "greater_than",
      "less_than",
      "is_empty",
      "is_not_empty",
    ]),
    value: z.string().optional(),
    ...compareOptionFields,
  })
  .passthrough();

const switchSchema = z
  .object({
    cases: z
      .array(
        z.object({
          id: z.string().min(1),
          field: z.string().min(1, "Field is required"),
          operator: z.enum([
            "contains",
            "not_contains",
            "equals",
            "not_equals",
            "greater_than",
            "less_than",
            "is_empty",
            "is_not_empty",
          ]),
          value: z.string().optional(),
          ...compareOptionFields,
        }),
      )
      .optional(),
  })
  .passthrough();

const recordLookupSchema = z
  .object({
    source: z.enum(["google_sheets", "notion"]).optional(),
    value: z.string().min(1, "A value to search for is required"),
    // google_sheets
    spreadsheetId: z.string().optional(),
    sheetName: z.string().optional(),
    column: z.string().optional(),
    // notion
    credentialId: z.string().optional(),
    databaseId: z.string().optional(),
    property: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const source = data.source ?? "google_sheets";
    if (source === "google_sheets") {
      if (!data.spreadsheetId?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Spreadsheet is required",
          path: ["spreadsheetId"],
        });
      if (!data.sheetName?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Sheet Name is required",
          path: ["sheetName"],
        });
      if (!data.column?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Column is required",
          path: ["column"],
        });
    } else {
      if (!data.credentialId?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A Notion credential is required",
          path: ["credentialId"],
        });
      if (!data.databaseId?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Database ID is required",
          path: ["databaseId"],
        });
      if (!data.property?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Property is required",
          path: ["property"],
        });
    }
  })
  .passthrough();

// Dynamic source + fixed target. `to` is the definite output format; `from` is
// optional (auto-detected at runtime when omitted). `conversion` is the legacy
// single-enum field — accepted so pre-restructure nodes still validate; the
// executor normalizes it to a `(from, to)` pair. A node must carry either the
// new `to` or the legacy `conversion`.
const convertSchema = z
  .object({
    to: z.enum(TARGET_FORMATS as [string, ...string[]]).optional(),
    from: z.enum(SOURCE_FORMATS as [string, ...string[]]).optional(),
    conversion: z.string().optional(),
    input: z.string().min(1, "An input value is required"),
  })
  .superRefine((data, ctx) => {
    if (!data.to && !data.conversion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A target format is required",
        path: ["to"],
      });
    }
  })
  .passthrough();

// The Calculator carries a single field: the arithmetic expression, which may
// mix literals with `@<path>@` references to upstream output. Its SYNTAX is
// deliberately not validated here — `evaluateExpression` (src/lib/expression.ts)
// owns that, and it can only judge an expression once the references have been
// resolved to numbers at run time. Validating shape here and meaning there keeps
// one grammar in one place.
const calculatorSchema = z
  .object({
    expression: z.string().min(1, "Enter something to calculate"),
  })
  .passthrough();

const openAiFamilySchema = apiPromptSchema.passthrough();

const aiTextSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "gemini", "groq"]),
    credentialId: z.string().min(1, "Credential is required"),
    systemPrompt: z.string().optional(),
    prompt: z.string().min(1, "Prompt is required"),
  })
  .passthrough();

const youtubeReplySchema = z
  .object({
    replyMessage: z.string().min(1, "Reply message is required"),
  })
  .passthrough();

const instagramReplySchema = youtubeReplySchema;

const youtubeCommentTriggerSchema = z
  .object({
    videoId: z.string().optional(),
    keywordFilter: z.string().optional(),
  })
  .passthrough();

const instagramCommentTriggerSchema = z
  .object({
    postId: z.string().optional(),
    keywordFilter: z.string().optional(),
  })
  .passthrough();

const discordSchema = z
  .object({
    username: z.string().optional(),
    content: z
      .string()
      .min(1, "Message content is required")
      .max(2000, "Discord messages cannot exceed 2000 characters"),
    webhookUrl: z.string().min(1, "Webhook URL is required"),
  })
  .passthrough();

const slackSchema = z
  .object({
    content: z.string().min(1, "Message content is required"),
    // Array of webhook URLs (new, fan-out) and/or a legacy single `webhookUrl`.
    webhookUrls: z.array(z.string()).optional(),
    webhookUrl: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const hasList = (data.webhookUrls ?? []).some((u) => u.trim());
    const hasLegacy = !!data.webhookUrl?.trim();
    if (!hasList && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add at least one webhook URL",
        path: ["webhookUrls"],
      });
    }
  })
  .passthrough();

const telegramActionSchema = z
  .object({
    credentialId: z.string().min(1, "Credential is required"),
    chatId: z.string().min(1, "Chat ID is required"),
    message: z
      .string()
      .min(1, "Message is required")
      .max(4096, "Telegram messages cannot exceed 4096 characters"),
  })
  .passthrough();

const notionActionSchema = z
  .object({
    credentialId: z.string().min(1, "Credential is required"),
    action: z.enum(["create_page", "append_to_database"]),
    pageTitle: plainTextSchema.min(1, "Page title is required"),
    content: plainTextSchema.min(1, "Content is required"),
    parentPageId: z.string().optional(),
    databaseId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === "create_page") {
      if (!data.parentPageId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Parent page ID is required",
          path: ["parentPageId"],
        });
      }
    } else if (!data.databaseId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Database ID is required",
        path: ["databaseId"],
      });
    }
  })
  .passthrough();

const whatsappActionSchema = z
  .object({
    // Array of recipients (new, fan-out) and/or a legacy single phone number.
    recipientPhones: z.array(z.string()).optional(),
    recipientPhone: z.string().optional(),
    message: z
      .string()
      .min(1, "Message is required")
      .max(4096, "WhatsApp messages cannot exceed 4096 characters"),
  })
  .superRefine((data, ctx) => {
    const hasList = (data.recipientPhones ?? []).some((p) => p.trim());
    const hasLegacy = !!data.recipientPhone?.trim();
    if (!hasList && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add at least one recipient",
        path: ["recipientPhones"],
      });
    }
  })
  .passthrough();

const gmailActionSchema = z
  .object({
    // Array of recipients (new) or a legacy comma-separated string.
    to: z.union([
      z.array(z.string().min(1)).min(1, "Add at least one recipient"),
      z.string().min(1, "To is required"),
    ]),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
  })
  .passthrough();

const googleSheetsTriggerSchema = z
  .object({
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Sheet Name is required"),
    triggerOn: z.enum(["added", "updated", "added_or_updated"]).optional(),
    ...sheetsTriggerOptionsSchemaFields,
  })
  .passthrough();

// Deep cron/timezone validity is enforced at save time (the dialog preview +
// `syncTriggerPollsForWorkflow`, both via `isValidSchedule`). Here we only
// require the two fields to be present so `cron-parser` stays out of every
// import path of this module; the executor just needs a configured schedule.
const scheduleTriggerSchema = z
  .object({
    cron: z.string().min(1, "Schedule is required"),
    timezone: z.string().min(1, "Timezone is required"),
  })
  .passthrough();

// Shared "match the columns" mapping shape: target field/column -> template
// string (may contain @<path>@ placeholders). Reused by any node that maps
// upstream data onto named targets.
const mappingSchema = z.record(z.string(), z.string());

const excelActionSchema = z
  .object({
    operation: z.enum(["append_row", "upsert_by_key"]),
    workbookId: z.string().min(1, "Workbook is required"),
    worksheetName: z.string().min(1, "Worksheet is required"),
    columnMappings: mappingSchema.optional(),
    keyColumn: z.string().optional(),
    keyValue: z.string().optional(),
    // header -> upsert write mode for a matched row: overwrite ("set") or
    // numeric accumulate ("add", for running totals).
    columnModes: z.record(z.string(), z.enum(["set", "add"])).optional(),
  })
  .superRefine((data, ctx) => {
    const hasMappings = data.columnMappings
      ? Object.values(data.columnMappings).some((v) => v.trim())
      : false;
    if (!hasMappings) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Map at least one column",
        path: ["columnMappings"],
      });
    }
    if (data.operation === "upsert_by_key") {
      if (!data.keyColumn?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Key column is required to upsert",
          path: ["keyColumn"],
        });
      }
      if (!data.keyValue?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Key value is required to upsert",
          path: ["keyValue"],
        });
      }
    }
  })
  .passthrough();

// Row-selection operator superset for find_rows / color_rows. Derived from the
// single source in row-match-operators.ts (cast only to satisfy z.enum's tuple
// type) — do NOT re-list literals and do NOT widen compareOperatorEnum (v3 #6).
const rowMatchOperatorEnum = z.enum(
  ROW_MATCH_OPERATORS as [RowMatchOperator, ...RowMatchOperator[]],
);

// One filter condition for find_rows / color_rows (matches RowMatchCondition).
const rowConditionSchema = z.object({
  id: z.string().optional(),
  column: z.string(),
  operator: rowMatchOperatorEnum,
  value: z.string().optional(),
  enabled: z.boolean().optional(),
  ...compareOptionFields,
});

// One color_rows rule: a background color plus the filter that selects the rows
// it paints. Rules are evaluated top-to-bottom and the FIRST match wins, so a
// row is painted exactly once no matter how many rules it satisfies.
const colorRuleSchema = z.object({
  id: z.string().optional(),
  // #RRGGBB only — `hexToRgb` (google-sheets.ts) accepts exactly this, and
  // rejecting a bad color at save time beats failing mid-run.
  color: z.string().regex(/^#[0-9a-f]{6}$/i, "Pick a color"),
  conditions: z.array(rowConditionSchema),
});

// The old `insert_row_adjacent` action is now `append_row` with a non-bottom
// `position`. Coerce saved nodes at the schema (not just the dialog) — the same
// reason `read_rows → find_rows` is coerced below: `parseNodeConfig` is what the
// executor calls at runtime, so scheduled/triggered workflows that were never
// re-opened keep running with no data migration.
function coerceLegacySheetsAction(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (r.action === "insert_row_adjacent") {
      return {
        ...r,
        action: "append_row",
        position:
          r.position ??
          (r.insertUnder === "each_row" ? "under_each" : "under_group"),
      };
    }
  }
  return raw;
}

const googleSheetsActionSchema = z.preprocess(
  coerceLegacySheetsAction,
  z
    .object({
      // read_rows (raw A1-range grid) was removed — find_rows with no conditions
      // reads every row of the tab, header-keyed. Saved read_rows nodes are
      // coerced here (not just in the dialog) so scheduled/triggered workflows
      // that were never re-opened keep running instead of permafailing.
      action: z.preprocess(
        (v) => (v === "read_rows" ? "find_rows" : v),
        z.enum([
          "append_row",
          "append_heading",
          "find_rows",
          "find_heading",
          "update_row",
          "update_heading",
          "color_rows",
          "color_heading",
        ]),
      ),
      // Where an appended row lands: the bottom of the tab (default), below a
      // matched GROUP, or below EVERY matched row (which fans out one run per
      // inserted row). The last two use `conditions` to pick the group — what
      // used to be the separate `insert_row_adjacent` action. Shared by BOTH
      // appending actions (append_row and append_heading) — they place a row
      // identically and differ only in what that row contains.
      position: z.enum(["bottom", "under_group", "under_each"]).optional(),
      spreadsheetId: z.string().min(1, "Spreadsheet is required"),
      sheetName: z.string().min(1, "Sheet Name is required"),
      range: z.string().optional(),
      values: z.string().optional(),
      columnMappings: mappingSchema.optional(),
      // Headers that may NOT be blank on the row-creating action (append_row,
      // any position) — the accessory "may be blank" toggle turned off.
      // Enforced after the row is built.
      requiredColumns: z.array(z.string()).optional(),
      // append_row + bottom only: leave a blank SEPARATOR row above the new row.
      // Implemented by skipping a row number, not by writing an empty row — the
      // row placement is absolute (see `nextFreeSheetRow`), so the gap simply
      // stays empty.
      blankRowAbove: z.boolean().optional(),
      // append_heading only: the single piece of text the merged heading row
      // holds, templated like any other user-authored field. REQUIRED for that
      // action — a heading row with nothing in it is just a blank row, which
      // append_row already does.
      headingText: z.string().optional(),
      // append_heading only: how that text is typeset. Every field is optional;
      // `resolveHeadingFormat` fills the rest. One shared fragment with the
      // dialog, so neither side can strip a field the other saves.
      headingFormat: headingFormatSchema.optional(),
      // The heading actions that SELECT one: find_heading (which to return),
      // update_heading (which to rewrite), color_heading (which to paint).
      // Absent ⇒ every heading on the tab.
      headingFilter: headingFilterSchema.optional(),
      // update_heading only: also re-apply `headingFormat` to the row it
      // rewrites. Off ⇒ change the text and leave the styling exactly as it is.
      restyleHeading: z.boolean().optional(),
      // color_heading only: the single colour every matching heading is painted.
      headingColor: headingColorSchema.optional(),
      // update_row / color_rows / a non-bottom append: which KIND of row the
      // filter may select. Absent ⇒ "data", so a filter never touches a section
      // title by accident. find_rows and find_heading do not read this — their
      // scope is fixed by the action itself.
      rowScope: z.enum(ROW_SCOPES).optional(),
      // AND-ed filter conditions, selecting rows for find_rows, update_row and a
      // non-bottom append alike (one row-matching mechanism, one editor, one
      // `matchRows`).
      // find_rows: no conditions reads every row (an old saved `selectedColumns`
      // key rides through harmlessly via .passthrough()).
      // update_row: the rows to overwrite. At least one condition is REQUIRED.
      // append_row under_*: the GROUP the new row joins — `position` decides
      // whether it lands below the group or below each of its rows. At least one
      // condition is REQUIRED.
      conditions: z.array(rowConditionSchema).optional(),
      // color_rows only: the ordered rule list (first match wins). This action
      // uses `colorRules[].conditions`, NOT the shared `conditions` above —
      // each rule carries its own filter.
      colorRules: z.array(colorRuleSchema).optional(),
      // color_rows only: paint just the topmost matched row ("first"), just the
      // bottom-most ("last"), or every matched row ("all", the default — today's
      // behavior). Its OWN key, not the shared `onMultipleMatches` below, whose
      // first/each/error enum has no "all"/"last" and whose fan-out semantics
      // color_rows deliberately does not use.
      onMultipleColorMatches: z.enum(["first", "last", "all"]).optional(),
      // Legacy field, superseded by `position` (coerced above). Kept optional so
      // inbound saved data validates; the executor reads `position` now.
      insertUnder: z.enum(["group", "each_row"]).optional(),
      // Multi-match policy (shared fragment) for the list-producing actions:
      // "first" (default), "each" (fan out one child run per matched row, capped
      // by maxFanOutItems), or "error" (fail when more than one matches).
      // find_rows: which matched row downstream continues with.
      // update_row: which matched row(s) the write lands on.
      ...multiMatchConfigFields,
    })
    .superRefine((data, ctx) => {
      // The two READ actions need only spreadsheet + tab (already required
      // above). find_heading's filter is optional by design — with none it
      // returns every heading on the tab.
      if (data.action === "find_rows" || data.action === "find_heading") return;

      // update_heading rewrites the heading it finds. Its filter is optional
      // (no filter ⇒ every heading), but it must be given SOMETHING to do —
      // with neither new text nor a restyle it would read the tab and write
      // nothing, which is a misconfiguration rather than a no-op worth running.
      if (data.action === "update_heading") {
        if (!data.headingText?.trim() && data.restyleHeading !== true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Give the heading new text, or turn on “Also restyle it” — otherwise this step would change nothing",
            path: ["headingText"],
          });
        }
        return;
      }

      // color_heading paints the headings its filter selects. The colour is the
      // one thing it cannot default.
      if (data.action === "color_heading") {
        if (!data.headingColor?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Pick a color",
            path: ["headingColor"],
          });
        }
        return;
      }

      // color_rows uses neither columnMappings nor the shared `conditions` —
      // each rule carries its own filter — so it validates here and returns
      // before the checks below.
      if (data.action === "color_rows") {
        const rules = data.colorRules ?? [];
        if (rules.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Add at least one color rule",
            path: ["colorRules"],
          });
          return;
        }
        // A rule whose filter is empty (or all-disabled) matches EVERY row —
        // matchRows is vacuously true — so it would repaint the whole tab.
        // Re-checked in the executor, which is what actually writes.
        rules.forEach((rule, i) => {
          if (!hasActiveRowCondition(rule.conditions)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "Add at least one condition — a rule with an empty filter would color every row",
              path: ["colorRules", i, "conditions"],
            });
          }
        });
        return;
      }

      const hasMappings = data.columnMappings
        ? Object.values(data.columnMappings).some((v) => v.trim())
        : false;
      // Both appending actions place their row the same way, so the filter rule
      // below applies to either one in a non-bottom position.
      const isUnderAppend =
        (data.action === "append_row" || data.action === "append_heading") &&
        (data.position ?? "bottom") !== "bottom";

      // append_heading writes ONE cell, not a mapping — its text is what must be
      // there. Checked before the mapping rules, none of which apply to it.
      if (data.action === "append_heading" && !data.headingText?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Heading text is required",
          path: ["headingText"],
        });
      }

      // update_row must map at least one column — with none it writes nothing.
      // append_row needs NO mapping in any position: a row with every column
      // unmapped is a blank row, which is a legitimate thing to append.
      if (data.action === "update_row" && !hasMappings) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Map at least one column to update",
          path: ["columnMappings"],
        });
      }

      // An empty filter matches EVERY row (matchRows is vacuously true with no
      // conditions). Harmless for find_rows — it just reads the tab — but both
      // write cases need a real filter: update_row would overwrite the entire
      // sheet, and a non-bottom append would "join" a group spanning every row,
      // which is just a bottom append wearing a filter's clothes. Enforced in
      // the executor too — that is what actually writes.
      if (
        (data.action === "update_row" || isUnderAppend) &&
        !hasActiveRowCondition(data.conditions)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            data.action === "update_row"
              ? "Add at least one condition — an empty filter would overwrite every row"
              : data.action === "append_heading"
                ? "Add at least one condition — it picks the group the heading is placed under"
                : "Add at least one condition — it picks the group the new row joins",
          path: ["conditions"],
        });
      }
    })
    .passthrough(),
);

const compareOperatorEnum = z.enum([
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "is_empty",
  "is_not_empty",
]);

const resumeParserSchema = z
  .object({
    provider: z.enum(["builtin", "affinda"]).optional(),
    sourceUrl: z.string().min(1, "Resume URL is required"),
    skillKeywords: z.string().optional(),
    credentialId: z.string().optional(),
    workspaceId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.provider === "affinda" && !data.credentialId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An Affinda credential is required",
        path: ["credentialId"],
      });
    }
  })
  .passthrough();

const candidateScoringSchema = z
  .object({
    provider: z.enum(["rules", "affinda"]).optional(),
    shortlistThreshold: z.coerce.number().optional(),
    reviewThreshold: z.coerce.number().optional(),
    rules: z
      .array(
        z.object({
          id: z.string().optional(),
          label: z.string().optional(),
          field: z.string().min(1, "Field is required"),
          operator: compareOperatorEnum,
          value: z.string().optional(),
          points: z.coerce.number(),
          required: z.boolean().optional(),
          ...compareOptionFields,
        }),
      )
      .optional(),
    credentialId: z.string().optional(),
    jobDescriptionId: z.string().optional(),
    resumeId: z.string().optional(),
    indexName: z.string().optional(),
    weights: z.record(z.string(), z.number()).optional(),
  })
  .superRefine((data, ctx) => {
    const provider = data.provider ?? "rules";
    if (provider === "rules") {
      if (!data.rules || data.rules.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Add at least one scoring rule",
          path: ["rules"],
        });
      }
    } else {
      if (!data.credentialId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An Affinda credential is required",
          path: ["credentialId"],
        });
      }
      if (!data.jobDescriptionId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A job description id is required",
          path: ["jobDescriptionId"],
        });
      }
    }
  })
  .passthrough();

const atsActionSchema = z
  .object({
    provider: z.enum(["lever"]).optional(),
    environment: z.enum(["sandbox", "production"]).optional(),
    credentialId: z.string().min(1, "A credential is required"),
    performAsUserId: z.string().min(1, "A 'perform as' user id is required"),
    name: z.string().min(1, "Candidate name is required"),
    email: z.string().optional(),
    resumeUrl: z.string().optional(),
    note: z.string().optional(),
    stageId: z.string().optional(),
    postingId: z.string().optional(),
  })
  .passthrough();

// Generic Typeform trigger config: the connected credential, selected form, and
// its discovered fields (each `{ path, label }` so the variable picker can expose
// them). No domain-specific (HR) fields — any workflow can consume the responses.
const typeformTriggerSchema = z
  .object({
    // A Typeform trigger cannot function without a connected account and a chosen
    // form — the dialog requires both — so require them here. `formTitle` and
    // `discoveredFields` are derived conveniences and stay optional.
    credentialId: z.string().min(1, "A Typeform credential is required"),
    formId: z.string().min(1, "A form is required"),
    formTitle: z.string().optional(),
    discoveredFields: z
      .array(z.object({ path: z.string(), label: z.string() }))
      .optional(),
  })
  .passthrough();

// Generic Google Form trigger config: the selected form + its discovered
// questions (each `{ path, label }` so the variable picker can expose them).
// No domain-specific (HR) fields — any workflow can consume the raw responses.
const googleFormTriggerSchema = z
  .object({
    // A Google Form trigger needs a chosen form to reference responses and route
    // submissions; require it. `formTitle`/`discoveredFields` stay optional.
    formId: z.string().min(1, "A form is required"),
    formTitle: z.string().optional(),
    discoveredFields: z
      .array(z.object({ path: z.string(), label: z.string() }))
      .optional(),
  })
  .passthrough();

// One schema per NodeType (must not guess field names)
const nodeConfigSchemas: Record<NodeType, AnyZodSchema> = {
  [NodeType.INITIAL]: emptyPassthroughSchema,
  [NodeType.HTTP_REQUEST]: httpRequestSchema,
  [NodeType.MANUAL_TRIGGER]: emptyPassthroughSchema,
  [NodeType.GOOGLE_FORM_TRIGGER]: googleFormTriggerSchema,
  [NodeType.TYPEFORM_TRIGGER]: typeformTriggerSchema,
  [NodeType.GMAIL_TRIGGER]: emptyPassthroughSchema,
  [NodeType.GOOGLE_SHEETS_TRIGGER]: googleSheetsTriggerSchema,
  [NodeType.SCHEDULE_TRIGGER]: scheduleTriggerSchema,
  // Token + secret live in the WebhookTrigger table (server-owned), so the node
  // itself carries no user config.
  [NodeType.WEBHOOK_TRIGGER]: emptyPassthroughSchema,
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: instagramCommentTriggerSchema,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: instagramReplySchema,
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: youtubeCommentTriggerSchema,
  [NodeType.YOUTUBE_REPLY_COMMENT]: youtubeReplySchema,
  [NodeType.AI_REPLY_GENERATOR]: aiReplyGeneratorSchema,
  [NodeType.AI_TEXT]: aiTextSchema,
  [NodeType.ANTHROPIC]: openAiFamilySchema,
  [NodeType.CONDITION]: conditionSchema,
  [NodeType.SWITCH]: switchSchema,
  [NodeType.RECORD_LOOKUP]: recordLookupSchema,
  [NodeType.CONVERT]: convertSchema,
  [NodeType.CALCULATOR]: calculatorSchema,
  [NodeType.GEMINI]: openAiFamilySchema,
  [NodeType.OPENAI]: openAiFamilySchema,
  [NodeType.DISCORD]: discordSchema,
  [NodeType.SLACK]: slackSchema,
  [NodeType.NOTION_ACTION]: notionActionSchema,
  [NodeType.TELEGRAM_ACTION]: telegramActionSchema,
  [NodeType.TELEGRAM_TRIGGER]: emptyPassthroughSchema,
  [NodeType.WHATSAPP_ACTION]: whatsappActionSchema,
  [NodeType.GMAIL_ACTION]: gmailActionSchema,
  [NodeType.GOOGLE_SHEETS_ACTION]: googleSheetsActionSchema,
  [NodeType.EXCEL_ACTION]: excelActionSchema,
  [NodeType.RESUME_PARSER]: resumeParserSchema,
  [NodeType.CANDIDATE_SCORING]: candidateScoringSchema,
  [NodeType.ATS_ACTION]: atsActionSchema,
};

export function parseNodeConfig(type: NodeType, data: unknown) {
  const schema = nodeConfigSchemas[type];
  if (!schema) {
    throw new Error(`No node config schema registered for NodeType="${type}"`);
  }

  const result = schema.safeParse(data);
  if (result.success) return result.data;

  throw new Error(
    `Invalid node.data for NodeType="${type}": ${
      getNodeConfigIssues(type, data).join("; ") || "unknown Zod error"
    }`,
  );
}

/**
 * Non-throwing companion to `parseNodeConfig`, for build-time UI validation in
 * the editor. Returns the list of issue summaries for a node's config (an empty
 * array means valid). `parseNodeConfig` stays the runtime entry point; both read
 * the *same* `nodeConfigSchemas` registry, so there is exactly one source of
 * schema truth — never add a client-only check here.
 */
export function getNodeConfigIssues(type: NodeType, data: unknown): string[] {
  const schema = nodeConfigSchemas[type];
  if (!schema) {
    return [`No node config schema registered for NodeType="${type}"`];
  }

  const result = schema.safeParse(data);
  if (result.success) return [];

  return result.error.issues.map(
    (i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
  );
}
