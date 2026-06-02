"use client";

import { createId } from "@paralleldrive/cuid2";
import { useReactFlow } from "@xyflow/react";
import {
  BrainCircuit,
  Filter,
  GlobeIcon,
  MousePointerIcon,
} from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { NodeType } from "@/generated/prisma";
import { Separator } from "./ui/separator";

export type NodeTypeOption = {
  type: NodeType;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }> | string;
};

const triggerNodes: NodeTypeOption[] = [
  {
    type: NodeType.MANUAL_TRIGGER,
    label: "Trigger manually",
    description: "Runs the flow on clicking a button. Good for getting started quickly",
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
    type: NodeType.INSTAGRAM_COMMENT_TRIGGER,
    label: "Instagram Comment",
    description: "Runs the flow when a comment is posted on your Instagram post",
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

const executionNodes: NodeTypeOption[] = [
  {
    type: NodeType.HTTP_REQUEST,
    label: "HTTP Request",
    description: "Makes an HTTP request",
    icon: GlobeIcon,
  },
  {
    type: NodeType.CONDITION,
    label: "Condition",
    description: "Continue only when a context field matches a rule",
    icon: Filter,
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
    label: "Slack",
    description: "Send a message to Slack",
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
    label: "Telegram",
    description: "Send a Telegram message with your bot",
    icon: "/logos/telegram.svg",
  },
  {
    type: NodeType.WHATSAPP_ACTION,
    label: "WhatsApp",
    description: "Send a WhatsApp message via Meta Cloud API",
    icon: "/logos/whatsapp.svg",
  },
  {
    type: NodeType.GMAIL_ACTION,
    label: "Gmail",
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
    description: "Generate an AI reply to a comment using xAI, Gemini, or OpenAI",
    icon: "/logos/xai.svg",
  },
];


interface NodeSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
};

export function NodeSelector({
  open,
  onOpenChange,
  children
}: NodeSelectorProps) {
  const { setNodes, getNodes, screenToFlowPosition } = useReactFlow();

  const handleNodeSelect = useCallback((selection: NodeTypeOption) => {
    // Check if trying to add a manual trigger when one already exists
    if (selection.type === NodeType.MANUAL_TRIGGER) {
      const nodes = getNodes();
      const hasManualTrigger = nodes.some(
        (node) => node.type === NodeType.MANUAL_TRIGGER,
      );

      if (hasManualTrigger) {
        toast.error("Only one manual trigger is allowed per workflow");
        return;
      }
    }

    setNodes((nodes) => {
      const hasInitialTrigger = nodes.some(
        (node) => node.type === NodeType.INITIAL,
      );

      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;

      const flowPosition = screenToFlowPosition({
        x: centerX + (Math.random() - 0.5) * 200,
        y: centerY + (Math.random() - 0.5) * 200,
      });

      const newNode = {
        id: createId(),
        data: {},
        position: flowPosition,
        type: selection.type,
      };

      if (hasInitialTrigger) {
        return [newNode];
      }

      return [...nodes, newNode];
    });

    onOpenChange(false);
  }, [
    setNodes,
    getNodes,
    onOpenChange,
    screenToFlowPosition,
  ]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            What triggers this workflow?
          </SheetTitle>
          <SheetDescription>
            A trigger is a step that starts your workflow.
          </SheetDescription>
        </SheetHeader>
        <div>
          {triggerNodes.map((nodeType) => {
            const Icon = nodeType.icon;

            return (
              <div
                key={nodeType.type}
                className="w-full justify-start h-auto py-5 px-4 rounded-none cursor-pointer border-l-2 border-transparent hover:border-l-primary"
                onClick={() => handleNodeSelect(nodeType)}
              >
                <div className="flex items-center gap-6 w-full overflow-hidden">
                  {typeof Icon === "string" ? (
                    <img
                      src={Icon}
                      alt={nodeType.label}
                      className="size-5 object-contain rounded-sm"
                    />
                  ) : (
                    <Icon className="size-5" />
                  )}
                  <div className="flex flex-col items-start text-left">
                    <span className="font-medium text-sm">
                      {nodeType.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {nodeType.description}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <Separator />
        <div>
          {executionNodes.map((nodeType) => {
            const Icon = nodeType.icon;

            return (
              <div
                key={nodeType.type}
                className="w-full justify-start h-auto py-5 px-4 rounded-none cursor-pointer border-l-2 border-transparent hover:border-l-primary"
                onClick={() => handleNodeSelect(nodeType)}
              >
                <div className="flex items-center gap-6 w-full overflow-hidden">
                  {typeof Icon === "string" ? (
                    <img
                      src={Icon}
                      alt={nodeType.label}
                      className="size-5 object-contain rounded-sm"
                    />
                  ) : (
                    <Icon className="size-5" />
                  )}
                  <div className="flex flex-col items-start text-left">
                    <span className="font-medium text-sm">
                      {nodeType.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {nodeType.description}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
};
