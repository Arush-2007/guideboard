import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@/generated/prisma";
import prisma from "@/lib/db";
import {
  getOutputKeyForNode,
  legacyOutputKey,
  rewriteRefsInJson,
  stripRefFromData,
} from "@/lib/node-ref";

/**
 * Whole-workflow copy: the "Copy" action on the workflows list.
 *
 * Kept out of `workflow-persistence.ts` because that module owns the
 * *generated* (LLM → JSON → rows) path; a copy starts from rows that are
 * already valid, so it needs none of that validation — only faithful
 * re-identification of the graph.
 */

/** Matches a copy suffix: a trailing `.2`, `.3`, … (never `.0` / `.1`). */
const COPY_SUFFIX_RE = /\.(\d+)$/;

/**
 * The name a copy chain is numbered from.
 *
 * `Lead capture.2` copies to `Lead capture.3`, not `Lead capture.2.2` — the
 * suffix names a position in one series, so it is stripped before renumbering.
 * `.0` and `.1` are left alone: they are not suffixes this function ever mints,
 * so they're far more likely part of the user's own name (`Sheet 2.0`). A
 * version-looking name like `Invoice v1.2` will be treated as a suffix; the
 * result is still a correct, non-colliding name, just numbered from `Invoice v1`.
 */
export function copyBaseName(name: string): string {
  const match = name.match(COPY_SUFFIX_RE);
  if (!match) return name;
  if (Number(match[1]) < 2) return name;
  return name.slice(0, -match[0].length);
}

/**
 * The next free `<base>.<n>` for a copy of `sourceName`, given the names that
 * already exist. The original itself counts as number 1, so the first copy is
 * always `.2`; gaps are not filled (three copies of a workflow whose `.2` was
 * deleted still produce `.4`), because reusing a number would put a fresh
 * workflow under a name the user may still recognise as the deleted one.
 */
export function nextCopyName(
  sourceName: string,
  existingNames: Iterable<string>,
): string {
  const base = copyBaseName(sourceName);
  const prefix = `${base}.`;

  let max = 1;
  for (const name of existingNames) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (n > max) max = n;
  }

  return `${base}.${max + 1}`;
}

/**
 * Duplicates a workflow's graph into a brand-new workflow owned by the same
 * user, and returns the new row.
 *
 * Node ids are regenerated (`Node.id` is a global primary key, so they cannot be
 * shared), which is the one thing that makes this more than a row copy:
 *
 *   - Connections are remapped through the id map, so the copy's edges point at
 *     the copy's nodes and never back at the original's.
 *   - `ref` is preserved verbatim. Refs are unique *per workflow*, so the copy
 *     can hold the same ones — and preserving them is what keeps every
 *     `@<AI_TEXT_1.output>@` reference inside the copied data pointing at the
 *     copied producer.
 *   - Data authored before refs existed references a producer by its legacy
 *     `<type>_<id>` key, which embeds the id that just changed. Those are
 *     rewritten to whatever key the *copied* node now writes under — its ref, or
 *     its new legacy key for ref-less types (triggers).
 *
 * Trigger poll rows are deliberately NOT provisioned: a copy is a draft, and
 * silently doubling a live Gmail/Sheets/Schedule automation the moment someone
 * clicks Copy is the wrong default. The copy starts polling when the user opens
 * and saves it, which runs `syncTriggerPollsForWorkflow` through the normal
 * editor path. A WEBHOOK_TRIGGER likewise gets its own fresh URL there rather
 * than inheriting the original's.
 *
 * `pendingFirstSave` is what keeps that honest: an inert workflow that LOOKS
 * saved is a trap, so the flag makes the editor open the copy dirty — the Save
 * button reads "Save", not "Saved" — until the save that actually activates it
 * lands. `workflows.update` clears it.
 */
export async function duplicateWorkflow(userId: string, workflowId: string) {
  const source = await prisma.workflow.findUnique({
    where: { id: workflowId, userId },
    include: { nodes: true, connections: true },
  });

  if (!source) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found" });
  }

  // Over-matches by design (`startsWith` on the base), because the exact
  // `base.<n>` shape is decided in `nextCopyName`; this only has to be a
  // superset of the candidates.
  const siblings = await prisma.workflow.findMany({
    where: { userId, name: { startsWith: copyBaseName(source.name) } },
    select: { name: true },
  });

  const name = nextCopyName(
    source.name,
    siblings.map((sibling) => sibling.name),
  );

  const newIdByOldId = new Map(
    source.nodes.map((node) => [node.id, createId()]),
  );
  const newNodeId = (oldId: string): string => {
    const id = newIdByOldId.get(oldId);
    if (!id) {
      // Only reachable if a connection outlived its node, which the schema's
      // cascade makes impossible — fail loudly rather than write a broken graph.
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Workflow has a connection to a missing node",
      });
    }
    return id;
  };

  const legacyKeyToNewKey = new Map<string, string>();
  for (const node of source.nodes) {
    legacyKeyToNewKey.set(
      legacyOutputKey(node.type, node.id),
      getOutputKeyForNode(node.type, newNodeId(node.id), node.ref),
    );
  }

  return prisma.$transaction(async (tx) => {
    const workflow = await tx.workflow.create({
      data: { name, userId, pendingFirstSave: true },
    });

    await tx.node.createMany({
      data: source.nodes.map((node) => ({
        id: newNodeId(node.id),
        workflowId: workflow.id,
        name: node.name,
        type: node.type,
        ref: node.ref,
        position: node.position as Prisma.InputJsonValue,
        credentialId: node.credentialId,
        // `stripRefFromData` for the same reason as the other two node-write
        // paths: the ref belongs to the `Node.ref` column, and a legacy row
        // whose blob still carries one must not copy that drift forward.
        data: JSON.parse(
          rewriteRefsInJson(
            JSON.stringify(
              stripRefFromData(node.data as Record<string, unknown> | null),
            ),
            legacyKeyToNewKey,
          ),
        ),
      })),
    });

    if (source.connections.length > 0) {
      await tx.connection.createMany({
        data: source.connections.map((connection) => ({
          workflowId: workflow.id,
          fromNodeId: newNodeId(connection.fromNodeId),
          toNodeId: newNodeId(connection.toNodeId),
          fromOutput: connection.fromOutput,
          toInput: connection.toInput,
        })),
      });
    }

    return workflow;
  });
}
