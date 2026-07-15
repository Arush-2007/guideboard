import { describe, expect, it } from "vitest";
import { unrunnableNodes } from "./connectivity";

// MANUAL_TRIGGER is in `triggerNodeTypeSet`; SLACK is not.
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

  it("flags an action left unfed when its incoming edge is deleted", () => {
    // The Instagram case: trigger -> ig -> slack, then ig->slack is removed.
    // Nothing feeds `slack`; `ig` still runs and just ends the flow.
    const nodes = [trigger("t"), action("ig"), action("slack")];
    const edges = [edge("t", "ig")];
    expect(flagged(nodes, edges)).toEqual(["slack"]);
  });

  it("flags ONLY the severed node, not the live chain hanging off it", () => {
    // trigger -> a -> b -> c, with trigger->a deleted. This pins the rule to the
    // engine: run-workflow.ts promotes a node with no incoming edges to a ROOT
    // ("roots (no incoming edges) always run"), and a node that runs activates
    // its outgoing edges — so a, b and c ALL still run. Only `a` is mis-wired.
    // Walking forward from triggers and flagging everything unreached would mark
    // b and c broken while they demonstrably run. Do not "fix" this into
    // trigger-reachability unless plans/bugs/engine-runs-disconnected-nodes.md
    // is fixed first.
    const nodes = [trigger("t"), action("a"), action("b"), action("c")];
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(flagged(nodes, edges)).toEqual(["a", "t"]);
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

  it("explains why each node is broken, describing wiring and never runtime", () => {
    const reasons = unrunnableNodes([trigger("t"), action("a")], []);
    expect(reasons.t).toMatch(/trigger isn't connected/i);
    expect(reasons.a).toMatch(/isn't wired into the flow/i);

    // The engine RUNS a node with no incoming edges (it becomes a root), so any
    // claim that it won't run is a lie to the user. See
    // plans/bugs/engine-runs-disconnected-nodes.md.
    for (const reason of Object.values(reasons)) {
      expect(reason).not.toMatch(/never run|won't run|will not run/i);
    }
  });
});
