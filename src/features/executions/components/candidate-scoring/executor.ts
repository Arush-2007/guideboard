import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { CompareOperator } from "@/features/executions/lib/compare";
import type { NodeExecutor } from "@/features/executions/types";
import { CredentialType, NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import {
  type ResolvedScoringRule,
  type ScoringDecision,
  scoreCandidate,
} from "@/lib/candidate-scoring";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import {
  carriesRetryDecision,
  HTTP_TIMEOUT,
  http,
  rethrowTimeout,
} from "@/lib/http";
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
  /** Affinda Search & Match index the resume is added to before matching. */
  indexName?: string;
  weights?: Record<string, number>;
};

const AFFINDA_BASE = "https://api.affinda.com";
const DEFAULT_AFFINDA_INDEX = "guideboard-resumes";

/** Best-effort read of a ky HTTPError body for branching on Affinda's message. */
async function errorBody(
  error: unknown,
): Promise<{ status?: number; text: string }> {
  const response = (error as { response?: Response })?.response;
  if (!response) return { text: "" };
  const text = await response.text().catch(() => "");
  return { status: response.status, text };
}

/**
 * Affinda's `resume_search/match` only scores resumes that live in a Search &
 * Match *index*. So before matching we make sure the parsed resume is in one:
 * try to add it; if the index doesn't exist yet, create it (docType `resumes`)
 * and retry; treat "already indexed" / "already exists" as success so reruns
 * and Inngest retries stay idempotent.
 */
async function ensureResumeIndexed(
  apiKey: string,
  indexName: string,
  resumeId: string,
): Promise<void> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const addDocument = () =>
    http
      .post(
        `${AFFINDA_BASE}/v2/index/${encodeURIComponent(indexName)}/documents`,
        {
          headers,
          json: { document: resumeId },
          timeout: HTTP_TIMEOUT.SLOW_API,
        },
      )
      .catch(
        rethrowTimeout({
          integration: "Affinda",
          timeoutClass: "SLOW_API",
          // Indexing the same document twice is a no-op on Affinda's side.
          idempotent: true,
          hint: "Affinda's index is slow right now.",
        }),
      );

  try {
    await addDocument();
    return;
  } catch (error) {
    const { status, text } = await errorBody(error);
    // Document already in the index — nothing to do.
    if (status === 400 && /already|exists|indexed/i.test(text)) return;
    // Index doesn't exist yet — create it, then retry adding the resume. Affinda
    // reports a missing index as a 400 `object_not_found` with attr "index"
    // (NOT a 404). Scope the match to that attr so a bad *resume* id (which is
    // also object_not_found, but attr "document") falls through and surfaces.
    const indexMissing =
      status === 404 ||
      (/object_not_found/i.test(text) && /"attr":\s*"index"/i.test(text));
    if (indexMissing) {
      try {
        await http
          .post(`${AFFINDA_BASE}/v2/index`, {
            headers,
            json: { name: indexName, docType: "resumes" },
            timeout: HTTP_TIMEOUT.SLOW_API,
          })
          .catch(
            rethrowTimeout({
              integration: "Affinda",
              timeoutClass: "SLOW_API",
              // Creating an index that exists is tolerated below as a create race.
              idempotent: true,
              hint: "Affinda is slow right now.",
            }),
          );
      } catch (createError) {
        // Tolerate a create race (another run made it first).
        const created = await errorBody(createError);
        if (!(created.status === 400 && /already|exists/i.test(created.text))) {
          throw createError;
        }
      }
      try {
        await addDocument();
      } catch (retryError) {
        const retry = await errorBody(retryError);
        if (
          !(retry.status === 400 && /already|exists|indexed/i.test(retry.text))
        ) {
          throw retryError;
        }
      }
      return;
    }
    throw error;
  }
}

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
    nodeStatusChannel(userId).status({ nodeId, status: "loading" }),
  );

  let config: CandidateScoringData;
  try {
    config = parseNodeConfig(
      NodeType.CANDIDATE_SCORING,
      data,
    ) as CandidateScoringData;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
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

      const indexName = config.indexName?.trim() || DEFAULT_AFFINDA_INDEX;

      // The match endpoint only scores resumes that live in a Search & Match
      // index, so add the parsed resume to one first (auto-creating it).
      await step.run("affinda-index-resume", () =>
        ensureResumeIndexed(apiKey, indexName, resumeId).then(() => null),
      );

      output = await step.run("affinda-match", async () => {
        const res = await http
          .get(`${AFFINDA_BASE}/v3/resume_search/match`, {
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
            // ML scoring is genuinely slow work on their side.
            timeout: HTTP_TIMEOUT.SLOW_API,
          })
          .json<AffindaMatchResponse>()
          .catch(
            rethrowTimeout({
              integration: "Affinda",
              timeoutClass: "SLOW_API",
              // Scoring is a pure read — re-running it returns the same score.
              idempotent: true,
              hint: "Affinda's scoring is slow right now.",
            }),
          );

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
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
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
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    // Pass through anything that ALREADY carries a retry decision (a classified
    // timeout, a 429 with Retry-After, a transient 5xx). Re-wrapping it below would
    // flatten it into "never retry" and turn a recoverable blip into a failed run.
    if (carriesRetryDecision(error)) throw error;
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Candidate scoring failed",
    );
  }
};
