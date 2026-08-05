import type { NodeDanglingRefs } from "@/lib/dangling-refs";
import type { DanglingSavePrompt, SaveChoice } from "../store/atoms";

/**
 * The lifecycle of the dangling-reference save prompt: open it, and give back
 * both the promise the save awaits and the handle that ends the wait.
 *
 * Extracted from `useSaveEditorWorkflow` because the interesting property is
 * not React — it is that **settlement happens exactly once, whoever gets there
 * first**. Three parties can end this wait, and two bugs came from each of them
 * settling the promise itself:
 *
 *   - `<DanglingSaveDialog>` when the user answers;
 *   - a second save that displaces this prompt (Ctrl+S while the modal is up,
 *     or the nav guard's "Save and leave");
 *   - the editor unmounting, which takes the dialog with it and leaves nobody
 *     able to click anything.
 *
 * With the rule written once here, a new exit cannot forget it. Taking the
 * store as two plain functions keeps this testable without a React renderer —
 * the repo runs vitest in a Node environment and has no DOM harness.
 */

/** The atom, reduced to what this needs: read the current prompt, write one. */
export type PromptStore = {
  get: () => DanglingSavePrompt | null;
  set: (next: DanglingSavePrompt | null) => void;
};

export type OpenedSavePrompt = {
  /** Resolves with the choice that ended the wait. Never rejects. */
  choice: Promise<SaveChoice>;
  /**
   * Ends the wait from outside the dialog — the unmount guard. Idempotent, and
   * the same function the dialog is handed, so every exit shares one path.
   */
  settle: (choice: SaveChoice) => void;
};

export function openSavePrompt(
  found: NodeDanglingRefs[],
  store: PromptStore,
): OpenedSavePrompt {
  let settled = false;
  let resolveChoice!: (choice: SaveChoice) => void;
  const choice = new Promise<SaveChoice>((resolve) => {
    resolveChoice = resolve;
  });

  const settle = (next: SaveChoice) => {
    // A second answer is not an error — the dialog can be clicked at the same
    // moment a nav-guard save displaces the prompt — it is simply not the
    // answer. And this guard is not merely tidiness: `resolveChoice` is already
    // once-only by the Promise spec, but `store.set(null)` is NOT. A late call
    // (the unmount guard firing after the dialog answered) would otherwise
    // clear whatever prompt is on screen BY THEN, hanging a save it never owned.
    if (settled) return;
    settled = true;
    store.set(null);
    resolveChoice(next);
  };

  // Displace a prompt still on screen BEFORE claiming the slot, and never from
  // inside a store updater. The original did this within `setPrompt`'s updater,
  // where `decide` wrote the very atom being updated; the replacement survived
  // only because the outer updater's return value was applied after the nested
  // write — correct by ordering, not by design. A read plus two sequential
  // writes has no such dependency.
  //
  // "cancel", because that save never got an answer and so must not write.
  store.get()?.decide("cancel");
  store.set({ found, decide: settle });

  return { choice, settle };
}
