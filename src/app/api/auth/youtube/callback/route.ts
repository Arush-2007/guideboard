import "server-only";

import { auth } from "@/lib/auth";
import prisma from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { headers } from "next/headers";
import ky from "ky";
import { NextResponse } from "next/server";

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

function failRedirect(request: Request) {
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

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return failRedirect(request);
  }

  try {
    const tokenResponse = await ky
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
      })
      .json<GoogleTokenResponse>();

    const accessToken = tokenResponse.access_token;
    const refreshToken = tokenResponse.refresh_token;

    if (!refreshToken) {
      return failRedirect(request);
    }

    const channelsUrl = new URL(
      "https://www.googleapis.com/youtube/v3/channels",
    );
    channelsUrl.searchParams.set("part", "snippet");
    channelsUrl.searchParams.set("mine", "true");

    const channelsResponse = await ky
      .get(channelsUrl.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
      .json<YoutubeChannelResponse>();

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
        },
      });
    }

    return NextResponse.redirect(new URL("/credentials", request.url));
  } catch {
    return failRedirect(request);
  }
}
