import { describe, expect, it } from "vitest";
import {
  type Producer,
  resolveFriendlyInput,
  resolveFriendlyOutput,
} from "@/lib/friendly-output";

describe("resolveFriendlyOutput", () => {
  it("returns null for a node type with no declared output contract", () => {
    // CONDITION is routing-only and intentionally left undeclared.
    expect(resolveFriendlyOutput("CONDITION", { condition_x: {} })).toBeNull();
  });

  it("projects a perNode output (AI text) using the declared labels", () => {
    const fields = resolveFriendlyOutput("AI_TEXT", {
      AI_TEXT_1: { output: "Yes" },
    });
    expect(fields).toEqual([
      { label: "AI output", value: "Yes", example: "Yes" },
    ]);
  });

  it("unwraps the legacy <type>_<id> perNode key too", () => {
    const fields = resolveFriendlyOutput("AI_TEXT", {
      ai_text_abc123: { output: "Hello" },
    });
    expect(fields).toEqual([
      { label: "AI output", value: "Hello", example: "Yes" },
    ]);
  });

  it("resolves nested dotted paths for a fixed-root trigger", () => {
    const fields = resolveFriendlyOutput("TELEGRAM_TRIGGER", {
      telegram: {
        text: "hi",
        from: { firstName: "Arav", lastName: "Jain" },
        chatId: "123",
      },
    });
    expect(fields).toEqual([
      {
        label: "Message text",
        value: "hi",
        example: "Sir, I want to work under you as an intern",
      },
      { label: "Sender first name", value: "Arav", example: "Ada" },
      { label: "Sender last name", value: "Jain", example: "Lovelace" },
      { label: "Chat ID", value: "123", example: "123456789" },
    ]);
  });

  it("drops fields absent from this run rather than showing them empty", () => {
    const fields = resolveFriendlyOutput("TELEGRAM_TRIGGER", {
      telegram: { text: "only text" },
    });
    expect(fields).toEqual([
      {
        label: "Message text",
        value: "only text",
        example: "Sir, I want to work under you as an intern",
      },
    ]);
  });

  it("returns an empty list (not null) when a declared node produced nothing recognized", () => {
    expect(resolveFriendlyOutput("AI_TEXT", { AI_TEXT_1: {} })).toEqual([]);
  });

  it("tolerates null/undefined output", () => {
    expect(resolveFriendlyOutput("AI_TEXT", null)).toEqual([]);
    expect(resolveFriendlyOutput("AI_TEXT", undefined)).toEqual([]);
  });

  it("resolves nested perNode paths for HTTP_REQUEST", () => {
    const fields = resolveFriendlyOutput("HTTP_REQUEST", {
      HTTP_REQUEST_1: {
        httpResponse: { status: 200, statusText: "OK", data: { ok: true } },
      },
    });
    expect(fields).toEqual([
      { label: "Status code", value: 200, example: "200" },
      { label: "Status text", value: "OK", example: "OK" },
      { label: "Response body", value: { ok: true } },
    ]);
  });

  it("resolves the shared aiReply fixed root for a reply node", () => {
    const fields = resolveFriendlyOutput("INSTAGRAM_REPLY_COMMENT", {
      aiReply: { text: "generated", replyText: "Thanks!" },
    });
    expect(fields).toEqual([{ label: "Reply sent", value: "Thanks!" }]);
  });
});

describe("resolveFriendlyInput", () => {
  // A run where a Telegram trigger feeds an AI text node; the AI node's input is
  // the context carrying the trigger's output.
  const producers: Producer[] = [
    {
      contextKey: "telegram",
      nodeType: "TELEGRAM_TRIGGER",
      label: "Telegram trigger",
    },
    { contextKey: "AI_TEXT_1", nodeType: "AI_TEXT", label: "AI text 1" },
  ];

  it("returns null when input isn't an object", () => {
    expect(resolveFriendlyInput(null, producers)).toBeNull();
    expect(resolveFriendlyInput("nope", producers)).toBeNull();
  });

  it("groups input fields by source node, value-filled", () => {
    const input = {
      telegram: {
        text: "I want to intern",
        from: { firstName: "Arav", username: "ASZKuve" },
        chatId: "5613978278",
      },
    };
    const sources = resolveFriendlyInput(input, producers);
    expect(sources).toEqual([
      {
        key: "telegram",
        label: "Telegram trigger",
        fields: [
          {
            label: "Message text",
            value: "I want to intern",
            example: "Sir, I want to work under you as an intern",
          },
          { label: "Sender first name", value: "Arav", example: "Ada" },
          { label: "Sender username", value: "ASZKuve", example: "ada_l" },
          { label: "Chat ID", value: "5613978278", example: "123456789" },
        ],
      },
    ]);
  });

  it("falls back to the static fixed-root registry for an unrecorded trigger", () => {
    const sources = resolveFriendlyInput(
      { telegram: { text: "hi" } },
      [], // no producers recorded for the trigger
    );
    expect(sources).toEqual([
      {
        key: "telegram",
        label: "Telegram trigger",
        fields: [
          {
            label: "Message text",
            value: "hi",
            example: "Sir, I want to work under you as an intern",
          },
        ],
      },
    ]);
  });

  it("skips context keys with no descriptor (raw view still shows them)", () => {
    const sources = resolveFriendlyInput(
      { unknown_blob: { foo: 1 }, AI_TEXT_1: { output: "Yes" } },
      producers,
    );
    expect(sources).toEqual([
      {
        key: "AI_TEXT_1",
        label: "AI text 1",
        fields: [{ label: "AI output", value: "Yes", example: "Yes" }],
      },
    ]);
  });

  it("returns an empty array when nothing recognized (caller shows raw)", () => {
    expect(resolveFriendlyInput({ unknown: { a: 1 } }, producers)).toEqual([]);
  });

  it("groups a topLevel trigger's root fields when that trigger ran", () => {
    const input = {
      commentId: "c_1",
      commentText: "Great video!",
      commenterName: "Ada",
      videoId: "v_9",
    };
    const sources = resolveFriendlyInput(
      input,
      [],
      ["YOUTUBE_COMMENT_TRIGGER"],
    );
    expect(sources).toEqual([
      {
        key: "YOUTUBE_COMMENT_TRIGGER",
        label: "Youtube comment trigger",
        fields: [
          {
            label: "Comment text",
            value: "Great video!",
            example: "Great video!",
          },
          { label: "Commenter name", value: "Ada", example: "Ada" },
          { label: "Comment ID", value: "c_1" },
          { label: "Video ID", value: "v_9" },
        ],
      },
    ]);
  });

  it("does not group topLevel fields when that trigger didn't run", () => {
    const input = { commentId: "c_1", commentText: "hi" };
    // No runNodeTypes → the root-level comment keys stay in raw only.
    expect(resolveFriendlyInput(input, [])).toEqual([]);
  });
});
