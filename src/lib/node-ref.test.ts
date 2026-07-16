import { describe, expect, it } from "vitest";
import {
  applyNodeRename,
  clearRefsForRemovedNodes,
  collectNodeRefs,
  getOutputKeyForNode,
  legacyOutputKey,
  nextNodeRef,
  nodeTypeHasRef,
  readNodeRef,
  removeRefsInData,
  removeRefsInTemplate,
  renameRefInData,
  renameRefInTemplate,
  rewriteRefsInJson,
  stripRefFromData,
  toRefSlug,
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

describe("toRefSlug", () => {
  it("turns spaces into underscores and preserves case", () => {
    expect(toRefSlug("Summarize resume")).toBe("Summarize_resume");
  });

  it("collapses any run of non-alphanumerics (incl. dots, punctuation) to one _", () => {
    expect(toRefSlug("My Node!! (v2)")).toBe("My_Node_v2");
    expect(toRefSlug("a...b")).toBe("a_b");
  });

  it("trims leading/trailing underscores", () => {
    expect(toRefSlug("  hello  ")).toBe("hello");
    expect(toRefSlug("__weird__")).toBe("weird");
  });

  it("returns empty string for input with no usable characters", () => {
    expect(toRefSlug("")).toBe("");
    expect(toRefSlug("   ")).toBe("");
    expect(toRefSlug("!@#$%")).toBe("");
  });

  it("caps length and never leaves a trailing underscore after the cap", () => {
    const long = `${"a".repeat(47)} tail`;
    const slug = toRefSlug(long);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("_")).toBe(false);
  });
});

describe("renameRefInTemplate", () => {
  it("rewrites a whole-output and a field reference", () => {
    expect(renameRefInTemplate("@<AI_TEXT_1>@", "AI_TEXT_1", "Summary")).toBe(
      "@<Summary>@",
    );
    expect(
      renameRefInTemplate("@<AI_TEXT_1.output>@", "AI_TEXT_1", "Summary"),
    ).toBe("@<Summary.output>@");
  });

  it("matches by first segment, so AI_TEXT_1 never touches AI_TEXT_10", () => {
    const t = "@<AI_TEXT_1.output>@ and @<AI_TEXT_10.output>@";
    expect(renameRefInTemplate(t, "AI_TEXT_1", "Summary")).toBe(
      "@<Summary.output>@ and @<AI_TEXT_10.output>@",
    );
  });

  it("leaves other refs and plain text untouched", () => {
    const t = "hi @<SLACK_1.ts>@ @<AI_TEXT_1.output>@";
    expect(renameRefInTemplate(t, "AI_TEXT_1", "Summary")).toBe(
      "hi @<SLACK_1.ts>@ @<Summary.output>@",
    );
  });

  it("preserves a deep path verbatim", () => {
    expect(
      renameRefInTemplate("@<HTTP_1.httpResponse.body.id>@", "HTTP_1", "Api"),
    ).toBe("@<Api.httpResponse.body.id>@");
  });
});

describe("renameRefInData", () => {
  it("rewrites references wherever they sit in the blob (nested, arrays, mappings)", () => {
    const data = {
      message: "Result: @<AI_TEXT_1.output>@",
      mapping: { colA: "@<AI_TEXT_1.output>@", colB: "@<SLACK_1.ts>@" },
      list: ["@<AI_TEXT_1>@", "literal"],
    };
    const out = renameRefInData(data, "AI_TEXT_1", "Summary");
    expect(out.message).toBe("Result: @<Summary.output>@");
    expect(out.mapping).toEqual({
      colA: "@<Summary.output>@",
      colB: "@<SLACK_1.ts>@",
    });
    expect(out.list).toEqual(["@<Summary>@", "literal"]);
  });

  it("does not mutate the input and handles null/undefined", () => {
    const data = { message: "@<AI_TEXT_1.output>@" };
    renameRefInData(data, "AI_TEXT_1", "Summary");
    expect(data.message).toBe("@<AI_TEXT_1.output>@");
    expect(renameRefInData(null, "A", "B")).toEqual({});
    expect(renameRefInData(undefined, "A", "B")).toEqual({});
  });
});

