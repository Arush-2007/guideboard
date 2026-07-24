import { NodeType } from "@/generated/prisma";
import { getOutputKeyForNode } from "@/lib/node-ref";

/**
 * Per-node OUTPUT schema registry.
 *
 * This is the counterpart to `node-schemas.ts` (which validates a node's
 * config *inputs*). Here we declare what each node *emits* into the workflow
 * `context`, so the UI can show users the data available from upstream nodes —
 * the left-hand side of the "match the columns" field-mapping component, and
 * the basis of a future variable picker.
 *
 * Why this is needed: action executors write their result under
 * `${nodeType}_${nodeId}` and triggers seed a fixed key (e.g. `telegram`), but
 * nothing in the UI advertises those shapes today, so users have to guess
 * `{{telegram.text}}`. This registry makes the output contract explicit and
 * discoverable.
 *
 * Field `path`s are relative to the node's output ROOT. How the root is keyed
 * in `context` depends on `rootKind`:
 *   - "fixed":    the node writes a constant top-level key (triggers). `rootKey`
 *                 holds it (e.g. "telegram"), so the full context path for a
 *                 field is `${rootKey}.${field.path}`.
 *   - "perNode":  the node writes `${nodeType.toLowerCase()}_${nodeId}`, so the
 *                 full path is resolved per placed node at mapping time.
 *   - "topLevel": the node seeds its fields directly at the context ROOT with no
 *                 wrapping key (some comment triggers, e.g. `commentId`), so the
 *                 full path IS `field.path`.
 */

export type NodeOutputField = {
  /** Path relative to the node's output root, e.g. "from.firstName". */
  path: string;
  /** Human-friendly label shown in the mapping UI. */
  label: string;
  /** Optional example value to help users recognize the field. */
  example?: string;
  /**
   * Opaque machine identifiers (message/user/page IDs, etc.) that aren't useful
   * to a non-technical user reading a run. The execution page's *Friendly* view
   * hides these (they remain in Raw, and stay referenceable in the variable
   * picker for power users). Human-readable, actionable fields omit the flag.
   */
  developer?: boolean;
  /**
   * Optional VARIABLE-PICKER visibility predicate, for nodes whose output shape
   * depends on their saved config (e.g. a Sheets node only emits `matchCount`
   * when its action is find_rows). Receives the placed node's saved `data`; a
   * field without a predicate is always offered. The friendly execution view
   * ignores this — it is already absence-driven (fields missing from a run's
   * recorded output are dropped).
   */
  pickIf?: (data: Record<string, unknown> | null | undefined) => boolean;
};

export type NodeOutputDescriptor =
  | { rootKind: "fixed"; rootKey: string; fields: NodeOutputField[] }
  | { rootKind: "perNode"; fields: NodeOutputField[] }
  | { rootKind: "topLevel"; fields: NodeOutputField[] };

// The Sheets action's pickable fields depend on the node's selected `action`
// (append_row is the historical default when unset). The picker reads a node's
// RAW saved config, which is coerced only at exec time / when the dialog opens —
// so the retired `insert_row_adjacent` action is normalized here too (mirroring
// coerceLegacySheetsAction in node-schemas.ts), or a node saved before the merge
// would lose its output fields until re-saved.
const isLegacyInsert = (data: Record<string, unknown> | null | undefined) =>
  (data?.action as string | undefined) === "insert_row_adjacent";
const sheetsAction = (data: Record<string, unknown> | null | undefined) =>
  isLegacyInsert(data)
    ? "append_row"
    : ((data?.action as string | undefined) ?? "append_row");
const isSheetsAppend = (data: Record<string, unknown> | null | undefined) =>
  sheetsAction(data) === "append_row";
const isSheetsFindRows = (data: Record<string, unknown> | null | undefined) =>
  sheetsAction(data) === "find_rows";
const isSheetsUpdate = (data: Record<string, unknown> | null | undefined) =>
  sheetsAction(data) === "update_row";
const isSheetsColor = (data: Record<string, unknown> | null | undefined) =>
  sheetsAction(data) === "color_rows";
// append_heading — one merged cell of text rather than a mapped row, so it emits
// its TEXT where the other row-writing actions emit header-keyed columns.
const isSheetsHeading = (data: Record<string, unknown> | null | undefined) =>
  sheetsAction(data) === "append_heading";
