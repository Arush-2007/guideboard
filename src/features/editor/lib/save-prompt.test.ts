import { describe, expect, it, vi } from "vitest";
import type { NodeDanglingRefs } from "@/lib/dangling-refs";
import type { DanglingSavePrompt } from "../store/atoms";
import { openSavePrompt, type PromptStore } from "./save-prompt";

/** A minimal stand-in for `danglingSavePromptAtom`. */
const makeStore = () => {
  let current: DanglingSavePrompt | null = null;
  const store: PromptStore = {
    get: () => current,
    set: (next) => {
      current = next;
    },
  };
  return { store, peek: () => current };
};

const found: NodeDanglingRefs[] = [
  {
    nodeId: "n1",
    nodeRef: "SLACK_1",
    nodeType: "SLACK",
    refs: [{ ref: "AI_TEXT_1", path: "AI_TEXT_1.output", field: "message" }],
  },
];

describe("openSavePrompt", () => {
  it("puts the prompt in the store and waits", async () => {
    const { store, peek } = makeStore();
    const settled = vi.fn();

    const { choice } = openSavePrompt(found, store);
    choice.then(settled);

    expect(peek()?.found).toBe(found);
    // Nothing has answered, so the save is still held open.
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  });

  it("resolves with the dialog's answer and clears the store", async () => {
    const { store, peek } = makeStore();
    const { choice } = openSavePrompt(found, store);

    peek()?.decide("as-is");

    await expect(choice).resolves.toBe("as-is");
    expect(peek()).toBeNull();
  });

  // ---- exit 1: the dialog ---------------------------------------------------

  it("passes each choice through unchanged", async () => {
    for (const answer of ["cancel", "as-is", "remove"] as const) {
      const { store, peek } = makeStore();
      const { choice } = openSavePrompt(found, store);
      peek()?.decide(answer);
      await expect(choice).resolves.toBe(answer);
    }
  });

  // ---- exit 2: a save that displaces this prompt ---------------------------

  it("settles a displaced prompt as cancel, so its save cannot write", async () => {
    // Ctrl+S while the modal is up, or the nav guard's "Save and leave".
    const { store, peek } = makeStore();

    const first = openSavePrompt(found, store);
    const second = openSavePrompt(found, store);

    // The displaced save is released, and released as "cancel" — it never got
    // an answer, so it must not go on to persist anything.
    await expect(first.choice).resolves.toBe("cancel");

    // …and the SECOND prompt is the one left on screen. This is what the old
    // nested-updater version got right only by write ordering.
    expect(peek()).not.toBeNull();
    peek()?.decide("remove");
    await expect(second.choice).resolves.toBe("remove");
  });

  it("leaves the newer prompt in the store, not null", async () => {
    // The displaced prompt's settle calls `set(null)`. If that ran after the
    // new prompt was written, the dialog would vanish and the second save would
    // hang — the exact failure the ordering was quietly relying on.
    const { store, peek } = makeStore();
    openSavePrompt(found, store);
    const second = openSavePrompt(found, store);

    expect(peek()).not.toBeNull();
    expect(peek()?.decide).toBe(second.settle);
  });

  // ---- exit 3: the editor unmounting ---------------------------------------

  it("can be settled from outside the dialog", async () => {
    // The editor unmounts with the warning up: `<DanglingSaveDialog>` goes with
    // it, so no click can reach `decide`. Without this the awaited save hangs
    // for the life of the page — and the nav guard awaits it before navigating.
    const { store, peek } = makeStore();
    const { choice, settle } = openSavePrompt(found, store);

    settle("cancel");

    await expect(choice).resolves.toBe("cancel");
    expect(peek()).toBeNull();
  });

  // ---- the guarantee that ties them together -------------------------------

  it("settles exactly once, whoever gets there first", async () => {
    const { store, peek } = makeStore();
    const { choice, settle } = openSavePrompt(found, store);
    const dialogDecide = peek()?.decide;

    // Three parties race. Only the first answer counts; the rest are ignored
    // rather than throwing, because a dialog click landing at the same moment
    // as a displacing save is normal, not exceptional.
    dialogDecide?.("as-is");
    settle("remove");
    dialogDecide?.("cancel");

    await expect(choice).resolves.toBe("as-is");
  });

  it("is safe to settle after the store has moved on", async () => {
    const { store, peek } = makeStore();
    const { choice, settle } = openSavePrompt(found, store);
    peek()?.decide("as-is");
    await choice;

    // The unmount guard firing late must not clear a prompt it does not own.
    const later = openSavePrompt(found, store);
    settle("cancel");

    expect(peek()).not.toBeNull();
    peek()?.decide("remove");
    await expect(later.choice).resolves.toBe("remove");
  });
});
