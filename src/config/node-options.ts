import {
  BrainCircuit,
  Clock,
  Filter,
  GlobeIcon,
  MousePointerIcon,
  Split,
  Webhook,
} from "lucide-react";
import { NodeType } from "@/generated/prisma";

// Single source of truth for the user-facing metadata (label / description /
// icon) of each selectable node type. Consumed by the node selector and the
// staging tray so the two never drift. Adding a new selectable node is a single
// edit here — keep it in sync with the executor/component/schema registries
// described in CLAUDE.md.
export type NodeOption = {
  type: NodeType;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }> | string;
};

export const triggerNodeOptions: NodeOption[] = [
  {
    type: NodeType.MANUAL_TRIGGER,
    label: "Trigger manually",
    description:
      "Runs the flow on clicking a button. Good for getting started quickly",
    icon: MousePointerIcon,
  },
  {
    type: NodeType.GOOGLE_FORM_TRIGGER,
    label: "Google Form",
    description: "Runs the flow when a Google Form is submitted",
    icon: "/logos/googleform.svg",
  },
  {
    type: NodeType.TYPEFORM_TRIGGER,
    label: "Typeform",
    description: "Runs the flow when a Typeform response is submitted",
    icon: "/logos/typeform.svg",
  },
  {
    type: NodeType.GMAIL_TRIGGER,
    label: "Gmail",
    description: "Runs the flow when a new unread email is detected",
    icon: "/logos/gmail.svg",
  },
  {
    type: NodeType.GOOGLE_SHEETS_TRIGGER,
    label: "Google Sheets",
    description: "Runs the flow when a new row is detected",
    icon: "/logos/google-sheets.svg",
  },
  {
    type: NodeType.SCHEDULE_TRIGGER,
    label: "Schedule",
    description: "Runs the flow on a recurring schedule (hourly, daily, cron)",
    icon: Clock,
  },
  {
    type: NodeType.WEBHOOK_TRIGGER,
    label: "Webhook",
    description: "Runs the flow when its unique URL receives a POST request",
    icon: Webhook,
  },
  {
    type: NodeType.INSTAGRAM_COMMENT_TRIGGER,
    label: "Instagram Comment",
    description:
      "Runs the flow when a comment is posted on your Instagram post",
    icon: "/logos/instagram.svg",
  },
  {
    type: NodeType.YOUTUBE_COMMENT_TRIGGER,
    label: "YouTube Comment",
    description: "Runs the flow when a comment is posted on your YouTube video",
    icon: "/logos/youtube.svg",
  },
  {
    type: NodeType.TELEGRAM_TRIGGER,
    label: "Telegram",
    description: "Runs the flow when your bot receives a message",
    icon: "/logos/telegram.svg",
  },
];

export const executionNodeOptions: NodeOption[] = [
  {
    type: NodeType.HTTP_REQUEST,
    label: "HTTP Request",
    description: "Makes an HTTP request",
    icon: GlobeIcon,
  },
  {
    type: NodeType.CONDITION,
    label: "Condition",
    description: "Branch to True or False based on a rule",
    icon: Filter,
  },
  {
    type: NodeType.SWITCH,
    label: "Switch",
    description: "Route to one of several branches by matching cases in order",
    icon: Split,
  },
  {
    type: NodeType.AI_TEXT,
    label: "AI",
    description: "Generate text with OpenAI, Anthropic, or Gemini",
    icon: BrainCircuit,
  },
  {
    type: NodeType.DISCORD,
    label: "Discord",
    description: "Send a message to Discord",
    icon: "/logos/discord.svg",
  },
  {
    type: NodeType.SLACK,
    label: "Send to Slack",
    description: "Send a message to one or more Slack channels",
    icon: "/logos/slack.svg",
  },
  {
    type: NodeType.NOTION_ACTION,
    label: "Notion",
    description: "Create a Notion page or append a row to a database",
    icon: "/logos/notion.svg",
  },
  {
    type: NodeType.TELEGRAM_ACTION,
    label: "Send Telegram",
    description: "Send a Telegram message with your bot",
    icon: "/logos/telegram.svg",
  },
  {
    type: NodeType.WHATSAPP_ACTION,
    label: "Send WhatsApp",
    description:
      "Send a WhatsApp message to one or more recipients via Meta Cloud API",
    icon: "/logos/whatsapp.svg",
  },
  {
    type: NodeType.GMAIL_ACTION,
    label: "Send Email",
    description: "Send an email via your connected Google account",
    icon: "/logos/gmail.svg",
  },
  {
    type: NodeType.GOOGLE_SHEETS_ACTION,
    label: "Google Sheets",
    description: "Append or read rows in a spreadsheet",
    icon: "/logos/google-sheets.svg",
  },
  {
    type: NodeType.INSTAGRAM_REPLY_COMMENT,
    label: "Instagram Reply",
    description: "Reply to an Instagram comment using your connected account",
    icon: "/logos/instagram.svg",
  },
  {
    type: NodeType.YOUTUBE_REPLY_COMMENT,
    label: "YouTube Reply",
    description: "Reply to a YouTube comment using your connected channel",
    icon: "/logos/youtube.svg",
  },
  {
    type: NodeType.AI_REPLY_GENERATOR,
    label: "AI Reply Generator",
    description:
      "Generate an AI reply to a comment using xAI, Gemini, OpenAI, or Groq",
    icon: "/logos/xai.svg",
  },
];

// Flat lookup by node type for components (e.g. the staging tray) that only
// know a type and need to render its icon/label.
export const nodeOptionByType: Partial<Record<NodeType, NodeOption>> =
  Object.fromEntries(
    [...triggerNodeOptions, ...executionNodeOptions].map((option) => [
      option.type,
      option,
    ]),
  );