describe("removeRefsInTemplate", () => {
  it("blanks a matching whole-output and field reference", () => {
    expect(removeRefsInTemplate("@<AI_TEXT_1>@", new Set(["AI_TEXT_1"]))).toBe(
      "",
    );
    expect(
      removeRefsInTemplate("x @<AI_TEXT_1.output>@ y", new Set(["AI_TEXT_1"])),
    ).toBe("x  y");
  });

  it("matches by first segment, so removing AI_TEXT_1 spares AI_TEXT_10", () => {
    expect(
      removeRefsInTemplate(
        "@<AI_TEXT_1.output>@|@<AI_TEXT_10.output>@",
        new Set(["AI_TEXT_1"]),
      ),
    ).toBe("|@<AI_TEXT_10.output>@");
  });

  it("removes any ref in the set (multi-delete) and leaves others", () => {
    expect(
      removeRefsInTemplate(
        "@<A_1.x>@ @<B_1.y>@ @<C_1.z>@",
        new Set(["A_1", "C_1"]),
      ),
    ).toBe(" @<B_1.y>@ ");
  });
});

describe("removeRefsInData", () => {
  it("blanks references wherever they sit in the blob", () => {
    const data = {
      message: "Out: @<AI_TEXT_1.output>@",
      mapping: { colA: "@<AI_TEXT_1.output>@", colB: "@<SLACK_1.ts>@" },
    };
    const out = removeRefsInData(data, new Set(["AI_TEXT_1"]));
    expect(out.message).toBe("Out: ");
    expect(out.mapping).toEqual({ colA: "", colB: "@<SLACK_1.ts>@" });
  });
});

describe("clearRefsForRemovedNodes", () => {
  it("strips references to removed nodes from the survivors", () => {
    const removed = [{ type: "AI_TEXT", data: { ref: "AI_TEXT_1" } }];
    const survivors = [
      {
        id: "b1",
        type: "SLACK",
        data: { ref: "SLACK_1", message: "Got @<AI_TEXT_1.output>@" },
      },
    ];
    const out = clearRefsForRemovedNodes(removed, survivors);
    expect(out[0].data).toEqual({ ref: "SLACK_1", message: "Got " });
  });

  it("returns the same array when the removed nodes had no refs (e.g. a trigger)", () => {
    const removed = [{ type: "TELEGRAM_TRIGGER", data: {} }];
    const survivors = [{ id: "b1", type: "SLACK", data: { ref: "SLACK_1" } }];
    expect(clearRefsForRemovedNodes(removed, survivors)).toBe(survivors);
  });

  it("does not mutate the survivors", () => {
    const removed = [{ type: "AI_TEXT", data: { ref: "AI_TEXT_1" } }];
    const survivors = [
      { id: "b1", type: "SLACK", data: { message: "@<AI_TEXT_1.output>@" } },
    ];
    clearRefsForRemovedNodes(removed, survivors);
    expect(survivors[0].data).toEqual({ message: "@<AI_TEXT_1.output>@" });
  });
});

