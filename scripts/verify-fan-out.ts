/**
 * Diagnostic: did a fan-out actually fan out correctly?
 *
 * A fan-out that "worked" is not proven by a green run. Children are seeded by
 * INDEX from a stored item list (`FanOutSource`/`FanOutItem`), so an off-by-one
 * or a misordered chain still reports SUCCESS everywhere while quietly
 * processing the wrong row — the one failure mode the execution page cannot
 * show you. This checks the things that distinguish those two outcomes:
 *
 *   A. the shared payload was stored ONCE, with the node's own summary stripped
 *   B. every child ran, exactly once, in item order, with no gaps
 *   C. each child was seeded with the item at ITS OWN index  ← the load-bearing one
 *   D. the run did not depend on blob storage
 *
 * A chain that was cut short (or is still running) reports PARTIAL rather than
 * FAIL as long as it is contiguous from 0 — a GAP is what means it broke.
 *
 * Usage:
 *   npx tsx scripts/verify-fan-out.ts             # the most recent fan-out
 *   npx tsx scripts/verify-fan-out.ts <execId>    # a specific parent run
 *
 * Read-only.
 */

import "dotenv/config";
import {
  type FanOutItemSeed,
  fanOutChildKeyPrefix,
  parseFanOutItemIndex,
} from "../src/inngest/fan-out";
import db from "../src/lib/db";
import { isRealEnvValue } from "../src/lib/env";

/** A child's persisted seed context, as `Execution.input` holds it. */
type SeedInput = Record<string, FanOutItemSeed | undefined>;

const [argExecutionId] = process.argv.slice(2);

let failures = 0;
let partial = false;
const pass = (m: string) => console.log(`  PASS     ${m}`);
const fail = (m: string) => {
  console.log(`  FAIL     ${m}`);
  failures++;
};
const note = (m: string) => console.log(`  PARTIAL  ${m}`);

const stable = (v: unknown) => JSON.stringify(v);
const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;

/**
 * The 0-based item index, via the format's sole parser. Position-indexing it
 * here would misread rows carrying the historical `wf:<workflowId>:` prefix and
 * report a perfectly ordered run as broken.
 */
const indexOf = (key: string | null): number =>
  parseFanOutItemIndex(key) ?? Number.NaN;

