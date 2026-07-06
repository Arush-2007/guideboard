import type { LucideIcon } from "lucide-react";
import { CredentialType } from "@/generated/prisma";

// Single source of truth for third-party brand metadata (user-facing label +
// icon). Consumed by node-options (picker + canvas nodes), the credentials
// pages, and the auth OAuth buttons so a brand's label/logo can never drift
// between surfaces. Icons are either a path under public/logos or a Lucide
// component.
export type IntegrationIcon = LucideIcon | string;

export const INTEGRATIONS = {
  affinda: { label: "Affinda", icon: "/logos/affinda.svg" },
  anthropic: { label: "Anthropic", icon: "/logos/anthropic.svg" },
  discord: { label: "Discord", icon: "/logos/discord.svg" },
  gemini: { label: "Gemini", icon: "/logos/gemini.svg" },
  github: { label: "GitHub", icon: "/logos/github.svg" },
  gmail: { label: "Gmail", icon: "/logos/gmail.svg" },
  google: { label: "Google", icon: "/logos/google.svg" },
  googleForms: { label: "Google Forms", icon: "/logos/googleform.svg" },
  googleSheets: { label: "Google Sheets", icon: "/logos/google-sheets.svg" },
  groq: { label: "Groq", icon: "/logos/groq.svg" },
  instagram: { label: "Instagram", icon: "/logos/instagram.svg" },
  lever: { label: "Lever", icon: "/logos/lever.svg" },
  microsoft: { label: "Microsoft", icon: "/logos/microsoft.svg" },
  microsoftExcel: { label: "Microsoft Excel", icon: "/logos/excel.svg" },
  notion: { label: "Notion", icon: "/logos/notion.svg" },
  openai: { label: "OpenAI", icon: "/logos/openai.svg" },
  slack: { label: "Slack", icon: "/logos/slack.svg" },
  telegram: { label: "Telegram", icon: "/logos/telegram.svg" },
  typeform: { label: "Typeform", icon: "/logos/typeform.svg" },
  whatsapp: { label: "WhatsApp", icon: "/logos/whatsapp.svg" },
  xai: { label: "xAI (Grok)", icon: "/logos/xai.svg" },
  youtube: { label: "YouTube", icon: "/logos/youtube.svg" },
} as const satisfies Record<string, { label: string; icon: IntegrationIcon }>;

export type IntegrationKey = keyof typeof INTEGRATIONS;

// Complete by construction: TypeScript rejects a new CredentialType until it
// gets a branding row here.
export const credentialTypeIntegrations: Record<CredentialType, IntegrationKey> =
  {
    [CredentialType.OPENAI]: "openai",
    [CredentialType.ANTHROPIC]: "anthropic",
    [CredentialType.GEMINI]: "gemini",
    [CredentialType.INSTAGRAM]: "instagram",
    [CredentialType.NOTION]: "notion",
    [CredentialType.TELEGRAM]: "telegram",
    [CredentialType.WHATSAPP]: "whatsapp",
    [CredentialType.XAI]: "xai",
    [CredentialType.GROQ]: "groq",
    [CredentialType.AFFINDA]: "affinda",
    [CredentialType.LEVER]: "lever",
    [CredentialType.TYPEFORM]: "typeform",
  };

export const getCredentialIntegration = (type: CredentialType) =>
  INTEGRATIONS[credentialTypeIntegrations[type]];
