import { describe, expect, it } from "vitest";
import {
  describeConfigValue,
  extractReferencePaths,
  type Producer,
  renderReferences,
  resolveFriendlyInput,
  resolveFriendlyOutput,
  resolveReferencedInput,
} from "@/lib/friendly-output";

describe("resolveFriendlyOutput", () => {
  it("returns null for a node type with no declared output contract", () => {
    // MANUAL_TRIGGER has no fixed output shape and is intentionally undeclared.
    expect(
      resolveFriendlyOutput("MANUAL_TRIGGER", { manual_x: {} }),
    ).toBeNull();
  });

  it("renders a Condition node's recorded boolean result", () => {
    const fields = resolveFriendlyOutput("CONDITION", {
      CONDITION_1: { result: false },
    });
    expect(fields).toEqual([{ label: "Result", value: false }]);
  });

  it("projects a perNode output (AI text) using the declared labels", () => {
    const fields = resolveFriendlyOutput("AI_TEXT", {
      AI_TEXT_1: { output: "Yes" },
    });
    expect(fields).toEqual([{ label: "AI output", value: "Yes" }]);
  });

  it("unwraps the legacy <type>_<id> perNode key too", () => {
    const fields = resolveFriendlyOutput("AI_TEXT", {
      ai_text_abc123: { output: "Hello" },
    });
    expect(fields).toEqual([{ label: "AI output", value: "Hello" }]);
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
      { label: "Message text", value: "hi" },
      { label: "Sender first name", value: "Arav" },
      { label: "Sender last name", value: "Jain" },
      { label: "Chat ID", value: "123" },
    ]);
  });

  it("drops fields absent from this run rather than showing them empty", () => {
    const fields = resolveFriendlyOutput("TELEGRAM_TRIGGER", {
      telegram: { text: "only text" },
    });
    expect(fields).toEqual([{ label: "Message text", value: "only text" }]);
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
      { label: "Status code", value: 200 },
      { label: "Status text", value: "OK" },
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
          { label: "Message text", value: "I want to intern" },
          { label: "Sender first name", value: "Arav" },
          { label: "Sender username", value: "ASZKuve" },
          { label: "Chat ID", value: "5613978278" },
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
        fields: [{ label: "Message text", value: "hi" }],
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
        fields: [{ label: "AI output", value: "Yes" }],
      },
    ]);
  });

  it("returns an empty array when nothing recognized (caller shows raw)", () => {
    expect(resolveFriendlyInput({ unknown: { a: 1 } }, producers)).toEqual([]);
  });

  it("groups a topLevel trigger's root fields when that trigger ran (developer IDs hidden)", () => {
    const input = {
      commentId: "c_1", // developer-flagged → hidden from Friendly
      commentText: "Great video!",
      commenterName: "Ada",
      videoId: "v_9", // developer-flagged → hidden from Friendly
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
          { label: "Comment text", value: "Great video!" },
          { label: "Commenter name", value: "Ada" },
        ],
      },
    ]);
  });

  it("does not group topLevel fields when that trigger didn't run", () => {
    const input = { commentId: "c_1", commentText: "hi" };
    // No runNodeTypes → the root-level comment keys stay in raw only.
    expect(resolveFriendlyInput(input, [])).toEqual([]);
  });

  it("hides developer-flagged fields (e.g. Telegram message ID) from the payload", () => {
    const sources = resolveFriendlyInput(
      { telegram: { text: "hi", messageId: "42", from: { id: "99" } } },
      [{ contextKey: "telegram", nodeType: "TELEGRAM_TRIGGER", label: "T" }],
    );
    const labels = sources?.[0]?.fields.map((f) => f.label) ?? [];
    expect(labels).toContain("Message text");
    expect(labels).not.toContain("Message ID");
    expect(labels).not.toContain("Sender user ID");
  });
});

