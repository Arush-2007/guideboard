import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The harness statically imports `appRouter`, whose module graph reaches
// `@/lib/auth` -> `@/lib/email` -> `import "server-only"` (throws under vitest),
// so we stub auth/headers exactly like the other *.integration.test.ts files.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => null,
    },
  },
}));

// `processSchedulePoll` dispatches via `sendWorkflowExecution`, which would hit
// a real Inngest endpoint. Stub it so we can assert what would be dispatched
// without a running Inngest server, keeping the rest of `@/inngest/utils` real.
const { sendWorkflowExecutionMock } = vi.hoisted(() => ({
  sendWorkflowExecutionMock: vi.fn(async () => ({ ids: ["evt"] })),
}));
vi.mock("@/inngest/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/inngest/utils")>()),
  sendWorkflowExecution: sendWorkflowExecutionMock,
}));

import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { processSchedulePoll } from "./schedule-poll";

let userId: string;
let workflowId: string;

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  userId = user.id;
  const workflow = await prisma.workflow.create({
    data: { name: "Scheduled report", userId },
  });
  workflowId = workflow.id;
  sendWorkflowExecutionMock.mockClear();
});

afterEach(async () => {
  await cleanupDb();
});

describe("processSchedulePoll", () => {
  // Hourly at minute 0, UTC. `now` sits between a past due slot (10:00) and the
  // next slot (11:00), so the advance target is deterministic.
  const now = new Date("2026-06-25T10:30:00.000Z");
  const dueAt = new Date("2026-06-25T10:00:00.000Z");

  const createDuePoll = (nextRunAt: Date) =>
    prisma.schedulePoll.create({
      data: {
        userId,
        workflowId,
        cron: "0 * * * *",
        timezone: "UTC",
        nextRunAt,
      },
    });

  it("dispatches a due schedule exactly once and advances nextRunAt", async () => {
    const poll = await createDuePoll(dueAt);

    const first = await processSchedulePoll(poll.id, now);
    expect(first.dispatched).toBe(true);

    // Dispatched exactly one workflow run, keyed on the due slot, with the
    // scheduled time seeded into the trigger context.
    expect(sendWorkflowExecutionMock).toHaveBeenCalledTimes(1);
    expect(sendWorkflowExecutionMock).toHaveBeenCalledWith({
      workflowId,
      initialData: { schedule: { scheduledAt: dueAt.toISOString() } },
      idempotencyKey: `schedule:${poll.id}:${dueAt.toISOString()}`,
    });

    // nextRunAt advanced to the next future firing; lastRunAt records the slot.
    const advanced = await prisma.schedulePoll.findUniqueOrThrow({
      where: { id: poll.id },
    });
    expect(advanced.nextRunAt.toISOString()).toBe("2026-06-25T11:00:00.000Z");
    expect(advanced.lastRunAt?.toISOString()).toBe(dueAt.toISOString());

    // A second tick before the new slot is due must NOT re-fire (idempotent at
    // the poll level, on top of the execution idempotency key).
    const second = await processSchedulePoll(poll.id, now);
    expect(second.dispatched).toBe(false);
    expect(sendWorkflowExecutionMock).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a schedule whose nextRunAt is still in the future", async () => {
    const poll = await createDuePoll(new Date("2026-06-25T12:00:00.000Z"));

    const result = await processSchedulePoll(poll.id, now);

    expect(result.dispatched).toBe(false);
    expect(sendWorkflowExecutionMock).not.toHaveBeenCalled();
    const unchanged = await prisma.schedulePoll.findUniqueOrThrow({
      where: { id: poll.id },
    });
    expect(unchanged.lastRunAt).toBeNull();
  });

  it("no-ops when the poll row no longer exists", async () => {
    const result = await processSchedulePoll("nonexistent-id", now);
    expect(result.dispatched).toBe(false);
    expect(sendWorkflowExecutionMock).not.toHaveBeenCalled();
  });
});
