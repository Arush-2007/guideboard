import "server-only";

import ky from "ky";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { logger } from "@/lib/logger";
import { MICROSOFT_SCOPES, MICROSOFT_TOKEN_URL } from "@/lib/microsoft-token";

type MicrosoftTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

type MicrosoftMeResponse = {
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
};

function failRedirect(request: Request, error?: unknown) {
  logger.error("[microsoft-oauth-callback] microsoft_auth_failed", error);
  return NextResponse.redirect(
    new URL("/credentials?error=microsoft_auth_failed", request.url),
  );
}

export async function GET(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user?.id) {
    return failRedirect(request);
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");

  if (oauthError || !code) {
    return failRedirect(request, oauthError);
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return failRedirect(request);
  }

  try {
    const tokenResponse = await ky
      .post(MICROSOFT_TOKEN_URL, {
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          scope: MICROSOFT_SCOPES,
          code,
        }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      })
      .json<MicrosoftTokenResponse>();

    const accessToken = tokenResponse.access_token;
    const refreshToken = tokenResponse.refresh_token;
    const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);

    if (!refreshToken) {
      return failRedirect(request);
    }

    const me = await ky
      .get(
        "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      )
      .json<MicrosoftMeResponse>();

    const email = me.mail ?? me.userPrincipalName ?? "";
    const displayName = me.displayName ?? email;

    const encryptedAccessToken = encrypt(accessToken);
    const encryptedRefreshToken = encrypt(refreshToken);

    await prisma.microsoftCredential.upsert({
      where: { userId: session.user.id },
      update: {
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt,
        microsoftId: me.id,
        displayName,
        email,
      },
      create: {
        userId: session.user.id,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt,
        microsoftId: me.id,
        displayName,
        email,
      },
    });

    return NextResponse.redirect(new URL("/credentials", request.url));
  } catch (error) {
    return failRedirect(request, error);
  }
}
