import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import prisma from "@/lib/db";
import { sendEmail } from "@/lib/email";
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
  // Accept auth requests from both the local dev origin and the ngrok tunnel.
  // Without this, opening the app over ngrok fails the origin/CSRF check with a
  // 403 (the request Origin won't match BETTER_AUTH_URL=localhost).
  trustedOrigins: [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NGROK_URL,
  ].filter((origin): origin is string => Boolean(origin)),
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
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your Guideboard password",
        text: `Reset your password by visiting this link: ${url}\n\nIf you didn't request this, you can safely ignore this email. The link expires in 1 hour.`,
        html: `
          <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
            <h2 style="margin-bottom: 8px;">Reset your password</h2>
            <p style="color: #555; line-height: 1.5;">
              We received a request to reset your Guideboard password. Click the
              button below to choose a new one.
            </p>
            <p style="margin: 24px 0;">
              <a href="${url}" style="background: #111; color: #fff; padding: 10px 20px; border-radius: 8px; text-decoration: none; display: inline-block;">
                Reset password
              </a>
            </p>
            <p style="color: #888; font-size: 13px; line-height: 1.5;">
              If you didn't request this, you can safely ignore this email.
              This link expires in 1 hour.
            </p>
          </div>
        `,
      });
    },
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
