import { hasEnumerableRefs } from "@/config/node-references";
import type { WorkflowContext } from "@/features/executions/types";
import { forEachString } from "@/lib/dangling-refs";
import { getOutputKeyForNode, refTokensIn } from "@/lib/node-ref";

/**
 * Which of a fan-out's shared context keys its children can actually read.
 *
 * A fan-out's context is carried to every child, and most of it is usually dead
 * weight: an upstream AI node's 200 KB output is stored with the fan-out and
 * copied into all N children's `Execution.input` rows even when nothing after
 * the fan-out mentions it. Dropping what no descendant can reference makes that
 * cost track what the workflow actually uses.
 *
 * ## The failure this must never cause
 *
 * Pruning a key that IS read does not raise an error. `renderTemplate` resolves
 * a missing path to the empty string, so the run continues, every reference to
 * the dropped value renders blank, and each node still performs its real side
 * effect — blank cells written to a sheet, empty messages sent. The same
 * silently-destructive shape `replayFromNode` refuses a truncation marker to
 * avoid. A wrong answer here is far worse than no pruning at all.
 *
 * So this is deliberately one-directional: it only ever prunes what it can
 * PROVE is unreadable, and returns `null` — meaning "carry everything" — the
 * moment the graph contains anything it cannot read exhaustively. Over-keeping
 * costs bytes. Under-keeping corrupts runs.
 *
 * ## Why this names what to DROP, not what to keep
 *
 * The first version listed the keys to KEEP, and that shape is quietly
 * dangerous: an empty result means "drop everything", so any bug that fails to
 * collect a reference deletes live data. Naming the DROPPABLE keys inverts it —
 * an empty result means "drop nothing", so the same bug degrades to carrying
 * the whole context.
 *
 * The set of droppable keys is also derived positively, from the workflow's own
 * node output keys, rather than as "everything not referenced". Only a key this
 * module can attribute to a node it can see is ever a candidate. That is what
 * makes the following safe, all of which are otherwise invisible here:
 *
 *   - Trigger payloads seeded at the context ROOT by a webhook route
 *     (`commentId`, `commentText`, `commenterName`, `postId` — see
 *     `api/webhooks/instagram/route.ts`), which belong to no node.
 *   - Fixed keys an executor writes beside its own output (`aiReply`, written
 *     by `ai-reply-generator/executor.ts`).
 *   - Fixed keys an executor READS with plain property access rather than
 *     through a template — `context.commentText` in the reply generator,
 *     `context.commentId` in the Instagram and YouTube reply nodes. No scan of
 *     node configs can see these, because they appear in no config.
 *
 * Scanning `@<path>@` tokens alone would have dropped every one of them, and a
 * reply node would have posted a comment about "someone" instead of the
 * commenter. Attribution is what closes that hole in general, rather than by a
 * list of exceptions that the next such executor would silently fall out of.
 */

/**
 * Context keys safe to drop, or `null` when nothing may be dropped at all.
 * Empty and `null` both mean "carry everything"; they differ only in why.
 */
export type DroppableKeys = ReadonlySet<string> | null;

/** The minimum a node must expose for its references and output key to be read. */
export type PrunableNode = {
  id: string;
  type: string;
  /** Stable per-workflow reference key; see `node-ref.ts`. */
  ref?: string | null;
  data: unknown;
};

/**
 * Scans one node's config, collecting `@<path>@` roots and reporting whether it
 * uses legacy Handlebars. ONE traversal doing both, over `forEachString` —
 * the walker `dangling-refs.ts` already owns, so the pruner and the detector
 * cannot drift apart about what a config contains.
 *
 * `{{...}}` is a fully supported syntax (see `templating.ts`) that `refTokensIn`
 * cannot see — it only matches `@<path>@`. Worse, Handlebars is not a path
 * grammar: `{{#each rows}}`, `{{lookup obj key}}`, `{{../outer}}` and custom
 * helpers can reach values no static scan would attribute to the right root
 * key. So its mere PRESENCE anywhere downstream disables pruning for the whole
 * fan-out: extracting roots from it would be a guess, and a wrong guess here
 * blanks a field rather than reporting a problem.
 */
function scanConfig(
  data: unknown,
  into: Set<string>,
): { usesHandlebars: boolean } {
  let usesHandlebars = false;
  forEachString(data, (text) => {
    if (text.includes("{{")) usesHandlebars = true;
    for (const { ref } of refTokensIn(text)) into.add(ref);
  });
  return { usesHandlebars };
}

/**
 * The context keys a fan-out's children provably cannot read, or `null` to
 * carry everything.
 *
 * `reachable` is the fan-out node plus its descendants — exactly the nodes a
 * child run executes. `allNodes` is the whole workflow, and supplies the only
 * keys eligible for dropping: a key is a candidate ONLY if it is some node's
 * output key. Anything else in the context — a webhook-seeded trigger payload,
 * a fixed key an executor writes or reads directly — is not attributable here
 * and is therefore never touched.
 *
 * Root keys, never whole paths. A reference like `@<OG_SHEETS.rows.0.name>@`
 * keeps the entire `OG_SHEETS` value: the context holds live objects whose
 * interior shape only the run knows, so trimming inside one would mean
 * rebuilding a value from a path list — far more machinery, and every gap in it
 * is a silently blanked field. Whole-key granularity is where the bytes are
 * anyway; the case worth winning is an unused node output, not an unused
 * property of a used one.
 *
 * Every field is scanned, including ones the node's current mode ignores
 * (`nodeInactiveFields`). Those cannot be read at run time, so counting them
 * only over-keeps — and over-keeping is the safe direction. Using that registry
 * to prune harder would make a bug in it corrupt runs instead of merely
 * producing a stale warning, which is not a trade worth making.
 */
export function planDroppableKeys(
  reachable: PrunableNode[],
  allNodes: PrunableNode[],
): DroppableKeys {
  const referenced = new Set<string>();

  for (const node of reachable) {
    // A node whose reads are not enumerable from `@<path>@` tokens forfeits
    // pruning for the whole fan-out. `hasEnumerableRefs` is a predicate of its
    // own rather than the dangling-ref detector's `isRefCheckedNodeType` —
    // see `node-references.ts` for why sharing one would couple a UI-warning
    // decision to a data-safety one in the direction that fails unsafely.
    if (!hasEnumerableRefs(node.type)) return null;
    if (scanConfig(node.data, referenced).usesHandlebars) return null;
  }

  // Candidates come from the graph, not from the context: a key no node here
  // produces is one this module cannot reason about, so it stays.
  const droppable = new Set<string>();
  for (const node of allNodes) {
    const key = getOutputKeyForNode(node.type, node.id, node.ref);
    if (!referenced.has(key)) droppable.add(key);
  }
  return droppable;
}

/**
 * `context` without `drop`, or unchanged when `drop` is `null` or empty.
 *
 * Separate from the planning so the decision (which needs the graph) and the
 * edit (which needs the live context) can each be tested on their own.
 */
export function pruneCarriedContext(
  context: WorkflowContext,
  drop: DroppableKeys,
): WorkflowContext {
  if (drop === null || drop.size === 0) return context;

  const pruned: WorkflowContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (!drop.has(key)) pruned[key] = value;
  }
  return pruned;
}
