import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import prisma from "@/lib/db";
import { emailTemplate, sendEmail } from "@/lib/email";
import { encrypt } from "@/lib/encryption";
import { socialProviderCredentials } from "@/lib/social-providers";
import { trustedOrigins } from "@/lib/trusted-origins";

// Which providers are configured is decided in one place, shared with the
// sign-in buttons, so a button can never be offered for a provider this file
// declines to register. See `src/lib/social-providers.ts`.
const socialCredentials = socialProviderCredentials();

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
  // Accept auth requests from the ngrok tunnel (kept) plus — in development
  // only — the localhost origin, so the UI can be browsed directly at
  // http://localhost:3000 (fast, no tunnel) while ngrok keeps serving inbound
  // webhooks unchanged. localhost is NOT trusted in production builds. Without a
  // matching trusted origin, better-auth rejects the request with a 403 on the
  // origin/CSRF check.
  trustedOrigins: trustedOrigins(),
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
        html: emailTemplate({
          heading: "Reset your password",
          body: "We received a request to reset your Guideboard password. Click the button below to choose a new one.",
          cta: "Reset password",
          url,
        }),
      });
    },
  },
  // Email-change confirmation depends on a verification sender being present.
  // `sendOnSignUp` stays off so the existing signup flow is unchanged — this
  // sender exists purely to close the loop on an address change.
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Confirm your Guideboard email address",
        text: `Confirm this address by visiting this link: ${url}\n\nIf you didn't request this, you can safely ignore this email.`,
        html: emailTemplate({
          heading: "Confirm your email address",
          body: "Click below to confirm this address for your Guideboard account.",
          cta: "Confirm email",
          url,
        }),
      });
    },
  },
  user: {
    changeEmail: {
      enabled: true,
      // Better Auth picks the safer of two paths on its own: when the current
      // address is verified the confirmation goes to *that* address (below), so
      // whoever holds the account today has to approve the move; when it isn't
      // verified it falls through to `sendVerificationEmail` against the new
      // address instead. Either way the email only changes after a click.
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Approve your Guideboard email change",
          text: `Approve changing your Guideboard email to ${newEmail} by visiting this link: ${url}\n\nIf you didn't request this, ignore this email and your address stays as it is.`,
          html: emailTemplate({
            heading: "Approve your email change",
            body: `Someone asked to change this account's email address to <strong>${newEmail}</strong>. Approve it below, or ignore this email to keep things as they are.`,
            cta: "Approve change",
            url,
          }),
        });
      },
    },
  },
  socialProviders: {
    ...(socialCredentials.github ? { github: socialCredentials.github } : {}),
    ...(socialCredentials.google
      ? {
          google: {
            ...socialCredentials.google,
            scope: [
              "openid",
              "email",
              "profile",
              "https://www.googleapis.com/auth/spreadsheets",
              "https://www.googleapis.com/auth/gmail.modify",
              "https://www.googleapis.com/auth/drive.readonly",
              // Read a Google Form's structure (questions) for the trigger's
              // "Load questions" discovery — see credentials.getGoogleFormQuestions.
              "https://www.googleapis.com/auth/forms.body.readonly",
            ],
            accessType: "offline",
            prompt: "consent",
          },
        }
      : {}),
  },
});
