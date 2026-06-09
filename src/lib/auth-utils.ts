import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";

// `cache` dedupes the session lookup within a single request render, so calling
// `requireAuth` in a layout *and* a page (defense-in-depth) costs one DB hit, not two.
export const requireAuth = cache(async () => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/login");
  }

  return session;
});

export const requireUnauth = cache(async () => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (session) {
    redirect("/");
  }
});
