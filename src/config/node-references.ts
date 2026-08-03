import { isSheetsAppendUnder, sheetsAction } from "@/config/node-outputs";
import { NodeType } from "@/generated/prisma";
import { MULTI_MATCH_CONFIG_KEYS } from "@/lib/multi-match";
import { ANCHOR_ROW_KEY } from "@/lib/sheet-headers";

/**
 * Per-node REFERENCE registry: how each node type names the other steps its
 * config draws values from.
 *
 * The counterpart to `node-outputs.ts`, which declares what a node PUBLISHES
 * downstream. This one is about the other direction — what a node's own config
 * is allowed to name, and in what syntax — and it is what the dangling-reference
 * detector (`lib/dangling-refs.ts`) reads to decide whether a reference is real,
 * dead, or none of its business.
 */

/**
 * Context keys a node injects while rendering its OWN fields, which never enter
 * the workflow context and so are invisible to every downstream node.
 *
 * `anchorRow` is the only one today: the Sheets non-bottom append exposes the
 * row it is attaching to, per inserted row, so a column can be filled from the
 * row above it (`@<anchorRow.Job No>@` — see `sheet-headers.ts`). The dialog
 * offers its FIELDS through the picker's `extraGroups` prop, built from live
 * sheet headers; only the root is static, and only the root is what this needs.
 *
 * ⚠️ A node that injects a root and is missing here has its own valid config
 * called a DANGLING reference — an amber badge that won't clear, and a save
 * warning whose "Remove and save" erases the working field. Declare the root
 * here at the same time as you add the `extraGroups` that offers it.
 */
const nodeSelfRoots: Partial<Record<NodeType, readonly string[]>> = {
  [NodeType.GOOGLE_SHEETS_ACTION]: [ANCHOR_ROW_KEY],
};

const NO_SELF_ROOTS: readonly string[] = [];

/** The self-roots a placed node of this type may reference (see above). */
export function selfRootsForType(
  type: string | null | undefined,
): readonly string[] {
  if (!type) return NO_SELF_ROOTS;
  return nodeSelfRoots[type as NodeType] ?? NO_SELF_ROOTS;
}

/**
 * Node types whose config is NOT checked for dangling references at all.
 *
 * The Code node is the only one, and it is excluded on purpose. Its field is a
 * PROGRAM, not a template: references are ordinary JavaScript property access
 * off the run context (`input.AI_TEXT_1.output`), which means
 *
 *   - finding them at all takes a syntactic scan that cannot see destructuring,
 *     aliasing or computed access, so it is guesswork either way;
 *   - the context object genuinely holds more than the variable picker lists —
 *     Sheets `find_rows` publishes `rows` that no descriptor declares — so
 *     "not in the picker" says nothing about whether the code is correct;
 *   - and nothing found could be auto-repaired regardless, because cutting a
 *     reference out of a program leaves code that will not parse.
 *
 * Warnings that fire unpredictably on working code are worse than no warnings,
 * so the Code node is left to the author. Everything else — the canvas badge,
 * the per-node save guard, the workflow save warning, the AI builder — skips it.
 */
const UNCHECKED_NODE_TYPES: ReadonlySet<string> = new Set([NodeType.CODE]);

/** Whether a node of this type has its references checked (see above). */
export function isRefCheckedNodeType(type: string | null | undefined): boolean {
  return !type || !UNCHECKED_NODE_TYPES.has(type);
}

/**
 * Config keys a node IGNORES for its current settings.
 *
 * A dialog with a mode selector keeps every mode's fields populated so each
 * control stays controlled from first render, and the canvas MERGES a saved
 * payload over the node's existing data — so a node switched between modes
 * carries the other mode's fields around forever. Those fields are never read:
 * a Sheets node set to `find_rows` still holds the column mappings it had as an
 * `append_row`, and nothing will ever render them.
 *
 * Reporting a dangling reference in one of them is noise about a field that
 * cannot affect the run. It is also actively harmful: a wide sheet turns one bad
 * wire into a mapping per column, burying the one field that IS live. That is
 * the reported bug — a duplicated `find_rows` node listing sixteen dead column
 * mappings alongside the single condition that actually mattered.
 *
 * Declared as INACTIVE rather than active so the default is unchanged: a node
 * absent here has every field checked, and a new field on a listed node is
 * checked until someone says otherwise. The failure mode of a mistake here is a
 * warning not shown, so entries should be added only where the executor
 * genuinely cannot read the field.
 */
type InactiveFields = (
  data: Record<string, unknown> | null | undefined,
) => readonly string[];

const nodeInactiveFields: Partial<Record<NodeType, InactiveFields>> = {
  // Sourced from the per-field comments on `googleSheetsActionSchema`, which
  // document each key's owning action; the action normalizers are shared with
  // `node-outputs.ts` so the two can't disagree about what a legacy node is.
  [NodeType.GOOGLE_SHEETS_ACTION]: (data) => {
    const action = sheetsAction(data);
    const isAppend = action === "append_row";
    const styledAppend = isAppend && data?.styleAppendedRow === true;
    const merging = styledAppend && data?.mergeMode === "merge";
    // A merged row is ONE cell, so the mapping is replaced by `mergedText` —
    // see the schema's warning about MERGE_ALL discarding every other column.
    const mapsColumns = action === "update_row" || (isAppend && !merging);
    const filtersRows =
      action === "find_rows" ||
      action === "update_row" ||
      action === "style_cells" ||
      isSheetsAppendUnder(data);
    const styles = action === "style_cells" || styledAppend;

    const off: string[] = [];
    if (!mapsColumns) off.push("columnMappings");
    if (!merging) off.push("mergedText");
    if (!filtersRows) off.push("conditions");
    if (!isAppend) off.push("requiredColumns", "position", "styleAppendedRow");
    if (!(isAppend && !isSheetsAppendUnder(data))) off.push("blankRowAbove");
    if (!styles) off.push("cellFormat", "mergeMode");
    if (action !== "style_cells") {
      off.push("styleColumns", "onMultipleStyleMatches");
    }
    if (action !== "find_rows" && action !== "update_row") {
      // Spread, never hand-listed: the fragment owns which keys exist, so a new
      // fan-out setting can't silently miss this list (see MULTI_MATCH_CONFIG_KEYS).
      off.push(...MULTI_MATCH_CONFIG_KEYS);
    }
    return off;
  },

  [NodeType.EXCEL_ACTION]: (data) =>
    data?.operation === "upsert_by_key"
      ? []
      : ["keyColumn", "keyValue", "columnModes"],

  [NodeType.RECORD_LOOKUP]: (data) =>
    (data?.source ?? "google_sheets") === "google_sheets"
      ? ["credentialId", "databaseId", "property"]
      : ["spreadsheetId", "sheetName", "column"],

  [NodeType.NOTION_ACTION]: (data) =>
    data?.action === "create_page" ? ["databaseId"] : ["parentPageId"],
};

const NO_INACTIVE_FIELDS: ReadonlySet<string> = new Set<string>();

/** The config keys a placed node won't read, given its current data. */
export function inactiveFieldsForNode(
  type: string | null | undefined,
  data: Record<string, unknown> | null | undefined,
): ReadonlySet<string> {
  const declared = type ? nodeInactiveFields[type as NodeType] : undefined;
  if (!declared) return NO_INACTIVE_FIELDS;
  return new Set(declared(data));
}
