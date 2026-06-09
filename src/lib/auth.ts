import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import prisma from "@/lib/db";
import { encrypt } from "@/lib/encryption";

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

async function syncGoogleCredentialFromAccountTable(userId: string) {
  const account = await prisma.account.findFirst({
    where: { userId, providerId: "google" },
  });
  if (!account?.accessToken || !account.refreshToken) {
    return;
  }

  await prisma.googleCredential.upsert({
    where: { userId },
    create: {
      userId,
      accessToken: encrypt(account.accessToken),
      refreshToken: encrypt(account.refreshToken),
      expiresAt: account.accessTokenExpiresAt,
      scopes: account.scope ?? "",
    },
    update: {
      accessToken: encrypt(account.accessToken),
      refreshToken: encrypt(account.refreshToken),
      expiresAt: account.accessTokenExpiresAt,
      scopes: account.scope ?? "",
    },
  });
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  session: {
    // Serve getSession from a signed cookie snapshot instead of hitting Postgres
    // on every call; refresh from DB after maxAge. Benefits both requireAuth() and
    // every tRPC protectedProcedure. Same-device signOut clears it, and the app has
    // no server-side revocation flows, so the staleness window carries no real risk.
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  databaseHooks: {
    account: {
      create: {
        after: async (account) => {
          const id = account.id;
          if (!id) return;
          const full = await prisma.account.findUnique({ where: { id } });
          if (full?.providerId === "google") {
            await syncGoogleCredentialFromAccountTable(full.userId);
          }
        },
      },
      update: {
        after: async (account) => {
          const id = account.id;
          if (!id) return;
          const full = await prisma.account.findUnique({ where: { id } });
          if (full?.providerId === "google") {
            await syncGoogleCredentialFromAccountTable(full.userId);
          }
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },
  socialProviders: {
    ...(githubClientId && githubClientSecret
      ? {
          github: {
            clientId: githubClientId,
            clientSecret: githubClientSecret,
          },
        }
      : {}),
    ...(googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            scope: [
              "openid",
              "email",
              "profile",
              "https://www.googleapis.com/auth/spreadsheets",
              "https://www.googleapis.com/auth/gmail.modify",
              "https://www.googleapis.com/auth/drive.readonly",
            ],
            accessType: "offline",
            prompt: "consent",
          },
        }
      : {}),
  },
});
