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
};

export type NodeOutputDescriptor =
  | { rootKind: "fixed"; rootKey: string; fields: NodeOutputField[] }
  | { rootKind: "perNode"; fields: NodeOutputField[] }
  | { rootKind: "topLevel"; fields: NodeOutputField[] };

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
      { path: "appendedRows", label: "Rows appended", example: "1" },
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
    fields: [
      { path: "row", label: "Row values" },
      { path: "rowIndex", label: "Row number", example: "2" },
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
      { path: "respondentEmail", label: "Respondent email" },
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
