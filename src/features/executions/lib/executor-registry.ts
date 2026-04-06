import { NodeType } from "@/generated/prisma";
import { NodeExecutor } from "../types";
import { manualTriggerExecutor } from "@/features/triggers/components/manual-trigger/executor";
import { httpRequestExecutor } from "../components/http-request/executor";
import { conditionExecutor } from "../components/condition/executor";
import { googleFormTriggerExecutor } from "@/features/triggers/components/google-form-trigger/executor";
import { stripeTriggerExecutor } from "@/features/triggers/components/stripe-trigger/executor";
import { typeformTriggerExecutor } from "@/features/triggers/components/typeform-trigger/executor";
import { instagramCommentTriggerExecutor } from "@/features/triggers/components/instagram-comment-trigger/executor";
import { instagramReplyExecutor } from "../components/instagram-reply-comment/executor";
import { youtubeCommentTriggerExecutor } from "@/features/triggers/components/youtube-comment-trigger/executor";
import { youtubeReplyExecutor } from "../components/youtube-reply-comment/executor";
import { aiReplyGeneratorExecutor } from "../components/ai-reply-generator/executor";
import { geminiExecutor } from "../components/gemini/executor";
import { openAiExecutor } from "../components/openai/executor";
import { anthropicExecutor } from "../components/anthropic/executor";
import { discordExecutor } from "../components/discord/executor";
import { slackExecutor } from "../components/slack/executor";
import { notionExecutor } from "../components/notion/executor";
import { telegramActionExecutor } from "../components/telegram-action/executor";
import { telegramTriggerExecutor } from "@/features/triggers/components/telegram-trigger/executor";
import { whatsappActionExecutor } from "../components/whatsapp-action/executor";

export const executorRegistry: Record<NodeType, NodeExecutor> = {
  [NodeType.INITIAL]: manualTriggerExecutor,
  [NodeType.MANUAL_TRIGGER]: manualTriggerExecutor,
  [NodeType.HTTP_REQUEST]: httpRequestExecutor,
  [NodeType.GOOGLE_FORM_TRIGGER]: googleFormTriggerExecutor,
  [NodeType.STRIPE_TRIGGER]: stripeTriggerExecutor,
  [NodeType.TYPEFORM_TRIGGER]: typeformTriggerExecutor,
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: instagramCommentTriggerExecutor,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: instagramReplyExecutor,
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: youtubeCommentTriggerExecutor,
  [NodeType.YOUTUBE_REPLY_COMMENT]: youtubeReplyExecutor,
  [NodeType.AI_REPLY_GENERATOR]: aiReplyGeneratorExecutor,
  [NodeType.GEMINI]: geminiExecutor,
  [NodeType.ANTHROPIC]: anthropicExecutor,
  [NodeType.CONDITION]: conditionExecutor,
  [NodeType.OPENAI]: openAiExecutor,
  [NodeType.DISCORD]: discordExecutor,
  [NodeType.SLACK]: slackExecutor,
  [NodeType.NOTION_ACTION]: notionExecutor,
  [NodeType.TELEGRAM_ACTION]: telegramActionExecutor,
  [NodeType.TELEGRAM_TRIGGER]: telegramTriggerExecutor,
  [NodeType.WHATSAPP_ACTION]: whatsappActionExecutor,
};

export const getExecutor = (type: NodeType): NodeExecutor => {
  const executor = executorRegistry[type];
  if (!executor) {
    throw new Error(`No executor found for node type: ${type}`);
  }

  return executor;
};
