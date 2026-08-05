import "server-only";
import { FORMAT_META, type Format } from "@/lib/conversions";
import { hasEnv, requireEnv } from "@/lib/env";
import { assertWithinTransferLimit } from "@/lib/file-limits";
import { rethrowTimeout, timeoutSignal } from "@/lib/http";

/**
 * Every CloudConvert call is bounded.
 *
 * These were raw `fetch`es with NO timeout at all — worse than a wrong timeout,
 * because a hung `fetch` holds the serverless invocation open until the PLATFORM
 * kills it, which surfaces as an opaque platform error rather than a node failure.
 *
 * All three are safe to repeat: CloudConvert jobs are addressed by id, the upload
 * is a presigned PUT-style overwrite, and the download is a read.
 */
const CLOUDCONVERT = {
  integration: "CloudConvert",
  timeoutClass: "MEDIA",
  idempotent: true,
  hint: "The file may be large, or CloudConvert may be busy right now.",
} as const;

/**
 * Binary/media conversions (images, PDF, audio, video) can't run in the
 * serverless executor — they need real transcoding compute — so they're
 * delegated to CloudConvert, a single external provider covering the whole
 * format matrix. This module is the one home for that integration, keyed by the
 * platform-owned `CLOUDCONVERT_API_KEY` (you hold the account and bill users —
 * same pattern as `ANTHROPIC_API_KEY`/`GEMINI_API_KEY`).
 *
 * Flow: create a job (import → convert → export) → optionally upload bytes for a
 * private source → poll until finished → download the produced file's bytes.
 * Storing the bytes (R2) is the caller's job via the shared `blob.ts` primitive,
 * keeping this module storage-agnostic and independently testable.
 *
 * Uses the global `fetch` (like `resume-fetch.ts`) so it runs in any runtime and
 * is trivial to mock in tests.
 */

const API_BASE = "https://api.cloudconvert.com/v2";
const POLL_INTERVAL_MS = 2500;
// ~3.3 min ceiling. Large media may need the webhook/callback model later; for
// now the whole job runs inside one Inngest step with bounded polling.
const MAX_POLL_ATTEMPTS = 80;

/** Where the input comes from: a public URL CloudConvert fetches, or raw bytes. */
export type MediaSource =
  | { url: string }
  | { bytes: Uint8Array; filename: string };

export type MediaConversionResult = {
  bytes: Uint8Array;
  contentType: string;
};

