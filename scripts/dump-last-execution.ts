/**
 * Diagnostic: what actually happened in a run?
 *
 * Prints one execution end to end — its status and error, every NodeExecution in
 * sequence with its output, and the workflow's wiring — so a run that "stopped
 * for no reason" can be read against the graph it was walking. The execution page
 * shows the friendly view; this shows the raw rows it is rendered from.
 *
 * Usage:
 *   npx tsx scripts/dump-last-execution.ts            # the most recent run
 *   npx tsx scripts/dump-last-execution.ts <execId>   # a specific run
 *
 * Read-only.
 */

import "dotenv/config";
import db from "../src/lib/db";

const [argExecutionId] = process.argv.slice(2);

/** Compact JSON, truncated — node outputs can carry whole sheet tables. */
function brief(value: unknown, max = 1500): string {
  if (value === null || value === undefined) return String(value);
  const s = JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

async function main() {
  const execution = argExecutionId
    ? await db.execution.findUnique({
        where: { id: argExecutionId },
        include: { nodeExecutions: { orderBy: { sequence: "asc" } } },
      })
    : await db.execution.findFirst({
        orderBy: { startedAt: "desc" },
        include: { nodeExecutions: { orderBy: { sequence: "asc" } } },
      });

  if (!execution) {
    console.error("No execution found.");
    process.exit(1);
  }

  console.log("#".repeat(72));
  console.log(`execution ${execution.id}`);
  console.log(`  workflow    ${execution.workflowId}`);
  console.log(`  status      ${execution.status}`);
  console.log(`  started     ${execution.startedAt.toISOString()}`);
  console.log(`  completed   ${execution.completedAt?.toISOString() ?? "—"}`);
  console.log(`  idempotency ${execution.idempotencyKey ?? "—"}`);
  if (execution.error) console.log(`  ERROR       ${execution.error}`);
  if (execution.errorStack)
    console.log(`  stack       ${execution.errorStack}`);
  console.log(`  input       ${brief(execution.input)}`);
  console.log(`  output      ${brief(execution.output, 3000)}`);

  console.log(
    `\n${"=".repeat(72)}\nNODE EXECUTIONS (${execution.nodeExecutions.length})`,
  );
  for (const ne of execution.nodeExecutions) {
    console.log(
      `\n  [${ne.sequence}] ${ne.nodeName} (${ne.nodeType}) — ${ne.status}` +
        ` ${ne.durationMs ?? "?"}ms  nodeId=${ne.nodeId}`,
    );
    if (ne.error) console.log(`      ERROR: ${ne.error}`);
    console.log(`      in : ${brief(ne.input, 600)}`);
    console.log(`      out: ${brief(ne.output, 3000)}`);
  }

  // The graph the run was walking, so a stop can be read as "no edge from the
  // branch it took" rather than guessed at.
  const nodes = await db.node.findMany({
    where: { workflowId: execution.workflowId },
    select: { id: true, ref: true, name: true, type: true, data: true },
  });
  const connections = await db.connection.findMany({
    where: { workflowId: execution.workflowId },
    select: {
      fromNodeId: true,
      toNodeId: true,
      fromOutput: true,
      toInput: true,
    },
  });
  const label = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? `${n.ref ?? n.name} (${n.type})` : id;
  };

  console.log(`\n${"=".repeat(72)}\nWORKFLOW GRAPH`);
  for (const n of nodes) {
    console.log(`\n  ${n.ref ?? n.name} [${n.type}] ${n.id}`);
    console.log(`      data: ${brief(n.data, 2000)}`);
  }
  console.log(`\n  edges:`);
  for (const c of connections) {
    console.log(
      `      ${label(c.fromNodeId)} --${c.fromOutput}--> ${label(c.toNodeId)}`,
    );
  }

  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
