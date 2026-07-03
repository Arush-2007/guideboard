import { gmailTriggerExecutor } from "@/features/triggers/components/gmail-trigger/executor";
import { googleFormTriggerExecutor } from "@/features/triggers/components/google-form-trigger/executor";
import { googleSheetsTriggerExecutor } from "@/features/triggers/components/google-sheets-trigger/executor";
import { instagramCommentTriggerExecutor } from "@/features/triggers/components/instagram-comment-trigger/executor";
import { manualTriggerExecutor } from "@/features/triggers/components/manual-trigger/executor";
import { scheduleTriggerExecutor } from "@/features/triggers/components/schedule-trigger/executor";
import { telegramTriggerExecutor } from "@/features/triggers/components/telegram-trigger/executor";
import { typeformTriggerExecutor } from "@/features/triggers/components/typeform-trigger/executor";
import { webhookTriggerExecutor } from "@/features/triggers/components/webhook-trigger/executor";
import { youtubeCommentTriggerExecutor } from "@/features/triggers/components/youtube-comment-trigger/executor";
import { NodeType } from "@/generated/prisma";
import { aiReplyGeneratorExecutor } from "../components/ai-reply-generator/executor";
import { aiTextExecutor } from "../components/ai-text/executor";
import { anthropicExecutor } from "../components/anthropic/executor";
import { atsActionExecutor } from "../components/ats-action/executor";
import { candidateScoringExecutor } from "../components/candidate-scoring/executor";
import { conditionExecutor } from "../components/condition/executor";
import { convertExecutor } from "../components/convert/executor";
import { discordExecutor } from "../components/discord/executor";
import { geminiExecutor } from "../components/gemini/executor";
import { gmailActionExecutor } from "../components/gmail-action/executor";
import { googleSheetsActionExecutor } from "../components/google-sheets-action/executor";
import { httpRequestExecutor } from "../components/http-request/executor";
import { instagramReplyExecutor } from "../components/instagram-reply-comment/executor";
import { notionExecutor } from "../components/notion/executor";
import { openAiExecutor } from "../components/openai/executor";
import { recordLookupExecutor } from "../components/record-lookup/executor";
import { resumeParserExecutor } from "../components/resume-parser/executor";
import { slackExecutor } from "../components/slack/executor";
import { switchExecutor } from "../components/switch/executor";
import { telegramActionExecutor } from "../components/telegram-action/executor";
import { whatsappActionExecutor } from "../components/whatsapp-action/executor";
import { youtubeReplyExecutor } from "../components/youtube-reply-comment/executor";
import type { NodeExecutor } from "../types";

export const executorRegistry: Record<NodeType, NodeExecutor> = {
  [NodeType.INITIAL]: manualTriggerExecutor,
  [NodeType.MANUAL_TRIGGER]: manualTriggerExecutor,
  [NodeType.HTTP_REQUEST]: httpRequestExecutor,
  [NodeType.GOOGLE_FORM_TRIGGER]: googleFormTriggerExecutor,
  [NodeType.TYPEFORM_TRIGGER]: typeformTriggerExecutor,
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: instagramCommentTriggerExecutor,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: instagramReplyExecutor,
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: youtubeCommentTriggerExecutor,
  [NodeType.YOUTUBE_REPLY_COMMENT]: youtubeReplyExecutor,
  [NodeType.AI_REPLY_GENERATOR]: aiReplyGeneratorExecutor,
  [NodeType.AI_TEXT]: aiTextExecutor,
  [NodeType.GEMINI]: geminiExecutor,
  [NodeType.ANTHROPIC]: anthropicExecutor,
  [NodeType.CONDITION]: conditionExecutor,
  [NodeType.SWITCH]: switchExecutor,
  [NodeType.RECORD_LOOKUP]: recordLookupExecutor,
  [NodeType.CONVERT]: convertExecutor,
  [NodeType.OPENAI]: openAiExecutor,
  [NodeType.DISCORD]: discordExecutor,
  [NodeType.SLACK]: slackExecutor,
  [NodeType.NOTION_ACTION]: notionExecutor,
  [NodeType.TELEGRAM_ACTION]: telegramActionExecutor,
  [NodeType.TELEGRAM_TRIGGER]: telegramTriggerExecutor,
  [NodeType.WHATSAPP_ACTION]: whatsappActionExecutor,
  [NodeType.GMAIL_ACTION]: gmailActionExecutor,
  [NodeType.GMAIL_TRIGGER]: gmailTriggerExecutor,
  [NodeType.GOOGLE_SHEETS_ACTION]: googleSheetsActionExecutor,
  [NodeType.GOOGLE_SHEETS_TRIGGER]: googleSheetsTriggerExecutor,
  [NodeType.SCHEDULE_TRIGGER]: scheduleTriggerExecutor,
  [NodeType.WEBHOOK_TRIGGER]: webhookTriggerExecutor,
  [NodeType.RESUME_PARSER]: resumeParserExecutor,
  [NodeType.CANDIDATE_SCORING]: candidateScoringExecutor,
  [NodeType.ATS_ACTION]: atsActionExecutor,
};

export const getExecutor = (type: NodeType): NodeExecutor => {
  const executor = executorRegistry[type];
  if (!executor) {
    throw new Error(`No executor found for node type: ${type}`);
  }

  return executor;
};