type CloudConvertForm = { url: string; parameters: Record<string, string> };
type CloudConvertFile = { filename: string; url: string };
type CloudConvertTask = {
  id: string;
  name: string;
  operation: string;
  status: "waiting" | "processing" | "finished" | "error" | string;
  message?: string;
  result?: { files?: CloudConvertFile[]; form?: CloudConvertForm };
};
type CloudConvertJob = {
  data: { id: string; status: string; tasks: CloudConvertTask[] };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getApiKey(): string {
  return requireEnv(
    process.env.CLOUDCONVERT_API_KEY,
    "CLOUDCONVERT_API_KEY",
    "CloudConvert",
  );
}

/**
 * Whether media conversions are available. Rejects the unedited
 * `your-cloudconvert-api-key` placeholder as well as an absent key, so an
 * untouched `.env` reports "not configured" instead of sending a fake key to
 * CloudConvert and surfacing whatever it answers with.
 */
export const isMediaConvertConfigured = (): boolean =>
  hasEnv(process.env.CLOUDCONVERT_API_KEY);

async function ccRequest<T>(
  path: string,
  apiKey: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    // After the spread: no caller may opt out of being bounded.
    signal: timeoutSignal("MEDIA"),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  }).catch(rethrowTimeout(CLOUDCONVERT));
  if (!res.ok) {
    throw new Error(
      `CloudConvert ${path} failed: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

/** Uploads bytes to a CloudConvert import/upload task's presigned form. */
async function uploadToForm(
  form: CloudConvertForm,
  source: { bytes: Uint8Array; filename: string },
): Promise<void> {
  const body = new FormData();
  for (const [key, value] of Object.entries(form.parameters)) {
    body.append(key, value);
  }
  // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the DOM lib's
  // stricter ArrayBuffer-vs-ArrayBufferLike generic on Blob parts.
  body.append("file", new Blob([source.bytes as BlobPart]), source.filename);

  const res = await fetch(form.url, {
    method: "POST",
    body,
    signal: timeoutSignal("MEDIA"),
  }).catch(rethrowTimeout(CLOUDCONVERT));
  // S3-style upload endpoints answer 201 (or 200/204) on success.
  if (!res.ok) {
    throw new Error(
      `CloudConvert upload failed: ${res.status} ${res.statusText}`,
    );
  }
}

/** Polls a job until it finishes, throwing on error / timeout. */
async function waitForJob(
  jobId: string,
  apiKey: string,
): Promise<CloudConvertJob["data"]> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const job = await ccRequest<CloudConvertJob>(`/jobs/${jobId}`, apiKey, {
      method: "GET",
    });
    if (job.data.status === "finished") return job.data;
    if (job.data.status === "error") {
      const failed = job.data.tasks.find((t) => t.status === "error");
      throw new Error(
        `CloudConvert job failed: ${failed?.message ?? "unknown error"}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("CloudConvert job timed out");
}

/**
 * Creates the CloudConvert job (import → convert → export) and, for a bytes
 * source, uploads the bytes to the provider — then returns just the small
 * `{ jobId }`. This is the FIRST half of a conversion, split out so the caller
 * (the executor) can checkpoint it in its own Inngest step: the expensive
 * poll+download (`fetchMediaResult`) can then fail and retry against the *same*
 * job instead of creating a new (paid) one each time.
 *
 * `from` is optional and only sets the convert task's `input_format` hint. Omit
 * it when the source format isn't reliably known — CloudConvert then infers the
 * format from the file's magic bytes, which is more trustworthy than a guess.
 *
 * Throws a plain `Error` on provider/network failure so the caller can treat
 * these as transient (retriable), unlike a config/compatibility error.
 */
export async function createMediaJob({
  from,
  to,
  source,
}: {
  from?: Format;
  to: Format;
  source: MediaSource;
}): Promise<{ jobId: string }> {
  const apiKey = getApiKey();

  const importTask =
    "url" in source
      ? { operation: "import/url", url: source.url }
      : { operation: "import/upload" };

  const created = await ccRequest<CloudConvertJob>("/jobs", apiKey, {
    method: "POST",
    body: JSON.stringify({
      tasks: {
        "import-file": importTask,
        "convert-file": {
          operation: "convert",
          input: "import-file",
          // Only hint the input format when we're confident; otherwise let
          // CloudConvert detect it from the actual file.
          ...(from ? { input_format: from } : {}),
          output_format: to,
        },
        "export-file": { operation: "export/url", input: "convert-file" },
      },
    }),
  });

  if (!("url" in source)) {
    const uploadForm = created.data.tasks.find((t) => t.name === "import-file")
      ?.result?.form;
    if (!uploadForm) {
      throw new Error("CloudConvert: upload form was not provided");
    }
    await uploadToForm(uploadForm, source);
  }

  return { jobId: created.data.id };
}

/**
 * The SECOND half of a conversion: waits for `jobId` to finish, then downloads
 * the produced file's bytes + content type. Idempotent w.r.t. the job — safe to
 * retry (it re-polls and re-downloads the same job), which is why the executor
 * runs it in its own Inngest step.
 */
export async function fetchMediaResult(
  jobId: string,
  to: Format,
): Promise<MediaConversionResult> {
  const apiKey = getApiKey();
  const finished = await waitForJob(jobId, apiKey);

  const file = finished.tasks
    .find((t) => t.operation === "export/url" && t.status === "finished")
    ?.result?.files?.find((f) => f.url);
  if (!file) {
    throw new Error("CloudConvert: no output file was produced");
  }

  const download = await fetch(file.url, {
    signal: timeoutSignal("MEDIA"),
  }).catch(rethrowTimeout(CLOUDCONVERT));
  if (!download.ok) {
    throw new Error(
      `CloudConvert: output download failed: ${download.status} ${download.statusText}`,
    );
  }

  // Size guard before AND after buffering (header can be absent or lie): the
  // whole output is held in memory on its way to R2, so an oversized transcode
  // must fail cleanly instead of OOMing the executor.
  const declared = download.headers.get("content-length");
  assertWithinTransferLimit(
    declared ? Number(declared) : null,
    "The converted file",
  );

  const bytes = new Uint8Array(await download.arrayBuffer());
  assertWithinTransferLimit(bytes.byteLength, "The converted file");

  return {
    bytes,
    contentType: FORMAT_META[to].mime ?? "application/octet-stream",
  };
}

/**
 * Runs one `from → to` conversion end-to-end. A thin wrapper composing
 * `createMediaJob` + `fetchMediaResult` for callers that don't checkpoint the
 * two halves separately (tests, one-shot use). The executor deliberately calls
 * the two halves directly so each lands in its own Inngest step.
 */
export async function convertMedia({
  from,
  to,
  source,
}: {
  from?: Format;
  to: Format;
  source: MediaSource;
}): Promise<MediaConversionResult> {
  const { jobId } = await createMediaJob({ from, to, source });
  return fetchMediaResult(jobId, to);
}
