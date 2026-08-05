import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";

// `env(...)` so the unedited `re_your_resend_api_key` placeholder reads as
// absent — `resend` stays null and callers get the clear "not configured"
// error, rather than a rejected send at delivery time.
const apiKey = env(process.env.RESEND_API_KEY);

// Resend's shared sandbox sender works without a verified domain, but it can
// only deliver to the email that owns the Resend account. Set EMAIL_FROM to a
// verified-domain address for real delivery.
const fromAddress =
  env(process.env.EMAIL_FROM) ?? "Guideboard <onboarding@resend.dev>";

const resend = apiKey ? new Resend(apiKey) : null;

/**
 * The one transactional email layout. Every account email Guideboard sends
 * (password reset, address verification, email-change approval) is the same
 * shape — heading, a line of body copy, one button — so the markup lives here
 * once rather than being re-pasted at each call site.
 */
export function emailTemplate({
  heading,
  body,
  cta,
  url,
}: {
  heading: string;
  /** Rendered as HTML — callers may pass simple inline tags like <strong>. */
  body: string;
  cta: string;
  url: string;
}): string {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="margin-bottom: 8px;">${heading}</h2>
      <p style="color: #555; line-height: 1.5;">${body}</p>
      <p style="margin: 24px 0;">
        <a href="${url}" style="background: #111; color: #fff; padding: 10px 20px; border-radius: 8px; text-decoration: none; display: inline-block;">
          ${cta}
        </a>
      </p>
      <p style="color: #888; font-size: 13px; line-height: 1.5;">
        If you didn't request this, you can safely ignore this email.
        This link expires in 1 hour.
      </p>
    </div>
  `;
}

interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail({ to, subject, html, text }: SendEmailArgs) {
  if (!resend) {
    throw new Error(
      "RESEND_API_KEY is not set — cannot send email. Add it to your .env.",
    );
  }

  const { error } = await resend.emails.send({
    from: fromAddress,
    to,
    subject,
    html,
    text,
  });

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }
}