// find_heading — searches heading rows only, and reports their TEXT and row
// numbers rather than find_rows' column grid.
const isSheetsFindHeading = (
  data: Record<string, unknown> | null | undefined,
) => sheetsAction(data) === "find_heading";
const isSheetsUpdateHeading = (
  data: Record<string, unknown> | null | undefined,
) => sheetsAction(data) === "update_heading";
const isSheetsColorHeading = (
  data: Record<string, unknown> | null | undefined,
) => sheetsAction(data) === "color_heading";
/** Any action that SELECTS headings — all three report `headingsOnTab`. */
const isSheetsHeadingSelect = (
  data: Record<string, unknown> | null | undefined,
) =>
  isSheetsFindHeading(data) ||
  isSheetsUpdateHeading(data) ||
  isSheetsColorHeading(data);
// A non-bottom append (formerly the insert_row_adjacent action) — an append_row
// whose `position` drops the row under a matched group / rows. It emits the
// group/anchor fields a plain bottom append does not. A legacy insert node was
// ALWAYS an under-append (either insertUnder value), so it qualifies regardless
// of `position`, which it predates.
const isSheetsAppendUnder = (
  data: Record<string, unknown> | null | undefined,
) =>
  isLegacyInsert(data) ||
  ((sheetsAction(data) === "append_row" ||
    sheetsAction(data) === "append_heading") &&
    ((data?.position as string | undefined) ?? "bottom") !== "bottom");

