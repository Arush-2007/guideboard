import prisma from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { asTimeoutError, HTTP_TIMEOUT, http } from "@/lib/http";

type MicrosoftRefreshResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
};

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";

export const MICROSOFT_SCOPES = "offline_access User.Read Files.ReadWrite";

export async function refreshMicrosoftTokenIfNeeded(
  userId: string,
): Promise<string> {
  const credential = await prisma.microsoftCredential.findUnique({
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
      "No Microsoft credential found. Connect your Microsoft account in Credentials to grant OneDrive/Excel access.",
    );
  }

  if (
    credential.expiresAt &&
    credential.expiresAt.getTime() > Date.now() + EXPIRY_BUFFER_MS
  ) {
    return decrypt(credential.accessToken);
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Microsoft token refresh failed: MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET is not configured",
    );
  }

  const refreshToken = decrypt(credential.refreshToken);

  let response: MicrosoftRefreshResponse;
  try {
    response = await http
      .post(MICROSOFT_TOKEN_URL, {
        timeout: HTTP_TIMEOUT.TOKEN,
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          scope: MICROSOFT_SCOPES,
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
      .json<MicrosoftRefreshResponse>();
  } catch (err) {
    // Classify BEFORE the generic wrap below — re-wrapping a timeout as a plain
    // Error would erase its retry decision and lose the actionable message.
    const timeout = asTimeoutError(err, {
      integration: "Microsoft sign-in",
      timeoutClass: "TOKEN",
      // A token refresh is safe to repeat.
      idempotent: true,
      hint: "This is Microsoft's OAuth service, not your workbook — usually transient.",
    });
    if (timeout) throw timeout;

    const message = err instanceof Error ? err.message : "unknown error";
    throw new Error(
      `Microsoft token refresh failed: ${message}. If this persists, reconnect your Microsoft account in Credentials.`,
    );
  }

  const newAccessToken = response.access_token;
  const expiresAt = new Date(Date.now() + response.expires_in * 1000);

  // Microsoft rotates refresh tokens on most refreshes and may invalidate the
  // old one, so the rotated token must be persisted.
  await prisma.microsoftCredential.update({
    where: { id: credential.id },
    data: {
      accessToken: encrypt(newAccessToken),
      expiresAt,
      ...(response.refresh_token
        ? { refreshToken: encrypt(response.refresh_token) }
        : {}),
    },
  });

  return newAccessToken;
}
