export const emailConfigured = () => !!process.env.RESEND_API_KEY;

/**
 * Sends through Resend's API (free tier: 3,000 emails a month). Returns false when no key
 * is set, so reminders simply stay in the app. https://resend.com/docs/api-reference/emails/send-email
 */
export async function sendEmail(mail: { to: string; subject: string; text: string; html: string }): Promise<boolean> {
  if (!emailConfigured()) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.ALRO_EMAIL_FROM ?? "ALRO <onboarding@resend.dev>", ...mail, to: [mail.to] }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}
