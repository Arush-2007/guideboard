/**
 * Diagnostic: what does Google ACTUALLY return for a tab's merged ranges?
 *
 * Heading detection (`headingDataRows`) is driven entirely by the `merges` array
 * on the Sheet resource. When a tab plainly has a merged row but the app reports
 * none, the question is whether the request is wrong, the response is shaped
 * differently than assumed, or the merge itself fails one of the three rules.
 * Unit tests cannot answer that — they feed the parser a hand-written response,
 * so they validate the assumption rather than test it. This calls the real API.
 *
 * Usage:
 *   npx tsx scripts/dump-sheet-merges.ts                      # auto: reads your Sheets nodes
 *   npx tsx scripts/dump-sheet-merges.ts <spreadsheetId> [tab]
 *
 * With no arguments it finds the Google Sheets nodes you have already
 * configured and uses their saved spreadsheet + tab, so there is no id to hunt
 * for. The spreadsheet id is otherwise the long token in the sheet's URL:
 *   docs.google.com/spreadsheets/d/<THIS PART>/edit
 *
 * It uses the Google credential already stored for your user, refreshing it the
 * same way the executor does. Read-only — it never writes to the sheet.
 */

import "dotenv/config";
import { NodeType } from "../src/generated/prisma";
import db from "../src/lib/db";
import { headingDataRows } from "../src/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "../src/lib/google-token";

const [argSpreadsheetId, argTabName] = process.argv.slice(2);

/**
 * The spreadsheet/tab pairs to inspect: the ones passed on the command line, or
 * — with no arguments — every distinct pair saved on a Google Sheets node.
 */
async function resolveTargets(): Promise<
  Array<{ spreadsheetId: string; tabName?: string; via: string }>
> {
  if (argSpreadsheetId) {
    return [
      { spreadsheetId: argSpreadsheetId, tabName: argTabName, via: "argument" },
    ];
  }

  const nodes = await db.node.findMany({
    where: { type: NodeType.GOOGLE_SHEETS_ACTION },
    select: { name: true, ref: true, data: true },
  });

  const seen = new Map<
    string,
    { spreadsheetId: string; tabName?: string; via: string }
  >();
  for (const node of nodes) {
    const data = (node.data ?? {}) as {
      spreadsheetId?: string;
      sheetName?: string;
      action?: string;
    };
    if (!data.spreadsheetId?.trim()) continue;
    const key = `${data.spreadsheetId}::${data.sheetName ?? ""}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      spreadsheetId: data.spreadsheetId.trim(),
      tabName: data.sheetName?.trim() || undefined,
      via: `node "${node.ref ?? node.name}" (${data.action ?? "append_row"})`,
    });
  }
  return [...seen.values()];
}

/** The mask the app sends, plus the variants worth ruling in or out. */
const MASKS: Array<{ label: string; fields?: string }> = [
  {
    label: "CURRENT (one sheets(...) group)",
    fields: "sheets(properties(sheetId,title,gridProperties.rowCount),merges)",
  },
  {
    label: "OLD (sheets named twice)",
    fields:
      "sheets.properties(sheetId,title,gridProperties.rowCount),sheets.merges",
  },
  { label: "NO MASK AT ALL (ground truth)" },
];

async function main() {
  // Whichever user holds a Google credential — this is a local dev box.
  const credential = await db.googleCredential.findFirst({
    select: { userId: true },
  });
  if (!credential) {
    console.error(
      "No GoogleCredential rows found. Connect a Google account in the app first.",
    );
    process.exit(1);
  }

  const accessToken = await refreshGoogleTokenIfNeeded(credential.userId);
  const targets = await resolveTargets();
  if (targets.length === 0) {
    console.error(
      "No Google Sheets nodes with a saved spreadsheet were found.\n" +
        "Pass one explicitly: npx tsx scripts/dump-sheet-merges.ts <spreadsheetId> [tab]",
    );
    process.exit(1);
  }

  console.log(`user: ${credential.userId}`);
  console.log(`targets found: ${targets.length}\n`);

  for (const target of targets) {
    await inspect(accessToken, target);
  }

  await db.$disconnect();
}

async function inspect(
  accessToken: string,
  {
    spreadsheetId,
    tabName,
    via,
  }: { spreadsheetId: string; tabName?: string; via: string },
) {
  console.log("#".repeat(72));
  console.log(`spreadsheet: ${spreadsheetId}   (from ${via})`);
  console.log(`tab filter:  ${tabName ?? "(all tabs)"}\n`);

  for (const mask of MASKS) {
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
    );
    if (mask.fields) url.searchParams.set("fields", mask.fields);

    console.log("=".repeat(72));
    console.log(mask.label);
    console.log(`  ${url.toString()}`);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      console.log(`  HTTP ${response.status}: ${await response.text()}\n`);
      continue;
    }

    const body = (await response.json()) as {
      sheets?: Array<{
        properties?: { title?: string; sheetId?: number };
        merges?: unknown[];
      }>;
    };

    for (const sheet of body.sheets ?? []) {
      const title = sheet.properties?.title ?? "(untitled)";
      if (
        tabName &&
        title.trim().toLowerCase() !== tabName.trim().toLowerCase()
      ) {
        continue;
      }
      const merges = sheet.merges;
      console.log(`\n  tab "${title}" (sheetId ${sheet.properties?.sheetId})`);
      console.log(
        `    merges key present: ${Object.hasOwn(sheet, "merges")}, count: ${
          merges?.length ?? 0
        }`,
      );
      if (merges?.length) {
        console.log(`    raw: ${JSON.stringify(merges)}`);
        // What the app would conclude from exactly this payload.
        const detected = headingDataRows(merges as never);
        const dataRows = [...detected.keys()];
        console.log(
          `    → headingDataRows: ${
            detected.size === 0
              ? "NONE — every merge failed a rule below"
              : dataRows
                  .map(
                    (n) =>
                      `data row ${n} (sheet row ${n + 2}, merged ${detected.get(n)} cols)`,
                  )
                  .join("; ")
          }`,
        );
        // Why each merge passed or failed, so a rejection is never a mystery.
        for (const m of merges as Array<Record<string, number | undefined>>) {
          const start = m.startRowIndex ?? 0;
          const end = m.endRowIndex ?? start + 1;
          const col = m.startColumnIndex ?? 0;
          const reasons: string[] = [];
          if (col !== 0) reasons.push(`starts at column index ${col}, not A`);
          if (end - start !== 1)
            reasons.push(`${end - start} rows tall, not 1`);
          if (start < 1) reasons.push("is the header row");
          console.log(
            `      ${JSON.stringify(m)} → ${
              reasons.length === 0
                ? "HEADING"
                : `rejected: ${reasons.join("; ")}`
            }`,
          );
        }
      }
    }
    console.log();
  }
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
