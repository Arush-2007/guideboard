import { beforeEach, describe, expect, it, vi } from "vitest";

// The async context the realtime middleware consults. Controlled per test so we
// can model "in the handler body" vs "already inside a step" vs "no function
// context at all" without an Inngest runtime.
let ctx: { execution?: { executingStep?: { id: string } } } | undefined;
let getAsyncCtxImpl: () => Promise<typeof ctx> = async () => ctx;

vi.mock("inngest/experimental", () => ({
  getAsyncCtx: () => getAsyncCtxImpl(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn() },
}));

const { directPublish } = await import("./direct-publish");

/** A publish that records whether `executingStep` was set while it ran. */
const spyPublish = () => {
  const sawFlag: boolean[] = [];
  const fn = vi.fn(async () => {
    sawFlag.push(Boolean(ctx?.execution?.executingStep));
    return undefined;
  });
  return { fn: fn as never, sawFlag };
};

beforeEach(() => {
  ctx = { execution: {} };
  getAsyncCtxImpl = async () => ctx;
});

describe("directPublish", () => {
  it("marks the call as in-step so the middleware doesn't wrap it", async () => {
    // The whole point: @inngest/realtime turns a publish into its own durable
    // `step.run("publish:<channel>")` unless it can see it is inside a step. On
    // Inngest Cloud that is seconds of dispatch latency for a UI ping — measured
    // at two such steps per checkpointed node before this existed.
    const { fn, sawFlag } = spyPublish();

    await directPublish(fn)({ channel: "c", topic: "t", data: {} } as never);

    expect(sawFlag).toEqual([true]);
  });

  it("leaves the context exactly as it found it", async () => {
    // Leaking the flag would make the SDK treat the rest of the handler body as
    // one long step.
    const { fn } = spyPublish();

    await directPublish(fn)({ channel: "c", topic: "t", data: {} } as never);

    expect(ctx?.execution?.executingStep).toBeUndefined();
  });

  it("does not disturb a publish that is already inside a step", async () => {
    // An inline node runs inside its segment's step.run, where the flag is
    // already set and publishes are free. Clearing it afterwards would tell the
    // SDK the segment had ended.
    const own = { id: "segment-step" };
    ctx = { execution: { executingStep: own } };
    const { fn, sawFlag } = spyPublish();

    await directPublish(fn)({ channel: "c", topic: "t", data: {} } as never);

    expect(sawFlag).toEqual([true]);
    expect(ctx.execution?.executingStep).toBe(own);
  });

  it("still publishes when there is no function context", async () => {
    // Unit tests drive the engine with a shimmed publish and no Inngest runtime.
    ctx = undefined;
    const { fn } = spyPublish();

    await directPublish(fn)({ channel: "c", topic: "t", data: {} } as never);

    expect(fn).toHaveBeenCalledOnce();
  });

  it("survives getAsyncCtx throwing", async () => {
    getAsyncCtxImpl = async () => {
      throw new Error("no ALS");
    };
    const { fn } = spyPublish();

    await expect(
      directPublish(fn)({ channel: "c", topic: "t", data: {} } as never),
    ).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("never lets a failed status ping fail the node", async () => {
    // Losing the step wrapper also lost its retry. A blip on the realtime API
    // must not throw into the executor — the node keeps running and the canvas
    // just misses a frame.
    const fn = vi.fn(async () => {
      throw new Error("realtime unavailable");
    });

    await expect(
      directPublish(fn as never)({
        channel: "c",
        topic: "t",
        data: {},
      } as never),
    ).resolves.toBeUndefined();
  });

  it("clears the flag even when the publish throws", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });

    await directPublish(fn as never)({
      channel: "c",
      topic: "t",
      data: {},
    } as never);

    expect(ctx?.execution?.executingStep).toBeUndefined();
  });
});
