"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { usePathname } from "next/navigation";
import { useCallback } from "react";
import { isDirtyAtom, navGuardTargetAtom } from "../store/atoms";

/**
 * Returns an onClick handler for in-app links that would otherwise silently
 * discard unsaved editor work (the editor breadcrumb, the sidebar items). While
 * the editor is dirty it swallows the navigation and opens the save-guard
 * dialog by parking the target in `navGuardTargetAtom`; otherwise it lets the
 * link behave normally.
 *
 * Gated on the editor route (`/workflows/<id>`): the shared `isDirtyAtom` is
 * only meaningful there (and <NavGuardDialog> that consumes the target is only
 * mounted there), so on the always-present sidebar links this is inert
 * everywhere else — no reliance on any teardown resetting the atom.
 */
export const useNavGuard = () => {
  const pathname = usePathname();
  const isDirty = useAtomValue(isDirtyAtom);
  const setTarget = useSetAtom(navGuardTargetAtom);
  const inEditor = pathname.startsWith("/workflows/");

  return useCallback(
    (href: string) => (event: React.MouseEvent) => {
      if (!isDirty || !inEditor) {
        return;
      }
      event.preventDefault();
      setTarget(href);
    },
    [isDirty, inEditor, setTarget],
  );
};
