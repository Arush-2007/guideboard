import type { Realtime } from "@inngest/realtime";
// --- Token actions (server actions that mint a per-channel subscription token) ---
import { fetchAiReplyGeneratorRealtimeToken } from "@/features/executions/components/ai-reply-generator/actions";
import { fetchAiTextRealtimeToken } from "@/features/executions/components/ai-text/actions";
import { fetchAnthropicRealtimeToken } from "@/features/executions/components/anthropic/actions";
import { fetchAtsActionRealtimeToken } from "@/features/executions/components/ats-action/actions";
import { fetchCandidateScoringRealtimeToken } from "@/features/executions/components/candidate-scoring/actions";
import { fetchConditionRealtimeToken } from "@/features/executions/components/condition/actions";
import { fetchConvertRealtimeToken } from "@/features/executions/components/convert/actions";
import { fetchDiscordRealtimeToken } from "@/features/executions/components/discord/actions";
import { fetchGeminiRealtimeToken } from "@/features/executions/components/gemini/actions";
import { fetchExcelActionRealtimeToken } from "@/features/executions/components/excel-action/actions";
import { fetchGmailActionRealtimeToken } from "@/features/executions/components/gmail-action/actions";
import { fetchGoogleSheetsActionRealtimeToken } from "@/features/executions/components/google-sheets-action/actions";
import { fetchHttpRequestRealtimeToken } from "@/features/executions/components/http-request/actions";
import { fetchInstagramReplyRealtimeToken } from "@/features/executions/components/instagram-reply-comment/actions";
import { fetchNotionRealtimeToken } from "@/features/executions/components/notion/actions";
import { fetchOpenAiRealtimeToken } from "@/features/executions/components/openai/actions";
import { fetchRecordLookupRealtimeToken } from "@/features/executions/components/record-lookup/actions";
import { fetchResumeParserRealtimeToken } from "@/features/executions/components/resume-parser/actions";
import { fetchSlackRealtimeToken } from "@/features/executions/components/slack/actions";
import { fetchSwitchRealtimeToken } from "@/features/executions/components/switch/actions";
import { fetchTelegramActionRealtimeToken } from "@/features/executions/components/telegram-action/actions";
import { fetchWhatsappActionRealtimeToken } from "@/features/executions/components/whatsapp-action/actions";
import { fetchYoutubeReplyRealtimeToken } from "@/features/executions/components/youtube-reply-comment/actions";
import { fetchGmailTriggerRealtimeToken } from "@/features/triggers/components/gmail-trigger/actions";
import { fetchGoogleFormTriggerRealtimeToken } from "@/features/triggers/components/google-form-trigger/actions";
import { fetchGoogleSheetsTriggerRealtimeToken } from "@/features/triggers/components/google-sheets-trigger/actions";
import { fetchInstagramCommentTriggerRealtimeToken } from "@/features/triggers/components/instagram-comment-trigger/actions";
import { fetchManualTriggerRealtimeToken } from "@/features/triggers/components/manual-trigger/actions";
import { fetchScheduleTriggerRealtimeToken } from "@/features/triggers/components/schedule-trigger/actions";
import { fetchTelegramTriggerRealtimeToken } from "@/features/triggers/components/telegram-trigger/actions";
import { fetchTypeformTriggerRealtimeToken } from "@/features/triggers/components/typeform-trigger/actions";
import { fetchWebhookTriggerRealtimeToken } from "@/features/triggers/components/webhook-trigger/actions";
import { fetchYoutubeCommentTriggerRealtimeToken } from "@/features/triggers/components/youtube-comment-trigger/actions";
import { NodeType } from "@/generated/prisma";
// --- Channel name constants (one per node type that streams status) ---
import { AI_REPLY_GENERATOR_CHANNEL_NAME } from "@/inngest/channels/ai-reply-generator";
import { AI_TEXT_CHANNEL_NAME } from "@/inngest/channels/ai-text";
import { ANTHROPIC_CHANNEL_NAME } from "@/inngest/channels/anthropic";
import { ATS_ACTION_CHANNEL_NAME } from "@/inngest/channels/ats-action";
import { CANDIDATE_SCORING_CHANNEL_NAME } from "@/inngest/channels/candidate-scoring";
import { CONDITION_CHANNEL_NAME } from "@/inngest/channels/condition";
import { CONVERT_CHANNEL_NAME } from "@/inngest/channels/convert";
import { DISCORD_CHANNEL_NAME } from "@/inngest/channels/discord";
import { GEMINI_CHANNEL_NAME } from "@/inngest/channels/gemini";
import { EXCEL_ACTION_CHANNEL_NAME } from "@/inngest/channels/excel-action";
import { GMAIL_ACTION_CHANNEL_NAME } from "@/inngest/channels/gmail-action";
import { GMAIL_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/gmail-trigger";
import { GOOGLE_FORM_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/google-form-trigger";
import { GOOGLE_SHEETS_ACTION_CHANNEL_NAME } from "@/inngest/channels/google-sheets-action";
import { GOOGLE_SHEETS_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/google-sheets-trigger";
import { HTTP_REQUEST_CHANNEL_NAME } from "@/inngest/channels/http-request";
import { INSTAGRAM_COMMENT_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/instagram-comment-trigger";
import { INSTAGRAM_REPLY_COMMENT_CHANNEL_NAME } from "@/inngest/channels/instagram-reply-comment";
import { MANUAL_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/manual-trigger";
import { NOTION_CHANNEL_NAME } from "@/inngest/channels/notion";
import { OPENAI_CHANNEL_NAME } from "@/inngest/channels/openai";
import { RECORD_LOOKUP_CHANNEL_NAME } from "@/inngest/channels/record-lookup";
import { RESUME_PARSER_CHANNEL_NAME } from "@/inngest/channels/resume-parser";
import { SCHEDULE_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/schedule-trigger";
import { SLACK_CHANNEL_NAME } from "@/inngest/channels/slack";
import { SWITCH_CHANNEL_NAME } from "@/inngest/channels/switch";
import { TELEGRAM_ACTION_CHANNEL_NAME } from "@/inngest/channels/telegram-action";
import { TELEGRAM_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/telegram-trigger";
import { TYPEFORM_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/typeform-trigger";
import { WEBHOOK_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/webhook-trigger";
import { WHATSAPP_ACTION_CHANNEL_NAME } from "@/inngest/channels/whatsapp-action";
import { YOUTUBE_COMMENT_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/youtube-comment-trigger";
import { YOUTUBE_REPLY_COMMENT_CHANNEL_NAME } from "@/inngest/channels/youtube-reply-comment";

export type RefreshNodeStatusToken = () => Promise<Realtime.Subscribe.Token>;

export interface NodeStatusChannel {
  channelName: string;
  refreshToken: RefreshNodeStatusToken;
}

/**
 * Parallel registration: every NodeType that streams realtime status maps to
 * its Inngest channel + token action. Must stay in sync with the node's
 * executor channel (see the realtime registration notes in CLAUDE.md). Node
 * types without live status (e.g. INITIAL) are intentionally omitted.
 *
 * Replaces the per-node `useNodeStatus({ channel, refreshToken })` wiring that
 * used to live in each node.tsx — now one subscription per distinct channel is
 * driven from this single source.
 */
export const nodeStatusRegistry: Partial<Record<NodeType, NodeStatusChannel>> =
  {
    [NodeType.HTTP_REQUEST]: {
      channelName: HTTP_REQUEST_CHANNEL_NAME,
      refreshToken: fetchHttpRequestRealtimeToken,
    },
    [NodeType.CONDITION]: {
      channelName: CONDITION_CHANNEL_NAME,
      refreshToken: fetchConditionRealtimeToken,
    },
    [NodeType.SWITCH]: {
      channelName: SWITCH_CHANNEL_NAME,
      refreshToken: fetchSwitchRealtimeToken,
    },
    [NodeType.RECORD_LOOKUP]: {
      channelName: RECORD_LOOKUP_CHANNEL_NAME,
      refreshToken: fetchRecordLookupRealtimeToken,
    },
    [NodeType.CONVERT]: {
      channelName: CONVERT_CHANNEL_NAME,
      refreshToken: fetchConvertRealtimeToken,
    },
    [NodeType.MANUAL_TRIGGER]: {
      channelName: MANUAL_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchManualTriggerRealtimeToken,
    },
    [NodeType.GOOGLE_FORM_TRIGGER]: {
      channelName: GOOGLE_FORM_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchGoogleFormTriggerRealtimeToken,
    },
    [NodeType.TYPEFORM_TRIGGER]: {
      channelName: TYPEFORM_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchTypeformTriggerRealtimeToken,
    },
    [NodeType.GMAIL_TRIGGER]: {
      channelName: GMAIL_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchGmailTriggerRealtimeToken,
    },
    [NodeType.GOOGLE_SHEETS_TRIGGER]: {
      channelName: GOOGLE_SHEETS_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchGoogleSheetsTriggerRealtimeToken,
    },
    [NodeType.SCHEDULE_TRIGGER]: {
      channelName: SCHEDULE_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchScheduleTriggerRealtimeToken,
    },
    [NodeType.WEBHOOK_TRIGGER]: {
      channelName: WEBHOOK_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchWebhookTriggerRealtimeToken,
    },
    [NodeType.INSTAGRAM_COMMENT_TRIGGER]: {
      channelName: INSTAGRAM_COMMENT_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchInstagramCommentTriggerRealtimeToken,
    },
    [NodeType.INSTAGRAM_REPLY_COMMENT]: {
      channelName: INSTAGRAM_REPLY_COMMENT_CHANNEL_NAME,
      refreshToken: fetchInstagramReplyRealtimeToken,
    },
    [NodeType.YOUTUBE_COMMENT_TRIGGER]: {
      channelName: YOUTUBE_COMMENT_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchYoutubeCommentTriggerRealtimeToken,
    },
    [NodeType.YOUTUBE_REPLY_COMMENT]: {
      channelName: YOUTUBE_REPLY_COMMENT_CHANNEL_NAME,
      refreshToken: fetchYoutubeReplyRealtimeToken,
    },
    [NodeType.AI_REPLY_GENERATOR]: {
      channelName: AI_REPLY_GENERATOR_CHANNEL_NAME,
      refreshToken: fetchAiReplyGeneratorRealtimeToken,
    },
    [NodeType.AI_TEXT]: {
      channelName: AI_TEXT_CHANNEL_NAME,
      refreshToken: fetchAiTextRealtimeToken,
    },
    [NodeType.GEMINI]: {
      channelName: GEMINI_CHANNEL_NAME,
      refreshToken: fetchGeminiRealtimeToken,
    },
    [NodeType.OPENAI]: {
      channelName: OPENAI_CHANNEL_NAME,
      refreshToken: fetchOpenAiRealtimeToken,
    },
    [NodeType.ANTHROPIC]: {
      channelName: ANTHROPIC_CHANNEL_NAME,
      refreshToken: fetchAnthropicRealtimeToken,
    },
    [NodeType.DISCORD]: {
      channelName: DISCORD_CHANNEL_NAME,
      refreshToken: fetchDiscordRealtimeToken,
    },
    [NodeType.SLACK]: {
      channelName: SLACK_CHANNEL_NAME,
      refreshToken: fetchSlackRealtimeToken,
    },
    [NodeType.NOTION_ACTION]: {
      channelName: NOTION_CHANNEL_NAME,
      refreshToken: fetchNotionRealtimeToken,
    },
    [NodeType.TELEGRAM_ACTION]: {
      channelName: TELEGRAM_ACTION_CHANNEL_NAME,
      refreshToken: fetchTelegramActionRealtimeToken,
    },
    [NodeType.TELEGRAM_TRIGGER]: {
      channelName: TELEGRAM_TRIGGER_CHANNEL_NAME,
      refreshToken: fetchTelegramTriggerRealtimeToken,
    },
    [NodeType.WHATSAPP_ACTION]: {
      channelName: WHATSAPP_ACTION_CHANNEL_NAME,
      refreshToken: fetchWhatsappActionRealtimeToken,
    },
    [NodeType.GMAIL_ACTION]: {
      channelName: GMAIL_ACTION_CHANNEL_NAME,
      refreshToken: fetchGmailActionRealtimeToken,
    },
    [NodeType.GOOGLE_SHEETS_ACTION]: {
      channelName: GOOGLE_SHEETS_ACTION_CHANNEL_NAME,
      refreshToken: fetchGoogleSheetsActionRealtimeToken,
    },
    [NodeType.EXCEL_ACTION]: {
      channelName: EXCEL_ACTION_CHANNEL_NAME,
      refreshToken: fetchExcelActionRealtimeToken,
    },
    [NodeType.RESUME_PARSER]: {
      channelName: RESUME_PARSER_CHANNEL_NAME,
      refreshToken: fetchResumeParserRealtimeToken,
    },
    [NodeType.CANDIDATE_SCORING]: {
      channelName: CANDIDATE_SCORING_CHANNEL_NAME,
      refreshToken: fetchCandidateScoringRealtimeToken,
    },
    [NodeType.ATS_ACTION]: {
      channelName: ATS_ACTION_CHANNEL_NAME,
      refreshToken: fetchAtsActionRealtimeToken,
    },
  };

/**
 * Reverse lookup: channelName -> token action, for a <NodeStatusSubscriber>
 * that only knows which channel it owns.
 */
export const refreshTokenByChannel: Record<string, RefreshNodeStatusToken> =
  Object.fromEntries(
    Object.values(nodeStatusRegistry).map((entry) => [
      entry.channelName,
      entry.refreshToken,
    ]),
  );

/** Resolve a node type string to its status channel name (or undefined). */
export const channelNameForNodeType = (type: string): string | undefined =>
  nodeStatusRegistry[type as NodeType]?.channelName;
