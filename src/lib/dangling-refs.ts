import {
  inactiveFieldsForNode,
  isRefCheckedNodeType,
  selfRootsForType,
} from "@/config/node-references";
import { isCustomFeatureRef } from "@/lib/custom-feature-token";
import {
  readNodeRef,
  refTokensIn,
  removePathsInTemplate,
} from "@/lib/node-ref";
import {
  fieldsForNode,
  type GraphNode,
  getUpstreamNodeIds,
} from "@/lib/upstream-fields";

/**
 * Detection of DANGLING references — `@<REF.path>@` tokens naming a node that
 * cannot reach the node holding them.
 *
 * A node's config is authored against the nodes upstream of it, but nothing ties
 * the two together afterwards, so the config can outlive the wiring that made it
 * valid. Duplicating a node is the loudest case (the clone deep-copies `data`
 * but inherits no edges, so every token in it is instantly dead), though it is
 * not special: deleting an edge, re-parenting a branch, or dragging a node above
 * its source does the same thing. Node DELETION is already handled upstream of
 * this module, by `clearRefsForRemovedNodes` on the editor's `onNodesChange`.
 *
 * Left alone, a dead token renders to the empty string at run time — a silently
 * blank message body or spreadsheet cell, with nothing on the canvas to say why.
 * Three surfaces consume this module so that never happens quietly, and all
 * three had to exist: a node's own settings dialog only ever checks the node the
 * user chose to open, so on its own it misses the copy nobody reopened.
 *
 *   - `useDanglingRefGuard` — the per-node save guard in every settings dialog.
 *   - `<DanglingRefValidator>` → `<DanglingRefsBadge>` — the canvas badge,
 *     raised the instant a bad duplicate or a cut wire creates one.
 *   - `useSaveEditorWorkflow` → `<DanglingSaveDialog>` — the whole-canvas check
 *     at the single save path, so nothing reaches the database unremarked.
 *
 * Kept React-free (it takes plain graph shapes, not hooks) so the rule is
 * unit-testable and lives in one place for all three.
 */

export type GraphEdge = { source: string; target: string };

/**
 * Every VALUE `currentNodeId` may legitimately reference — the exact list of
 * paths the variable picker offers it.
 *
 * Whole paths, not just the producing step's name. Matching on the name alone
 * (`OG_SHEETS`) only ever answers "is that step connected?", which misses the
 * commoner failure by far: the step IS connected but no longer publishes the
 * value being asked for — a sheet column renamed or removed, a node switched to
 * a mode that emits a different shape. Those render blank exactly like an
 * unconnected step does, and the user has no way to see why.
 *
 * Built from `fieldsForNode` — the picker's own model — so the guard and the
 * picker can never disagree: a value the user could have inserted a moment ago
 * is never called dead by the next save. Two things the upstream walk can't see
 * are unioned in:
 *
 *   - The node's OWN self-roots (`selfRootsForType`), which it injects while
 *     rendering its own fields. The picker offers these through its
 *     `extraGroups` prop rather than through the graph.
 *   - Nothing else. In particular the bare output key is NOT added for a node
 *     that declares fields: adding it would make every path beneath it a valid
 *     drill-down and collapse this straight back to name-only matching.
 */
export type ReachableValues = {
  /** The exact paths the picker offers. */
  paths: ReadonlySet<string>;
  /**
   * Containers whose contents are known EXHAUSTIVELY — the parents of
   * `discoveredFields`, read off live data. A path inside one of these that is
   * not offered is genuinely absent.
   */
  closed: ReadonlySet<string>;
  /** Root keys reachable at all, for everything no closed container covers. */
  roots: ReadonlySet<string>;
};

export function availablePaths(
  currentNodeId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): ReachableValues {
  // Only this node's ancestry, not the whole canvas: a dialog save asks about
  // ONE node, and building every node's set to read a single entry would run
  // `fieldsForNode` for every node on the canvas to answer it.
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const acc = emptyReachable();
  for (const id of getUpstreamNodeIds(currentNodeId, edges)) {
    const node = nodeById.get(id);
    if (node) addPublishedPaths(acc, node);
  }
  for (const root of selfRootsForType(nodeById.get(currentNodeId)?.type)) {
    // A self-root's fields are dialog-built from live sheet headers, which this
    // walk cannot see — so the root is reachable and its contents are open.
    acc.roots.add(root);
  }
  return acc;
}

type MutableReachable = {
  paths: Set<string>;
  closed: Set<string>;
  roots: Set<string>;
};

function emptyReachable(): MutableReachable {
  return { paths: new Set(), closed: new Set(), roots: new Set() };
}

