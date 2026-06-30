import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { CompareOperator } from "@/features/executions/lib/compare";
import type { NodeExecutor } from "@/features/executions/types";
import { CredentialType, NodeType } from "@/generated/prisma";
import { candidateScoringChannel } from "@/inngest/channels/candidate-scoring";
import {
  type ResolvedScoringRule,
  type ScoringDecision,
  scoreCandidate,
} from "@/lib/candidate-scoring";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { renderTemplate } from "@/lib/templating";

type ScoringProvider = "rules" | "affinda";

type ScoringRuleConfig = {
  id?: string;
  label?: string;
  field: string;
  operator: CompareOperator;
  value?: string;
  points: number;
  required?: boolean;
};

type CandidateScoringData = {
  provider?: ScoringProvider;
  shortlistThreshold?: number;
  reviewThreshold?: number;
  rules?: ScoringRuleConfig[];
  // affinda
  credentialId?: string;
  jobDescriptionId?: string;
  resumeId?: string;
  weights?: Record<string, number>;
};

type AffindaMatchResponse = {
  score?: number;
  details?: Record<string, { label?: string; value?: string; score?: number }>;
};

type ScoringOutput = {
  score: number;
  decision: ScoringDecision;
  reasons: string[];
};

export const candidateScoringExecutor: NodeExecutor<
  CandidateScoringData
> = async ({ data, nodeId, outputKey, userId, context, step, publish }) => {
  await publish(
    candidateScoringChannel(userId).status({ nodeId, status: "loading" }),
  );

  let config: CandidateScoringData;
  try {
    config = parseNodeConfig(
      NodeType.CANDIDATE_SCORING,
      data,
    ) as CandidateScoringData;
  } catch (error) {
    await publish(
      candidateScoringChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const provider: ScoringProvider = config.provider ?? "rules";
  const thresholds = {
    shortlist: config.shortlistThreshold ?? 60,
    review: config.reviewThreshold ?? 35,
  };

  try {
    let output: ScoringOutput;

    if (provider === "affinda") {
      const credential = await step.run("get-affinda-credential", () =>
        prisma.credential.findUnique({
          where: { id: config.credentialId, userId },
        }),
      );
      if (!credential || credential.type !== CredentialType.AFFINDA) {
        throw new NonRetriableError(
          "Candidate Scoring: Affinda credential not found or wrong type",
        );
      }
      const apiKey = decrypt(credential.value).trim();
      const resumeId = renderTemplate(config.resumeId ?? "", context).trim();
      const jobDescriptionId = renderTemplate(
        config.jobDescriptionId ?? "",
        context,
      ).trim();
      if (!resumeId || !jobDescriptionId) {
        throw new NonRetriableError(
          "Candidate Scoring: Affinda needs a resume id and a job description id",
        );
      }

      output = await step.run("affinda-match", async () => {
        const res = await ky
          .get("https://api.affinda.com/v3/resume_search/match", {
            headers: { Authorization: `Bearer ${apiKey}` },
            searchParams: {
              resume: resumeId,
              job_description: jobDescriptionId,
              ...Object.fromEntries(
                Object.entries(config.weights ?? {}).map(([k, v]) => [
                  k,
                  String(v),
                ]),
              ),
            },
            timeout: 60_000,
          })
          .json<AffindaMatchResponse>();

        const score = Math.round((res.score ?? 0) * 100);
        const reasons = Object.values(res.details ?? {})
          .filter((d) => typeof d.score === "number")
          .map(
            (d) =>
              `${d.label ?? "Category"}: ${Math.round((d.score ?? 0) * 100)}%`,
          );
        const decision: ScoringDecision =
          score >= thresholds.shortlist
            ? "SHORTLIST"
            : score >= thresholds.review
              ? "REVIEW"
              : "REJECT";
        return {
          score,
          decision,
          reasons: [`Affinda match ${score}% → ${decision}.`, ...reasons],
        };
      });
    } else {
      // Built-in rules: template each rule's field/value against context, then
      // run the pure scorecard core (unit-tested in candidate-scoring.test.ts).
      output = await step.run("rules-score", async () => {
        const resolved: ResolvedScoringRule[] = (config.rules ?? []).map(
          (rule) => ({
            id: rule.id,
            label: rule.label,
            operator: rule.operator,
            value: renderTemplate(rule.value ?? "", context),
            points: Number(rule.points) || 0,
            required: rule.required,
            fieldValue: renderTemplate(rule.field ?? "", context),
          }),
        );
        return scoreCandidate(resolved, thresholds);
      });
    }

    await publish(
      candidateScoringChannel(userId).status({ nodeId, status: "success" }),
    );

    return {
      ...context,
      [outputKey]: {
        score: output.score,
        decision: output.decision,
        reasons: output.reasons,
      },
    };
  } catch (error) {
    await publish(
      candidateScoringChannel(userId).status({ nodeId, status: "error" }),
    );
    if (error instanceof NonRetriableError) throw error;
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Candidate scoring failed",
    );
  }
};
