import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { CredentialType, NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import {
  carriesRetryDecision,
  HTTP_TIMEOUT,
  http,
  rethrowTimeout,
} from "@/lib/http";
import { renderTemplate } from "@/lib/templating";

type AtsProvider = "lever";
type AtsEnvironment = "sandbox" | "production";

type AtsActionData = {
  provider?: AtsProvider;
  environment?: AtsEnvironment;
  credentialId?: string;
  performAsUserId?: string;
  name?: string;
  email?: string;
  resumeUrl?: string;
  note?: string;
  stageId?: string;
  postingId?: string;
};

type LeverCreateResponse = { data?: { id?: string } };

/** Provider → credential type. One entry per ATS; add Greenhouse here later. */
const providerToCredentialType: Record<AtsProvider, CredentialType> = {
  lever: CredentialType.LEVER,
};

function leverBaseUrl(env: AtsEnvironment): string {
  return env === "production"
    ? "https://api.lever.co/v1"
    : "https://api.sandbox.lever.co/v1";
}

export const atsActionExecutor: NodeExecutor<AtsActionData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    nodeStatusChannel(userId).status({ nodeId, status: "loading" }),
  );

  let config: AtsActionData;
  try {
    config = parseNodeConfig(NodeType.ATS_ACTION, data) as AtsActionData;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const provider: AtsProvider = config.provider ?? "lever";
  const environment: AtsEnvironment = config.environment ?? "sandbox";

  try {
    const credential = await step.run("get-ats-credential", () =>
      prisma.credential.findUnique({
        where: { id: config.credentialId, userId },
      }),
    );
    if (!credential || credential.type !== providerToCredentialType[provider]) {
      throw new NonRetriableError(
        "ATS node: credential not found or wrong type",
      );
    }
    const apiKey = decrypt(credential.value).trim();

    const name = renderTemplate(config.name ?? "", context).trim();
    const email = renderTemplate(config.email ?? "", context).trim();
    const resumeUrl = renderTemplate(config.resumeUrl ?? "", context).trim();
    const note = renderTemplate(config.note ?? "", context).trim();
    if (!name) {
      throw new NonRetriableError("ATS node: candidate name is required");
    }

    // Pure, cheap, side-effect-free — compute OUTSIDE the steps so each step
    // makes exactly ONE bounded call. With one 45s SLOW_API call per step, ky's
    // classified timeout always fires before a 60s platform kill, so no
    // whole-step retry can duplicate a non-idempotent write.
    // Lever: Basic auth with the API key as the username (empty password).
    const authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
    const base = leverBaseUrl(environment);
    const performAs = config.performAsUserId?.trim();
    if (!performAs) {
      throw new NonRetriableError(
        "ATS node (Lever): a 'perform as' user id is required",
      );
    }
    const hireBase =
      environment === "production"
        ? "https://hire.lever.co"
        : "https://hire.sandbox.lever.co";

    const body: Record<string, unknown> = {
      name,
      emails: email ? [email] : [],
      tags: ["guideboard"],
    };
    if (resumeUrl) body.links = [resumeUrl];
    if (config.stageId?.trim()) body.stage = config.stageId.trim();
    if (config.postingId?.trim()) body.postings = [config.postingId.trim()];

    // STEP 1 — create. ONE SLOW_API call, so ky's 45s timeout fires before any
    // 60s platform kill; no whole-step retry can duplicate the create.
    const result = await step.run("ats-create-opportunity", async () => {
      const created = await http
        .post(`${base}/opportunities`, {
          headers: { Authorization: authHeader },
          searchParams: { perform_as: performAs },
          json: body,
          timeout: HTTP_TIMEOUT.SLOW_API,
        })
        .json<LeverCreateResponse>()
        .catch(
          rethrowTimeout({
            integration: "Lever",
            timeoutClass: "SLOW_API",
            // A retry would create a SECOND opportunity for the same candidate.
            idempotent: false,
            hint: "The candidate may already have been created in Lever — check before re-running.",
          }),
        );

      const opportunityId = created.data?.id ?? null;
      return {
        opportunityId,
        url: opportunityId ? `${hireBase}/candidates/${opportunityId}` : null,
      };
    });

    // STEP 2 — note in its OWN step. The create above is memoized, so a note
    // retry never re-creates the opportunity.
    if (result.opportunityId && note) {
      await step.run("ats-add-note", async () => {
        await http
          .post(`${base}/opportunities/${result.opportunityId}/notes`, {
            headers: { Authorization: authHeader },
            searchParams: { perform_as: performAs },
            json: { value: note },
            timeout: HTTP_TIMEOUT.SLOW_API,
          })
          .catch(
            rethrowTimeout({
              integration: "Lever",
              timeoutClass: "SLOW_API",
              // A retry would add the note a SECOND time.
              idempotent: false,
              hint: "The note may already have been added — check the opportunity before re-running.",
            }),
          );
        return null;
      });
    }

    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
    );
    return { ...context, [outputKey]: result };
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    // Pass through anything that ALREADY carries a retry decision (a classified
    // timeout, a 429 with Retry-After, a transient 5xx). Re-wrapping it below would
    // flatten it into "never retry" and turn a recoverable blip into a failed run.
    if (carriesRetryDecision(error)) throw error;
    throw new NonRetriableError(
      error instanceof Error ? error.message : "ATS sync failed",
    );
  }
};
