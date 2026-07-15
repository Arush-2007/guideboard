import { beforeEach, describe, expect, it, vi } from "vitest";

// record-lookup's Google Sheets path reads via `readSheetTable` (ky.get.json).
const { kyGetMock } = vi.hoisted(() => ({ kyGetMock: vi.fn() }));
// HTTP goes through the shared client in `http.ts` (`ky.create(...)`), so the mock
// must answer `create` with the same fake instance.
vi.mock("ky", () => {
  const instance = { get: kyGetMock, post: vi.fn() };
  return {
    default: { ...instance, create: () => instance },
    TimeoutError: class TimeoutError extends Error {},
  };
});

const { refreshTokenMock } = vi.hoisted(() => ({ refreshTokenMock: vi.fn() }));
vi.mock("@/lib/google-token", () => ({
  refreshGoogleTokenIfNeeded: refreshTokenMock,
}));

vi.mock("@/inngest/channels/node-status", () => ({
  nodeStatusChannel: () => ({ status: (payload: unknown) => payload }),
}));

import type { NodeExecutorParams } from "@/features/executions/types";
import { recordLookupExecutor } from "./executor";

const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
} as unknown as NodeExecutorParams["step"];
const publish = (async () => {}) as unknown as NodeExecutorParams["publish"];

function mockRead(values: unknown[][]) {
  kyGetMock.mockReturnValue({ json: async () => ({ values }) });
}

type LookupOut = Record<
  string,
  { exists: boolean; matchCount: number; matched: unknown }
>;

const run = (data: Record<string, unknown>) =>
  recordLookupExecutor({
    data,
    nodeId: "n1",
    outputKey: "RECORD_LOOKUP_1",
    userId: "u1",
    context: {},
    step,
    publish,
  } as unknown as NodeExecutorParams) as Promise<LookupOut>;

beforeEach(() => {
  vi.clearAllMocks();
  refreshTokenMock.mockResolvedValue("token-123");
});

describe("recordLookupExecutor — Google Sheets (readSheetTable migration)", () => {
  it("finds a case-insensitive match and returns the header-keyed row", async () => {
    mockRead([
      ["Email", "Name"],
      ["a@x.com", "Ada"],
      ["b@x.com", "Bo"],
    ]);

    const out = (
      await run({
        source: "google_sheets",
        spreadsheetId: "s",
        sheetName: "Sheet1",
        column: "Email",
        value: "A@X.com",
      })
    ).RECORD_LOOKUP_1;

    expect(out).toEqual({
      exists: true,
      matchCount: 1,
      matched: { Email: "a@x.com", Name: "Ada" },
    });
  });

  it("counts every match", async () => {
    mockRead([["Buyer"], ["Acme"], ["acme"], ["Globex"]]);

    const out = (
      await run({
        source: "google_sheets",
        spreadsheetId: "s",
        sheetName: "Sheet1",
        column: "Buyer",
        value: "acme",
      })
    ).RECORD_LOOKUP_1;

    expect(out.exists).toBe(true);
    expect(out.matchCount).toBe(2);
  });

  it("returns not-found when the value is absent", async () => {
    mockRead([["Email"], ["a@x.com"]]);

    const out = (
      await run({
        source: "google_sheets",
        spreadsheetId: "s",
        sheetName: "S",
        column: "Email",
        value: "z@x.com",
      })
    ).RECORD_LOOKUP_1;

    expect(out).toEqual({ exists: false, matchCount: 0, matched: null });
  });

  it("returns not-found when the column doesn't exist", async () => {
    mockRead([["Name"], ["Ada"]]);

    const out = (
      await run({
        source: "google_sheets",
        spreadsheetId: "s",
        sheetName: "S",
        column: "Email",
        value: "a@x.com",
      })
    ).RECORD_LOOKUP_1;

    expect(out).toEqual({ exists: false, matchCount: 0, matched: null });
  });
});
