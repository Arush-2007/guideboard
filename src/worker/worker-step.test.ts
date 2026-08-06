import { NonRetriableError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the step SEMANTICS: namespacing, the repeat counter, the JSON
 * round trip, input forwarding and the fence seam. Persistence itself is proven
 * against a real Postgres in `src/queue/step-store.integration.test.ts` — none
 * of the behaviour here depends on the database, and mocking it keeps these
 * tests able to run in the ordinary `npm test` pass.
 *
 * The fake store emulates the two properties of the real one that these tests
 * actually rely on: the FIRST write for a key wins, and the value a caller gets
 * back has been through JSON (Postgres does that with `jsonb`; here `JSON.parse`
 * of the same string the real store binds as a parameter does it).
 */

const { rows, loadStepResults, insertStepResultOrReadExisting } = vi.hoisted(
  () => {
    const rows = new Map<string, unknown>();
    return {
      rows,
      // A copy, as a real query would be — so a test can prove the map is
      // loaded once and then answered from memory.
      loadStepResults: vi.fn(async () => new Map(rows)),
      insertStepResultOrReadExisting: vi.fn(
        async ({ stepId, json }: { stepId: string; json: string }) => {
          if (!rows.has(stepId)) rows.set(stepId, JSON.parse(json));
          return rows.get(stepId);
        },
      ),
    };
  },
);

// Never construct a PrismaClient in a unit test. Matches the repo's convention
// (see ai-text/executor.test.ts).
vi.mock("@/lib/db", () => ({ default: {} }));

// Only the two database calls are replaced; `toStoredJson` stays REAL, because
// the serialization traps below are exactly what it exists to handle.
vi.mock("@/queue/step-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/queue/step-store")>()),
  loadStepResults,
  insertStepResultOrReadExisting,
}));

import { FencedError } from "./fenced-error";
import { createWorkerStep } from "./worker-step";

const EXECUTION_ID = "exec_1";

const newStep = (signal?: AbortSignal) =>
  createWorkerStep({ executionId: EXECUTION_ID, signal });

beforeEach(() => {
  rows.clear();
  vi.clearAllMocks();
});

