/**
 * Repointing a Google Sheets trigger at a different tab, against a real
 * Postgres.
 *
 * The poller diffs POSITIONALLY: row N now against row N at the last poll,
 * with anything at or beyond `lastRowCount` counted as an append. That makes
 * the stored baseline meaningful only for the tab it was taken from — so the
 * moment `sheetName` or `spreadsheetId` changes, keeping it is not a stale
 * cache, it is a wrong answer:
 *
 *   - a SMALLER tab never reaches the old row count, so nothing ever fires;
 *   - a LARGER one fires every row past that count as "added", over rows that
 *     were already sitting in the sheet.
 *
 * Neither failure surfaces an error, which is why this is pinned here rather
 * than left to the unit suite's mocked database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/encryption", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));

import { NodeType } from "@/generated/prisma";
import prisma from "@/lib/db";
import { syncTriggerPollsForWorkflow } from "@/lib/workflow-persistence";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";

let userId: string;
let workflowId: string;

const SPREADSHEET = "sheet_abc";

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  userId = user.id;
  const workflow = await prisma.workflow.create({
    data: { name: "Sheets trigger workflow", userId },
  });
  workflowId = workflow.id;
});

afterEach(async () => {
  await cleanupDb();
});

/** Saving a workflow whose trigger watches `sheetName` on `spreadsheetId`. */
const save = (spreadsheetId: string, sheetName: string) =>
  syncTriggerPollsForWorkflow(userId, workflowId, [
    {
      type: NodeType.GOOGLE_SHEETS_TRIGGER,
      data: { spreadsheetId, sheetName, triggerOn: "added" },
    },
  ]);

/** Stands in for "the poller has run and recorded a baseline". */
const seedBaseline = () =>
  prisma.googleSheetsPoll.update({
    where: { workflowId },
    data: {
      lastRowCount: 157,
      rowHashes: {
        sig: "a",
        cols: "0,1",
        header: ["S.No.", "Amount"],
        headings: {},
        cellHashes: [["h1", "h2"]],
      },
    },
  });

const readPoll = () =>
  prisma.googleSheetsPoll.findUniqueOrThrow({ where: { workflowId } });

describe("sheets trigger baseline when the watched tab changes", () => {
  it("clears the baseline when the tab name changes", async () => {
    await save(SPREADSHEET, "JOB-NUMBER");
    await seedBaseline();

    await save(SPREADSHEET, "OTHER-TAB");

    const poll = await readPoll();
    expect(poll.sheetName).toBe("OTHER-TAB");
    expect(poll.lastRowCount).toBe(0);
    expect(poll.rowHashes).toBeNull();
  });

  it("clears the baseline when the spreadsheet changes", async () => {
    await save(SPREADSHEET, "JOB-NUMBER");
    await seedBaseline();

    await save("sheet_xyz", "JOB-NUMBER");

    const poll = await readPoll();
    expect(poll.spreadsheetId).toBe("sheet_xyz");
    expect(poll.lastRowCount).toBe(0);
    expect(poll.rowHashes).toBeNull();
  });

  it("KEEPS the baseline when the tab is unchanged", async () => {
    // An ordinary re-save must not re-baseline: that would swallow every row
    // added since the last poll, because a baseline poll fires nothing.
    await save(SPREADSHEET, "JOB-NUMBER");
    await seedBaseline();

    await save(SPREADSHEET, "JOB-NUMBER");

    const poll = await readPoll();
    expect(poll.lastRowCount).toBe(157);
    expect(poll.rowHashes).not.toBeNull();
  });

  it("keeps the baseline when only the trigger options change", async () => {
    // The watched-COLUMN axis re-seeds inside the poller via the stored
    // projection, so the sync must not also reset here — doing both would
    // discard rows added between the change and the next poll.
    await save(SPREADSHEET, "JOB-NUMBER");
    await seedBaseline();

    await syncTriggerPollsForWorkflow(userId, workflowId, [
      {
        type: NodeType.GOOGLE_SHEETS_TRIGGER,
        data: {
          spreadsheetId: SPREADSHEET,
          sheetName: "JOB-NUMBER",
          triggerOn: "added_or_updated",
          ignoreColumns: ["Amount"],
        },
      },
    ]);

    const poll = await readPoll();
    expect(poll.triggerOn).toBe("added_or_updated");
    expect(poll.lastRowCount).toBe(157);
    expect(poll.rowHashes).not.toBeNull();
  });
});
