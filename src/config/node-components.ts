import { InitialNode } from "@/components/initial-node";
import { NodeType } from "@/generated/prisma";
import type { NodeTypes } from "@xyflow/react";

import { HttpRequestNode } from "@/features/executions/components/http-request/node";
import { ManualTriggerNode } from "@/features/triggers/components/manual-trigger/node";
import { GoogleFormTrigger } from "@/features/triggers/components/google-form-trigger/node";
import { StripeTriggerNode } from "@/features/triggers/components/stripe-trigger/node";
import { InstagramCommentTriggerNode } from "@/features/triggers/components/instagram-comment-trigger/node";
import { InstagramReplyNode } from "@/features/executions/components/instagram-reply-comment/node";
import { YoutubeCommentTriggerNode } from "@/features/triggers/components/youtube-comment-trigger/node";
import { YoutubeReplyNode } from "@/features/executions/components/youtube-reply-comment/node";
import { AiReplyGeneratorNode } from "@/features/executions/components/ai-reply-generator/node";
import { GeminiNode } from "@/features/executions/components/gemini/node";
import { OpenAiNode } from "@/features/executions/components/openai/node";
import { AnthropicNode } from "@/features/executions/components/anthropic/node";
import { DiscordNode } from "@/features/executions/components/discord/node";
import { SlackNode } from "@/features/executions/components/slack/node";

export const nodeComponents = {
  [NodeType.INITIAL]: InitialNode,
  [NodeType.HTTP_REQUEST]: HttpRequestNode,
  [NodeType.MANUAL_TRIGGER]: ManualTriggerNode,
  [NodeType.GOOGLE_FORM_TRIGGER]: GoogleFormTrigger,
  [NodeType.STRIPE_TRIGGER]: StripeTriggerNode,
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: InstagramCommentTriggerNode,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: InstagramReplyNode,
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: YoutubeCommentTriggerNode,
  [NodeType.YOUTUBE_REPLY_COMMENT]: YoutubeReplyNode,
  [NodeType.AI_REPLY_GENERATOR]: AiReplyGeneratorNode,
  [NodeType.GEMINI]: GeminiNode,
  [NodeType.OPENAI]: OpenAiNode,
  [NodeType.ANTHROPIC]: AnthropicNode,
  [NodeType.DISCORD]: DiscordNode,
  [NodeType.SLACK]: SlackNode,
} as const satisfies NodeTypes;

export type RegisteredNodeType = keyof typeof nodeComponents;
