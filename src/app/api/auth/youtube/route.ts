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

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.redirect(
      new URL("/credentials?error=youtube_auth_failed", request.url),
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope:
      "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/youtube.readonly",
  });

  const authorizeUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  return NextResponse.redirect(authorizeUrl);
}
