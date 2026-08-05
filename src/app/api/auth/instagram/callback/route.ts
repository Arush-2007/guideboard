import "server-only";

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { env } from "@/lib/env";
import { HTTP_TIMEOUT, http } from "@/lib/http";

type ShortLivedTokenResponse = {
  access_token: string;
  user_id?: number;
};

type LongLivedTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
};

type InstagramMeResponse = {
  id: string;
  username: string;
};

function failRedirect(request: Request) {
  return NextResponse.redirect(
    new URL("/credentials?error=instagram_auth_failed", request.url),
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
    return failRedirect(request);
  }

  const clientId = env(process.env.INSTAGRAM_APP_ID);
  const clientSecret = env(process.env.INSTAGRAM_APP_SECRET);
  const redirectUri = env(process.env.INSTAGRAM_REDIRECT_URI);

  if (!clientId || !clientSecret || !redirectUri) {
    return failRedirect(request);
  }

  try {
    const shortLived = await http
      .post("https://api.instagram.com/oauth/access_token", {
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code,
        }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: HTTP_TIMEOUT.TOKEN,
      })
      .json<ShortLivedTokenResponse>();

    const shortLivedToken = shortLived.access_token;

    const longLivedUrl = new URL("https://graph.instagram.com/access_token");
    longLivedUrl.searchParams.set("grant_type", "ig_exchange_token");
    longLivedUrl.searchParams.set("client_secret", clientSecret);
    longLivedUrl.searchParams.set("access_token", shortLivedToken);

    const longLived = await http
      .get(longLivedUrl.toString(), { timeout: HTTP_TIMEOUT.TOKEN })
      .json<LongLivedTokenResponse>();

    const longLivedToken = longLived.access_token;
    const tokenExpiresAt = longLived.expires_in
      ? new Date(Date.now() + longLived.expires_in * 1000)
      : undefined;

    const meUrl = new URL("https://graph.instagram.com/me");
    meUrl.searchParams.set("fields", "id,username");
    meUrl.searchParams.set("access_token", longLivedToken);

    const me = await http
      .get(meUrl.toString(), { timeout: HTTP_TIMEOUT.TOKEN })
      .json<InstagramMeResponse>();

    const existing = await prisma.instagramCredential.findFirst({
      where: { userId: session.user.id },
    });

    const encryptedToken = encrypt(longLivedToken);

    if (existing) {
      await prisma.instagramCredential.update({
        where: { id: existing.id },
        data: {
          accessToken: encryptedToken,
          instagramAccountId: me.id,
          instagramUsername: me.username,
          tokenExpiresAt,
        },
      });
    } else {
      await prisma.instagramCredential.create({
        data: {
          userId: session.user.id,
          accessToken: encryptedToken,
          instagramAccountId: me.id,
          instagramUsername: me.username,
          tokenExpiresAt,
        },
      });
    }

    return NextResponse.redirect(new URL("/credentials", request.url));
  } catch {
    return failRedirect(request);
  }
}
