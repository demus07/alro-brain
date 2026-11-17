import nodemailer, { type Transporter } from "nodemailer";

const smtpConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);

/** Email goes out through a mailbox's SMTP server when one is set, otherwise through Resend. */
export const emailConfigured = () => smtpConfigured() || !!process.env.RESEND_API_KEY;

let transport: Transporter | undefined;

/** One connection setup per process; SMTP settings only change with a restart. */
function smtp(): Transporter {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 465;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 speaks TLS from the start; 587 and 25 upgrade with STARTTLS.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return transport;
}

/**
 * Sends one email: through SMTP (e.g. a Hostinger or Google Workspace mailbox) when SMTP_HOST,
 * SMTP_USER and SMTP_PASSWORD are set, else through Resend's API (free tier: 3,000 emails a month,
 * https://resend.com/docs/api-reference/emails/send-email). Returns false when neither is set, so
 * reminders simply stay in the app.
 */
export async function sendEmail(mail: { to: string; subject: string; text: string; html: string }): Promise<boolean> {
  if (smtpConfigured()) {
    await smtp().sendMail({ from: process.env.ALRO_EMAIL_FROM ?? process.env.SMTP_USER, ...mail });
    return true;
  }
  if (!process.env.RESEND_API_KEY) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.ALRO_EMAIL_FROM ?? "ALRO <onboarding@resend.dev>", ...mail, to: [mail.to] }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}
