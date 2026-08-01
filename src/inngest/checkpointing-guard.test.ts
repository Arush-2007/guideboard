import { describe, expect, it } from "vitest";
import { inngest } from "./client";

/**
 * Inngest's `checkpointing` (a.k.a. `experimentalCheckpointing`) switches the
 * SDK from `StepMode.Async` to `StepMode.AsyncCheckpointing`, which resumes
 * steps in-process and keeps the handler running instead of abandoning it after
 * one callback.
 *
 * It looks like exactly the latency knob this codebase wants, and turning it on
 * would silently invalidate two designs that rest on the Async semantics:
 *
 *  - **Step batching.** `nodes:i-j` segments assume one step callback per
 *    invocation, so the engine can re-seed context and activations from a
 *    memoized return value.
 *  - **The node recorder.** Records are buffered and flushed inside step
 *    callbacks precisely because each callback runs exactly once. With many
 *    callbacks per invocation the flush points move, and the O(K²) write bug
 *    this replaced could come back in a different shape.
 *
 * Neither failure is loud. Both would look like "records are wrong sometimes".
 * A comment is too weak a guard for that, so this is a test: it fails at CI the
 * moment someone reaches for the flag, which is the only moment that matters.
 *
 * If you are here because this test failed: enabling checkpointing is a real
 * option, but re-verify `src/inngest/run-workflow.ts`'s segment handoff and
 * flush points against the new execution mode first.
 *
 * The selector reads four places (`InngestFunction.shouldAsyncCheckpoint`):
 * `checkpointing` and `experimentalCheckpointing`, on both the client options
 * and the per-function options.
 */
const CHECKPOINTING_KEYS = ["checkpointing", "experimentalCheckpointing"];

describe("Inngest checkpointing stays off", () => {
  it("is not enabled on the client", () => {
    const options = (
      inngest as unknown as { options?: Record<string, unknown> }
    ).options;

    // Anchor first. Both `options` and `opts` below are private fields read
    // through a cast, so a rename in the SDK would leave the loop iterating over
    // `undefined?.[key]` and passing for the wrong reason. Pinning a value we
    // KNOW is set turns that into a failure instead of false comfort.
    expect(
      options,
      "SDK renamed Inngest's private options field",
    ).toBeDefined();
    expect(options?.id).toBeDefined();

    for (const key of CHECKPOINTING_KEYS) {
      expect(options?.[key], `client option "${key}" must stay unset`).toBe(
        undefined,
      );
    }
  });

  it("is not enabled on executeWorkflow", async () => {
    // Imported lazily: functions.ts pulls in Prisma, blob storage and the email
    // client, none of which this assertion needs at module load.
    const { executeWorkflow } = await import("./functions");
    const opts = (
      executeWorkflow as unknown as { opts?: Record<string, unknown> }
    ).opts;

    expect(
      opts,
      "SDK renamed InngestFunction's private opts field",
    ).toBeDefined();
    expect(opts?.id).toBe("execute-workflow");

    for (const key of CHECKPOINTING_KEYS) {
      expect(
        opts?.[key],
        `executeWorkflow option "${key}" must stay unset`,
      ).toBe(undefined);
    }
  });
});
