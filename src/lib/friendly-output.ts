import { type NodeOutputDescriptor, nodeOutputs } from "@/config/node-outputs";
import type { NodeType } from "@/generated/prisma";
import { PLACEHOLDER_RE } from "@/lib/template-token";

/**
 * Pure projection behind the execution page's "Friendly" input/output views.
 * Reuses the same `node-outputs.ts` registry that powers the variable picker, so
 * the fields a user can *reference* downstream and the fields they *see* in a run
 * are one source of truth and can never drift. Kept React-free so it can be
 * unit-tested directly.
 */

export type FriendlyField = {
  label: string;
  /** Resolved value from the recorded run data. */
  value: unknown;
};

/** A group of fields from one source node, for the friendly INPUT view. */
export type FriendlySource = {
  /** Stable key (the context key the source wrote under). */
  key: string;
  /** Friendly heading, e.g. the node's name or "Telegram trigger". */
  label: string;
  fields: FriendlyField[];
};

/** A node that wrote a key into the run context; built from this run's rows. */
export type Producer = {
  /** Top-level context key (`ref`, `<type>_<id>`, or a trigger's fixed key). */
  contextKey: string;
  nodeType: string;
  /** Friendly heading for this source — the node's name. */
  label: string;
};

/** Reads a dotted path (`from.firstName`) out of a nested object. */
function getByPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** "TELEGRAM_TRIGGER" -> "Telegram trigger". */
function humanizeType(type: string): string {
  const lower = type.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Matches `@<path>@` placeholders — the canonical reference syntax. */
const REFERENCE_RE = PLACEHOLDER_RE;

/**
 * Resolves a descriptor's declared fields against an output ROOT object (the
 * unwrapped per-node data). Fields absent from this run are dropped, so the list
 * reflects what actually ran. `developer`-flagged fields (opaque IDs) are skipped
 * here — they stay in Raw and in the variable picker, just not the Friendly view.
 */
function resolveFields(
  descriptor: NodeOutputDescriptor,
  root: unknown,
): FriendlyField[] {
  const fields: FriendlyField[] = [];
  for (const field of descriptor.fields) {
    if (field.developer) continue;
    const value = getByPath(root, field.path);
    if (value === undefined) continue;
    fields.push({ label: field.label, value });
  }
  return fields;
}

/**
 * The recorded `output` is the new-key diff a node added to the context — a
 * single namespaced key wrapping the actual output. Descriptor field paths are
 * relative to that inner root, so unwrap it:
 *   - "fixed" roots (triggers) write a constant key (e.g. `telegram`).
 *   - "perNode" roots write one `ref`/`<type>_<id>` key, so the sole value is it.
 */
function getOutputRoot(
  descriptor: NodeOutputDescriptor,
  output: unknown,
): unknown {
  if (output == null || typeof output !== "object") return output;
  const obj = output as Record<string, unknown>;
  if (descriptor.rootKind === "fixed") {
    return descriptor.rootKey in obj ? obj[descriptor.rootKey] : obj;
  }
  // topLevel fields live at the root, so the object itself is the root.
  if (descriptor.rootKind === "topLevel") return obj;
  const values = Object.values(obj);
  return values.length === 1 ? values[0] : obj;
}

/**
 * Reverse map from a trigger's fixed context key (`telegram`) to its descriptor,
 * so context keys not produced by a recorded row (e.g. a pre-seeded trigger) can
 * still be rendered. Built once from the static registry.
 */
const fixedRootMap = (() => {
  const map = new Map<
    string,
    { type: string; descriptor: NodeOutputDescriptor; label: string }
  >();
  for (const [type, descriptor] of Object.entries(nodeOutputs)) {
    if (descriptor?.rootKind === "fixed") {
      map.set(descriptor.rootKey, {
        type,
        descriptor,
        label: humanizeType(type),
      });
    }
  }
  return map;
})();

/**
 * Triggers whose fields are seeded at the context ROOT (no wrapping key), so they
 * can't be matched by a single context key. They're grouped by which such trigger
 * actually ran in a given execution. Built once from the static registry.
 */
const topLevelTriggers: { type: string; descriptor: NodeOutputDescriptor }[] =
  Object.entries(nodeOutputs)
    .filter(([, d]) => d?.rootKind === "topLevel")
    .map(([type, descriptor]) => ({
      type,
      descriptor: descriptor as NodeOutputDescriptor,
    }));

/**
 * Projects a node's own recorded OUTPUT into the human-friendly field list
 * declared in `node-outputs.ts`. Returns `null` when the node type has no
 * descriptor — the caller should fall back to the raw JSON view.
 */
export function resolveFriendlyOutput(
  nodeType: string,
  output: unknown,
): FriendlyField[] | null {
  const descriptor = nodeOutputs[nodeType as NodeType];
  if (!descriptor) return null;
  return resolveFields(descriptor, getOutputRoot(descriptor, output));
}

/**
 * The unwrapped output object for a node (the inner root its fields live under),
 * or `undefined` when the type is undeclared / produced nothing. Used by the
 * per-node output *summary* messages, which read raw output values.
 */
export function getNodeOutputRoot(
  nodeType: string,
  output: unknown,
): Record<string, unknown> | undefined {
  const descriptor = nodeOutputs[nodeType as NodeType];
  if (!descriptor) return undefined;
  const root = getOutputRoot(descriptor, output);
  return root && typeof root === "object"
    ? (root as Record<string, unknown>)
    : undefined;
}

/**
 * Renders a config template's `@<path>@` references against a run context — a
 * lightweight, client-safe subset of `renderTemplate` (no Handlebars) used to
 * show resolved config values (e.g. the URL an HTTP node hit) in summaries.
 */
export function renderReferences(template: unknown, context: unknown): string {
  if (typeof template !== "string") return "";
  const ctx = (context && typeof context === "object" ? context : {}) as Record<
    string,
    unknown
  >;
  return template.replace(REFERENCE_RE, (_match, path: string) => {
    const value = getByPath(ctx, path.trim());
    if (value == null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/**
 * Projects a node's INPUT (the full context it received) into friendly field
 * groups — one per upstream source node, each showing that source's declared
 * fields with the values this run actually carried. Mirrors the variable picker,
 * but value-filled.
 *
 * `producers` maps the run's context keys to the node that wrote them (and its
 * friendly name); trigger keys not present there fall back to the static
 * fixed-root registry. `runNodeTypes` is the node types present in this run, used
 * to group "topLevel" triggers (whose fields sit at the context root with no
 * wrapping key). Context keys with no descriptor are skipped (raw view still
 * shows everything). Returns `null` when the input isn't an object.
 */
export function resolveFriendlyInput(
  input: unknown,
  producers: Producer[],
  runNodeTypes: string[] = [],
): FriendlySource[] | null {
  if (input == null || typeof input !== "object") return null;
  const ctx = input as Record<string, unknown>;
  const producerByKey = new Map(producers.map((p) => [p.contextKey, p]));

  const sources: FriendlySource[] = [];

  // Keyed sources (fixed/perNode): one context key wraps the node's output.
  for (const [key, root] of Object.entries(ctx)) {
    const producer = producerByKey.get(key);
    const fixed = fixedRootMap.get(key);

    const type = producer?.nodeType ?? fixed?.type;
    if (!type) continue; // unknown context key — only visible in the raw view
    const descriptor = nodeOutputs[type as NodeType];
    if (!descriptor) continue;

    const fields = resolveFields(descriptor, root);
    if (fields.length === 0) continue;
    sources.push({
      key,
      label: producer?.label ?? fixed?.label ?? key,
      fields,
    });
  }

  // topLevel triggers: fields live at the context root, so group them by which
  // such trigger actually ran (the keys above never matched them).
  const ranTypes = new Set(runNodeTypes);
  for (const { type, descriptor } of topLevelTriggers) {
    if (!ranTypes.has(type)) continue;
    const fields = resolveFields(descriptor, ctx);
    if (fields.length === 0) continue;
    sources.push({ key: type, label: humanizeType(type), fields });
  }

  return sources;
}

/**
 * Deep-scans a node's config (`data`) for every `@<path>@` reference, returning
 * the context paths it pulls in (in first-seen order, deduped). This is how we
 * know which upstream fields a node *actually uses*, so its friendly input shows
 * only those — not the whole accumulated context.
 */
export function extractReferencePaths(data: unknown): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(REFERENCE_RE)) {
        const path = match[1].trim();
        if (path && !seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(data);
  return paths;
}

/** Resolves a referenced context path to its source node + friendly field label. */
function describePath(
  path: string,
  producerByKey: Map<string, Producer>,
  ranTypes: Set<string>,
): { sourceKey: string; sourceLabel: string; fieldLabel: string } {
  const dot = path.indexOf(".");
  const rootKey = dot === -1 ? path : path.slice(0, dot);
  const rest = dot === -1 ? "" : path.slice(dot + 1);

  // perNode/fixed root: the first segment identifies the source node.
  const producer = producerByKey.get(rootKey);
  const fixed = fixedRootMap.get(rootKey);
  const keyedType = producer?.nodeType ?? fixed?.type;
  if (keyedType) {
    const field = nodeOutputs[keyedType as NodeType]?.fields.find(
      (f) => f.path === rest,
    );
    return {
      sourceKey: rootKey,
      sourceLabel: producer?.label ?? fixed?.label ?? humanizeType(keyedType),
      fieldLabel: field?.label ?? rest ?? rootKey,
    };
  }

  // topLevel trigger: the whole path is the field; attribute it to a trigger that ran.
  for (const { type, descriptor } of topLevelTriggers) {
    if (!ranTypes.has(type)) continue;
    const field = descriptor.fields.find((f) => f.path === path);
    if (field) {
      return {
        sourceKey: type,
        sourceLabel: humanizeType(type),
        fieldLabel: field.label,
      };
    }
  }

  return {
    sourceKey: "_other",
    sourceLabel: "Previous step",
    fieldLabel: path,
  };
}

/**
 * Friendly INPUT view for a NON-trigger node: only the upstream fields the node
 * *references in its config*, resolved to this run's values and grouped by source
 * node. Referenced paths absent from the recorded context are dropped (e.g. an
 * optional field that wasn't present). Returns `[]` when the node references
 * nothing — the caller shows a "didn't use prior data" note.
 */
export function resolveReferencedInput(
  config: unknown,
  input: unknown,
  producers: Producer[],
  runNodeTypes: string[] = [],
): FriendlySource[] {
  const ctx = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const producerByKey = new Map(producers.map((p) => [p.contextKey, p]));
  const ranTypes = new Set(runNodeTypes);

  // Preserve first-seen source order.
  const groups = new Map<string, FriendlySource>();
  for (const path of extractReferencePaths(config)) {
    const value = getByPath(ctx, path);
    if (value === undefined) continue;
    const { sourceKey, sourceLabel, fieldLabel } = describePath(
      path,
      producerByKey,
      ranTypes,
    );
    const group = groups.get(sourceKey);
    if (group) group.fields.push({ label: fieldLabel, value });
    else
      groups.set(sourceKey, {
        key: sourceKey,
        label: sourceLabel,
        fields: [{ label: fieldLabel, value }],
      });
  }

  return [...groups.values()];
}

/**
 * Describes a single config field for the Friendly view: where its value came
 * from + the resolved value. A field that is *exactly one reference* is labeled
 * by the referenced field's name (e.g. "AI output", "Message text"); anything the
 * user typed (a literal, or text mixed with references) is labeled "Entered by
 * user". Either way the value is resolved against the run context. Used by the
 * branching nodes (Condition/Switch) to render their field/value criteria.
 */
export function describeConfigValue(
  template: unknown,
  context: unknown,
  producers: Producer[],
  runNodeTypes: string[] = [],
): { label: string; value: string } {
  const value = renderReferences(template, context);
  if (typeof template === "string") {
    const refs = extractReferencePaths(template);
    const withoutRefs = template.replace(REFERENCE_RE, "").trim();
    if (refs.length === 1 && withoutRefs === "") {
      const { fieldLabel } = describePath(
        refs[0],
        new Map(producers.map((p) => [p.contextKey, p])),
        new Set(runNodeTypes),
      );
      return { label: fieldLabel, value };
    }
  }
  return { label: "Entered by user", value };
}
