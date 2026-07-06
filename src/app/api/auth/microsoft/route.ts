import "server-only";

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { MICROSOFT_SCOPES } from "@/lib/microsoft-token";

export async function GET(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.redirect(
      new URL("/credentials?error=microsoft_not_configured", request.url),
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    prompt: "select_account",
    scope: MICROSOFT_SCOPES,
  });

  // "organizations" tenant: the Graph Excel workbook APIs only work on
  // OneDrive for Business, so personal Microsoft accounts must not connect.
  const authorizeUrl = `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?${params.toString()}`;

  return NextResponse.redirect(authorizeUrl);
}
