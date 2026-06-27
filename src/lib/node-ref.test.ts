import { describe, expect, it } from "vitest";
import {
  getOutputKeyForNode,
  legacyOutputKey,
  nextNodeRef,
  nodeTypeHasRef,
  rewriteRefsInJson,
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
  it("is true for per-node-output nodes and false for triggers/fixed-key nodes", () => {
    expect(nodeTypeHasRef("AI_TEXT")).toBe(true);
    expect(nodeTypeHasRef("GMAIL_ACTION")).toBe(true);
    expect(nodeTypeHasRef("TELEGRAM_TRIGGER")).toBe(false);
    expect(nodeTypeHasRef("CONDITION")).toBe(false);
    expect(nodeTypeHasRef("AI_REPLY_GENERATOR")).toBe(false);
  });
});

describe("rewriteRefsInJson", () => {
  it("replaces legacy keys with refs across a serialized blob", () => {
    const map = new Map([
      [legacyOutputKey("AI_TEXT", "abc"), "AI_TEXT_1"],
      [legacyOutputKey("HTTP_REQUEST", "xyz"), "HTTP_REQUEST_1"],
    ]);
    const json = JSON.stringify({
      field: "!#ai_text_abc.output#!",
      url: "!#http_request_xyz.httpResponse.status#!",
    });
    const out = JSON.parse(rewriteRefsInJson(json, map));
    expect(out.field).toBe("!#AI_TEXT_1.output#!");
    expect(out.url).toBe("!#HTTP_REQUEST_1.httpResponse.status#!");
  });
});