/**
 * Builds a {@link ReachableValues} from a flat list of offered paths, deriving
 * the reachable roots from them. `closed` containers must be named explicitly —
 * only live-discovered fields carry that authority (see `isOfferedPath`).
 */
export function reachableValues(
  paths: Iterable<string>,
  closed: Iterable<string> = [],
): ReachableValues {
  const acc = emptyReachable();
  for (const path of paths) {
    acc.paths.add(path);
    const root = path.split(".", 1)[0];
    if (root) acc.roots.add(root);
  }
  for (const container of closed) acc.closed.add(container);
  return acc;
}

/**
 * Adds everything ONE node publishes — the unit every available-set is unioned
 * from.
 *
 * A discovered field additionally CLOSES its parent: those siblings came from
 * the live data, so together they are the whole of it.
 */
function addPublishedPaths(into: MutableReachable, node: GraphNode): void {
  for (const row of fieldsForNode(node)) {
    into.paths.add(row.path);
    const root = row.path.split(".", 1)[0];
    if (root) into.roots.add(root);
    if (row.discovered) {
      // Guarded on the INDEX, not on the resulting string. A dot-less path
      // (`rows`) gives `lastIndexOf` of -1, and `slice(0, -1)` is the path minus
      // its LAST CHARACTER — `row` — which is a plausible-looking string, so the
      // old `if (parent)` check waved it through and registered it as a closed
      // container. Everything beginning `row.` would then be declared
      // authoritatively absent: an amber badge that will not clear, and a
      // "Remove and save" that erases a working field. A single-segment
      // discovered path simply has no parent to close.
      const dot = row.path.lastIndexOf(".");
      if (dot > 0) into.closed.add(row.path.slice(0, dot));
    }
  }
}

/**
 * Whether a reference resolves to a value this node can actually read.
 *
 * Three questions, in order, and the middle one is the whole design:
 *
 *   1. Is the exact path on offer? Then yes.
 *   2. Does it sit inside a CLOSED container — one whose contents were read off
 *      the live data? Then no. A Sheets `find_rows` step lists a path per column
 *      it found, so `OG_SHEETS.firstRow.Customer Name` after that column was
 *      renamed is a value the sheet demonstrably no longer has.
 *   3. Otherwise, is the producing step reachable at all? Then yes.
 *
 * Step 3 is deliberately permissive, because the static output registry is a
 * CURATED list, not a description: `node-outputs.ts` declares what is worth
 * offering in the picker and routinely omits outputs the executor really emits —
 * Sheets `find_rows` publishes `rows`, which no descriptor mentions, and a Code
 * node reading `input.GOVT_DETAILS.rows` is entirely correct. Treating that
 * registry as exhaustive put an amber badge on working code. Only the discovered
 * fields carry the authority to say something is missing, so only they do.
 */
function isOfferedPath(path: string, available: ReachableValues): boolean {
  if (available.paths.has(path)) return true;

  for (const container of available.closed) {
    if (path.startsWith(`${container}.`)) return false;
  }

  const root = path.split(".", 1)[0];
  return root ? available.roots.has(root) : false;
}

/**
 * {@link availablePaths} for every node at once.
 *
 * The canvas validator runs this on every React Flow store change, so the shape
 * of the work matters. Each node's published refs are derived ONCE, and each
 * node's available set is its predecessors' published ∪ available sets — so
 * every EDGE is relaxed exactly once, rather than each node re-walking its whole
 * ancestry and re-scanning the edge list at every step (which was O(V²·E)).
 *
 * The union itself still copies strings, so this is O(E × ancestor refs) rather
 * than truly linear — fine at canvas sizes, and the honest description.
 *
 * A CYCLE abandons the memoized walk entirely and redoes the map exhaustively,
 * one independent ancestry scan per node. Breaking a back-edge mid-walk yields a
 * set that is correct for the node on the stack but INCOMPLETE for anything
 * downstream of the cycle, and memoizing it spreads that hole further — a node
 * below `A⇄B` would lose everything the branch above the cycle published, and its
 * perfectly good references would be called dead (and offered for removal) while
 * its own dialog said they were fine. The exhaustive pass is O(V²·E) and only
 * runs on a graph the engine already refuses to execute, so paying for it there
 * is the right trade.
 */
