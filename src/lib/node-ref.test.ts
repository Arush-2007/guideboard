import { describe, expect, it } from "vitest";
import {
  collectNodeRefs,
  getOutputKeyForNode,
  legacyOutputKey,
  nextNodeRef,
  nodeTypeHasRef,
  readNodeRef,
  rewriteRefsInJson,
  stripRefFromData,
  withAssignedRef,
} from "./node-ref";

describe("nextNodeRef", () => {
  it("always suffixes, starting at _1 for the first of a type", () => {
    expect(nextNodeRef("AI_TEXT", [])).toBe("AI_TEXT_1");
  });

  it("increments past the current max for that type, ignoring other types", () => {
    expect(nextNodeRef("AI_TEXT", ["AI_TEXT_1", "OPENAI_1", "AI_TEXT_2"])).toBe(
      "AI_TEXT_3",
    );
  });

  it("never reuses a number after a deletion gap (max + 1, not first free)", () => {
    // _1 deleted, only _2 remains -> next is _3, so refs never collide with a
    // previously-used number.
    expect(nextNodeRef("AI_TEXT", ["AI_TEXT_2"])).toBe("AI_TEXT_3");
  });

  it("ignores malformed/non-numeric suffixes", () => {
    expect(nextNodeRef("AI_TEXT", ["AI_TEXT_x", "AI_TEXT_1"])).toBe(
      "AI_TEXT_2",
    );
  });
});

describe("getOutputKeyForNode", () => {
  it("uses the ref when present", () => {
    expect(getOutputKeyForNode("AI_TEXT", "abc", "AI_TEXT_1")).toBe(
      "AI_TEXT_1",
    );
  });

  it("falls back to the legacy <type>_<id> key when ref is absent", () => {
    expect(getOutputKeyForNode("AI_TEXT", "abc", null)).toBe("ai_text_abc");
    expect(getOutputKeyForNode("AI_TEXT", "abc")).toBe("ai_text_abc");
  });
});

describe("nodeTypeHasRef", () => {
  it("is true for every non-trigger node (actions, AI, Condition, reply nodes)", () => {
    expect(nodeTypeHasRef("AI_TEXT")).toBe(true);
    expect(nodeTypeHasRef("GMAIL_ACTION")).toBe(true);
    expect(nodeTypeHasRef("CONDITION")).toBe(true);
    expect(nodeTypeHasRef("AI_REPLY_GENERATOR")).toBe(true);
    expect(nodeTypeHasRef("YOUTUBE_REPLY_COMMENT")).toBe(true);
  });

  it("is false for triggers and the INITIAL placeholder", () => {
    expect(nodeTypeHasRef("TELEGRAM_TRIGGER")).toBe(false);
    expect(nodeTypeHasRef("WEBHOOK_TRIGGER")).toBe(false);
    expect(nodeTypeHasRef("GMAIL_TRIGGER")).toBe(false);
    expect(nodeTypeHasRef("INITIAL")).toBe(false);
  });
});

describe("readNodeRef", () => {
  it("reads a ref out of the data blob", () => {
    expect(readNodeRef({ ref: "AI_TEXT_1", prompt: "hi" })).toBe("AI_TEXT_1");
  });

  it("returns null for absent, empty, or non-string refs", () => {
    expect(readNodeRef({})).toBeNull();
    expect(readNodeRef(null)).toBeNull();
    expect(readNodeRef(undefined)).toBeNull();
    expect(readNodeRef({ ref: "" })).toBeNull();
    expect(readNodeRef({ ref: 7 } as unknown as Record<string, unknown>)).toBe(
      null,
    );
  });
});

describe("collectNodeRefs", () => {
  it("gathers refs from data, skipping ref-less nodes", () => {
    const refs = collectNodeRefs([
      { type: "AI_TEXT", data: { ref: "AI_TEXT_1" } },
      { type: "TELEGRAM_TRIGGER", data: {} },
      { type: "SLACK", data: { ref: "SLACK_1" } },
    ]);
    expect([...refs].sort()).toEqual(["AI_TEXT_1", "SLACK_1"]);
  });
});