describe("applyNodeRename", () => {
  // A producer (a1 -> AI_TEXT_1) referenced by a consumer (b1).
  const graph = () => [
    { id: "a1", type: "AI_TEXT", data: { ref: "AI_TEXT_1", prompt: "hi" } },
    {
      id: "b1",
      type: "SLACK",
      data: { ref: "SLACK_1", message: "Out: @<AI_TEXT_1.output>@" },
    },
  ];

  it("renames the target and rewrites the consumer's reference", () => {
    const { nodes, check } = applyNodeRename(graph(), "a1", "Summarize resume");

    expect(check).toEqual({ ok: true, slug: "Summarize_resume" });
    expect(nodes[0].data).toEqual({
      ref: "Summarize_resume",
      prompt: "hi",
    });
    expect(nodes[1].data).toEqual({
      ref: "SLACK_1",
      message: "Out: @<Summarize_resume.output>@",
    });
  });

  it("rejects a duplicate of another node's ref and leaves the graph untouched", () => {
    const input = graph();
    const { nodes, check } = applyNodeRename(input, "a1", "SLACK_1");

    expect(check).toEqual({ ok: false, reason: "duplicate" });
    expect(nodes).toBe(input);
  });

  it("names a node that had no ref (a trigger) without rewriting anything", () => {
    // Triggers carry no auto-assigned ref and their output is keyed by a fixed
    // name (`@<telegram.text>@`), so renaming one just sets its own name — there
    // is no old ref for any downstream token to have pointed at.
    const nodes = [
      { id: "t1", type: "TELEGRAM_TRIGGER", data: {} },
      {
        id: "b1",
        type: "SLACK",
        data: { ref: "SLACK_1", message: "Hi @<telegram.text>@" },
      },
    ];
    const { nodes: out, check } = applyNodeRename(
      nodes,
      "t1",
      "Customer message",
    );

    expect(check).toEqual({ ok: true, slug: "Customer_message" });
    expect(out[0].data).toEqual({ ref: "Customer_message" });
    // The consumer's fixed-key reference is untouched.
    expect(out[1].data).toEqual({
      ref: "SLACK_1",
      message: "Hi @<telegram.text>@",
    });
  });

  it("blocks naming a trigger the same as an existing node", () => {
    const nodes = [
      { id: "t1", type: "TELEGRAM_TRIGGER", data: {} },
      { id: "a1", type: "AI_TEXT", data: { ref: "AI_TEXT_1" } },
    ];
    const { check } = applyNodeRename(nodes, "t1", "AI_TEXT_1");
    expect(check).toEqual({ ok: false, reason: "duplicate" });
  });

  it("rejects an empty/all-punctuation name", () => {
    const input = graph();
    const { nodes, check } = applyNodeRename(input, "a1", "!!!");

    expect(check).toEqual({ ok: false, reason: "empty" });
    expect(nodes).toBe(input);
  });

  it("treats a rename to the same slug as unchanged (no-op)", () => {
    const input = graph();
    const { nodes, check } = applyNodeRename(input, "a1", "AI_TEXT_1");

    expect(check).toEqual({ ok: false, reason: "unchanged" });
    expect(nodes).toBe(input);
  });

  it("sanitizes then compares, so 'AI_TEXT 1' is unchanged not duplicate", () => {
    const input = graph();
    const { check } = applyNodeRename(input, "a1", "AI_TEXT 1");
    expect(check).toEqual({ ok: false, reason: "unchanged" });
  });

  it("does not mutate the input nodes", () => {
    const input = graph();
    applyNodeRename(input, "a1", "Renamed");
    expect(input[0].data).toEqual({ ref: "AI_TEXT_1", prompt: "hi" });
    expect(input[1].data).toEqual({
      ref: "SLACK_1",
      message: "Out: @<AI_TEXT_1.output>@",
    });
  });

  it("only rewrites the FIRST-segment match, never a same-prefixed sibling", () => {
    const nodes = [
      { id: "a1", type: "AI_TEXT", data: { ref: "AI_TEXT_1" } },
      { id: "a2", type: "AI_TEXT", data: { ref: "AI_TEXT_10" } },
      {
        id: "b1",
        type: "SLACK",
        data: { message: "@<AI_TEXT_1.output>@ @<AI_TEXT_10.output>@" },
      },
    ];
    const { nodes: out } = applyNodeRename(nodes, "a1", "Renamed");
    expect((out[2].data as { message: string }).message).toBe(
      "@<Renamed.output>@ @<AI_TEXT_10.output>@",
    );
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