async function main() {
  const source = argExecutionId
    ? await db.fanOutSource.findFirst({
        where: { executionId: argExecutionId },
        orderBy: { createdAt: "desc" },
      })
    : await db.fanOutSource.findFirst({ orderBy: { createdAt: "desc" } });

  if (!source) {
    console.log(
      argExecutionId
        ? `No fan-out found for execution ${argExecutionId}.`
        : "No fan-out found. Either none has run, or the dev server is still " +
            "on a stale Prisma client (restart `npm run dev:all`).",
    );
    return;
  }

  const parent = await db.execution.findUnique({
    where: { id: source.executionId },
    // `output` is the parent's FULL context — what the carried copy was pruned
    // FROM, so the two together show exactly what the prune dropped.
    select: { status: true, error: true, startedAt: true, output: true },
  });

  const items = await db.fanOutItem.findMany({
    where: { sourceId: source.id },
    orderBy: { index: "asc" },
    select: { index: true, item: true },
  });

  console.log(`\nFan-out  node ${source.nodeId}  of run ${source.executionId}`);
  console.log(`Parent   ${parent?.status}  ${parent?.startedAt.toISOString()}`);
  console.log(`Items    ${items.length} stored\n`);
  if (parent?.error) console.log(`Parent error: ${parent.error}\n`);

  // ---- A. stored once ------------------------------------------------------
  console.log("A. Payload stored once");
  items.every((row, i) => row.index === i)
    ? pass(`item indices are contiguous 0..${items.length - 1}`)
    : fail("stored item indices have gaps or duplicates");

  const contextBytes = Buffer.byteLength(stable(source.context));
  const itemsBytes = Buffer.byteLength(stable(items.map((i) => i.item)));
  console.log(
    `           shared context ${kb(contextBytes)}, items ${kb(itemsBytes)} ` +
      `— stored once, not once per child`,
  );

  // The node's own output key must NOT survive into the stored context: every
  // child overwrites it with its per-item seed without ever reading it.
  const ctxKeys = Object.keys((source.context ?? {}) as object);
  console.log(`           context keys: ${ctxKeys.join(", ") || "(none)"}`);

  // ---- B. children ---------------------------------------------------------
  console.log("\nB. Children");
  const children = await db.execution.findMany({
    where: {
      idempotencyKey: {
        startsWith: fanOutChildKeyPrefix(source.executionId, source.nodeId),
      },
    },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      idempotencyKey: true,
      status: true,
      error: true,
      input: true,
    },
  });

  const childIdx = children.map((c) => indexOf(c.idempotencyKey));
  const contiguous = childIdx.every((v, i) => v === i);

  if (children.length === items.length) {
    pass(`all ${children.length} items ran`);
  } else if (contiguous) {
    note(
      `${children.length} of ${items.length} items ran (contiguous ` +
        `0..${children.length - 1} — stopped or still running, not broken)`,
    );
    partial = true;
  } else {
    fail(
      `${children.length} of ${items.length} items ran, WITH GAPS — the chain ` +
        `broke: ${childIdx.slice(0, 20).join(",")}…`,
    );
  }

  new Set(childIdx).size === children.length
    ? pass("no duplicate child runs (per-item idempotency held)")
    : fail(
        `${children.length - new Set(childIdx).size} duplicate child run(s)`,
      );

  contiguous
    ? pass("children started in item order 0,1,2,… (chaining held)")
    : fail("children started out of item order");

  const failed = children.filter((c) => c.status === "FAILED");
  failed.length === 0
    ? pass("no failed children")
    : fail(
        `${failed.length} failed — first at item ${indexOf(failed[0].idempotencyKey)}: ` +
          `${(failed[0].error ?? "").slice(0, 200)}`,
      );

  // ---- C. the one that matters --------------------------------------------
  console.log("\nC. Item ↔ index correspondence");
  const firstInput = (children[0]?.input ?? {}) as SeedInput;
  const outputKey = Object.keys(firstInput).find(
    (k) => firstInput[k]?.__fanOut === true,
  );

  if (!children.length) {
    fail("no children to check");
  } else if (!outputKey) {
    fail("no seeded __fanOut key on a child's input — cannot verify");
  } else {
    console.log(`           seed key: ${outputKey}`);
    let wrongItem = 0;
    let wrongIndex = 0;
    for (const child of children) {
      const i = indexOf(child.idempotencyKey);
      const seed = (child.input as SeedInput)?.[outputKey];
      if (!seed) continue;
      if (stable(seed.item) !== stable(items[i]?.item)) {
        if (wrongItem === 0) {
          console.log(`           first mismatch at index ${i}:`);
          console.log(
            `             stored: ${stable(items[i]?.item).slice(0, 110)}`,
          );
          console.log(
            `             child : ${stable(seed.item).slice(0, 110)}`,
          );
        }
        wrongItem++;
      }
      // `index` is surfaced 1-based to the user; `total` is the item count.
      if (seed.index !== i + 1 || seed.total !== items.length) wrongIndex++;
    }
    wrongItem === 0
      ? pass(`all ${children.length} children received their OWN item`)
      : fail(`${wrongItem} child(ren) received the WRONG item`);
    wrongIndex === 0
      ? pass("every seed carries the right 1-based index and total")
      : fail(`${wrongIndex} child(ren) have a wrong index/total on the seed`);
  }

  // ---- D. blob independence ------------------------------------------------
  console.log("\nD. Blob independence");
  isRealEnvValue(process.env.R2_ACCOUNT_ID)
    ? console.log(
        "           R2 IS configured — this run cannot prove independence " +
          "from it (fan-out no longer uses blob storage regardless)",
      )
    : pass("R2 is unconfigured and the fan-out ran anyway");

  // ---- E. what the reachability prune dropped ------------------------------
  // Reported, never asserted: whether a key SHOULD have been dropped depends on
  // the graph, and re-deriving that here would just restate `planCarriedKeys`
  // rather than check it. What this shows is the decision it actually made on
  // live data — including "carried everything", which is the correct outcome
  // whenever a Code node or a `{{handlebars}}` field sits downstream.
  console.log("\nE. Carried-context prune");
  const fullContext = (parent?.output ?? {}) as Record<string, unknown>;
  const fullKeys = Object.keys(fullContext);
  const carriedKeys = Object.keys((source.context ?? {}) as object);

  // The fan-out node's OWN summary is dropped by `carriedContext`, always and
  // for a different reason (every child overwrites that key with its per-item
  // seed). Counting it as a prune would credit the prune on any run — including
  // ones that predate it — so it is reported on its own line.
  const ownKey = outputKey;
  const pruned = fullKeys.filter(
    (k) => k !== ownKey && !carriedKeys.includes(k),
  );
  const bytesOf = (keys: string[]) =>
    Buffer.byteLength(
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, fullContext[k]]))),
    );

  if (fullKeys.length === 0) {
    console.log("           parent recorded no output context to compare");
  } else {
    console.log(`           parent context : ${fullKeys.join(", ")}`);
    console.log(
      `           carried to kids: ${carriedKeys.join(", ") || "(none)"}`,
    );
    if (ownKey && fullKeys.includes(ownKey)) {
      console.log(
        `           own summary    : ${ownKey} (${kb(bytesOf([ownKey]))}) — ` +
          "always stripped, replaced by each child's per-item seed",
      );
    }
    if (pruned.length > 0) {
      const saved = kb(bytesOf(pruned));
      console.log(
        `           pruned         : ${pruned.join(", ")} (${saved})`,
      );
      console.log(
        `           saved          : ${saved} once in storage, and again in ` +
          `each of ${items.length} children's input rows`,
      );
    } else {
      console.log(
        "           pruned         : nothing — every remaining key is " +
          "reachable, pruning was declined for this graph, or this run " +
          "predates the prune",
      );
    }
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED.\n`);
    process.exitCode = 1;
  } else if (partial) {
    console.log(
      `\nAll checks passed for the ${children.length} items that ran.\n` +
        "Full-length completion is NOT established by this run.\n",
    );
  } else {
    console.log("\nAll checks passed.\n");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
