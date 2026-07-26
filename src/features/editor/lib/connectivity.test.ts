import { describe, expect, it } from "vitest";
import { unrunnableNodes } from "./connectivity";

// MANUAL_TRIGGER is in TRIGGER_NODE_TYPES; SLACK is not.
const trigger = (id: string) => ({ id, type: "MANUAL_TRIGGER" });
const action = (id: string, type = "SLACK") => ({ id, type });
const edge = (source: string, target: string) => ({ source, target });

const flagged = (
  nodes: Parameters<typeof unrunnableNodes>[0],
  edges: Parameters<typeof unrunnableNodes>[1],
) => Object.keys(unrunnableNodes(nodes, edges)).sort();

describe("unrunnableNodes", () => {
  it("does NOT flag a legitimate terminal node (the regression that shipped)", () => {
    // trigger -> a -> b. `b` ends the workflow: it is wired, configured, and
    // simply has no downstream. It must stay clean, or every well-formed
    // workflow wears a permanent warning.
    const nodes = [trigger("t"), action("a"), action("b")];
    const edges = [edge("t", "a"), edge("a", "b")];
    expect(flagged(nodes, edges)).toEqual([]);
  });

  it("flags an action left unreachable when its incoming edge is deleted", () => {
    // The Instagram case: trigger -> ig -> slack, then ig->slack is removed.
    // `slack` can never run; `ig` still runs and just ends the flow.
    const nodes = [trigger("t"), action("ig"), action("slack")];
    const edges = [edge("t", "ig")];
    expect(flagged(nodes, edges)).toEqual(["slack"]);
  });

  it("flags the WHOLE chain severed from its trigger, not just the cut point", () => {
    // trigger -> a -> b -> c with trigger->a deleted. The engine roots only on
    // triggers, so a, b and c are ALL skipped — reachability must be transitive.
    // `t` is flagged too: it now drives nothing.
    const nodes = [trigger("t"), action("a"), action("b"), action("c")];
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(flagged(nodes, edges)).toEqual(["a", "b", "c", "t"]);
  });

  it("flags a trigger that drives nothing", () => {
    expect(flagged([trigger("t")], [])).toEqual(["t"]);
  });

  it("does not flag a trigger that has an outgoing edge", () => {
    const nodes = [trigger("t"), action("a")];
    expect(flagged(nodes, [edge("t", "a")])).toEqual([]);
  });

  it("flags every node in a fully unwired canvas", () => {
    expect(flagged([trigger("t"), action("a")], [])).toEqual(["a", "t"]);
  });

  it("treats a branching node as driving the flow if ANY output is wired", () => {
    const nodes = [trigger("t"), action("sw", "SWITCH"), action("x")];
    const edges = [edge("t", "sw"), edge("sw", "x")];
    expect(flagged(nodes, edges)).toEqual([]);
  });

  it("reaches through a diamond (merge node fed by two branches)", () => {
    const nodes = [
      trigger("t"),
      action("sw", "SWITCH"),
      action("yes"),
      action("no"),
      action("merge"),
    ];
    const edges = [
      edge("t", "sw"),
      edge("sw", "yes"),
      edge("sw", "no"),
      edge("yes", "merge"),
      edge("no", "merge"),
    ];
    expect(flagged(nodes, edges)).toEqual([]);
  });

  it("terminates on a cyclic graph instead of hanging", () => {
    // Draw-time validation rejects cycles, but a persisted/legacy graph could
    // still contain one — the visited set must stop the walk.
    const nodes = [trigger("t"), action("a"), action("b"), action("orphan")];
    const edges = [edge("t", "a"), edge("a", "b"), edge("b", "a")];
    expect(flagged(nodes, edges)).toEqual(["orphan"]);
  });

  it("excludes the INITIAL placeholder node", () => {
    expect(flagged([{ id: "i", type: "INITIAL" }], [])).toEqual([]);
  });

  it("ignores nodes with no type", () => {
    expect(flagged([{ id: "n", type: null }], [])).toEqual([]);
  });

  it("clears an action once it regains an incoming edge", () => {
    const nodes = [trigger("t"), action("a")];
    expect(flagged(nodes, [])).toContain("a");
    expect(flagged(nodes, [edge("t", "a")])).not.toContain("a");
  });

  it("explains why each node is broken", () => {
    // Distinguishes 'nothing feeds it' from 'fed, but by a dead upstream'.
    const reasons = unrunnableNodes(
      [trigger("t"), action("a"), action("b"), action("c")],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(reasons.t).toMatch(/trigger isn't connected/i);
    expect(reasons.a).toMatch(/nothing connects into this node/i);
    expect(reasons.b).toMatch(/can't be reached from a trigger/i);
    // Now that the engine skips unreachable nodes, this claim is literally true.
    expect(reasons.a).toMatch(/never run/i);
    expect(reasons.c).toMatch(/never run/i);
  });
});
