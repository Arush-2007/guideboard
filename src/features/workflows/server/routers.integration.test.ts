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

  it("rewrites a downstream legacy-key reference to the producer's new ref on save", async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Ref rewrite", userId: authState.userId },
    });

    // The producer (a1) has no ref yet; the consumer (b1) references it by the
    // legacy `<type>_<id>` key — exactly what a picked field authored before the
    // producer got a ref would store.
    await caller.workflows.update({
      id: workflow.id,
      nodes: [
        {
          id: "a1",
          type: "GOOGLE_SHEETS_ACTION",
          position: { x: 0, y: 0 },
          data: { action: "find_rows" },
        },
        {
          id: "b1",
          type: "SLACK",
          position: { x: 200, y: 0 },
          data: {
            message: "Jobs: @<google_sheets_action_a1.columnValues.Job No>@",
          },
        },
      ],
      edges: [{ source: "a1", target: "b1" }],
    });

    const nodes = await prisma.node.findMany({
      where: { workflowId: workflow.id },
    });
    const producer = nodes.find((n) => n.id === "a1");
    const consumer = nodes.find((n) => n.id === "b1");

    expect(producer?.ref).toBe("GOOGLE_SHEETS_ACTION_1");
    // The consumer's legacy reference now points at the producer's ref, so it
    // resolves against the ref-keyed run context.
    expect((consumer?.data as { message?: string }).message).toBe(
      "Jobs: @<GOOGLE_SHEETS_ACTION_1.columnValues.Job No>@",
    );
  });
});

describe("workflows.duplicate", () => {
  /** A trigger -> action workflow whose action references the trigger. */
  async function seedWorkflow(name: string) {
    const workflow = await prisma.workflow.create({
      data: { name, userId: authState.userId },
    });
    await caller.workflows.update({
      id: workflow.id,
      nodes: [
        {
          id: "t1",
          type: "GOOGLE_SHEETS_TRIGGER",
          position: { x: 0, y: 0 },
          data: { spreadsheetId: "ss-1", sheetName: "Data" },
        },
        {
          id: "a1",
          type: "SLACK",
          position: { x: 300, y: 0 },
          data: { message: "New row: @<google_sheets_trigger_t1.row>@" },
        },
      ],
      edges: [{ source: "t1", target: "a1" }],
    });
    return workflow;
  }

  it("copies the graph under a numbered name, re-identifying every node", async () => {
    const source = await seedWorkflow("Lead capture");

    const copy = await caller.workflows.duplicate({ id: source.id });
    expect(copy.name).toBe("Lead capture.2");

    const copied = await prisma.workflow.findUniqueOrThrow({
      where: { id: copy.id },
      include: { nodes: true, connections: true },
    });

    // Nodes are re-identified — a shared id would tie the two graphs together.
    expect(copied.nodes).toHaveLength(2);
    expect(copied.nodes.map((n) => n.id).sort()).not.toContain("t1");
    expect(copied.nodes.map((n) => n.type).sort()).toEqual([
      "GOOGLE_SHEETS_TRIGGER",
      "SLACK",
    ]);

    // Refs are per-workflow, so the copy keeps them and its own references
    // still resolve.
    const copiedSlack = copied.nodes.find((n) => n.type === "SLACK");
    const copiedTrigger = copied.nodes.find(
      (n) => n.type === "GOOGLE_SHEETS_TRIGGER",
    );
    expect(copiedSlack?.ref).toBe("SLACK_1");

    // The legacy reference was rewritten to the COPY's trigger id, not left
    // pointing at the original's node.
    expect((copiedSlack?.data as { message?: string }).message).toBe(
      `New row: @<google_sheets_trigger_${copiedTrigger?.id}.row>@`,
    );

    // The edge is remapped inside the copy.
    expect(copied.connections).toHaveLength(1);
    expect(copied.connections[0]).toMatchObject({
      fromNodeId: copiedTrigger?.id,
      toNodeId: copiedSlack?.id,
    });

    // The original is untouched.
    const original = await prisma.workflow.findUniqueOrThrow({
      where: { id: source.id },
      include: { nodes: true, connections: true },
    });
    expect(original.name).toBe("Lead capture");
    expect(original.nodes.map((n) => n.id).sort()).toEqual(["a1", "t1"]);
    expect(original.connections).toHaveLength(1);
  });

  it("leaves the copy's triggers dormant, and flags it, until it is saved", async () => {
    const source = await seedWorkflow("Sheet watcher");
    expect(
      await prisma.googleSheetsPoll.count({ where: { workflowId: source.id } }),
    ).toBe(1);

    const copy = await caller.workflows.duplicate({ id: source.id });

    // No poll row: copying a live automation must not silently double its runs.
    expect(
      await prisma.googleSheetsPoll.count({ where: { workflowId: copy.id } }),
    ).toBe(0);
    // ...and the original's poll row survives.
    expect(
      await prisma.googleSheetsPoll.count({ where: { workflowId: source.id } }),
    ).toBe(1);

    // The inert state is advertised, so the editor opens dirty instead of
    // claiming "Saved" for a workflow that isn't running.
    expect(copy.pendingFirstSave).toBe(true);
    const loaded = await caller.workflows.getOne({ id: copy.id });
    expect(loaded.pendingFirstSave).toBe(true);
  });

  it("activates the copy on its first save and clears the flag", async () => {
    const source = await seedWorkflow("Sheet watcher");
    const copy = await caller.workflows.duplicate({ id: source.id });

    const loaded = await caller.workflows.getOne({ id: copy.id });
    await caller.workflows.update({
      id: copy.id,
      nodes: loaded.nodes,
      edges: loaded.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      })),
    });

    // Saving is what makes the copy real: its poll row exists and the flag is
    // retired, so it stops reading as unsaved everywhere.
    expect(
      await prisma.googleSheetsPoll.count({ where: { workflowId: copy.id } }),
    ).toBe(1);
    expect(
      (await caller.workflows.getOne({ id: copy.id })).pendingFirstSave,
    ).toBe(false);
  });

  it("numbers successive copies, and copies of copies, in one series", async () => {
    const source = await seedWorkflow("Lead capture");

    const second = await caller.workflows.duplicate({ id: source.id });
    const third = await caller.workflows.duplicate({ id: source.id });
    expect(second.name).toBe("Lead capture.2");
    expect(third.name).toBe("Lead capture.3");

    // Copying the copy continues the same series rather than nesting.
    const fourth = await caller.workflows.duplicate({ id: second.id });
    expect(fourth.name).toBe("Lead capture.4");
  });

  it("refuses to copy another user's workflow", async () => {
    const source = await seedWorkflow("Private");
    const intruder = await createTestUser();
    authState.userId = intruder.id;

    await expect(caller.workflows.duplicate({ id: source.id })).rejects.toThrow(
      /not found/i,
    );

    expect(
      await prisma.workflow.count({ where: { userId: intruder.id } }),
    ).toBe(0);
  });
});
