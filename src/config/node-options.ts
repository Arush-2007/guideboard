import {
  BrainCircuit,
  Building2,
  ClipboardCheck,
  Clock,
  FileText,
  Filter,
  GlobeIcon,
  type LucideIcon,
  MousePointerIcon,
  Replace,
  Search,
  Sparkles,
  Split,
  Webhook,
} from "lucide-react";
import { INTEGRATIONS } from "@/config/integrations";
import { NodeType } from "@/generated/prisma";

// Single source of truth for the user-facing metadata (label / description /
// icon) of each selectable node type. Consumed by the node selector, the
// staging tray, and the canvas node components (via getNodeOption) so they
// never drift. Brand icons come from the integrations registry; Lucide icons
// for utility nodes live here. Adding a new selectable node is a single edit
// here — keep it in sync with the executor/component/schema registries
// described in CLAUDE.md.
export type NodeOption = {
  type: NodeType;
  label: string;
  description: string;
  icon: LucideIcon | string;
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
    label: "Google Form Trigger",
    description: "Runs the flow when a Google Form is submitted",
    icon: INTEGRATIONS.googleForms.icon,
  },
  {
    type: NodeType.TYPEFORM_TRIGGER,
    label: "Typeform Trigger",
    description: "Runs the flow when a Typeform response is submitted",
    icon: INTEGRATIONS.typeform.icon,
  },
  {
    type: NodeType.GMAIL_TRIGGER,
    label: "Gmail Trigger",
    description: "Runs the flow when a new unread email is detected",
    icon: INTEGRATIONS.gmail.icon,
  },
  {
    type: NodeType.GOOGLE_SHEETS_TRIGGER,
    label: "Google Sheets Trigger",
    description: "Runs the flow when a new row is detected",
    icon: INTEGRATIONS.googleSheets.icon,
  },
  {
    type: NodeType.SCHEDULE_TRIGGER,
    label: "Schedule Trigger",
    description: "Runs the flow on a recurring schedule (hourly, daily, cron)",
    icon: Clock,
  },
  {
    type: NodeType.WEBHOOK_TRIGGER,
    label: "Webhook Trigger",
    description: "Runs the flow when its unique URL receives a POST request",
    icon: Webhook,
  },
  {
    type: NodeType.INSTAGRAM_COMMENT_TRIGGER,
    label: "Instagram Comment Trigger",
    description:
      "Runs the flow when a comment is posted on your Instagram post",
    icon: INTEGRATIONS.instagram.icon,
  },
  {
    type: NodeType.YOUTUBE_COMMENT_TRIGGER,
    label: "YouTube Comment Trigger",
    description: "Runs the flow when a comment is posted on your YouTube video",
    icon: INTEGRATIONS.youtube.icon,
  },
  {
    type: NodeType.TELEGRAM_TRIGGER,
    label: "Telegram Trigger",
    description: "Runs the flow when your bot receives a message",
    icon: INTEGRATIONS.telegram.icon,
  },
];

// Single source of truth for "is this node type a trigger?", derived from the
// options above so it can never drift from the selectable trigger list. Consumed
// by draw-time connection validation to reject edges that point into a trigger.
export const triggerNodeTypeSet: ReadonlySet<NodeType> = new Set(
  triggerNodeOptions.map((option) => option.type),
);

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
    type: NodeType.RECORD_LOOKUP,
    label: "Record Lookup",
    description:
      "Check if a value exists in a Google Sheet or Notion database — returns true/false",
    icon: Search,
  },
  {
    type: NodeType.AI_TEXT,
    label: "AI",
    description: "Generate text with OpenAI, Anthropic, or Gemini",
    icon: BrainCircuit,
  },
  {
    type: NodeType.CONVERT,
    label: "Convert",
    description:
      "Convert to a fixed target format (input auto-detected): text (PDF/HTML→text, CSV↔JSON, Markdown→HTML), images (JPG/PNG/WebP), PDF, and audio/video (MP4/MOV/MP3)",
    icon: Replace,
  },
  {
    type: NodeType.DISCORD,
    label: "Discord",
    description: "Send a message to Discord",
    icon: INTEGRATIONS.discord.icon,
  },
  {
    type: NodeType.SLACK,
    label: "Send to Slack",
    description: "Send a message to one or more Slack channels",
    icon: INTEGRATIONS.slack.icon,
  },
  {
    type: NodeType.NOTION_ACTION,
    label: "Notion",
    description: "Create a Notion page or append a row to a database",
    icon: INTEGRATIONS.notion.icon,
  },
  {
    type: NodeType.TELEGRAM_ACTION,
    label: "Send Telegram",
    description: "Send a Telegram message with your bot",
    icon: INTEGRATIONS.telegram.icon,
  },
  {
    type: NodeType.WHATSAPP_ACTION,
    label: "Send WhatsApp",
    description:
      "Send a WhatsApp message to one or more recipients via Meta Cloud API",
    icon: INTEGRATIONS.whatsapp.icon,
  },
  {
    type: NodeType.GMAIL_ACTION,
    label: "Send Email",
    description: "Send an email via your connected Google account",
    icon: INTEGRATIONS.gmail.icon,
  },
  {
    type: NodeType.GOOGLE_SHEETS_ACTION,
    label: "Google Sheets",
    description: "Append or read rows in a spreadsheet",
    icon: INTEGRATIONS.googleSheets.icon,
  },
  {
    type: NodeType.EXCEL_ACTION,
    label: "Microsoft Excel",
    description: "Append or upsert rows in an Excel workbook on OneDrive",
    icon: INTEGRATIONS.microsoftExcel.icon,
  },
  {
    type: NodeType.RESUME_PARSER,
    label: "Resume Parser",
    description:
      "Extract text and key fields from an applicant's resume (built-in or Affinda)",
    icon: FileText,
  },
  {
    type: NodeType.CANDIDATE_SCORING,
    label: "Candidate Scoring",
    description:
      "Score applicants with a rules scorecard or Affinda fit match, then route shortlist/review/reject",
    icon: ClipboardCheck,
  },
  {
    type: NodeType.ATS_ACTION,
    label: "ATS — Create Candidate",
    description: "Push a shortlisted candidate into your ATS (Lever)",
    icon: Building2,
  },
  {
    type: NodeType.INSTAGRAM_REPLY_COMMENT,
    label: "Instagram Reply",
    description: "Reply to an Instagram comment using your connected account",
    icon: INTEGRATIONS.instagram.icon,
  },
  {
    type: NodeType.YOUTUBE_REPLY_COMMENT,
    label: "YouTube Reply",
    description: "Reply to a YouTube comment using your connected channel",
    icon: INTEGRATIONS.youtube.icon,
  },
  {
    type: NodeType.AI_REPLY_GENERATOR,
    label: "AI Reply Generator",
    description:
      "Generate an AI reply to a comment using xAI, Gemini, OpenAI, or Groq",
    icon: Sparkles,
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

// Strict lookup for the canvas node components, which are only ever rendered
// for registered node types. Mirrors getExecutor in the executor registry.
export function getNodeOption(type: NodeType): NodeOption {
  const option = nodeOptionByType[type];
  if (!option) {
    throw new Error(`No node option registered for type: ${type}`);
  }
  return option;
}
