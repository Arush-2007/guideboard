import "server-only";
import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;

// Resend's shared sandbox sender works without a verified domain, but it can
// only deliver to the email that owns the Resend account. Set EMAIL_FROM to a
// verified-domain address for real delivery.
const fromAddress =
  process.env.EMAIL_FROM ?? "Guideboard <onboarding@resend.dev>";

const resend = apiKey ? new Resend(apiKey) : null;

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