export function availablePathsByNode(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, ReachableValues> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const predecessors = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const list = predecessors.get(edge.target);
    if (list) list.push(edge.source);
    else predecessors.set(edge.target, [edge.source]);
  }

  // Upstream values ONLY, because this is what propagates: a self-root is
  // node-local and must not flow to a node's successors.
  const fromUpstream = new Map<string, MutableReachable>();
  const visiting = new Set<string>();
  let cyclic = false;

  const resolve = (id: string): MutableReachable => {
    const done = fromUpstream.get(id);
    if (done) return done;
    // A back-edge. Every set computed from here on is potentially incomplete, so
    // the whole memoized walk is discarded below rather than trusted.
    if (visiting.has(id)) {
      cyclic = true;
      return EMPTY_REACHABLE;
    }

    visiting.add(id);
    const acc = emptyReachable();
    for (const from of predecessors.get(id) ?? []) {
      const node = nodeById.get(from);
      if (node) addPublishedPaths(acc, node);
      mergeReachable(acc, resolve(from));
    }
    visiting.delete(id);

    fromUpstream.set(id, acc);
    return acc;
  };

  const upstreamById = new Map<string, MutableReachable>();
  for (const node of nodes) upstreamById.set(node.id, resolve(node.id));

  if (cyclic) {
    // Redo it the slow, unconditionally-correct way: each node's ancestry walked
    // on its own, so no node inherits a set that was cut short by a back-edge.
    upstreamById.clear();
    for (const node of nodes) {
      const acc = emptyReachable();
      for (const id of getUpstreamNodeIds(node.id, edges)) {
        const from = nodeById.get(id);
        if (from) addPublishedPaths(acc, from);
      }
      upstreamById.set(node.id, acc);
    }
  }

  const byNode = new Map<string, ReachableValues>();
  for (const node of nodes) {
    const upstream = upstreamById.get(node.id) ?? emptyReachable();
    const selfRoots = selfRootsForType(node.type);
    if (selfRoots.length === 0) {
      byNode.set(node.id, upstream);
      continue;
    }
    // Copied rather than mutated: `upstream` is the set this node hands to its
    // successors, and adding a node-local root to it would leak that root
    // downstream — the precise thing self-roots are not.
    const own = emptyReachable();
    mergeReachable(own, upstream);
    for (const root of selfRoots) own.roots.add(root);
    byNode.set(node.id, own);
  }
  return byNode;
}

function mergeReachable(into: MutableReachable, from: ReachableValues): void {
  for (const path of from.paths) into.paths.add(path);
  for (const container of from.closed) into.closed.add(container);
  for (const root of from.roots) into.roots.add(root);
}

/** Shared stand-in for the cycle break. Never mutated — see `resolve`. */
const EMPTY_REACHABLE: MutableReachable = emptyReachable();

/**
 * The two walks over a config blob, read and write.
 *
 * A config puts references anywhere a string can go — a top-level prompt, a
 * column mapping's value, a condition nested two arrays deep — so both walks go
 * generically rather than naming fields. Each carries the OUTERMOST key down:
 * it names the control the user filled in ("Column mappings"), which is what
 * they need in order to go find it, whereas the index and sub-key below it
 * ("…0.value") name a row of a list they can already see once they are looking
 * at the right field.
 *
 * Deliberately NOT the `JSON.stringify` round-trip `removeRefsInData` uses:
 * these run over a form's submitted values, where dropping `undefined` keys
 * would turn "clear this field" into "leave it as it was".
 */

/**
 * Read-only walk. Separate from `mapStrings` because the detector runs over
 * every node on every graph change, and rebuilding each config just to look at
 * it made a Sheets node's ~100 mapping and discovered-field objects into that
 * much immediate garbage, per node, per change.
 *
 * Exported for `inngest/carried-context.ts`, which asks a different question of
 * the same trees (which context keys can this sub-graph read?) and must not
 * disagree with this module about what a config CONTAINS — the two are already
 * coupled through `isRefCheckedNodeType`, so a second hand-rolled walk could
 * drift the pruner away from the detector silently.
 */
export function forEachString(
  value: unknown,
  fn: (text: string, key: string) => void,
  key = "",
): void {
  if (typeof value === "string") {
    fn(value, key);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) forEachString(item, fn, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) {
      forEachString(item, fn, key || name);
    }
  }
}

/** Rebuilding walk, for the half that actually edits the config. */
function mapStrings(
  value: unknown,
  fn: (text: string, key: string) => string,
  key = "",
): unknown {
  if (typeof value === "string") return fn(value, key);
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, fn, key));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      out[name] = mapStrings(item, fn, key || name);
    }
    return out;
  }
  return value;
}