// Declared incrementally as each node gets its contract defined. Nodes absent
// here simply contribute no mappable fields yet (the `raw`/templating escape
// hatch still works).
export const nodeOutputs: Partial<Record<NodeType, NodeOutputDescriptor>> = {
  [NodeType.SCHEDULE_TRIGGER]: {
    rootKind: "fixed",
    rootKey: "schedule",
    fields: [
      {
        path: "scheduledAt",
        label: "Scheduled time (ISO)",
        example: "2026-06-25T13:00:00.000Z",
      },
    ],
  },
  [NodeType.WEBHOOK_TRIGGER]: {
    rootKind: "fixed",
    rootKey: "webhook",
    fields: [
      {
        // Request body is arbitrary JSON; expose the root so users can drill in
        // via the templating escape hatch (e.g. `@<webhook.body.email>@`).
        path: "body",
        label: "Request body (JSON)",
        example: '{ "email": "ada@example.com" }',
      },
    ],
  },
  [NodeType.TELEGRAM_TRIGGER]: {
    rootKind: "fixed",
    rootKey: "telegram",
    fields: [
      {
        path: "text",
        label: "Message text",
        example: "Sir, I want to work under you as an intern",
      },
      { path: "from.firstName", label: "Sender first name", example: "Ada" },
      { path: "from.lastName", label: "Sender last name", example: "Lovelace" },
      { path: "from.username", label: "Sender username", example: "ada_l" },
      {
        path: "from.id",
        label: "Sender user ID",
        example: "123456789",
        developer: true,
      },
      {
        path: "contact.phoneNumber",
        label: "Shared contact number",
        example: "+15551234567",
      },
      { path: "contact.firstName", label: "Shared contact name" },
      { path: "chatId", label: "Chat ID", example: "123456789" },
      {
        path: "messageId",
        label: "Message ID",
        example: "42",
        developer: true,
      },
      { path: "date", label: "Sent at (unix seconds)", example: "1718000000" },
    ],
  },
  [NodeType.AI_TEXT]: {
    rootKind: "perNode",
    fields: [
      {
        path: "output",
        label: "AI output",
        example: "Yes",
      },
    ],
  },
  [NodeType.GOOGLE_SHEETS_ACTION]: {
    rootKind: "perNode",
    fields: [
      // NOTE: field `path`s must stay UNIQUE per node type — `pickIf` scopes
      // which fields the PICKER offers, but the execution page's friendly
      // views look fields up by path alone (resolveFields / describePath in
      // friendly-output.ts), so two entries sharing a path would render twice
      // and mislabel each other. Actions that emit the same key therefore share
      // ONE entry with a label that reads correctly for all of them.
      //
      // `rowByHeader` is "the row this run wrote", header-keyed — the appended
      // row, the updated row, the row inserted into a group, and in "each"
      // (fan-out) mode the child run's own row. One reference survives a switch
      // between the row-writing actions, and works per-row in every mode.
      {
        path: "rowByHeader",
        label: "The row this step wrote (all columns)",
        // isSheetsAppend already covers every append position.
        pickIf: (data) => isSheetsAppend(data) || isSheetsUpdate(data),
      },
      {
        path: "appendedRows",
        label: "How many rows were added",
        example: "1",
        // Only a bottom append emits this; the under-append reports matchCount.
        // append_heading's bottom path emits it too.
        pickIf: (data) =>
          (isSheetsAppend(data) || isSheetsHeading(data)) &&
          !isSheetsAppendUnder(data),
      },
      // append_heading only: the text the merged row was given, AFTER its
      // template was rendered — so a downstream step can repeat the section
      // title it just wrote.
      // append_heading writes it; update_heading rewrites it. Same key, so a
      // reference survives a switch between them.
      {
        path: "headingText",
        label: "The heading text that was written",
        example: "Invoices — March 2026",
        pickIf: (data) => isSheetsHeading(data) || isSheetsUpdateHeading(data),
      },
      // update_heading only: whether the style was re-applied as well. Branch on
      // it to tell a rename apart from a rename-and-restyle.
      {
        path: "restyled",
        label: "Whether the heading was restyled (true/false)",
        example: "true",
        pickIf: isSheetsUpdateHeading,
      },
      // update_heading only: the text BEFORE this run changed it.
      {
        path: "previousHeading",
        label: "The heading text before this step changed it",
        pickIf: isSheetsUpdateHeading,
      },
      // color_heading only.
      {
        path: "color",
        label: "The color the headings were painted",
        example: "#fef3c7",
        pickIf: isSheetsColorHeading,
      },
      // How wide the merged band ended up: the tab's header width at write time.
      {
        path: "mergedColumns",
        label: "How many columns the heading spans",
        example: "6",
        pickIf: isSheetsHeading,
        developer: true,
      },
      // find_heading. `firstHeading` is "the heading this run found" — the
      // single-value reference, alongside the full list.
      {
        path: "firstHeading",
        label: "The heading this step found",
        example: "Invoices — March 2026",
        pickIf: isSheetsFindHeading,
      },
      {
        path: "headings",
        label: "Every matching heading",
        pickIf: (data) =>
          isSheetsFindHeading(data) || isSheetsColorHeading(data),
      },
      {
        path: "headingRowIndexes",
        label: "The sheet row number of each matching heading",
        example: "[7, 21]",
        pickIf: (data) =>
          isSheetsFindHeading(data) || isSheetsColorHeading(data),
      },
      // How many headings the tab has AT ALL, regardless of the search. Branch
      // on it to tell "nothing matched" from "this tab has no headings yet".
      {
        path: "headingsOnTab",
        label: "How many headings the tab has in total",
        example: "3",
        pickIf: isSheetsHeadingSelect,
      },
      // find_heading: how many headings this run actually acted on (all of them,
      // or one in first/last mode) — matchCount is how many MATCHED.
      {
        path: "actedCount",
        label: "How many headings this step used",
        example: "1",
        pickIf: isSheetsFindHeading,
      },
      // Merged rows that do NOT qualify as headings (wrong start column, or
      // spanning several rows). Diagnostic: it is what separates "this tab has
      // nothing merged" from "what you merged doesn't count, and here's why".
      {
        path: "nearMisses",
        label: "Merged rows that don't qualify as headings",
        example: "1",
        pickIf: isSheetsHeadingSelect,
        developer: true,
      },
      // find_rows. `firstRow` is "the row this run acted on" in EVERY mode:
      // the first match in "first"/"error" mode, and — in "each" (fan-out)
      // mode — the child run's own row (each child carries a reshaped output
      // where firstRow IS its row), so one reference works per-row everywhere.
      {
        path: "firstRow",
        label: "The row this run matched (all columns)",
        pickIf: isSheetsFindRows,
      },
      // find_rows: rows returned. update_row: rows overwritten. color_rows: rows
      // that matched (all of them, even when only the first/last is painted).
      // under-append: the size of the group the new row joined (0 ⇒ it started a
      // new one).
      {
        path: "matchCount",
        label: "How many rows matched the filter",
        example: "3",
        pickIf: (data) =>
          isSheetsFindRows(data) ||
          isSheetsUpdate(data) ||
          isSheetsColor(data) ||
          isSheetsAppendUnder(data) ||
          isSheetsHeadingSelect(data),
      },
      // color_rows only: how many rows were actually painted — the same as
      // matchCount in "all" mode, exactly one in "first"/"last".
      {
        path: "coloredCount",
        label: "How many rows were colored",
        example: "1",
        pickIf: (data) => isSheetsColor(data) || isSheetsColorHeading(data),
      },
      // update_row only.
      {
        path: "previousRow",
        label: "The row as it was BEFORE this step changed it",
        pickIf: isSheetsUpdate,
      },
      // False when nothing matched — the run updated no row at all. Branch on
      // this to handle the "that row doesn't exist yet" case.
      {
        path: "matched",
        label: "Whether a row was found to update (true/false)",
        example: "true",
        pickIf: (data) => isSheetsUpdate(data) || isSheetsUpdateHeading(data),
      },
      // under-append only. False ⇒ nothing matched, so the row started a new
      // group at the bottom instead of joining one.
      {
        path: "insertedUnderGroup",
        label: "Whether the row joined an existing group (true/false)",
        example: "true",
        pickIf: isSheetsAppendUnder,
      },
      // The row the new one was attached to: the group's last row, or — in
      // "below every match" mode — the specific row this one sits under (each
      // fan-out child carries its own). Empty when nothing matched.
      {
        path: "anchorRow",
        label: "The row the new row was placed under (all columns)",
        pickIf: isSheetsAppendUnder,
      },
      // Where the row landed. update_row emits this too (the row it overwrote),
      // so the label reads correctly for both — one entry, one path.
      {
        path: "rowIndex",
        label: "The sheet row number this step wrote",
        example: "7",
        pickIf: (data) =>
          isSheetsAppendUnder(data) ||
          isSheetsUpdate(data) ||
          // A heading reports its row in EVERY position — unlike a bottom
          // append_row, whose answer is "the row after the last one".
          isSheetsHeading(data) ||
          // The heading SELECTORS report the row they acted on too.
          isSheetsFindHeading(data) ||
          isSheetsUpdateHeading(data),
      },
      { path: "spreadsheetId", label: "Spreadsheet ID", developer: true },
    ],
  },
  [NodeType.GMAIL_ACTION]: {
    rootKind: "perNode",
    fields: [
      {
        path: "to",
        label: "Recipients",
        example: "alice@team.com, bob@team.com",
      },
      { path: "subject", label: "Subject", example: "New intern application" },
      { path: "body", label: "Message body" },
    ],
  },
  [NodeType.SLACK]: {
    rootKind: "perNode",
    fields: [
      { path: "messageContent", label: "Message sent" },
      { path: "deliveredCount", label: "Channels notified", example: "2" },
    ],
  },
  [NodeType.WHATSAPP_ACTION]: {
    rootKind: "perNode",
    fields: [
      { path: "recipientPhones", label: "Recipients", example: "911234567890" },
      { path: "message", label: "Message sent" },
      { path: "deliveredCount", label: "Recipients notified", example: "4" },
    ],
  },
  [NodeType.GMAIL_TRIGGER]: {
    rootKind: "fixed",
    rootKey: "gmail",
    fields: [
      { path: "subject", label: "Subject", example: "New intern application" },
      { path: "from", label: "From", example: "ada@example.com" },
      { path: "snippet", label: "Preview snippet" },
      { path: "messageId", label: "Message ID", developer: true },
    ],
  },
  [NodeType.GOOGLE_SHEETS_TRIGGER]: {
    rootKind: "fixed",
    rootKey: "googleSheets",
    // Per-column values (`googleSheets.values.<Header>`) are offered dynamically
    // as `discoveredFields` the dialog saves from the sheet's header row (see
    // upstream-fields.ts), since the columns depend on the chosen sheet.
    fields: [
      {
        path: "changeType",
        label: "Change type",
        example: "added",
      },
      {
        path: "changedFields",
        label: "Changed fields",
        example: "Status, Amount",
      },
      { path: "sheetName", label: "Sheet name", example: "Sheet1" },
      { path: "spreadsheetId", label: "Spreadsheet ID", developer: true },
    ],
  },
  [NodeType.HTTP_REQUEST]: {
    rootKind: "perNode",
    fields: [
      { path: "httpResponse.status", label: "Status code", example: "200" },
      { path: "httpResponse.statusText", label: "Status text", example: "OK" },
      { path: "httpResponse.data", label: "Response body" },
    ],
  },
  [NodeType.DISCORD]: {
    rootKind: "perNode",
    fields: [{ path: "messageContent", label: "Message sent" }],
  },
  [NodeType.NOTION_ACTION]: {
    rootKind: "perNode",
    fields: [
      { path: "pageId", label: "Page ID", developer: true },
      { path: "url", label: "Page URL" },
    ],
  },
  [NodeType.TELEGRAM_ACTION]: {
    rootKind: "perNode",
    fields: [
      { path: "text", label: "Message sent" },
      { path: "chatId", label: "Chat ID", example: "123456789" },
    ],
  },
  [NodeType.ANTHROPIC]: {
    rootKind: "perNode",
    fields: [{ path: "text", label: "AI output" }],
  },
  [NodeType.GEMINI]: {
    rootKind: "perNode",
    fields: [{ path: "text", label: "AI output" }],
  },
  [NodeType.OPENAI]: {
    rootKind: "perNode",
    fields: [{ path: "text", label: "AI output" }],
  },
  // The AI-reply nodes don't write under their own per-node key — they all merge
  // into a shared top-level `aiReply` object (so a reply node can consume the
  // generator's output). Declared as a "fixed" root accordingly.
  [NodeType.AI_REPLY_GENERATOR]: {
    rootKind: "fixed",
    rootKey: "aiReply",
    fields: [{ path: "text", label: "Generated reply" }],
  },
  [NodeType.INSTAGRAM_REPLY_COMMENT]: {
    rootKind: "fixed",
    rootKey: "aiReply",
    fields: [{ path: "replyText", label: "Reply sent" }],
  },
  [NodeType.YOUTUBE_REPLY_COMMENT]: {
    rootKind: "fixed",
    rootKey: "aiReply",
    fields: [{ path: "replyText", label: "Reply sent" }],
  },
  // These comment triggers seed their fields directly at the context ROOT
  // (no wrapping key), so they're declared with the "topLevel" root kind.
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: {
    rootKind: "topLevel",
    fields: [
      { path: "commentText", label: "Comment text", example: "Love this! 🔥" },
      { path: "commenterName", label: "Commenter name", example: "ada_l" },
      { path: "commentId", label: "Comment ID", developer: true },
      { path: "postId", label: "Post ID", developer: true },
    ],
  },
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: {
    rootKind: "topLevel",
    fields: [
      { path: "commentText", label: "Comment text", example: "Great video!" },
      { path: "commenterName", label: "Commenter name", example: "Ada" },
      { path: "commentId", label: "Comment ID", developer: true },
      { path: "videoId", label: "Video ID", developer: true },
      { path: "channelId", label: "Channel ID", developer: true },
    ],
  },
  // Branching nodes record the decision they made (the executors write it so the
  // run is self-explanatory): a Condition emits true/false, a Switch the branch.
  [NodeType.CONDITION]: {
    rootKind: "perNode",
    fields: [{ path: "result", label: "Result", example: "true" }],
  },
  [NodeType.SWITCH]: {
    rootKind: "perNode",
    fields: [{ path: "matched", label: "Matched branch", example: "Default" }],
  },
  // Record Lookup: whether a value exists in a store (+ how many, + first match).
  // Non-branching — feed `exists` into a Condition node to route.
  [NodeType.RECORD_LOOKUP]: {
    rootKind: "perNode",
    fields: [
      { path: "exists", label: "Exists ?", example: "false" },
      { path: "matchCount", label: "Matches found", example: "0" },
      { path: "matched", label: "First matching record" },
    ],
  },
  // Convert node: the converted value (text/array for text conversions, or the
  // stored file's URL for binary ones) plus the detected source + fixed target,
  // and — for binary outputs — the blob handle (URL + metadata).
  [NodeType.CONVERT]: {
    rootKind: "perNode",
    fields: [
      { path: "result", label: "Converted result" },
      { path: "from", label: "Source format", example: "pdf" },
      { path: "to", label: "Target format", example: "text" },
      { path: "file.url", label: "File URL (binary output)" },
      {
        path: "file.contentType",
        label: "File type",
        example: "image/png",
        developer: true,
      },
    ],
  },
  [NodeType.CALCULATOR]: {
    rootKind: "perNode",
    fields: [
      { path: "result", label: "Result", example: "1416" },
      {
        path: "expression",
        label: "Expression that was calculated",
        example: "1200 * 1.18",
      },
    ],
  },
  // The Code node's output is whatever the user's code returns, so its SHAPE is
  // not knowable ahead of time. It is stored whole under `result`; the picker
  // offers that single entry, and a downstream node drills into it by hand
  // (`@<CODE_1.result.total>@`) exactly as it would any nested value.
  [NodeType.CODE]: {
    rootKind: "perNode",
    fields: [
      {
        path: "result",
        label: "Result (whatever your code returns)",
        example: '{ "total": 1416 }',
      },
    ],
  },
  // Resume Parser output (built-in or Affinda provider both map onto this).
  [NodeType.RESUME_PARSER]: {
    rootKind: "perNode",
    fields: [
      { path: "resumeText", label: "Resume text" },
      {
        path: "skills",
        label: "Detected skills",
        example: "React, TypeScript",
      },
      {
        path: "totalYearsExperience",
        label: "Total years experience",
        example: "3",
      },
      { path: "emails", label: "Emails found", example: "ada@example.com" },
      { path: "affindaResumeId", label: "Affinda resume ID", developer: true },
    ],
  },
  // Candidate Scoring decision (the basis for the downstream Switch).
  [NodeType.CANDIDATE_SCORING]: {
    rootKind: "perNode",
    fields: [
      { path: "decision", label: "Decision", example: "SHORTLIST" },
      { path: "score", label: "Score", example: "75" },
      { path: "reasons", label: "Reasons" },
    ],
  },
  // ATS candidate record.
  [NodeType.ATS_ACTION]: {
    rootKind: "perNode",
    fields: [
      { path: "url", label: "Candidate URL" },
      { path: "opportunityId", label: "Opportunity ID", developer: true },
    ],
  },
  // The Typeform trigger is GENERIC: it exposes the raw submission under
  // `typeform`. The base fields below are always present; the specific per-form
  // questions are added dynamically from the node's saved `discoveredFields`
  // ("Load questions" in the dialog) by the variable picker (see upstream-fields).
  [NodeType.TYPEFORM_TRIGGER]: {
    rootKind: "fixed",
    rootKey: "typeform",
    fields: [
      { path: "formId", label: "Form ID", developer: true },
      { path: "submittedAt", label: "Submitted at" },
      { path: "fields", label: "All answers (raw)" },
    ],
  },
  // The Google Form trigger is GENERIC: it exposes the raw submission. The base
  // fields below are always present; the specific per-form questions are added
  // dynamically from the node's saved `discoveredFields` ("Load questions" in the
  // dialog) by the variable picker (see upstream-fields.ts).
  [NodeType.GOOGLE_FORM_TRIGGER]: {
    rootKind: "fixed",
    rootKey: "googleForm",
    fields: [
      { path: "respondentEmail", label: "Respondent email (if collected)" },
      { path: "timestamp", label: "Submitted at" },
      { path: "formTitle", label: "Form title" },
      { path: "responses", label: "All responses (raw)" },
    ],
  },
  // Intentionally NOT declared (the raw view still shows their data):
  //   - MANUAL_TRIGGER / INITIAL: no fixed output shape (manual payload varies).
};

/**
 * Resolves the full `context` path for a field of a given placed node.
 * For "fixed" roots the nodeId/ref are ignored; for "perNode" roots the node's
 * `ref` (e.g. `AI_TEXT_1`) is the key, falling back to `<type>_<id>`.
 */
export function resolveOutputPath(
  type: NodeType,
  nodeId: string,
  fieldPath: string,
  ref?: string | null,
): string | null {
  const descriptor = nodeOutputs[type];
  if (!descriptor) return null;
  // topLevel fields live at the context root, so the path IS the field path.
  if (descriptor.rootKind === "topLevel") return fieldPath;
  const root =
    descriptor.rootKind === "fixed"
      ? descriptor.rootKey
      : getOutputKeyForNode(type, nodeId, ref);
  return `${root}.${fieldPath}`;
}
