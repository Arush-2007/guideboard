import { describe, expect, it } from "vitest";
import { describeProviderError } from "./provider-error";

describe("describeProviderError", () => {
  it("surfaces the provider's JSON error message with status and label", () => {
    // Shape of an AI SDK AI_APICallError for a Groq network block.
    const err = {
      name: "AI_APICallError",
      statusCode: 403,
      responseBody: JSON.stringify({
        error: {
          message: "Access denied. Please check your network settings.",
        },
      }),
      message: "Forbidden",
    };

    const out = describeProviderError(err, "Groq");
    expect(out.message).toBe(
      "Groq 403: Access denied. Please check your network settings.",
    );
    expect((out as Error & { cause?: unknown }).cause).toBe(err);
  });

  it("falls back to the raw body when it is not JSON", () => {
    const err = { statusCode: 500, responseBody: "upstream exploded" };
    expect(describeProviderError(err, "OpenAI").message).toBe(
      "OpenAI 500: upstream exploded",
    );
  });

  it("uses the message when there is no response body", () => {
    const err = { statusCode: 401, message: "Unauthorized" };
    expect(describeProviderError(err, "Gemini").message).toBe(
      "Gemini 401: Unauthorized",
    );
  });

  it("passes non-API errors through unchanged", () => {
    const err = new Error("Credential not found");
    expect(describeProviderError(err, "Groq")).toBe(err);
  });
});
