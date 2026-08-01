import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import {
  CHECKPOINTED_NODE_TYPES,
  isTriggerNodeType,
  requiresCheckpoint,
  TRIGGER_NODE_TYPES,
} from "./node-kinds";
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

describe("CHECKPOINTED_NODE_TYPES", () => {
  // This map decides which nodes may share one Inngest step. A wrong `true`
  // costs four seconds; a wrong `false` silently duplicates a side effect on
  // retry. The compiler enforces that every type is CLASSIFIED (it is a total
  // Record); these tests pin the classifications that are load-bearing.

  it("classifies every node type in the Prisma enum", () => {
    expect(sorted(Object.keys(CHECKPOINTED_NODE_TYPES))).toEqual(
      sorted(Object.values(NodeType)),
    );
  });

  it("treats every trigger as inline-safe", () => {
    // Triggers are passthroughs — the payload is already in `initialData`. If
    // one ever stops being a passthrough, this fails and forces the question.
    for (const type of TRIGGER_NODE_TYPES) {
      expect(requiresCheckpoint(type)).toBe(false);
    }
  });

  it("checkpoints every node that sends or creates something external", () => {
    // Each of these declares `idempotent: false` in its own rethrowTimeout call
    // — "a retry would send/post/create it a SECOND time". Inlining any of them
    // makes a segment retry do exactly that.
    const senders = [
      NodeType.GMAIL_ACTION,
      NodeType.SLACK,
      NodeType.DISCORD,
      NodeType.NOTION_ACTION,
      NodeType.TELEGRAM_ACTION,
      NodeType.WHATSAPP_ACTION,
      NodeType.INSTAGRAM_REPLY_COMMENT,
      NodeType.YOUTUBE_REPLY_COMMENT,
      NodeType.ATS_ACTION,
    ];
    for (const type of senders) {
      expect(requiresCheckpoint(type)).toBe(true);
    }
  });

  it("checkpoints the spreadsheet actions, whose plan/write split is load-bearing", () => {
    // NOT because the write isn't idempotent — it is, to an absolute range —
    // but because the row number comes from a memoized READ. Inline it and a
    // retry re-reads a sheet its own write already changed: append lands a
    // duplicate row, update can hit a different row entirely.
    expect(requiresCheckpoint(NodeType.GOOGLE_SHEETS_ACTION)).toBe(true);
    expect(requiresCheckpoint(NodeType.EXCEL_ACTION)).toBe(true);
  });

  it("checkpoints everything billed per call", () => {
    const billed = [
      NodeType.AI_TEXT,
      NodeType.OPENAI,
      NodeType.ANTHROPIC,
      NodeType.GEMINI,
      NodeType.AI_REPLY_GENERATOR,
      NodeType.CONVERT,
      NodeType.RESUME_PARSER,
    ];
    for (const type of billed) {
      expect(requiresCheckpoint(type)).toBe(true);
    }
  });

  it("inlines pure computation", () => {
    // No third-party call, no side effect — the whole point of batching.
    for (const type of [
      NodeType.CONDITION,
      NodeType.SWITCH,
      NodeType.CALCULATOR,
      NodeType.CODE,
    ]) {
      expect(requiresCheckpoint(type)).toBe(false);
    }
  });

  it("checkpoints nodes that are safe to repeat but too slow to share a step", () => {
    // Question 4. Both pass the correctness questions and fail the time one, so
    // "is re-running this safe?" is not sufficient grounds to inline anything.
    // RECORD_LOOKUP: a 30s READ behind a 10s token refresh. CANDIDATE_SCORING on
    // affinda: 45s to index plus 45s to match, one node exceeding the whole
    // step budget — and billed on top, so question 2 catches it as well.
    expect(requiresCheckpoint(NodeType.RECORD_LOOKUP)).toBe(true);
    expect(requiresCheckpoint(NodeType.CANDIDATE_SCORING)).toBe(true);
  });

  it("keeps every inline-safe node free of unbounded third-party calls", () => {
    // The invariant MAX_SEGMENT_NODES is derived from: the cap assumes the
    // slowest inline node is CODE at its 1s interrupt deadline. Classifying a
    // network-calling node as inline-safe silently invalidates that arithmetic,
    // so the allowlist is pinned here — a new `false` entry must be justified
    // against question 4 before this test will pass.
    const inlineSafe = Object.entries(CHECKPOINTED_NODE_TYPES)
      .filter(([, checkpointed]) => !checkpointed)
      .map(([type]) => type);

    expect(sorted(inlineSafe)).toEqual(
      sorted([
        ...TRIGGER_NODE_TYPES,
        NodeType.INITIAL,
        NodeType.CONDITION,
        NodeType.SWITCH,
        NodeType.CALCULATOR,
        NodeType.CODE,
      ]),
    );
  });

  it("fails closed on an unknown type", () => {
    // Reachable only via a non-NodeType string (bad data, a stale row). Guessing
    // "safe" there would batch a node nobody has classified.
    expect(requiresCheckpoint("NOT_A_REAL_TYPE" as NodeType)).toBe(true);
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
