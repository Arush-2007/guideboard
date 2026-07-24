import { NodeType } from "@/generated/prisma";
import { asFormat, FORMAT_META } from "@/lib/conversions";

/**
 * Per-node "what happened" summary line for the execution page's Friendly output
 * view. The registry counterpart to the output *table* (node-outputs.ts): the
 * table shows the fields, this shows a one-line human description. Adding a node
 * = add one entry here (and one in node-outputs.ts). Returns `null` to fall back
 * to the table alone.
 *
 * Triggers are handled by the caller (a uniform "Workflow was triggered"), and
 * failed/skipped nodes never reach here — they get their own status notes.
 */

export type NodeSummaryArgs = {
  /** The node's unwrapped output object (its fields' root), if any. */
  output: Record<string, unknown> | undefined;
  /** The node's config (`data`), for values not echoed into the output. */
  config: Record<string, unknown>;
  /** Renders a config template's `@<path>@` refs against this run's input. */
  resolve: (template: unknown) => string;
};

export type NodeSummary = (args: NodeSummaryArgs) => string | null;

const str = (value: unknown): string =>
  value == null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

const aiSummary: NodeSummary = ({ output }) => {
  const text = output?.output ?? output?.text;
  return typeof text === "string" && text.length > 0
    ? "The AI generated a response."
    : null;
};

export const nodeSummaries: Partial<Record<NodeType, NodeSummary>> = {
  [NodeType.HTTP_REQUEST]: ({ output, config, resolve }) => {
    const method = typeof config.method === "string" ? config.method : "HTTP";
    const url = resolve(config.endpoint).trim();
    const response = output?.httpResponse as
      | Record<string, unknown>
      | undefined;
    const status = response?.status;
    const where = url ? ` to ${url}` : "";
    const got = status != null ? ` — returned ${str(status)}` : "";
    return `Sent a ${method} request${where}${got}.`;
  },
  // NOTE: CONDITION and SWITCH are intentionally absent — the execution view
  // renders their decision directly (Condition: a True/False message; Switch: the
  // matched branch + a field/operator/value criteria table reconstructed from
  // config), since a generic summary can't express their branching semantics.
  [NodeType.AI_TEXT]: aiSummary,
  [NodeType.ANTHROPIC]: aiSummary,
  [NodeType.GEMINI]: aiSummary,
  [NodeType.OPENAI]: aiSummary,
  [NodeType.AI_REPLY_GENERATOR]: () => "Generated a reply.",
  [NodeType.GMAIL_ACTION]: ({ output }) =>
    output?.to ? `Email sent to ${str(output.to)}.` : "Email sent.",
  [NodeType.SLACK]: ({ output }) =>
    output?.deliveredCount != null
      ? `Message posted to ${str(output.deliveredCount)} channel(s).`
      : "Message posted to Slack.",
  [NodeType.WHATSAPP_ACTION]: ({ output }) =>
    output?.deliveredCount != null
      ? `Message sent to ${str(output.deliveredCount)} recipient(s).`
      : "WhatsApp message sent.",
  [NodeType.DISCORD]: () => "Message posted to Discord.",
  [NodeType.TELEGRAM_ACTION]: ({ output }) =>
    output?.chatId
      ? `Message sent to chat ${str(output.chatId)}.`
      : "Telegram message sent.",
  [NodeType.NOTION_ACTION]: () => "Created a Notion page.",
  // NOTE: GOOGLE_SHEETS_ACTION is intentionally absent. Every one of its actions
  // (append_row / find_rows / update_row) renders its own summary + a
  // spreadsheet-shaped view in the execution page, because what happened depends
  // on the action, on how many rows matched, and on whether the run fanned out —
  // none of which a single generic line can state truthfully. A catch-all here
  // once claimed "Updated the sheet." for a run that matched zero rows and wrote
  // nothing; there must be no such line to fall back to.
  [NodeType.CONVERT]: ({ output }) => {
    const from = asFormat(typeof output?.from === "string" ? output.from : "");
    const to = asFormat(typeof output?.to === "string" ? output.to : "");
    return to
      ? `Converted ${from ? FORMAT_META[from].label : "input"} to ${FORMAT_META[to].label}.`
      : "Converted the input.";
  },
  [NodeType.CALCULATOR]: ({ output }) => {
    if (typeof output?.result !== "number") return null;
    // Shows the resolved expression, not the template, so the line reads as a
    // sum the user can check: "Calculated 1200 * 1.18 = 1416."
    const expression =
      typeof output?.expression === "string" ? output.expression : "";
    return expression
      ? `Calculated ${expression} = ${output.result}.`
      : `Calculated ${output.result}.`;
  },
  [NodeType.CODE]: ({ output }) =>
    output && "result" in output ? "Ran your code." : null,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: () => "Reply posted to the comment.",
  [NodeType.YOUTUBE_REPLY_COMMENT]: () => "Reply posted to the comment.",
};
