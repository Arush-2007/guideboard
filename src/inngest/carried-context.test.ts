import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import {
  type PrunableNode,
  planDroppableKeys,
  pruneCarriedContext,
} from "./carried-context";

/** A node whose output key is its `ref`, which is what a template names. */
const node = (
  ref: string,
  data: unknown,
  type: NodeType = NodeType.SLACK,
): PrunableNode => ({ id: `id_${ref}`, ref, type, data });

describe("planDroppableKeys", () => {
  it("drops a node output nothing reachable references", () => {
    const fan = node("SHEETS_1", { action: "find_rows" });
    const unused = node("AI_TEXT_1", {});
    expect(planDroppableKeys([fan], [fan, unused])?.has("AI_TEXT_1")).toBe(
      true,
    );
  });

  it("keeps a node output a reachable node references", () => {
    const fan = node("SHEETS_1", { action: "find_rows" });
    const used = node("AI_TEXT_1", {});
    const child = node("POST_1", { message: "@<AI_TEXT_1.output>@" });
    expect(
      planDroppableKeys([fan, child], [fan, used, child])?.has("AI_TEXT_1"),
    ).toBe(false);
  });

  it("matches on the ROOT of a path, keeping the value whole", () => {
    const used = node("AI_TEXT_1", {});
    const child = node("POST_1", { x: "@<AI_TEXT_1.output.deep.0>@" });
    expect(planDroppableKeys([child], [used, child])?.has("AI_TEXT_1")).toBe(
      false,
    );
  });

  it("finds references nested in arrays and objects", () => {
    const a = node("TRIGGER_1", {});
    const b = node("CALC_2", {});
    const c = node("COND_3", {});
    const child = node("SHEETS_9", {
      columnMappings: [
        { column: "Name", value: "@<TRIGGER_1.name>@" },
        { column: "Total", value: "@<CALC_2.result>@" },
      ],
      conditions: { all: [{ left: "@<COND_3.value>@", right: "x" }] },
    });
    const drop = planDroppableKeys([child], [a, b, c, child]);
    expect(drop?.has("TRIGGER_1")).toBe(false);
    expect(drop?.has("CALC_2")).toBe(false);
    expect(drop?.has("COND_3")).toBe(false);
  });

  // ---- attribution: the hole a keep-list design had ------------------------

  it("never drops a key no node produces", () => {
    // REGRESSION. Webhook routes seed trigger payloads straight into the
    // context root (`commentId`, `commentText`, `commenterName`, `postId` —
    // api/webhooks/instagram/route.ts), and executors read some of them with
    // plain property access rather than a template: `context.commentText` in
    // ai-reply-generator, `context.commentId` in the Instagram/YouTube reply
    // nodes. None appear in any node config, so a scan of `@<>@` tokens cannot
    // see them. Only keys attributable to a node's OUTPUT are ever candidates,
    // which is what makes these safe without naming them one by one.
    const fan = node("SHEETS_1", { action: "find_rows" });
    const reply = node("REPLY_1", { message: "static" });
    const drop = planDroppableKeys([fan, reply], [fan, reply]);

    for (const key of [
      "commentId",
      "commentText",
      "commenterName",
      "postId",
      "aiReply",
      "telegram",
      "webhook",
    ]) {
      expect(drop?.has(key)).toBe(false);
    }
  });

  it("survives the real Instagram reply graph end to end", () => {
    const fan = node(
      "SHEETS_1",
      { action: "find_rows" },
      NodeType.GOOGLE_SHEETS_ACTION,
    );
    const gen = node(
      "AI_REPLY_1",
      { keyword: "price" },
      NodeType.AI_REPLY_GENERATOR,
    );
    const reply = node("IG_REPLY_1", {}, NodeType.INSTAGRAM_REPLY_COMMENT);

    const context = {
      commentId: "c1",
      commentText: "what is the price?",
      commenterName: "Ada",
      postId: "p1",
    };
    const pruned = pruneCarriedContext(
      context,
      planDroppableKeys([fan, gen, reply], [fan, gen, reply]),
    );

    // Every one survives. Otherwise the generator replies about "someone" and
    // the reply node throws "commentId is missing from workflow context".
    expect(pruned).toEqual(context);
  });

  // ---- the bail-outs -------------------------------------------------------

  it("drops NOTHING when a Code node is reachable", () => {
    // Pinned on NodeType.CODE by name, not via whatever predicate the pruner
    // happens to use. `hasEnumerableRefs` is deliberately a separate set from
    // the dangling-ref detector's `UNCHECKED_NODE_TYPES` (see
    // node-references.ts): teaching that detector to handle Code would remove
    // it from there, and a shared predicate would then let the pruner conclude
    // a program references nothing and hand every child an empty context. This
    // test is the backstop that turns that into a failure here instead.
    const unused = node("AI_TEXT_1", {});
    const code = node(
      "CODE_1",
      { code: "return input.ANYTHING;" },
      NodeType.CODE,
    );
    expect(planDroppableKeys([code], [unused, code])).toBeNull();
  });

  it("drops NOTHING when any config uses legacy {{handlebars}}", () => {
    const unused = node("AI_TEXT_1", {});
    const child = node("POST_1", { message: "Hello {{AI_TEXT_1.output}}" });
    expect(planDroppableKeys([child], [unused, child])).toBeNull();
  });

  it("finds handlebars nested as deeply as references are", () => {
    const child = node("POST_1", { rows: [{ m: { value: "{{json ctx}}" } }] });
    expect(planDroppableKeys([child], [child])).toBeNull();
  });

  it("does not bail on a lone brace, only on a handlebars opener", () => {
    const used = node("TRIGGER_1", {});
    const child = node("HTTP_1", { body: '{ "n": "@<TRIGGER_1.name>@" }' });
    const drop = planDroppableKeys([child], [used, child]);
    expect(drop).not.toBeNull();
    expect(drop?.has("TRIGGER_1")).toBe(false);
  });

  it("counts fields the node's current mode ignores", () => {
    // Over-keeping is the safe direction: a bug in `nodeInactiveFields` must
    // not be able to corrupt a run.
    const stale = node("STALE_1", {});
    const child = node("SHEETS_2", {
      action: "find_rows",
      columnMappings: [{ column: "C", value: "@<STALE_1.y>@" }],
    });
    expect(planDroppableKeys([child], [stale, child])?.has("STALE_1")).toBe(
      false,
    );
  });

  it("ignores references made by nodes outside the reachable set", () => {
    // A sibling branch never runs in a child, so its references must not keep a
    // value alive in every child's context.
    const unused = node("AI_TEXT_1", {});
    const fan = node("SHEETS_1", { action: "find_rows" });
    const sibling = node("OTHER_1", { message: "@<AI_TEXT_1.output>@" });
    expect(
      planDroppableKeys([fan], [unused, fan, sibling])?.has("AI_TEXT_1"),
    ).toBe(true);
  });

  it("falls back to the legacy <type>_<id> key when a node has no ref", () => {
    const legacy: PrunableNode = {
      id: "abc",
      ref: null,
      type: NodeType.AI_TEXT,
      data: {},
    };
    const fan = node("SHEETS_1", { action: "find_rows" });
    expect(planDroppableKeys([fan], [legacy, fan])?.has("ai_text_abc")).toBe(
      true,
    );
  });

  it("handles an empty graph and null-ish config without throwing", () => {
    expect(planDroppableKeys([], [])?.size).toBe(0);
    expect(planDroppableKeys([node("A_1", null)], [])?.size).toBe(0);
    expect(planDroppableKeys([node("A_1", undefined)], [])?.size).toBe(0);
  });
});

