import ky from "ky";
import prisma from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";

type GoogleRefreshResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export async function refreshYoutubeTokenIfNeeded(
  userId: string,
): Promise<string> {
  const credential = await prisma.youtubeCredential.findFirst({
    where: { userId },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
    },
  });

  if (!credential) {
    throw new Error(
      "No connected YouTube account found. Connect your YouTube account in Credentials.",
    );
  }

  // If the token is still valid (more than 5 min remaining), return it as-is
  if (
    credential.expiresAt &&
    credential.expiresAt.getTime() > Date.now() + EXPIRY_BUFFER_MS
  ) {
    return decrypt(credential.accessToken);
  }

  // Token is expired or about to expire — refresh it
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "YouTube token refresh failed: YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET is not configured",
    );
  }

  const refreshToken = decrypt(credential.refreshToken);

  let response: GoogleRefreshResponse;
  try {
    response = await ky
      .post("https://oauth2.googleapis.com/token", {
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
      .json<GoogleRefreshResponse>();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown error";
    throw new Error(`YouTube token refresh failed: ${message}`);
  }

  const newAccessToken = response.access_token;
  const expiresAt = new Date(Date.now() + response.expires_in * 1000);

  await prisma.youtubeCredential.update({
    where: { id: credential.id },
    data: {
      accessToken: encrypt(newAccessToken),
      expiresAt,
    },
  });

  return newAccessToken;
}
