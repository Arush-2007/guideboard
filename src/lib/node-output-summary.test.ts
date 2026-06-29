import { describe, expect, it } from "vitest";
import { nodeSummaries } from "@/lib/node-output-summary";

const args = (output: Record<string, unknown> | undefined, config = {}) => ({
  output,
  config,
  resolve: (t: unknown) => (typeof t === "string" ? t : ""),
});

describe("nodeSummaries", () => {
  it("HTTP describes method, URL, and status", () => {
    const msg = nodeSummaries.HTTP_REQUEST?.(
      args(
        { httpResponse: { status: 200 } },
        { method: "GET", endpoint: "https://api.example.com" },
      ),
    );
    expect(msg).toBe(
      "Sent a GET request to https://api.example.com — returned 200.",
    );
  });

  it("AI announces a response when text is present", () => {
    expect(nodeSummaries.AI_TEXT?.(args({ output: "Yes" }))).toBe(
      "The AI generated a response.",
    );
    expect(nodeSummaries.AI_TEXT?.(args({ output: "" }))).toBeNull();
  });

  it("Gmail names the recipient", () => {
    expect(nodeSummaries.GMAIL_ACTION?.(args({ to: "a@b.com" }))).toBe(
      "Email sent to a@b.com.",
    );
  });
});