/** One dead reference, as the user needs to see it. */
export type DanglingRef = {
  /**
   * The producing node the reference names. Not shown on its own — it is what
   * makes the reference dead, and what {@link stripDanglingRefs} removes by.
   */
  ref: string;
  /** The reference as written, without its wrapper: `AI_TEXT_2.output`. */
  path: string;
  /** The config key holding it, e.g. `message` — "" if it sat at the root. */
  field: string;
};

/**
 * Every reference a config names that `available` does not offer, in first-seen
 * order, deduplicated by the pair a user can act on (which field, which value).
 *
 * Reports whole PATHS, not just the refs behind them: `AI_TEXT_2` is the name of
 * a step, and a user reading it has to work out which of that step's values the
 * field was pulling. `AI_TEXT_2.output` is the thing that was actually in the
 * box.
 *
 * Detection matches the WHOLE path against what the picker offers this node
 * (`isOfferedPath`), not just the producing step's name. A reference is dead
 * whenever the exact value it names is not on offer — whether because the step
 * isn't connected, or because it is connected and no longer publishes that
 * value. Both render blank; only the first would be caught by matching names.
 * Drill-downs past an offered value stay valid, since the run is the only thing
 * that knows the shape inside one.
 *
 * Only `@<path>@` TOKENS are looked for. The Code node, whose references are
 * JavaScript rather than templates, is excluded from checking altogether — see
 * `isRefCheckedNodeType` for why.
 */
export function findDanglingRefs(
  config: unknown,
  available: ReachableValues,
  options: {
    /**
     * The node's type. Two things depend on it: whether this node is checked at
     * all, and which fields its CURRENT settings ignore — a Sheets node set to
     * `find_rows` still carries the column mappings it had as an append, and
     * nothing will ever render them. See `config/node-references.ts`; the
     * discriminator (`action`, `source`, …) is read from `config` itself, which
     * is the same blob being scanned.
     */
    nodeType?: string | null;
  } = {},
): DanglingRef[] {
  if (!isRefCheckedNodeType(options.nodeType)) return [];

  const inactive = inactiveFieldsForNode(
    options.nodeType,
    config as Record<string, unknown> | null | undefined,
  );
  const dangling: DanglingRef[] = [];

  forEachString(config, (text, key) => {
    // A field the node's current settings never read cannot produce a blank at
    // run time, so a dead reference in it is not a problem to report.
    if (inactive.has(key)) return;

    for (const { ref, path } of refTokensIn(text)) {
      // Custom-feature tokens (`@<custom:serialNumber?…>@`) wear the placeholder
      // shape deliberately — see `custom-feature-token.ts` — but name a
      // behaviour of the node being configured rather than data flowing in, so
      // no wiring can make them reachable or unreachable. Checked here, not via
      // `available`, because that is a property of the GRAMMAR and holds for
      // every node; the node-specific exceptions live in `availablePaths`.
      if (isOfferedPath(path, available) || isCustomFeatureRef(ref)) continue;
      const seen = dangling.some((d) => d.path === path && d.field === key);
      if (!seen) dangling.push({ ref, path, field: key });
    }
  });
  return dangling;
}

/** One node's dead references, for the canvas badge and the save summary. */
export type NodeDanglingRefs = {
  nodeId: string;
  /** Carried raw so the caller names the node via `displayNameFor`. */
  nodeRef: string | null;
  nodeType: string;
  refs: DanglingRef[];
};

/**
 * Every dead reference on the canvas, per node.
 *
 * The whole-canvas counterpart to the per-node save guard, and the reason the
 * guard alone was not enough: a duplicated node's references only pass through
 * its dialog if the user happens to OPEN that dialog. Duplicate, wire it wrong,
 * hit Save, and nothing had ever looked at it.
 *
 * Nodes with nothing wrong are absent from the result entirely, so an empty
 * array means a clean canvas.
 */
export function findDanglingRefsByNode(
  nodes: GraphNode[],
  edges: GraphEdge[],
): NodeDanglingRefs[] {
  const available = availablePathsByNode(nodes, edges);
  const found: NodeDanglingRefs[] = [];
  for (const node of nodes) {
    if (!node.type) continue;
    const refs = findDanglingRefs(
      node.data,
      available.get(node.id) ?? reachableValues([]),
      { nodeType: node.type },
    );
    if (refs.length === 0) continue;
    found.push({
      nodeId: node.id,
      nodeRef: readNodeRef(node.data),
      nodeType: node.type,
      refs,
    });
  }
  return found;
}

/** Every dead reference sitting in one config field. */
export type DanglingFieldGroup = {
  /** The config key, "" if the value sat at the root. */
  field: string;
  /** The dead references in it, in first-seen order. */
  refs: DanglingRef[];
};