describe("extractReferencePaths", () => {
  it("pulls @<path>@ references from nested config, deduped + in order", () => {
    const config = {
      to: ["@<AI_TEXT_1.output>@"],
      subject: "Re: @<telegram.text>@",
      body: "Hi @<telegram.from.firstName>@ — @<telegram.text>@",
      static: "no references here",
    };
    expect(extractReferencePaths(config)).toEqual([
      "AI_TEXT_1.output",
      "telegram.text",
      "telegram.from.firstName",
    ]);
  });

  it("returns [] when nothing is referenced", () => {
    expect(extractReferencePaths({ a: "plain", b: 3 })).toEqual([]);
  });
});

describe("resolveReferencedInput", () => {
  const producers: Producer[] = [
    { contextKey: "AI_TEXT_1", nodeType: "AI_TEXT", label: "AI text 1" },
    {
      contextKey: "telegram",
      nodeType: "TELEGRAM_TRIGGER",
      label: "Telegram trigger",
    },
  ];
  const input = {
    telegram: { text: "I want to intern", from: { firstName: "Arav" } },
    AI_TEXT_1: { output: "aravj8108@gmail.com" },
  };

  it("shows ONLY the upstream fields the node's config references", () => {
    // A Gmail node whose recipient comes from the AI node and body from Telegram.
    const config = {
      to: ["@<AI_TEXT_1.output>@"],
      body: "From @<telegram.from.firstName>@",
      subject: "Internship",
    };
    const sources = resolveReferencedInput(config, input, producers);
    expect(sources).toEqual([
      {
        key: "AI_TEXT_1",
        label: "AI text 1",
        fields: [{ label: "AI output", value: "aravj8108@gmail.com" }],
      },
      {
        key: "telegram",
        label: "Telegram trigger",
        fields: [{ label: "Sender first name", value: "Arav" }],
      },
    ]);
  });

  it("returns [] for a node that references nothing", () => {
    expect(
      resolveReferencedInput({ subject: "static" }, input, producers),
    ).toEqual([]);
  });

  it("drops references whose value is absent from this run's context", () => {
    const config = { body: "@<telegram.missing.field>@" };
    expect(resolveReferencedInput(config, input, producers)).toEqual([]);
  });

  it("shows a Condition node's compared field as its input", () => {
    // A Condition comparing the AI output to a literal references one upstream
    // field; the literal `value` contributes nothing.
    const config = {
      field: "@<AI_TEXT_1.output>@",
      operator: "equals",
      value: "aravj8108@gmail.com",
    };
    expect(resolveReferencedInput(config, input, producers)).toEqual([
      {
        key: "AI_TEXT_1",
        label: "AI text 1",
        fields: [{ label: "AI output", value: "aravj8108@gmail.com" }],
      },
    ]);
  });
});

describe("renderReferences", () => {
  it("substitutes @<path>@ against the context", () => {
    expect(
      renderReferences("Hi @<telegram.from.firstName>@!", {
        telegram: { from: { firstName: "Arav" } },
      }),
    ).toBe("Hi Arav!");
  });

  it("renders a missing reference as empty and ignores non-strings", () => {
    expect(renderReferences("@<a.b>@", {})).toBe("");
    expect(renderReferences(42, {})).toBe("");
  });
});

describe("describeConfigValue", () => {
  const producers: Producer[] = [
    { contextKey: "AI_TEXT_1", nodeType: "AI_TEXT", label: "AI text 1" },
  ];
  const context = { AI_TEXT_1: { output: "aravj8108@gmail.com" } };

  it("labels a pure reference by the upstream field's name", () => {
    expect(
      describeConfigValue("@<AI_TEXT_1.output>@", context, producers),
    ).toEqual({ label: "AI output", value: "aravj8108@gmail.com" });
  });

  it("labels a user-typed literal as 'Entered by user'", () => {
    expect(describeConfigValue("Yes", context, producers)).toEqual({
      label: "Entered by user",
      value: "Yes",
    });
  });

  it("treats text mixed with a reference as user-entered (resolved)", () => {
    expect(
      describeConfigValue("To: @<AI_TEXT_1.output>@", context, producers),
    ).toEqual({ label: "Entered by user", value: "To: aravj8108@gmail.com" });
  });
});
