import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { type BlobHandle, isBlobConfigured, putBlob } from "@/lib/blob";
import {
  asFormat,
  detectFormat,
  FORMAT_META,
  type Format,
  legacyConversionToPair,
  resolveConversion,
} from "@/lib/conversions";
import { getTextConverter } from "@/lib/converters";
import { FileTooLargeError } from "@/lib/file-limits";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { logger } from "@/lib/logger";
import {
  createMediaJob,
  fetchMediaResult,
  isMediaConvertConfigured,
  type MediaSource,
} from "@/lib/media-convert";
import { fetchBytes, fetchResumeText, isDriveSource } from "@/lib/resume-fetch";
import { renderTemplate } from "@/lib/templating";

const COMPATIBILITY_ERROR = "Compatibility Issue - The input is not expected";

type ConvertData = {
  to?: string;
  from?: string;
  /** Legacy single-enum field; normalized to a (from, to) pair. */
  conversion?: string;
  input?: string;
};

type ConvertOutput = {
  /** Text/JSON for text conversions; the stored file's URL for binary ones. */
  result: unknown;
  /** The (detected or pinned) source format. */
  from: Format;
  /** The fixed target format. */
  to: Format;
  /** Present for binary conversions: the stored blob (URL + metadata). */
  file?: BlobHandle;
};

export const convertExecutor: NodeExecutor<ConvertData> = async ({
  data,
  nodeId,
  outputKey,
  executionId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    nodeStatusChannel(userId).status({ nodeId, status: "loading" }),
  );

  let config: ConvertData;
  try {
    config = parseNodeConfig(NodeType.CONVERT, data) as ConvertData;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const input = renderTemplate(config.input ?? "", context).trim();
  if (!input) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError("Convert: an input value is required");
  }

  // Resolve the target: new `to`, or a legacy `conversion` mapped to a pair.
  const legacy = legacyConversionToPair(config.conversion);
  const to = asFormat(config.to) ?? legacy?.to;
  if (!to) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError("Convert: a target format is required");
  }

  // Source is dynamic: a pinned `from`, else the legacy pair's source, else
  // auto-detected from the input. Track confidence — a pinned/legacy source is
  // trusted, an auto-detected one only when it's a real signal (not the generic
  // "unknown URL → pdf" fallback). Confidence gates the provider's input_format
  // hint on the binary path (below); it doesn't affect text engines.
  const pinned = asFormat(config.from) ?? legacy?.from;
  const detected = pinned ? undefined : detectFormat(input);
  const from = pinned ?? detected?.format;
  const fromConfident = pinned ? true : (detected?.confident ?? false);

  const descriptor = from ? resolveConversion(from, to) : undefined;
  if (!from || !descriptor) {
    // Raise in both ways: structured log (→ console always, → Sentry in prod via
    // the logger) AND a NonRetriableError that fails the run / surfaces in the UI.
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    logger.error(COMPATIBILITY_ERROR, new Error(COMPATIBILITY_ERROR), {
      nodeId,
      detectedFrom: from ?? "unknown",
      to,
    });
    throw new NonRetriableError(COMPATIBILITY_ERROR);
  }

  try {
    let result: unknown;
    let file: BlobHandle | undefined;

    switch (descriptor.engine) {
      case "text-fetch": {
        // Download the file and extract text. Private Google Drive files need
        // the user's Google token; public URLs don't.
        const accessToken = isDriveSource(input)
          ? await refreshGoogleTokenIfNeeded(userId).catch(() => undefined)
          : undefined;
        result = await step.run(`convert-${from}-to-${to}`, async () => {
          const { text } = await fetchResumeText(input, { accessToken });
          return text;
        });
        break;
      }
      case "text-sync": {
        const convert = getTextConverter(from, to);
        if (!convert) {
          // Matrix declared a text-sync pair with no handler — a wiring bug, not
          // a user error. Guarded by conversions.test.ts, but fail loudly.
          throw new NonRetriableError(
            `Convert: no handler registered for ${from} → ${to}`,
          );
        }
        result = await step.run(`convert-${from}-to-${to}`, async () =>
          convert(input),
        );
        break;
      }
      default: {
        // Binary output: transcode via the external provider and store the
        // bytes in blob storage, threading a handle (URL) through context — never
        // base64. Both dependencies are config, so a missing one is non-retriable.
        // Via the shared probe, not a bare truthiness check on the env var: an
        // unedited placeholder is non-empty and would otherwise be sent to the
        // provider as if it were a key.
        if (!isMediaConvertConfigured()) {
          throw new NonRetriableError(
            "Convert: CLOUDCONVERT_API_KEY is not set — cannot run binary conversions.",
          );
        }
        if (!isBlobConfigured()) {
          throw new NonRetriableError(
            "Convert: blob storage (R2) is not configured — cannot store binary output.",
          );
        }
        // Split across two Inngest steps so a retry of the expensive half
        // (poll + download + store) re-uses the same provider job instead of
        // creating a new (paid) one. Bytes never cross a step boundary — the
        // Drive download + upload happen entirely inside step A, which returns
        // only the small `{ jobId }`.
        //
        // Residual edge: if step A creates the job but its in-step byte upload
        // then fails, a retry recreates the job. Acceptable — the dominant cost
        // (the long poll + completed transcode) is what step B now protects.
        const { jobId } = await step.run(
          `convert-create-${from}-${to}`,
          async () => {
            // Private Drive sources can't be fetched by the provider, so
            // download the bytes ourselves (with the user's token) and upload
            // them; public URLs are handed to the provider directly.
            let source: MediaSource;
            if (isDriveSource(input)) {
              const accessToken = await refreshGoogleTokenIfNeeded(
                userId,
              ).catch(() => undefined);
              const { bytes } = await fetchBytes(input, { accessToken });
              source = {
                bytes,
                filename: `input.${FORMAT_META[from].ext ?? from}`,
              };
            } else {
              source = { url: input };
            }

            // Only hint the input format when it's trusted; otherwise let the
            // provider detect it from the actual file's bytes.
            return createMediaJob({
              from: fromConfident ? from : undefined,
              to,
              source,
            });
          },
        );

        file = await step.run(`convert-store-${from}-${to}`, async () => {
          const { bytes, contentType } = await fetchMediaResult(jobId, to);
          // Deterministic per (execution, node): a retried store overwrites its
          // own object instead of orphaning the previous attempt's upload, and
          // pruneOldExecutions can GC by `conversions/<userId>/<executionId>/`.
          return putBlob({
            bytes,
            contentType,
            key: `conversions/${userId}/${executionId}/${nodeId}.${FORMAT_META[to].ext ?? to}`,
          });
        });
        result = file.url;
        break;
      }
    }

    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
    );

    return {
      ...context,
      [outputKey]: { result, from, to, file } satisfies ConvertOutput,
    };
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    if (error instanceof NonRetriableError) throw error;
    // An oversized file is a user-fixable input problem on any engine —
    // retrying won't shrink it. Matched by name as well because an error
    // re-surfaced from a step.run keeps the name but not the class.
    if (
      error instanceof FileTooLargeError ||
      (error instanceof Error && error.name === "FileTooLargeError")
    ) {
      throw new NonRetriableError(error.message);
    }
    // Binary conversions hit the network/provider — those failures are
    // transient, so let Inngest retry. Text conversions are deterministic given
    // their input, so a failure won't improve on retry → mark non-retriable.
    if (descriptor.engine === "binary") {
      throw error instanceof Error ? error : new Error(String(error));
    }
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Conversion failed",
    );
  }
};
