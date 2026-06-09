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

describe("workflows.generateFromPrompt", () => {
  it("persists the workflow graph and syncs a youtube poll row", async () => {
    mockAnthropic(
      JSON.stringify({
        name: "Reply to YouTube comments",
        nodes: [
          {
            id: "n1",
            type: "YOUTUBE_COMMENT_TRIGGER",
            position: { x: 100, y: 200 },
            data: { videoId: "vid-123" },
          },
          {
            id: "n2",
            type: "SLACK",
            position: { x: 400, y: 200 },
            data: {},
          },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2" }],
      }),
    );

    const { workflowId } = await caller.workflows.generateFromPrompt({
      prompt: "reply to my youtube comments in slack",
    });

    const workflow = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflowId },
      include: { nodes: true, connections: true },
    });
    expect(workflow.name).toBe("Reply to YouTube comments");
    expect(workflow.userId).toBe(authState.userId);
    expect(workflow.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(workflow.connections).toHaveLength(1);
    expect(workflow.connections[0]).toMatchObject({
      fromNodeId: "n1",
      toNodeId: "n2",
    });

    const youtubePolls = await prisma.youtubeCommentPoll.findMany({
      where: { workflowId },
    });
    expect(youtubePolls).toHaveLength(1);
    expect(youtubePolls[0]).toMatchObject({
      videoId: "vid-123",
      userId: authState.userId,
    });

    const sheetsPolls = await prisma.googleSheetsPoll.findMany({
      where: { workflowId },
    });
    expect(sheetsPolls).toHaveLength(0);
  });

  it("syncs a google sheets poll row from trigger config", async () => {
    mockAnthropic(
      JSON.stringify({
        name: "Sheet to Slack",
        nodes: [
          {
            id: "n1",
            type: "GOOGLE_SHEETS_TRIGGER",
            position: { x: 100, y: 200 },
            data: { spreadsheetId: "sheet-1", sheetName: "Sheet1" },
          },
        ],
        edges: [],
      }),
    );

    const { workflowId } = await caller.workflows.generateFromPrompt({
      prompt: "watch my sheet",
    });

    const sheetsPolls = await prisma.googleSheetsPoll.findMany({
      where: { workflowId },
    });
    expect(sheetsPolls).toHaveLength(1);
    expect(sheetsPolls[0]).toMatchObject({
      spreadsheetId: "sheet-1",
      sheetName: "Sheet1",
      userId: authState.userId,
    });
  });

  it("syncs a gmail poll row from a gmail trigger node", async () => {
    mockAnthropic(
      JSON.stringify({
        name: "Gmail to Slack",
        nodes: [
          {
            id: "n1",
            type: "GMAIL_TRIGGER",
            position: { x: 100, y: 200 },
            data: {},
          },
          {
            id: "n2",
            type: "SLACK",
            position: { x: 400, y: 200 },
            data: {},
          },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2" }],
      }),
    );

    const { workflowId } = await caller.workflows.generateFromPrompt({
      prompt: "send my unread gmail to slack",
    });

    const gmailPolls = await prisma.gmailPoll.findMany({
      where: { workflowId },
    });
    expect(gmailPolls).toHaveLength(1);
    expect(gmailPolls[0]).toMatchObject({ userId: authState.userId });
  });

  it("rejects a generated graph whose edge references an unknown node", async () => {
    mockAnthropic(
      JSON.stringify({
        name: "Broken",
        nodes: [
          {
            id: "n1",
            type: "MANUAL_TRIGGER",
            position: { x: 100, y: 200 },
            data: {},
          },
        ],
        edges: [{ id: "e1", source: "n1", target: "ghost" }],
      }),
    );

    await expect(
      caller.workflows.generateFromPrompt({ prompt: "break it" }),
    ).rejects.toThrow(/unknown node/i);

    expect(await prisma.workflow.count()).toBe(0);
  });
});

describe("workflows.update", () => {
  it("adds then removes a google sheets poll as the trigger comes and goes", async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Editable", userId: authState.userId },
    });

    await caller.workflows.update({
      id: workflow.id,
      nodes: [
        {
          id: "t1",
          type: "GOOGLE_SHEETS_TRIGGER",
          position: { x: 100, y: 200 },
          data: { spreadsheetId: "ss-9", sheetName: "Data" },
        },
      ],
      edges: [],
    });

    expect(
      await prisma.googleSheetsPoll.count({
        where: { workflowId: workflow.id },
      }),
    ).toBe(1);

    // Replace the trigger with a non-polling one; the poll row should be gone.
    await caller.workflows.update({
      id: workflow.id,
      nodes: [
        {
          id: "t1",
          type: "MANUAL_TRIGGER",
          position: { x: 100, y: 200 },
          data: {},
        },
      ],
      edges: [],
    });

    expect(
      await prisma.googleSheetsPoll.count({
        where: { workflowId: workflow.id },
      }),
    ).toBe(0);
  });

  it("adds then removes a gmail poll as the trigger comes and goes", async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Gmail editable", userId: authState.userId },
    });

    await caller.workflows.update({
      id: workflow.id,
      nodes: [
        {
          id: "g1",
          type: "GMAIL_TRIGGER",
          position: { x: 100, y: 200 },
          data: {},
        },
      ],
      edges: [],
    });

    expect(
      await prisma.gmailPoll.count({ where: { workflowId: workflow.id } }),
    ).toBe(1);

    // Drop the gmail trigger; the stale poll row must be cleaned up so the
    // cron poller stops firing executions for it.
    await caller.workflows.update({
      id: workflow.id,
      nodes: [
        {
          id: "g1",
          type: "MANUAL_TRIGGER",
          position: { x: 100, y: 200 },
          data: {},
        },
      ],
      edges: [],
    });

    expect(
      await prisma.gmailPoll.count({ where: { workflowId: workflow.id } }),
    ).toBe(0);
  });
});
