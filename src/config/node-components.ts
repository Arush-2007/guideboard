import type { NodeTypes } from "@xyflow/react";
import { InitialNode } from "@/components/initial-node";
import { AiReplyGeneratorNode } from "@/features/executions/components/ai-reply-generator/node";
import { AiTextNode } from "@/features/executions/components/ai-text/node";
import { AnthropicNode } from "@/features/executions/components/anthropic/node";
import { AtsActionNode } from "@/features/executions/components/ats-action/node";
import { CandidateScoringNode } from "@/features/executions/components/candidate-scoring/node";
import { ConditionNode } from "@/features/executions/components/condition/node";
import { ConvertNode } from "@/features/executions/components/convert/node";
import { DiscordNode } from "@/features/executions/components/discord/node";
import { GeminiNode } from "@/features/executions/components/gemini/node";
import { GmailActionNode } from "@/features/executions/components/gmail-action/node";
import { GoogleSheetsActionNode } from "@/features/executions/components/google-sheets-action/node";
import { HttpRequestNode } from "@/features/executions/components/http-request/node";
import { InstagramReplyNode } from "@/features/executions/components/instagram-reply-comment/node";
import { NotionNode } from "@/features/executions/components/notion/node";
import { OpenAiNode } from "@/features/executions/components/openai/node";
import { RecordLookupNode } from "@/features/executions/components/record-lookup/node";
import { ResumeParserNode } from "@/features/executions/components/resume-parser/node";
import { SlackNode } from "@/features/executions/components/slack/node";
import { SwitchNode } from "@/features/executions/components/switch/node";
import { TelegramActionNode } from "@/features/executions/components/telegram-action/node";
import { WhatsappActionNode } from "@/features/executions/components/whatsapp-action/node";
import { YoutubeReplyNode } from "@/features/executions/components/youtube-reply-comment/node";
import { GmailTriggerNode } from "@/features/triggers/components/gmail-trigger/node";
import { GoogleFormTrigger } from "@/features/triggers/components/google-form-trigger/node";
import { GoogleSheetsTriggerNode } from "@/features/triggers/components/google-sheets-trigger/node";
import { InstagramCommentTriggerNode } from "@/features/triggers/components/instagram-comment-trigger/node";
import { ManualTriggerNode } from "@/features/triggers/components/manual-trigger/node";
import { ScheduleTriggerNode } from "@/features/triggers/components/schedule-trigger/node";
import { TelegramTrigger } from "@/features/triggers/components/telegram-trigger/node";
import { TypeformTrigger } from "@/features/triggers/components/typeform-trigger/node";
import { WebhookTriggerNode } from "@/features/triggers/components/webhook-trigger/node";
import { YoutubeCommentTriggerNode } from "@/features/triggers/components/youtube-comment-trigger/node";
import { NodeType } from "@/generated/prisma";

export const nodeComponents = {
  [NodeType.INITIAL]: InitialNode,
  [NodeType.HTTP_REQUEST]: HttpRequestNode,
  [NodeType.MANUAL_TRIGGER]: ManualTriggerNode,
  [NodeType.GOOGLE_FORM_TRIGGER]: GoogleFormTrigger,
  [NodeType.TYPEFORM_TRIGGER]: TypeformTrigger,
  [NodeType.GMAIL_TRIGGER]: GmailTriggerNode,
  [NodeType.GOOGLE_SHEETS_TRIGGER]: GoogleSheetsTriggerNode,
  [NodeType.SCHEDULE_TRIGGER]: ScheduleTriggerNode,
  [NodeType.WEBHOOK_TRIGGER]: WebhookTriggerNode,
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: InstagramCommentTriggerNode,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: InstagramReplyNode,
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: YoutubeCommentTriggerNode,
  [NodeType.YOUTUBE_REPLY_COMMENT]: YoutubeReplyNode,
  [NodeType.AI_REPLY_GENERATOR]: AiReplyGeneratorNode,
  [NodeType.AI_TEXT]: AiTextNode,
  [NodeType.GEMINI]: GeminiNode,
  [NodeType.OPENAI]: OpenAiNode,
  [NodeType.ANTHROPIC]: AnthropicNode,
  [NodeType.CONDITION]: ConditionNode,
  [NodeType.SWITCH]: SwitchNode,
  [NodeType.RECORD_LOOKUP]: RecordLookupNode,
  [NodeType.CONVERT]: ConvertNode,
  [NodeType.DISCORD]: DiscordNode,
  [NodeType.SLACK]: SlackNode,
  [NodeType.NOTION_ACTION]: NotionNode,
  [NodeType.TELEGRAM_ACTION]: TelegramActionNode,
  [NodeType.TELEGRAM_TRIGGER]: TelegramTrigger,
  [NodeType.WHATSAPP_ACTION]: WhatsappActionNode,
  [NodeType.GMAIL_ACTION]: GmailActionNode,
  [NodeType.GOOGLE_SHEETS_ACTION]: GoogleSheetsActionNode,
  [NodeType.RESUME_PARSER]: ResumeParserNode,
  [NodeType.CANDIDATE_SCORING]: CandidateScoringNode,
  [NodeType.ATS_ACTION]: AtsActionNode,
} as const satisfies NodeTypes;

export type RegisteredNodeType = keyof typeof nodeComponents;
