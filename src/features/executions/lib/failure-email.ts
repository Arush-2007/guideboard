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
