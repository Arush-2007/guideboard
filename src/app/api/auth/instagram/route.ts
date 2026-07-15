import "server-only";

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.INSTAGRAM_APP_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.redirect(
      new URL("/credentials?error=instagram_auth_failed", request.url),
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "instagram_basic,instagram_manage_comments",
    response_type: "code",
  });

  const authorizeUrl = `https://api.instagram.com/oauth/authorize?${params.toString()}`;

  return NextResponse.redirect(authorizeUrl);
}
