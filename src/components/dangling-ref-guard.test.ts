import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Coverage backstop for the dangling-reference save guard.
 *
 * `useDanglingRefGuard` is wired into each node's settings dialog BY HAND — the
 * import, `form.handleSubmit(guard.save)`, and rendering `guard.dialog`. There
 * is no compiler backstop for that: a new dialog can add a `<VariableTextarea>`,
 * compile, pass every other test, and ship without the guard, so the node's own
 * save never tells the user a field references a step that can't reach it.
 *
 * This is the same hazard `CLAUDE.md` describes for the partial node registries,
 * and the same answer `node-kinds.test.ts` gives: assert the invariant that the
 * types can't, so an omission is a build failure rather than a silent
 * degradation.
 *
 * A miss is not catastrophic — the canvas badge and the workflow-save warning
 * both still catch the node, because they read the React Flow store rather than
 * any one dialog. What is lost is the warning at the moment it is actionable,
 * while the user is looking at the field.
 */

const FEATURES_DIR = fileURLToPath(new URL("../features", import.meta.url));

/**
 * Components through which a field can hold a `@<…>@` reference. A dialog using
 * any of them is authoring references and needs the guard; the two list
 * components are included because they render `VariableInput` internally, so
 * their consumers never name it directly.
 */
const VARIABLE_FIELD_COMPONENTS = [
  "VariableInput",
  "VariableTextarea",
  "VariablePicker",
  "FieldMapping",
  "RecipientList",
];

/**
 * Dialogs deliberately exempt, each with the reason. Empty on purpose: an
 * exemption should be a deliberate, reviewed act, not a quiet omission — which
 * is the whole point of this file.
 */
const EXEMPT: ReadonlySet<string> = new Set<string>([
  // The Code node's field is a PROGRAM: its references are JavaScript property
  // access off the run context, not `@<…>@` tokens. Finding them takes guesswork
  // a syntactic scan can't do reliably, the context genuinely holds more than
  // the picker lists, and nothing found could be auto-repaired anyway — so it is
  // excluded from checking outright. See `isRefCheckedNodeType`.
  "executions/components/code/dialog.tsx",
]);

/** Every `dialog.tsx` under `src/features`, as repo-relative-ish labels. */
function nodeDialogFiles(): { label: string; source: string }[] {
  const found: { label: string; source: string }[] = [];
  for (const entry of readdirSync(FEATURES_DIR, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!entry.endsWith("dialog.tsx")) continue;
    const label = entry.split(/[\\/]/).join("/");
    found.push({
      label,
      source: readFileSync(join(FEATURES_DIR, entry), "utf8"),
    });
  }
  return found;
}

const dialogs = nodeDialogFiles();
const usesVariableFields = (source: string) =>
  VARIABLE_FIELD_COMPONENTS.some((name) => source.includes(name));
const hasGuard = (source: string) => source.includes("useDanglingRefGuard");

describe("dangling-reference guard coverage", () => {
  it("finds the node dialogs to check", () => {
    // A path change that silently matched nothing would make every assertion
    // below vacuously true.
    expect(dialogs.length).toBeGreaterThan(20);
  });

  it("every dialog with a variable field wires up the guard", () => {
    const missing = dialogs
      .filter(
        ({ label, source }) =>
          !EXEMPT.has(label) && usesVariableFields(source) && !hasGuard(source),
      )
      .map(({ label }) => label);

    expect(
      missing,
      `These node dialogs let the user author @<…>@ references but never check ` +
        `them on save. Add \`useDanglingRefGuard\` (see any sibling dialog), or ` +
        `add the file to EXEMPT with a reason.`,
    ).toEqual([]);
  });

  it("no dialog carries the guard without a field that needs it", () => {
    // The converse: wiring left behind after the last variable field was
    // removed is dead code that reads as coverage.
    const pointless = dialogs
      .filter(({ source }) => hasGuard(source) && !usesVariableFields(source))
      .map(({ label }) => label);

    expect(
      pointless,
      "These dialogs wire up the guard but have no field that can hold a reference.",
    ).toEqual([]);
  });
});
