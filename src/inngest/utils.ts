import { createId } from "@paralleldrive/cuid2";
import type { WorkflowExecutionPayload } from "@/execution/payload";
import { inngest } from "./client";

/**
 * The event payload, which is `WorkflowExecutionPayload` plus the workflow it
 * targets. The fields and their reasoning live in `src/execution/payload.ts`,
 * declared once so this input and `WorkflowJob.payload` (which holds
 * `workflowId` in its own column) cannot drift as the shape grows.
 */
type SendWorkflowExecutionInput = WorkflowExecutionPayload & {
  workflowId: string;
};

/**
 * Callers pass a key naming the EXTERNAL EVENT only — `gmail:<messageId>`,
 * `youtube:<commentId>`, `google_sheets:<sheetId>:<row>:…` — never the
 * workflow. Two workflows watching the same inbox, sheet, chat or video
 * legitimately both handle the same event, and each should run.
 *
 * That is enforced by the `@@unique([workflowId, idempotencyKey])` constraint
 * on `Execution` (see the schema), which `executeWorkflow`'s `check-idempotency`
 * step reads through. Scoping lives in the constraint rather than in the key's
 * text so it is a fact the database holds, not a prefix convention every
 * producer has to apply and every reader has to strip.
 */
export const sendWorkflowExecution = async ({
  workflowId,
  initialData,
  initialDataBlobKey,
  initialDataSnapshot,
  idempotencyKey,
  replayFromNodeId,
  replayOfExecutionId,
  fanOutChain,
}: SendWorkflowExecutionInput) => {
  return inngest.send({
    name: "workflows/execute.workflow",
    data: {
      workflowId,
      initialData: initialData ?? {},
      initialDataBlobKey,
      initialDataSnapshot,
      idempotencyKey,
      replayFromNodeId,
      replayOfExecutionId,
      fanOutChain,
    },
    id: createId(),
  });
};
