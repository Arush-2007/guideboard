import { describe, expect, it } from "vitest";
import { type ClampedMarker, clampJson } from "@/lib/clamp-json";
import {
  isSnapshotStorable,
  NODE_INPUT_SNAPSHOT_MAX_BYTES,
  planNodeInputSnapshots,
} from "./node-input-snapshot";

/** A clamp marker as `clampJson` produces one, at a chosen size. */
const marker = (bytes: number): ClampedMarker => ({
  __truncated: true,
  bytes,
  preview: "…",
});

describe("isSnapshotStorable", () => {
  it("stores an ordinary oversized input", () => {
    // The realistic case: past the 32 KB clamp, nowhere near the cap.
    expect(isSnapshotStorable(marker(53_600))).toBe(true);
  });

  it("stores right up to the cap, and not past it", () => {
    expect(isSnapshotStorable(marker(NODE_INPUT_SNAPSHOT_MAX_BYTES))).toBe(
      true,
    );
    expect(isSnapshotStorable(marker(NODE_INPUT_SNAPSHOT_MAX_BYTES + 1))).toBe(
      false,
    );
  });

  it("refuses an unserializable input, which clampJson reports as -1 bytes", () => {
    // A cycle or BigInt cannot be written as JSON here either, so it is not
    // storable at any size — not merely "small enough".
    expect(isSnapshotStorable(marker(-1))).toBe(false);
  });

  it("reads the size clampJson already measured, rather than re-measuring", () => {
    // The marker is the contract between the two: whatever clampJson put in
    // `bytes` is what the policy decides on. A real marker proves the field is
    // populated as assumed.
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const clamped = clampJson(big);
    expect(clamped).toMatchObject({ __truncated: true });
    expect((clamped as ClampedMarker).bytes).toBeGreaterThan(32_768);
    expect(isSnapshotStorable(clamped as ClampedMarker)).toBe(true);
  });
});

describe("planNodeInputSnapshots", () => {
  /**
   * Records as the recorder prepares them. `skipped: true` models what the
   * ENGINE now emits for a node that never ran: no `input` at all, which
   * therefore clamps to nothing rather than to a marker.
   */
  const prepared = (
    entries: { nodeId: string; bytes?: number; skipped?: boolean }[],
  ) =>
    entries.map((e) => ({
      record: {
        nodeId: e.nodeId,
        input: e.skipped ? undefined : { full: `context of ${e.nodeId}` },
      },
      clampedInput: e.skipped
        ? null
        : e.bytes === undefined
          ? { small: true }
          : marker(e.bytes),
    }));

  it("selects only the inputs that were actually clamped", () => {
    const rows = planNodeInputSnapshots(
      "exec_1",
      prepared([
        { nodeId: "a" }, // fit inline — nothing to store
        { nodeId: "b", bytes: 50_000 },
      ]),
    );

    expect(rows).toEqual([
      { executionId: "exec_1", nodeId: "b", input: { full: "context of b" } },
    ]);
  });

  it("stores the FULL input, not the clamped marker", () => {
    // The entire point: the marker is what the row already holds, and replaying
    // from it renders every reference blank while side effects still fire.
    const rows = planNodeInputSnapshots(
      "exec_1",
      prepared([{ nodeId: "a", bytes: 50_000 }]),
    );
    expect(rows[0].input).toEqual({ full: "context of a" });
  });

  it("stores nothing for a node that never ran", () => {
    // A SKIPPED record carries no `input` (see `NodeRecord.input`), so it
    // cannot clamp to a marker and cannot reach the snapshot table. There is
    // deliberately no status check in `planNodeInputSnapshots` — the policy is
    // stated once, in the engine, rather than re-tested here where the two
    // could drift.
    const rows = planNodeInputSnapshots(
      "exec_1",
      prepared([{ nodeId: "a", skipped: true }]),
    );
    expect(rows).toEqual([]);
  });

  it("skips inputs past the cap, leaving replay to refuse honestly", () => {
    const rows = planNodeInputSnapshots(
      "exec_1",
      prepared([
        { nodeId: "a", bytes: NODE_INPUT_SNAPSHOT_MAX_BYTES + 1 },
        { nodeId: "b", bytes: 40_000 },
      ]),
    );
    expect(rows.map((r) => r.nodeId)).toEqual(["b"]);
  });

  it("returns nothing when a flush has no oversized inputs", () => {
    expect(
      planNodeInputSnapshots("exec_1", prepared([{ nodeId: "a" }])),
    ).toEqual([]);
  });
});
