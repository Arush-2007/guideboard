import prisma from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { asTimeoutError, HTTP_TIMEOUT, http } from "@/lib/http";

type GoogleRefreshResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
};

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export async function refreshGoogleTokenIfNeeded(
  userId: string,
): Promise<string> {
  const credential = await prisma.googleCredential.findUnique({
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
      "No Google credential found. Sign in with Google to grant Sheets, Gmail, and Drive access.",
    );
  }

  if (
    credential.expiresAt &&
    credential.expiresAt.getTime() > Date.now() + EXPIRY_BUFFER_MS
  ) {
    return decrypt(credential.accessToken);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Google token refresh failed: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not configured",
    );
  }

  const refreshToken = decrypt(credential.refreshToken);

  let response: GoogleRefreshResponse;
  try {
    response = await http
      .post("https://oauth2.googleapis.com/token", {
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        // A refresh runs INSIDE the budget of the call it guards, so it gets the
        // short TOKEN clock — a slow refresh must not eat the read's whole budget.
        timeout: HTTP_TIMEOUT.TOKEN,
      })
      .json<GoogleRefreshResponse>();
  } catch (err) {
    // Classify BEFORE the generic wrap below: re-wrapping a timeout as a plain
    // Error would erase its retry decision and lose the actionable message.
    const timeout = asTimeoutError(err, {
      integration: "Google sign-in",
      timeoutClass: "TOKEN",
      // A token refresh is safe to repeat.
      idempotent: true,
      hint: "This is Google's OAuth service, not your spreadsheet — usually transient.",
    });
    if (timeout) throw timeout;

    const message = err instanceof Error ? err.message : "unknown error";
    throw new Error(`Google token refresh failed: ${message}`);
  }

  const newAccessToken = response.access_token;
  const expiresAt = new Date(Date.now() + response.expires_in * 1000);

  await prisma.googleCredential.update({
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
