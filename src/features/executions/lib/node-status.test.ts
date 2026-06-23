import { describe, expect, it } from "vitest";
import {
  deriveActiveChannels,
  reduceLatestStatuses,
  type StatusMessageLike,
} from "./node-status";

const channelOf = (type: string): string | undefined => {
  const map: Record<string, string> = {
    ANTHROPIC: "anthropic-execution",
    OPENAI: "openai-execution",
    SLACK: "slack-execution",
  };
  return map[type];
};

describe("deriveActiveChannels", () => {
  it("returns an empty list for no node types", () => {
    expect(deriveActiveChannels([], channelOf)).toEqual([]);
  });

  it("collapses duplicate node types into one channel", () => {
    expect(
      deriveActiveChannels(["ANTHROPIC", "ANTHROPIC", "ANTHROPIC"], channelOf),
    ).toEqual(["anthropic-execution"]);
  });

  it("returns distinct channels sorted for stable identity", () => {
    expect(
      deriveActiveChannels(["SLACK", "ANTHROPIC", "OPENAI"], channelOf),
    ).toEqual(["anthropic-execution", "openai-execution", "slack-execution"]);
  });

  it("excludes types with no channel (e.g. INITIAL) and null/undefined", () => {
    expect(
      deriveActiveChannels(
        ["ANTHROPIC", "INITIAL", null, undefined, "UNKNOWN"],
        channelOf,
      ),
    ).toEqual(["anthropic-execution"]);
  });

  it("is order-independent (same set -> same result)", () => {
    const a = deriveActiveChannels(["OPENAI", "ANTHROPIC"], channelOf);
    const b = deriveActiveChannels(["ANTHROPIC", "OPENAI"], channelOf);
    expect(a).toEqual(b);
  });
});

describe("reduceLatestStatuses", () => {
  const msg = (
    nodeId: string,
    status: string,
    createdAt: string,
    overrides: Partial<StatusMessageLike> = {},
  ): StatusMessageLike => ({
    kind: "data",
    topic: "status",
    channel: "anthropic-execution",
    createdAt,
    data: { nodeId, status },
    ...overrides,
  });

  it("returns an empty delta for no messages", () => {
    expect(reduceLatestStatuses([])).toEqual({});
  });

  it("maps a single message to nodeId -> status", () => {
    expect(
      reduceLatestStatuses([msg("n1", "loading", "2026-01-01T00:00:00Z")]),
    ).toEqual({ n1: "loading" });
  });

  it("keeps the latest status per nodeId by createdAt", () => {
    const result = reduceLatestStatuses([
      msg("n1", "loading", "2026-01-01T00:00:00Z"),
      msg("n1", "success", "2026-01-01T00:00:02Z"),
    ]);
    expect(result).toEqual({ n1: "success" });
  });

  it("picks latest even when messages arrive out of order", () => {
    const result = reduceLatestStatuses([
      msg("n1", "success", "2026-01-01T00:00:02Z"),
      msg("n1", "loading", "2026-01-01T00:00:00Z"),
    ]);
    expect(result).toEqual({ n1: "success" });
  });

  it("tracks multiple nodes independently", () => {
    const result = reduceLatestStatuses([
      msg("n1", "loading", "2026-01-01T00:00:00Z"),
      msg("n2", "error", "2026-01-01T00:00:01Z"),
    ]);
    expect(result).toEqual({ n1: "loading", n2: "error" });
  });

  it("ignores non-data and non-status messages", () => {
    const result = reduceLatestStatuses([
      msg("n1", "success", "2026-01-01T00:00:00Z"),
      {
        kind: "event",
        topic: "status",
        data: { nodeId: "n2", status: "error" },
      },
      msg("n3", "loading", "2026-01-01T00:00:00Z", { topic: "other" }),
    ]);
    expect(result).toEqual({ n1: "success" });
  });

  it("ignores malformed payloads (missing nodeId/status)", () => {
    const result = reduceLatestStatuses([
      { kind: "data", topic: "status", data: { status: "loading" } },
      { kind: "data", topic: "status", data: { nodeId: "n2" } },
      { kind: "data", topic: "status", data: null },
      msg("n3", "success", "2026-01-01T00:00:00Z"),
    ]);
    expect(result).toEqual({ n3: "success" });
  });
});
