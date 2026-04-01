import ky from "ky";
import prisma from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encryption";

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

interface RefreshResponse {
  access_token: string;
  expires_in: number;
}

export async function refreshInstagramTokenIfNeeded(
  userId: string,
): Promise<void> {
  const credential = await prisma.instagramCredential.findFirst({
    where: { userId },
    select: { id: true, accessToken: true, tokenExpiresAt: true },
  });

  if (!credential) return;

  // Only refresh if expiry is known and within 10 days
  if (
    !credential.tokenExpiresAt ||
    credential.tokenExpiresAt.getTime() > Date.now() + TEN_DAYS_MS
  )
    return;

  const currentToken = decrypt(credential.accessToken);

  const data = await ky
    .get("https://graph.instagram.com/refresh_access_token", {
      searchParams: {
        grant_type: "ig_refresh_token",
        access_token: currentToken,
      },
    })
    .json<RefreshResponse>();

  await prisma.instagramCredential.update({
    where: { id: credential.id },
    data: {
      accessToken: encrypt(data.access_token),
      tokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
    },
  });
}