/**
 * Collapses a node's dead references to one entry per FIELD.
 *
 * A single missing step takes every field that named it, and a Sheets node maps
 * a column per sheet header — so one bad wire routinely produces a dozen-plus
 * findings that differ only in the column name. Listed one per line they bury
 * the thing the user has to act on, which is WHICH FIELDS went blank, not which
 * seventeen values did.
 *
 * Grouped by field rather than by the missing step: a node whose fields name two
 * different missing steps would otherwise be split across two headings, and the
 * user still has to go to each field to fix it either way.
 */
export function groupByField(refs: DanglingRef[]): DanglingFieldGroup[] {
  const byField = new Map<string, DanglingFieldGroup>();
  for (const ref of refs) {
    const group = byField.get(ref.field);
    if (group) group.refs.push(ref);
    else byField.set(ref.field, { field: ref.field, refs: [ref] });
  }
  return [...byField.values()];
}

/**
 * Applies {@link stripDanglingRefs} to each listed node, leaving every other
 * node — and the array's order — untouched.
 *
 * Takes the ALREADY-FOUND list rather than re-deriving it, so what the user was
 * shown in the save warning is exactly what gets removed; a graph that changed
 * in between cannot widen the blast radius. Non-removable findings are skipped
 * entirely — a Code node's references are reported but never edited, because
 * cutting one out of a program breaks its syntax.
 */
export function stripDanglingRefsInNodes<T extends GraphNode>(
  nodes: T[],
  found: NodeDanglingRefs[],
): T[] {
  const pathsByNode = new Map(
    found
      .map(
        (entry) =>
          [entry.nodeId, new Set(entry.refs.map((r) => r.path))] as const,
      )
      .filter(([, paths]) => paths.size > 0),
  );
  if (pathsByNode.size === 0) return nodes;
  return nodes.map((node) => {
    const paths = pathsByNode.get(node.id);
    if (!paths) return node;
    return { ...node, data: stripDanglingRefs(node.data ?? {}, paths) };
  });
}

/**
 * A plain-language note for an AI-BUILT workflow whose references were stripped,
 * or "" when there was nothing to strip.
 *
 * Written here, beside the detector, because both builders (the conversational
 * one and `generateFromPrompt`) have to say the same thing — and because the
 * user reading it never asked for a reference and has no idea what one is. It
 * names the step and the field so they know where to look, and says plainly that
 * the field is now empty.
 */
export function describeStrippedRefs(found: NodeDanglingRefs[]): string {
  // Counted in FIELDS, not references: two dead values in one box is one field
  // to go and fix, and saying "2 fields" sends the user looking for a second.
  const places = found.map((entry) => {
    const refs = entry.refs;
    const fields = [
      ...new Set(
        refs.map((ref) =>
          ref.field ? humanizeFieldKey(ref.field) : "a field",
        ),
      ),
    ];
    return { name: entry.nodeRef ?? entry.nodeType, fields };
  });

  const total = places.reduce((sum, place) => sum + place.fields.length, 0);
  if (total === 0) return "";

  const one = total === 1;
  const where = places
    .map((place) => `${place.name} (${place.fields.join(", ")})`)
    .join("; ");

  return (
    `Heads up: I cleared ${one ? "1 field" : `${total} fields`} that ` +
    `pulled a value the step before ${one ? "it" : "them"} doesn't produce — ` +
    `${where}. ${one ? "It is" : "They are"} empty now, so open the ` +
    `workflow and fill ${one ? "it" : "them"} in before running it.`
  );
}

/** `recipientPhones` → "Recipient phones", for naming the field in the warning. */
export function humanizeFieldKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/**
 * Returns `config` with every `@<path>@` token whose WHOLE path is in `paths`
 * removed, and the prose around it kept.
 *
 * Keyed on the exact paths that were REPORTED, never on the steps behind them.
 * Detection is per-value — it exists to say "this one column is gone from an
 * otherwise healthy step" — so removing by step would erase the sibling values
 * that still work, which is precisely what the warning promises it won't do.
 *
 * Token-level, not field-level: "Summarize @<SLACK_2.ts>@ politely" becomes
 * "Summarize  politely", not "". Node DELETION is the one case that legitimately
 * takes a whole step at once, and it has its own door
 * (`removeRefsInData` → `removeRefsInTemplate`).
 */
export function stripDanglingRefs<T>(config: T, paths: ReadonlySet<string>): T {
  if (paths.size === 0) return config;
  return mapStrings(config, (text) => removePathsInTemplate(text, paths)) as T;
}