describe("createWorkerStep — memoization", () => {
  it("runs a callback once and returns its value", async () => {
    const fn = vi.fn(async () => ({ ok: true }));
    const step = newStep().forNode("node_a");

    expect(await step.run("http-request", fn)).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns a stored value without executing the callback", async () => {
    // What a resumed run sees: the step completed in a previous attempt.
    rows.set("node_a:http-request", { ok: true, from: "the first attempt" });

    const fn = vi.fn(async () => ({ ok: false }));
    const result = await newStep().forNode("node_a").run("http-request", fn);

    expect(result).toEqual({ ok: true, from: "the first attempt" });
    // The entire point of the store: no second email, no duplicate row.
    expect(fn).not.toHaveBeenCalled();
  });

  it("treats a stored null as a hit, not a miss", async () => {
    // A callback that returned nothing stores JSON null. Looking that up with a
    // truthy check instead of `.has` would re-execute it on every resume.
    rows.set("node_a:notify", null);

    const fn = vi.fn(async () => "sent again");
    expect(await newStep().forNode("node_a").run("notify", fn)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("loads the run's stored steps exactly once, across root and nodes", async () => {
    const step = newStep();
    await step.forNode("node_a").run("a", async () => 1);
    await step.forNode("node_b").run("b", async () => 2);
    await step.run("nodes:0-1", async () => 3);

    // Per-step SELECTs are what this replaces; the pool margin it buys is what
    // keeps the heartbeat from being starved (parent plan §6.3 hazard 1).
    expect(loadStepResults).toHaveBeenCalledTimes(1);
  });

  it("retries the load after a rejection instead of replaying it", async () => {
    // A memoized FAILURE is not a memoized value. One connection blip on the
    // first load must not pin that rejected promise for the rest of the run —
    // an executor that catches a `step.run` failure and continues would then get
    // the same stale error for every remaining step, attributing the fault to
    // steps that never touched the database.
    loadStepResults.mockRejectedValueOnce(new Error("connection terminated"));

    const step = newStep();

    await expect(
      step.forNode("node_a").run("first", async () => 1),
    ).rejects.toThrow("connection terminated");

    // The next step re-issues the query and runs normally.
    const fn = vi.fn(async () => "recovered");
    expect(await step.forNode("node_b").run("second", fn)).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(loadStepResults).toHaveBeenCalledTimes(2);
  });
});

describe("createWorkerStep — step id namespacing", () => {
  it("does not collide on a shared literal across two nodes", async () => {
    // THE bug this key shape exists to prevent. `get-credential` is a literal in
    // four AI executors, so two AI nodes in one workflow hit it as ordinary
    // shape — and keyed on the bare id, node B would be served node A's value.
    const step = newStep();

    const a = await step
      .forNode("node_a")
      .run("get-credential", async () => "A");
    const b = await step
      .forNode("node_b")
      .run("get-credential", async () => "B");

    expect(a).toBe("A");
    expect(b).toBe("B");
    expect([...rows.keys()]).toEqual([
      "node_a:get-credential",
      "node_b:get-credential",
    ]);
  });

  it("suffixes repeats within one node, and only repeats", async () => {
    const step = newStep().forNode("node_a");

    expect(await step.run("convert", async () => 1)).toBe(1);
    expect(await step.run("convert", async () => 2)).toBe(2);
    expect(await step.run("convert", async () => 3)).toBe(3);

    expect([...rows.keys()]).toEqual([
      "node_a:convert",
      "node_a:convert#1",
      "node_a:convert#2",
    ]);
  });

  it("resets the repeat counter per node, not per run", async () => {
    const step = newStep();
    const a = step.forNode("node_a");
    await a.run("convert", async () => "a1");
    await a.run("convert", async () => "a2");
    await step.forNode("node_b").run("convert", async () => "b1");

    // node_b starts at the bare id. A counter shared across nodes (module scope,
    // say) would have numbered this `#2` and made node_b's key depend on how
    // many times an unrelated node ran.
    expect([...rows.keys()]).toEqual([
      "node_a:convert",
      "node_a:convert#1",
      "node_b:convert",
    ]);
  });

  it("keeps one counter per node however many handles are taken", async () => {
    // `forNode` is idempotent. If it minted a fresh scope per call, the counter
    // would reset to "first call" here, the second `convert` would resolve to
    // `node_a:convert`, and it would be served the FIRST call's stored value
    // instead of executing — the collision bug, reintroduced within one node.
    const step = newStep();
    expect(step.forNode("node_a")).toBe(step.forNode("node_a"));

    await step.forNode("node_a").run("convert", async () => "first");
    await step.forNode("node_a").run("convert", async () => "second");

    expect([...rows.keys()]).toEqual(["node_a:convert", "node_a:convert#1"]);
    expect(rows.get("node_a:convert#1")).toBe("second");
  });

  it("numbers repeats identically on a resume that executes nothing", async () => {
    // Determinism is what makes the counter safe: the id depends on call ORDER
    // within the node, which a replay reproduces because it re-runs the same
    // code in the same order.
    rows.set("node_a:convert", "first");
    rows.set("node_a:convert#1", "second");

    const fn = vi.fn(async () => "recomputed");
    const step = newStep().forNode("node_a");

    expect(await step.run("convert", fn)).toBe("first");
    expect(await step.run("convert", fn)).toBe("second");
    expect(fn).not.toHaveBeenCalled();
  });

  it("stores the engine's own segment ids unprefixed", async () => {
    // `nodes:0-4` is derived from topological position and is already unique
    // within a run, so the root adds nothing — these are the exact ids Inngest
    // stores today, which is what keeps the two runtimes comparable.
    await newStep().run("nodes:0-4", async () => "segment");

    expect([...rows.keys()]).toEqual(["nodes:0-4"]);
  });
});

describe("createWorkerStep — the JSON round trip", () => {
  it("returns a Date as an ISO string, on the FIRST execution", async () => {
    const iso = "2026-08-05T10:00:00.000Z";
    const result = await newStep()
      .forNode("node_a")
      .run("read-sheet", async () => ({ at: new Date(iso) }));

    // Inngest's `step.run` returns `Jsonify<T>`, so an executor never sees a
    // `Date`. Returning the raw value on a first run and a parsed one on resume
    // would be green in every test and wrong only in production, after a crash.
    expect(result).toEqual({ at: iso });
  });

  it("drops undefined properties, as JSON does", async () => {
    const result = await newStep()
      .forNode("node_a")
      .run("plan", async () => ({ row: 5, note: undefined }));

    expect(result).toEqual({ row: 5 });
    expect(Object.hasOwn(result as object, "note")).toBe(false);
  });

  it("stores and returns null for a callback that returns nothing", async () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string, and parsing that
    // throws `SyntaxError: "undefined" is not valid JSON`. A step callback that
    // returns nothing is completely normal, so this must not be an error path.
    const result = await newStep()
      .forNode("node_a")
      .run("side-effect-only", async () => {});

    expect(result).toBeNull();
    expect(rows.get("node_a:side-effect-only")).toBeNull();
  });

  it("fails legibly, naming the step, on a value JSON cannot carry", async () => {
    const step = newStep().forNode("node_a");

    // A raw `TypeError: Do not know how to serialize a BigInt` names neither the
    // step nor the node, and would surface as an unattributable engine crash.
    await expect(
      // `BigInt(1)` rather than a `1n` literal: tsconfig targets ES2017.
      step.run("count", async () => ({ total: BigInt(1) })),
    ).rejects.toThrow(
      /Step "node_a:count" returned a value that cannot be stored/,
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(step.run("loop", async () => circular)).rejects.toThrow(
      NonRetriableError,
    );
  });
});

describe("createWorkerStep — call shape", () => {
  it("forwards trailing input to the callback", async () => {
    // `createStepRun` persists trailing input, so dropping it would hand an
    // executor `undefined` for arguments it declared.
    const result = await newStep()
      .forNode("node_a")
      .run("join", async (a: string, b: string) => `${a}-${b}`, "x", "y");

    expect(result).toBe("x-y");
  });

  it("memoizes ai.wrap exactly as run, with the same namespacing", async () => {
    const fn = vi.fn(async (n: number) => ({ doubled: n * 2 }));

    expect(
      await newStep().forNode("node_ai").ai.wrap("anthropic", fn, 21),
    ).toEqual({ doubled: 42 });
    expect([...rows.keys()]).toEqual(["node_ai:anthropic"]);
    expect(fn).toHaveBeenCalledTimes(1);

    // A resumed run reaches the same step id and is served the stored result —
    // the property that stops a crash from paying for a second LLM call.
    const resumed = vi.fn(async (n: number) => ({ doubled: n * 2 }));
    expect(
      await newStep().forNode("node_ai").ai.wrap("anthropic", resumed, 99),
    ).toEqual({ doubled: 42 });
    expect(resumed).not.toHaveBeenCalled();
  });

  it("throws a legible error from ai.infer instead of not existing", async () => {
    // Implemented rather than omitted: the object is built behind a cast, so an
    // executor reaching for `infer` compiles cleanly and would otherwise hit
    // `undefined is not a function`.
    const infer = newStep().ai.infer as unknown as () => Promise<unknown>;

    await expect(infer()).rejects.toThrow(
      /not available on the self-hosted worker[\s\S]*step\.ai\.wrap/,
    );
  });

  it("exposes ai.models as empty descriptors", async () => {
    expect(newStep().ai.models).toEqual({});
  });
});

describe("createWorkerStep — the fence seam", () => {
  it("does not run a callback once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new FencedError("lease-stolen"));

    const fn = vi.fn(async () => "should never happen");
    const step = newStep(controller.signal).forNode("node_a");

    await expect(step.run("slack-webhook", fn)).rejects.toThrow(FencedError);
    // The whole point: a fenced worker performs no further side effect.
    expect(fn).not.toHaveBeenCalled();
    expect(insertStepResultOrReadExisting).not.toHaveBeenCalled();
  });

  it("aborts even on a step that would only have been read", async () => {
    // Checked at the top of every call, not just before a callback that will
    // execute — so a fenced worker cannot fast-forward through a resumed run's
    // memoized steps on a job it no longer owns.
    rows.set("node_a:http-request", { ok: true });

    const controller = new AbortController();
    controller.abort(new FencedError("lease-stolen"));

    await expect(
      newStep(controller.signal)
        .forNode("node_a")
        .run("http-request", async () => 1),
    ).rejects.toThrow(FencedError);
  });

  it("preserves the fence reason so the log line stays honest", async () => {
    const controller = new AbortController();
    controller.abort(new FencedError("job-row-gone"));

    await expect(
      newStep(controller.signal).run("nodes:0-1", async () => 1),
    ).rejects.toMatchObject({ name: "FencedError", reason: "job-row-gone" });
  });

  it("assumes a lost lease, and says so, when aborted without a reason", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      newStep(controller.signal)
        .forNode("node_a")
        .run("x", async () => 1),
    ).rejects.toThrow(/without a FencedError reason/);
  });

  it("is inert when no signal is supplied", async () => {
    // Nothing wires a lease until Step 5; the default path must be a no-op.
    expect(
      await newStep()
        .forNode("node_a")
        .run("x", async () => "ran"),
    ).toBe("ran");
  });

  it("is not a NonRetriableError", async () => {
    // Being fenced says nothing about whether the work is retriable — it says
    // this process is no longer the one doing it. Conflating the two would let a
    // lease handover masquerade as a permanent config failure.
    const controller = new AbortController();
    controller.abort(new FencedError("lease-stolen"));

    const err = await newStep(controller.signal)
      .forNode("node_a")
      .run("x", async () => 1)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FencedError);
    expect(err).not.toBeInstanceOf(NonRetriableError);
  });
});
