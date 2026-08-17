import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import {
  CHECKPOINTED_NODE_TYPES,
  isTriggerNodeType,
  requiresCheckpoint,
  TOKEN_WEBHOOK_ROUTE_SEGMENTS,
  TOKEN_WEBHOOK_TRIGGER_TYPES,
  TRIGGER_NODE_TYPES,
  tokenWebhookPath,
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

describe("TOKEN_WEBHOOK_TRIGGER_TYPES", () => {
  // The registry with no compiler backstop, and the one whose drift already
  // shipped: a type listed with no route gets a credential nobody can use, and a
  // route shipped without listing its type gets no row, so it 404s every caller.
  // That second one is exactly how the Google Form trigger came to be dead in
  // production. Neither direction fails to compile, so it is checked here.

  const WEBHOOKS_DIR = path.join(
    process.cwd(),
    "src",
    "app",
    "api",
    "webhooks",
  );

  /** Every `/api/webhooks/<segment>/[token]/route.ts` that actually exists. */
  const routeSegmentsOnDisk = () =>
    readdirSync(WEBHOOKS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) =>
        existsSync(path.join(WEBHOOKS_DIR, name, "[token]", "route.ts")),
      );

  it("matches the token routes on disk exactly (drift in either direction)", () => {
    // Deliberately an equality, not two subset checks: a route without a listed
    // type and a listed type without a route are both failures, and reading it
    // as one assertion is what keeps the next author from adding just one side.
    expect(sorted(Object.values(TOKEN_WEBHOOK_ROUTE_SEGMENTS))).toEqual(
      sorted(routeSegmentsOnDisk()),
    );
  });

  it("finds the routes it claims exist", () => {
    // Guards the guard: if the directory layout moves, the check above would
    // compare two empty lists and pass while proving nothing.
    expect(routeSegmentsOnDisk().length).toBeGreaterThan(0);
  });

  it("lists only triggers", () => {
    for (const type of TOKEN_WEBHOOK_TRIGGER_TYPES) {
      expect(TRIGGER_NODE_TYPES.has(type)).toBe(true);
    }
  });

  it("gives each type its own segment", () => {
    // Two types sharing a segment would mean one route serving both, which the
    // per-nodeType token scoping exists to prevent.
    const segments = Object.values(TOKEN_WEBHOOK_ROUTE_SEGMENTS);
    expect(new Set(segments).size).toBe(segments.length);
  });

  it("builds the public path both dialogs show the user", () => {
    expect(tokenWebhookPath(NodeType.GOOGLE_FORM_TRIGGER, "tok_1")).toBe(
      "/api/webhooks/google-form/tok_1",
    );
    expect(tokenWebhookPath(NodeType.WEBHOOK_TRIGGER, "tok_2")).toBe(
      "/api/webhooks/generic/tok_2",
    );
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
