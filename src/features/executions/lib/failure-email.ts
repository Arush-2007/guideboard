/**
 * Builds the subject/html/text for the "your workflow run failed" alert sent
 * from `executeWorkflow.onFailure`. Kept separate from the Inngest handler so
 * the handler stays thin and this is unit-testable.
 *
 * `failedNode` is optional: failures that happen before any node runs (e.g. a
 * cyclic workflow caught by `topologicalSort`, or the create-execution step
 * itself) produce no NodeExecution rows, so the copy degrades to "before any
 * node ran" rather than naming a node.
 */

interface FailureEmailArgs {
  workflowName: string;
  executionId: string;
  error: string;
  failedNode?: { name: string; type: string };
  /** Absolute origin, e.g. process.env.BETTER_AUTH_URL. */
  appUrl?: string;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The error text a failed run should actually show.
 *
 * When a node throws, the engine records it FAILED — with its message, stack and
 * input — before the throw propagates, so there is always per-node detail to
 * open. `recordedNodes === 0` therefore means the run never reached that path:
 * the platform ended the invocation (execution-time ceiling, out of memory), or
 * it failed before the first node (a cyclic graph, a workflow that would not
 * load).
 *
 * Those runs otherwise present as a failure with an empty node list and an error
 * like "function timed out" — technically true, and useless. This says the cause
 * is unknown and WHY it is unknown, so the absence of detail reads as
 * information rather than as a missing feature.
 *
 * Shared by the Execution row and the alert email deliberately: the email is
 * often the only thing anyone reads.
 */
export function resolveFailureCause(
  recordedNodes: number,
  platformError: string,
): string {
  if (recordedNodes > 0) return platformError;
  return (
    "Node failed: cause unknown — the run stopped before any node could record " +
    "what it was doing, so there is no per-node detail. This is usually the " +
    "platform ending the run (time limit or out of memory) rather than a node " +
    "erroring; a workflow that cannot be loaded or contains a cycle also lands " +
    `here. Underlying error: ${platformError}`
  );
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function buildFailureEmail({
  workflowName,
  executionId,
  error,
  failedNode,
  appUrl,
}: FailureEmailArgs): BuiltEmail {
  const where = failedNode
    ? `at the "${failedNode.name}" (${failedNode.type}) node`
    : "before any node ran";

  const subject = failedNode
    ? `Workflow "${workflowName}" failed at ${failedNode.name}`
    : `Workflow "${workflowName}" failed`;

  const link = appUrl
    ? `${appUrl.replace(/\/$/, "")}/executions/${executionId}`
    : undefined;

  const text = [
    `Your workflow "${workflowName}" failed ${where}.`,
    "",
    `Error: ${error}`,
    "",
    link ? `View the run: ${link}` : `Execution ID: ${executionId}`,
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.5; color: #111;">
      <h2 style="margin: 0 0 12px;">Workflow run failed</h2>
      <p style="margin: 0 0 8px;">
        Your workflow <strong>${escapeHtml(workflowName)}</strong> failed ${escapeHtml(where)}.
      </p>
      <p style="margin: 0 0 16px;">
        <span style="color: #b91c1c; font-family: ui-monospace, monospace; white-space: pre-wrap;">${escapeHtml(error)}</span>
      </p>
      ${
        link
          ? `<p style="margin: 0;"><a href="${escapeHtml(link)}" style="color: #2563eb;">View the run</a></p>`
          : `<p style="margin: 0; color: #6b7280;">Execution ID: ${escapeHtml(executionId)}</p>`
      }
    </div>
  `.trim();

  return { subject, html, text };
}