describe("withAssignedRef", () => {
  it("stamps the first node of a type as _1", () => {
    const node = withAssignedRef({ type: "AI_TEXT", data: {} }, new Set());
    expect(node.data).toEqual({ ref: "AI_TEXT_1" });
  });

  it("numbers a second node of the same type _2", () => {
    const used = collectNodeRefs([
      { type: "AI_TEXT", data: { ref: "AI_TEXT_1" } },
    ]);
    expect(withAssignedRef({ type: "AI_TEXT", data: {} }, used).data).toEqual({
      ref: "AI_TEXT_2",
    });
  });

  it("numbers each type independently", () => {
    const used = collectNodeRefs([
      { type: "AI_TEXT", data: { ref: "AI_TEXT_1" } },
    ]);
    expect(withAssignedRef({ type: "SLACK", data: {} }, used).data).toEqual({
      ref: "SLACK_1",
    });
  });

  it("leaves triggers and INITIAL untouched", () => {
    const trigger = { type: "TELEGRAM_TRIGGER", data: {} };
    expect(withAssignedRef(trigger, new Set())).toBe(trigger);
    const initial = { type: "INITIAL", data: {} };
    expect(withAssignedRef(initial, new Set())).toBe(initial);
  });

  it("preserves existing data alongside the ref", () => {
    const node = withAssignedRef(
      { type: "AI_TEXT", data: { prompt: "summarize" } },
      new Set(),
    );
    expect(node.data).toEqual({ prompt: "summarize", ref: "AI_TEXT_1" });
  });

  it("overwrites a copied ref rather than inheriting it (the duplicate case)", () => {
    // A duplicated node deep-copies `data`, ref included; the clone must claim
    // its own identity or two nodes answer to AI_TEXT_1.
    const used = collectNodeRefs([
      { type: "AI_TEXT", data: { ref: "AI_TEXT_1" } },
    ]);
    const clone = withAssignedRef(
      { type: "AI_TEXT", data: { ref: "AI_TEXT_1", prompt: "x" } },
      used,
    );
    expect(clone.data).toEqual({ ref: "AI_TEXT_2", prompt: "x" });
  });

  it("does not mutate the input node", () => {
    const original = { type: "AI_TEXT", data: {} };
    withAssignedRef(original, new Set());
    expect(original.data).toEqual({});
  });

  it("threads one set across a batch so siblings never collide", () => {
    const used = new Set<string>();
    const a = withAssignedRef({ type: "AI_TEXT", data: {} }, used);
    const b = withAssignedRef({ type: "AI_TEXT", data: {} }, used);
    const c = withAssignedRef({ type: "AI_TEXT", data: {} }, used);
    expect([a.data, b.data, c.data]).toEqual([
      { ref: "AI_TEXT_1" },
      { ref: "AI_TEXT_2" },
      { ref: "AI_TEXT_3" },
    ]);
  });
});

describe("stripRefFromData", () => {
  it("removes the canvas ref so the persisted blob never duplicates the column", () => {
    expect(stripRefFromData({ ref: "AI_TEXT_1", prompt: "hi" })).toEqual({
      prompt: "hi",
    });
  });

  it("is a no-op for data that has no ref", () => {
    expect(stripRefFromData({ prompt: "hi" })).toEqual({ prompt: "hi" });
  });

  it("returns an empty object for null/undefined data", () => {
    expect(stripRefFromData(null)).toEqual({});
    expect(stripRefFromData(undefined)).toEqual({});
  });

  it("does not mutate the input", () => {
    const data = { ref: "AI_TEXT_1", prompt: "hi" };
    stripRefFromData(data);
    expect(data).toEqual({ ref: "AI_TEXT_1", prompt: "hi" });
  });
});

describe("rewriteRefsInJson", () => {
  it("replaces legacy keys with refs across a serialized blob", () => {
    const map = new Map([
      [legacyOutputKey("AI_TEXT", "abc"), "AI_TEXT_1"],
      [legacyOutputKey("HTTP_REQUEST", "xyz"), "HTTP_REQUEST_1"],
    ]);
    const json = JSON.stringify({
      field: "@<ai_text_abc.output>@",
      url: "@<http_request_xyz.httpResponse.status>@",
    });
    const out = JSON.parse(rewriteRefsInJson(json, map));
    expect(out.field).toBe("@<AI_TEXT_1.output>@");
    expect(out.url).toBe("@<HTTP_REQUEST_1.httpResponse.status>@");
  });
});
