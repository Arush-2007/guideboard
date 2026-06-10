import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture what the webhook forwards into the engine without touching Inngest.
// `vi.hoisted` so the fn exists when the hoisted vi.mock factory references it.
const { sendWorkflowExecution } = vi.hoisted(() => ({
  sendWorkflowExecution: vi.fn(
    async (_input: {
      workflowId: string;
      initialData?: any;
      idempotencyKey?: string;
    }) => ({ ids: ["evt"] }),
  ),
}));
vi.mock("@/inngest/utils", () => ({ sendWorkflowExecution }));
// Rate limiter is in-memory + stateful; force "allowed" for deterministic tests.
vi.mock("@/lib/rate-limit", () => ({ isAllowed: () => true }));

import { POST } from "./route";

const SECRET = "test-telegram-secret";

function makeRequest(
  body: unknown,
  opts?: { secret?: string; workflowId?: string },
) {
  const workflowId = opts?.workflowId ?? "wf_1";
  return new Request(
    `http://localhost:3000/api/webhooks/telegram?workflowId=${workflowId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": opts?.secret ?? SECRET,
      },
      body: JSON.stringify(body),
    },
    // The handler only uses standard Request methods, so a global Request works.
  ) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  sendWorkflowExecution.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Telegram webhook → trigger output contract", () => {
  it("forwards the rich telegram shape and a chat-scoped idempotency key", async () => {
    const res = await POST(
      makeRequest({
        update_id: 100,
        message: {
          message_id: 42,
          date: 1718000000,
          text: "Sir, I want to work under you as an intern",
          from: {
            id: 555,
            first_name: "Ada",
            last_name: "Lovelace",
            username: "ada_l",
          },
          chat: { id: 999 },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(sendWorkflowExecution).toHaveBeenCalledTimes(1);
    const arg = sendWorkflowExecution.mock.calls[0][0];

    expect(arg.workflowId).toBe("wf_1");
    expect(arg.idempotencyKey).toBe("telegram:999:42");
    expect(arg.initialData.telegram).toEqual({
      messageId: 42,
      text: "Sir, I want to work under you as an intern",
      date: 1718000000,
      from: {
        id: "555",
        firstName: "Ada",
        lastName: "Lovelace",
        username: "ada_l",
      },
      chatId: "999",
      contact: null,
      raw: expect.objectContaining({ update_id: 100 }),
    });
  });

  it("captures a shared contact's phone number when present", async () => {
    await POST(
      makeRequest({
        message: {
          message_id: 7,
          chat: { id: 12 },
          from: { id: 1, first_name: "Bob" },
          contact: { phone_number: "+15551234567", first_name: "Bob" },
        },
      }),
    );

    const arg = sendWorkflowExecution.mock.calls[0][0];
    expect(arg.initialData.telegram.contact).toEqual({
      phoneNumber: "+15551234567",
      firstName: "Bob",
    });
  });

  it("rejects a bad secret and never dispatches", async () => {
    const res = await POST(
      makeRequest(
        { message: { message_id: 1, chat: { id: 1 } } },
        { secret: "wrong" },
      ),
    );
    expect(res.status).toBe(401);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("skips non-message updates (e.g. edited_message only) without dispatching", async () => {
    const res = await POST(
      makeRequest({ update_id: 5, edited_message: { foo: 1 } }),
    );
    expect(res.status).toBe(200);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });
});
