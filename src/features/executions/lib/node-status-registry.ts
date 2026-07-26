import type { Realtime } from "@inngest/realtime";
import { NodeType } from "@/generated/prisma";
import { NODE_STATUS_CHANNEL_NAME } from "@/inngest/channels/node-status";
import { fetchNodeStatusRealtimeToken } from "./node-status-token";

export type RefreshNodeStatusToken = () => Promise<Realtime.Subscribe.Token>;

/**
 * The set of NodeTypes that stream realtime status during a run. They ALL
 * publish to the single unified `node-status:<userId>` channel (see
 * `src/inngest/channels/node-status.ts`), so the editor opens one subscription
 * regardless of node-type count — but this stays the single source of truth for
 * *which* types emit status, so types without live status (e.g. INITIAL) resolve
 * to no channel and never open a subscription.
 *
 * When adding a node whose executor publishes status, add its NodeType here.
 */
const STATUS_EMITTING_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  NodeType.HTTP_REQUEST,
  NodeType.CONDITION,
  NodeType.SWITCH,
  NodeType.RECORD_LOOKUP,
  NodeType.CONVERT,
  NodeType.CALCULATOR,
  NodeType.CODE,
  NodeType.MANUAL_TRIGGER,
  NodeType.GOOGLE_FORM_TRIGGER,
  NodeType.TYPEFORM_TRIGGER,
  NodeType.GMAIL_TRIGGER,
  NodeType.GOOGLE_SHEETS_TRIGGER,
  NodeType.SCHEDULE_TRIGGER,
  NodeType.WEBHOOK_TRIGGER,
  NodeType.INSTAGRAM_COMMENT_TRIGGER,
  NodeType.INSTAGRAM_REPLY_COMMENT,
  NodeType.YOUTUBE_COMMENT_TRIGGER,
  NodeType.YOUTUBE_REPLY_COMMENT,
  NodeType.AI_REPLY_GENERATOR,
  NodeType.AI_TEXT,
  NodeType.GEMINI,
  NodeType.OPENAI,
  NodeType.ANTHROPIC,
  NodeType.DISCORD,
  NodeType.SLACK,
  NodeType.NOTION_ACTION,
  NodeType.TELEGRAM_ACTION,
  NodeType.TELEGRAM_TRIGGER,
  NodeType.WHATSAPP_ACTION,
  NodeType.GMAIL_ACTION,
  NodeType.GOOGLE_SHEETS_ACTION,
  NodeType.EXCEL_ACTION,
  NodeType.RESUME_PARSER,
  NodeType.CANDIDATE_SCORING,
  NodeType.ATS_ACTION,
]);

/**
 * Resolve a node type string to its status channel name (or undefined for types
 * with no live status). Every emitting type maps to the one unified channel, so
 * `deriveActiveChannels` collapses a whole canvas to a single channel.
 */
export const channelNameForNodeType = (type: string): string | undefined =>
  STATUS_EMITTING_NODE_TYPES.has(type as NodeType)
    ? NODE_STATUS_CHANNEL_NAME
    : undefined;

/**
 * Reverse lookup: channelName -> token action, for a <NodeStatusSubscriber>
 * that only knows which channel it owns. One entry now — the unified channel.
 */
export const refreshTokenByChannel: Record<string, RefreshNodeStatusToken> = {
  [NODE_STATUS_CHANNEL_NAME]: fetchNodeStatusRealtimeToken,
};
