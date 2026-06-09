import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { authState } = vi.hoisted(() => ({ authState: { userId: "" } }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        authState.userId
          ? { user: { id: authState.userId }, session: { id: "test-session" } }
          : null,
    },
  },
}));

import prisma from "@/lib/db";
import {
  cleanupDb,
  createCaller,
  createTestUser,
  mockAnthropic,
} from "@/test/trpc-harness";

const caller = createCaller();

beforeAll(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  authState.userId = user.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conversations.chat (BUILDING phase)", () => {
  it("persists the generated workflow and syncs trigger polls", async () => {
    const { conversationId } = await caller.conversations.create();

    mockAnthropic(
      JSON.stringify({
        phase: "BUILDING",
        message: "Creating your workflow now...",
        workflow: {
          name: "Sheet watcher",
          nodes: [
            {
              id: "n1",
              type: "GOOGLE_SHEETS_TRIGGER",
              position: { x: 100, y: 200 },
              data: { spreadsheetId: "abc", sheetName: "Tab1" },
            },
            {
              id: "n2",
              type: "SLACK",
              position: { x: 400, y: 200 },
              data: {},
            },
          ],
          edges: [{ id: "e1", source: "n1", target: "n2" }],
        },
      }),
    );

    const result = await caller.conversations.chat({
      conversationId,
      message: "build it",
    });

    expect(result.phase).toBe("BUILDING");
    expect(result.workflowId).toBeDefined();

    const workflow = await prisma.workflow.findUniqueOrThrow({
      where: { id: result.workflowId },
      include: { nodes: true, connections: true },
    });
    expect(workflow.name).toBe("Sheet watcher");
    expect(workflow.nodes).toHaveLength(2);
    expect(workflow.connections).toHaveLength(1);

    const sheetsPolls = await prisma.googleSheetsPoll.findMany({
      where: { workflowId: result.workflowId },
    });
    expect(sheetsPolls).toHaveLength(1);
    expect(sheetsPolls[0]).toMatchObject({
      spreadsheetId: "abc",
      sheetName: "Tab1",
      userId: authState.userId,
    });

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.phase).toBe("BUILDING");
    expect(conversation.workflowId).toBe(result.workflowId);
  });

  it("stays conversational and persists nothing in GATHERING phase", async () => {
    const { conversationId } = await caller.conversations.create();

    mockAnthropic(
      JSON.stringify({
        phase: "GATHERING",
        message: "What should trigger it?",
      }),
    );

    const result = await caller.conversations.chat({
      conversationId,
      message: "I want an automation",
    });

    expect(result.phase).toBe("GATHERING");
    expect(await prisma.workflow.count()).toBe(0);
  });
});
