import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import { isTriggerNodeType, TRIGGER_NODE_TYPES } from "./node-kinds";
import { triggerNodeOptions } from "./node-options";

const sorted = (values: Iterable<string>) => [...values].sort();

describe("TRIGGER_NODE_TYPES", () => {
  // This set decides what the ENGINE runs as a root. A trigger missing from it
  // is treated as an action, so it needs an incoming edge to run — which a
  // trigger can never have. It would silently never fire. These two tests make
  // that a failing build instead of a support ticket.

  it("matches the Prisma enum's trigger members exactly", () => {
    const enumTriggers = Object.values(NodeType).filter((type) =>
      type.endsWith("_TRIGGER"),
    );
    expect(sorted(TRIGGER_NODE_TYPES)).toEqual(sorted(enumTriggers));
  });

  it("matches the selectable trigger list exactly (drift in either direction)", () => {
    const optionTypes = triggerNodeOptions.map((option) => option.type);
    expect(sorted(TRIGGER_NODE_TYPES)).toEqual(sorted(optionTypes));
  });

  it("contains no actions", () => {
    expect(TRIGGER_NODE_TYPES.has(NodeType.SLACK)).toBe(false);
    expect(TRIGGER_NODE_TYPES.has(NodeType.AI_TEXT)).toBe(false);
    // INITIAL is a canvas placeholder, not a trigger — it must not be a root.
    expect(TRIGGER_NODE_TYPES.has(NodeType.INITIAL)).toBe(false);
  });
});

describe("isTriggerNodeType", () => {
  it("accepts a trigger and rejects an action", () => {
    expect(isTriggerNodeType(NodeType.MANUAL_TRIGGER)).toBe(true);
    expect(isTriggerNodeType(NodeType.SLACK)).toBe(false);
  });

  it("is safe on null/undefined/unknown types", () => {
    expect(isTriggerNodeType(null)).toBe(false);
    expect(isTriggerNodeType(undefined)).toBe(false);
    expect(isTriggerNodeType("NOT_A_REAL_TYPE")).toBe(false);
  });
});
