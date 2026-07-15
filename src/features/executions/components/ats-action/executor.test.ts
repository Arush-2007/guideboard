import { NonRetriableError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake ky. Only POST is exercised (create opportunity + add note); create() must
// return the same instance so the shared client in http.ts sees these mocks.
const { kyPostMock } = vi.hoisted(() => ({ kyPostMock: vi.fn() }));
vi.mock("ky", () => {
  const instance = { post: kyPostMock };
  return {
    default: { ...instance, create: () => instance },
    HTTPError: class HTTPError extends Error {},
    TimeoutError: class TimeoutError extends Error {},
  };
});

const { findUniqueMock } = vi.hoisted(() => ({ findUniqueMock: vi.fn() }));
vi.mock("@/lib/db", () => ({
  default: { credential: { findUnique: findUniqueMock } },
}));

// decrypt is called on the stored credential value; return it verbatim.
vi.mock("@/lib/encryption", () => ({
  decrypt: (value: string) => value,
}));

// Make `.status(payload)` return the payload so `publish` receives it verbatim.
vi.mock("@/inngest/channels/node-status", () => ({
  nodeStatusChannel: () => ({ status: (payload: unknown) => payload }),
}));

import type { NodeExecutorParams } from "@/features/executions/types";
import { CredentialType } from "@/generated/prisma";
import { atsActionExecutor } from "./executor";

// Records the step names the executor checkpoints under. The split of create and
// note into SEPARATE steps is the correctness property under test (so an Inngest
// retry of the note replays the memoized create instead of opening a second
// opportunity), so the tests assert on the recorded names.
let stepNames: string[];
const step = {
  run: async (name: string, fn: () => unknown) => {
    stepNames.push(name);
    return fn();
  },
} as unknown as NodeExecutorParams["step"];

let publishedStatuses: string[];
const publish = (async (msg: { status: string }) => {
  publishedStatuses.push(msg.status);
}) as unknown as NodeExecutorParams["publish"];

type AtsResult = Record<
  string,
  { opportunityId: string | null; url: string | null }
>;

const run = (
  data: Record<string, unknown>,
  context: Record<string, unknown> = {},
) =>
  atsActionExecutor({
    data,
    nodeId: "a1",
    outputKey: "ATS_ACTION_1",
    executionId: "exec_test",
    userId: "u1",
    context,
    step,
    publish,
  }) as Promise<AtsResult>;

// A ky ResponsePromise stand-in: awaitable, .catch-able, and .json()-able.
const res = (value: unknown = {}) =>
  Object.assign(Promise.resolve(value), {
    json: () => Promise.resolve(value),
  });

const baseData = {
  provider: "lever",
  environment: "sandbox",
  credentialId: "cred1",
  performAsUserId: "user-xyz",
  name: "Ada Lovelace",
  email: "ada@example.com",
};

const createCall = () =>
  kyPostMock.mock.calls.find(
    ([url]) =>
      String(url).includes("/opportunities") && !String(url).includes("/notes"),
  );
const noteCall = () =>
  kyPostMock.mock.calls.find(([url]) => String(url).includes("/notes"));

beforeEach(() => {
  kyPostMock.mockReset();
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({
    id: "cred1",
    userId: "u1",
    type: CredentialType.LEVER,
    value: "lever-api-key",
  });
  stepNames = [];
  publishedStatuses = [];
});

describe("atsActionExecutor", () => {
  it("splits create and note into separate steps and posts both", async () => {
    kyPostMock.mockImplementation((url: string) => {
      if (String(url).includes("/notes")) return res({});
      return res({ data: { id: "opp1" } });
    });

    const result = await run({ ...baseData, note: "Sourced via Guideboard" });

    // The split is pinned: create is its own memoized step, note is a second.
    expect(stepNames).toEqual([
      "get-ats-credential",
      "ats-create-opportunity",
      "ats-add-note",
    ]);

    const create = createCall();
    expect(create).toBeDefined();
    expect(String(create?.[0])).toBe(
      "https://api.sandbox.lever.co/v1/opportunities",
    );
    expect(create?.[1]?.json).toMatchObject({
      name: "Ada Lovelace",
      emails: ["ada@example.com"],
      tags: ["guideboard"],
    });

    const note = noteCall();
    expect(note).toBeDefined();
    expect(String(note?.[0])).toBe(
      "https://api.sandbox.lever.co/v1/opportunities/opp1/notes",
    );
    expect(note?.[1]?.json).toEqual({ value: "Sourced via Guideboard" });

    expect(result.ATS_ACTION_1).toEqual({
      opportunityId: "opp1",
      url: "https://hire.sandbox.lever.co/candidates/opp1",
    });
    expect(publishedStatuses).toEqual(["loading", "success"]);
  });

  it("does not run the note step when no note is provided", async () => {
    kyPostMock.mockImplementation(() => res({ data: { id: "opp1" } }));

    await run(baseData);

    expect(stepNames).toEqual(["get-ats-credential", "ats-create-opportunity"]);
    expect(stepNames).not.toContain("ats-add-note");
    expect(noteCall()).toBeUndefined();
  });

  it("does not add a note when the create returned no opportunity id", async () => {
    kyPostMock.mockImplementation((url: string) => {
      if (String(url).includes("/notes")) return res({});
      return res({ data: {} });
    });

    const result = await run({ ...baseData, note: "Should not be sent" });

    expect(stepNames).not.toContain("ats-add-note");
    expect(noteCall()).toBeUndefined();
    expect(result.ATS_ACTION_1).toEqual({ opportunityId: null, url: null });
  });

  it("rejects a wrong credential type without retry", async () => {
    findUniqueMock.mockResolvedValue({
      id: "cred1",
      userId: "u1",
      type: CredentialType.OPENAI,
      value: "nope",
    });

    await expect(run(baseData)).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
    expect(publishedStatuses).toEqual(["loading", "error"]);
  });
});
