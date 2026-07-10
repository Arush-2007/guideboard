/**
 * Builds the Inngest idempotency key for an inbound Google-Form submission.
 *
 * Keying on the form's stable `responseId` (Google's per-response id) means a
 * retried or accidentally re-POSTed submission dedupes against the first
 * execution instead of spawning a duplicate run. When the `responseId` is
 * missing (e.g. a manual test post), we fall back to a per-call timestamp so
 * each call still gets a distinct key and is never dropped as a false
 * duplicate. Dedup itself is enforced downstream by `executeWorkflow`'s
 * `check-idempotency` step against `Execution.idempotencyKey`.
 */
export function googleFormIdempotencyKey(
  workflowId: string,
  responseId?: string | null,
): string {
  const id =
    typeof responseId === "string" && responseId.trim()
      ? responseId.trim()
      : Date.now().toString();
  return `google-form:${workflowId}:${id}`;
}
