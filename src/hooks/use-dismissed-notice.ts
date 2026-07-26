"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A one-off explainer the user can silence with "Don't show this again".
 *
 * Client-only preference, so it lives in localStorage rather than the database —
 * losing it on a new device just means the explainer shows once more, which is
 * the harmless direction. Starts `false` on the server and reads storage after
 * mount (SSR-safe); notices gate on a user action, which can only happen after
 * hydration, so the initial value is never observed.
 */
export function useDismissedNotice(key: string) {
  const storageKey = `notice_dismissed:${key}`;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(localStorage.getItem(storageKey) === "1");
  }, [storageKey]);

  const dismiss = useCallback(() => {
    localStorage.setItem(storageKey, "1");
    setDismissed(true);
  }, [storageKey]);

  return { dismissed, dismiss };
}
