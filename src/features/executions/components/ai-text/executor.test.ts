import { beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialType } from "@/generated/prisma";

// Mock the AI SDK so no real provider call happens (credits aside, tests must be
// hermetic). `generateText` is captured so we can assert the rendered prompt.
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock("ai", () => ({ generateText: generateTextMock }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => ({}) }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => () => ({}) }));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => ({}),
}));

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: { credential: { findUnique } } }));
vi.mock("@/lib/encryption", () => ({ decrypt: (v: string) => v }));

import { aiTextExecutor } from "./executor";

const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
  ai: { wrap: async (_name: string, fn: any, args: any) => fn(args) },
} as any;
const publish = (async () => {}) as any;

beforeEach(() => {
  generateTextMock.mockReset();
  findUnique.mockReset();
  findUnique.mockResolvedValue({
    id: "cred1",
    userId: "u1",
    type: CredentialType.ANTHROPIC,
    value: "secret-key",
  });
  generateTextMock.mockResolvedValue({
    steps: [{ content: [{ type: "text", text: "Yes" }] }],
  });
});

describe("aiTextExecutor (the USP node)", () => {
  it("renders the operation against upstream context and returns { output }", async () => {
    const result = await aiTextExecutor({
      data: {
        provider: "anthropic",
        credentialId: "cred1",
        prompt:
          "If !#telegram.text#! is an internship application reply Yes else No",
      },
      nodeId: "a1",
      userId: "u1",
      context: { telegram: { text: "I want to intern with you" } },
      step,
      publish,
    });

    // The operation was templated via renderTemplate before hitting the model.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0][0].prompt).toBe(
      "If I want to intern with you is an internship application reply Yes else No",
    );

    // Result is exposed under the documented `output` key.
    expect(result.ai_text_a1).toEqual({ output: "Yes" });
    // Upstream context is preserved for downstream nodes.
    expect((result.telegram as any).text).toBe("I want to intern with you");
  });

  it("throws a non-retriable error when the credential type mismatches the provider", async () => {
    findUnique.mockResolvedValue({
      id: "cred1",
      userId: "u1",
      type: CredentialType.OPENAI,
      value: "secret-key",
    });

    await expect(
      aiTextExecutor({
        data: { provider: "anthropic", credentialId: "cred1", prompt: "hi" },
        nodeId: "a1",
        userId: "u1",
        context: {},
        step,
        publish,
      }),
    ).rejects.toThrow(/does not match selected provider/i);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