describe("pruneCarriedContext", () => {
  const context = {
    TRIGGER_1: { name: "Ada" },
    AI_TEXT_1: { output: "x".repeat(1000) },
    commentText: "hello",
  };

  it("removes exactly the droppable keys", () => {
    const pruned = pruneCarriedContext(context, new Set(["AI_TEXT_1"]));
    expect(Object.keys(pruned).sort()).toEqual(["TRIGGER_1", "commentText"]);
  });

  it("returns the context UNCHANGED for null", () => {
    // null means "could not prove", and must never be read as "drop all".
    expect(pruneCarriedContext(context, null)).toBe(context);
  });

  it("returns the context UNCHANGED for an empty drop-set", () => {
    // The fail-safe direction: an empty result carries everything, so a bug
    // that collects nothing degrades to no pruning rather than to data loss.
    expect(pruneCarriedContext(context, new Set())).toBe(context);
  });

  it("ignores droppable keys the context does not hold", () => {
    const pruned = pruneCarriedContext(context, new Set(["NOPE_1"]));
    expect(Object.keys(pruned).sort()).toEqual([
      "AI_TEXT_1",
      "TRIGGER_1",
      "commentText",
    ]);
  });

  it("preserves kept values by reference, not by copy", () => {
    const pruned = pruneCarriedContext(context, new Set(["AI_TEXT_1"]));
    expect(pruned.TRIGGER_1).toBe(context.TRIGGER_1);
  });
});

describe("prune round-trip", () => {
  it("drops a large unreferenced output and keeps everything else", () => {
    const context = {
      TRIGGER_1: { name: "Ada" },
      AI_TEXT_1: { output: "x".repeat(200_000) },
      commentText: "hi",
    };
    const fan = node("SHEETS_1", { action: "find_rows" });
    const unused = node("AI_TEXT_1", {});
    const trig = node("TRIGGER_1", {});
    const post = node("POST_1", { message: "Row for @<TRIGGER_1.name>@" });

    const pruned = pruneCarriedContext(
      context,
      planDroppableKeys([fan, post], [fan, unused, trig, post]),
    );

    expect(Object.keys(pruned).sort()).toEqual(["TRIGGER_1", "commentText"]);
    expect(JSON.stringify(pruned).length).toBeLessThan(200);
  });

  it("keeps that same output once a Code node appears downstream", () => {
    const context = {
      AI_TEXT_1: { output: "big" },
      TRIGGER_1: { name: "Ada" },
    };
    const fan = node("SHEETS_1", { action: "find_rows" });
    const unused = node("AI_TEXT_1", {});
    const code = node("CODE_1", { code: "return input;" }, NodeType.CODE);

    expect(
      pruneCarriedContext(
        context,
        planDroppableKeys([fan, code], [fan, unused, code]),
      ),
    ).toBe(context);
  });
});
