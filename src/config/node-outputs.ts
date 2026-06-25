import { NodeType } from "@/generated/prisma";

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
 *   - "fixed":   the node writes a constant top-level key (triggers). `rootKey`
 *                holds it (e.g. "telegram"), so the full context path for a
 *                field is `${rootKey}.${field.path}`.
 *   - "perNode": the node writes `${nodeType.toLowerCase()}_${nodeId}`, so the
 *                full path is resolved per placed node at mapping time.
 */

export type NodeOutputField = {
  /** Path relative to the node's output root, e.g. "from.firstName". */
  path: string;
  /** Human-friendly label shown in the mapping UI. */
  label: string;
  /** Optional example value to help users recognize the field. */
  example?: string;
};

export type NodeOutputDescriptor =
  | { rootKind: "fixed"; rootKey: string; fields: NodeOutputField[] }
  | { rootKind: "perNode"; fields: NodeOutputField[] };

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
      { path: "from.id", label: "Sender user ID", example: "123456789" },
      {
        path: "contact.phoneNumber",
        label: "Shared contact number",
        example: "+15551234567",
      },
      { path: "contact.firstName", label: "Shared contact name" },
      { path: "chatId", label: "Chat ID", example: "123456789" },
      { path: "messageId", label: "Message ID", example: "42" },
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
      { path: "spreadsheetId", label: "Spreadsheet ID" },
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
};

/**
 * Resolves the full `context` path for a field of a given placed node.
 * For "fixed" roots the nodeId is ignored.
 */
export function resolveOutputPath(
  type: NodeType,
  nodeId: string,
  fieldPath: string,
): string | null {
  const descriptor = nodeOutputs[type];
  if (!descriptor) return null;
  const root =
    descriptor.rootKind === "fixed"
      ? descriptor.rootKey
      : `${type.toLowerCase()}_${nodeId}`;
  return `${root}.${fieldPath}`;
}
