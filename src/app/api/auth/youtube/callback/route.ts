import "server-only";

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { env } from "@/lib/env";
import { HTTP_TIMEOUT, http } from "@/lib/http";
import { logger } from "@/lib/logger";

type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

type YoutubeChannelResponse = {
  items: Array<{
    id: string;
    snippet: { title: string };
  }>;
};

function failRedirect(request: Request, error?: unknown) {
  logger.error("[youtube-oauth-callback] youtube_auth_failed", error);
  return NextResponse.redirect(
    new URL("/credentials?error=youtube_auth_failed", request.url),
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

  const clientId = env(process.env.YOUTUBE_CLIENT_ID);
  const clientSecret = env(process.env.YOUTUBE_CLIENT_SECRET);
  const redirectUri = env(process.env.YOUTUBE_REDIRECT_URI);

  if (!clientId || !clientSecret || !redirectUri) {
    return failRedirect(request);
  }

  try {
    const tokenResponse = await http
      .post("https://oauth2.googleapis.com/token", {
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code,
        }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        // The auth code is SINGLE-USE, so this must never be retried — the shared
        // client is retry:0. Bounding it just stops a hung exchange from holding the
        // redirect open indefinitely.
        timeout: HTTP_TIMEOUT.TOKEN,
      })
      .json<GoogleTokenResponse>();

    const accessToken = tokenResponse.access_token;
    const refreshToken = tokenResponse.refresh_token;
    const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);

    if (!refreshToken) {
      return failRedirect(request);
    }

    const channelsUrl = new URL(
      "https://www.googleapis.com/youtube/v3/channels",
    );
    channelsUrl.searchParams.set("part", "snippet");
    channelsUrl.searchParams.set("mine", "true");

    const res = await http.get(channelsUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      timeout: HTTP_TIMEOUT.TOKEN,
      // The 403 path below reads the body itself, so ky must not throw on it.
      throwHttpErrors: false,
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error("[youtube-channels-403]", undefined, {
        status: res.status,
        body,
      });
      throw new Error("channels fetch failed");
    }
    const channelsResponse = (await res.json()) as YoutubeChannelResponse;

    const channel = channelsResponse.items?.[0];
    if (!channel) {
      return failRedirect(request);
    }

    const channelId = channel.id;
    const channelTitle = channel.snippet.title;

    const existing = await prisma.youtubeCredential.findFirst({
      where: { userId: session.user.id },
    });

    const encryptedAccessToken = encrypt(accessToken);
    const encryptedRefreshToken = encrypt(refreshToken);

    if (existing) {
      await prisma.youtubeCredential.update({
        where: { id: existing.id },
        data: {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          channelId,
          channelTitle,
          expiresAt,
        },
      });
    } else {
      await prisma.youtubeCredential.create({
        data: {
          userId: session.user.id,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          channelId,
          channelTitle,
          expiresAt,
        },
      });
    }

    return NextResponse.redirect(new URL("/credentials", request.url));
  } catch (error) {
    return failRedirect(request, error);
  }
}
