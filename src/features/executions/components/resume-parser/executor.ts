import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { CredentialType, NodeType } from "@/generated/prisma";
import { resumeParserChannel } from "@/inngest/channels/resume-parser";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { fetchResumeText } from "@/lib/resume-fetch";
import { extractResumeFields } from "@/lib/resume-fields";
import { renderTemplate } from "@/lib/templating";

type ResumeParserProvider = "builtin" | "affinda";

type ResumeParserData = {
  provider?: ResumeParserProvider;
  sourceUrl?: string;
  skillKeywords?: string;
  credentialId?: string;
  workspaceId?: string;
};

/** The normalized output every provider maps onto (see node-outputs.ts). */
type ResumeOutput = {
  resumeText: string;
  skills: string[];
  totalYearsExperience: number | null;
  emails: string[];
  phones: string[];
  links: string[];
  /** Affinda document id, so the scoring node can match on it. */
  affindaResumeId: string | null;
};

type AffindaResumeResponse = {
  data?: {
    rawText?: string;
    emails?: string[];
    phoneNumbers?: string[];
    websites?: string[];
    totalYearsExperience?: number;
    skills?: Array<{ name?: string }>;
  };
  meta?: { identifier?: string };
};

function isDriveUrl(url: string): boolean {
  return /drive\.google\.com|googleapis\.com\/drive/.test(url);
}

export const resumeParserExecutor: NodeExecutor<ResumeParserData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    resumeParserChannel(userId).status({ nodeId, status: "loading" }),
  );

  let config: ResumeParserData;
  try {
    config = parseNodeConfig(NodeType.RESUME_PARSER, data) as ResumeParserData;
  } catch (error) {
    await publish(
      resumeParserChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const provider: ResumeParserProvider = config.provider ?? "builtin";
  const sourceUrl = renderTemplate(config.sourceUrl ?? "", context).trim();
  if (!sourceUrl) {
    await publish(
      resumeParserChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError("Resume Parser: a resume URL is required");
  }

  try {
    let output: ResumeOutput;

    if (provider === "affinda") {
      const credential = await step.run("get-affinda-credential", () =>
        prisma.credential.findUnique({
          where: { id: config.credentialId, userId },
        }),
      );
      if (!credential || credential.type !== CredentialType.AFFINDA) {
        throw new NonRetriableError(
          "Resume Parser: Affinda credential not found or wrong type",
        );
      }
      const apiKey = decrypt(credential.value).trim();

      output = await step.run("affinda-parse-resume", async () => {
        const form = new FormData();
        form.append("url", sourceUrl);
        form.append("wait", "true");
        if (config.workspaceId?.trim())
          form.append("workspace", config.workspaceId.trim());

        const res = await ky
          .post("https://api.affinda.com/v2/resumes", {
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
            timeout: 60_000,
          })
          .json<AffindaResumeResponse>();

        const d = res.data ?? {};
        return {
          resumeText: d.rawText ?? "",
          skills: (d.skills ?? [])
            .map((s) => s.name?.trim())
            .filter((n): n is string => !!n),
          totalYearsExperience: d.totalYearsExperience ?? null,
          emails: d.emails ?? [],
          phones: d.phoneNumbers ?? [],
          links: d.websites ?? [],
          affindaResumeId: res.meta?.identifier ?? null,
        } satisfies ResumeOutput;
      });
    } else {
      // Built-in provider: download + extract text (free, runs today). Private
      // Google Drive files need the user's Google token; public URLs don't.
      const accessToken = isDriveUrl(sourceUrl)
        ? await refreshGoogleTokenIfNeeded(userId).catch(() => undefined)
        : undefined;

      output = await step.run("builtin-parse-resume", async () => {
        const { text } = await fetchResumeText(sourceUrl, { accessToken });
        const keywords = (config.skillKeywords ?? "")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        const fields = extractResumeFields(text, keywords);
        return {
          resumeText: text,
          skills: fields.matchedSkills,
          totalYearsExperience: null,
          emails: fields.emails,
          phones: fields.phones,
          links: fields.links,
          affindaResumeId: null,
        } satisfies ResumeOutput;
      });
    }

    await publish(
      resumeParserChannel(userId).status({ nodeId, status: "success" }),
    );

    return { ...context, [outputKey]: output };
  } catch (error) {
    await publish(
      resumeParserChannel(userId).status({ nodeId, status: "error" }),
    );
    if (error instanceof NonRetriableError) throw error;
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Resume parsing failed",
    );
  }
};
