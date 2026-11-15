import { z } from "zod";
import { ProviderError } from "./api";
import type { ActionDef } from "./provider";

export const emailInput = z.object({
  to: z.array(z.email()).min(1).describe("Recipient email addresses"),
  cc: z.array(z.email()).nullish(),
  subject: z.string().min(1),
  body: z.string().min(1).describe("Plain text, signed as the asker would sign it"),
});
export type EmailInput = z.infer<typeof emailInput>;

/** Everything an email action shares except how it's sent. */
export const emailAction = (from: string, run: ActionDef<EmailInput>["run"]): ActionDef<EmailInput> => ({
  description: `Send an email from the asker's ${from} mailbox.`,
  input: emailInput,
  // Mail can reach anyone: always treated as leaving the company.
  audience: () => "external",
  summary: (i) => `Email to ${i.to.join(", ")}: ${i.subject}`,
  body: (i) => i.body,
  withBody: (i, body) => ({ ...i, body }),
  async run(api, input, ctx) {
    try {
      return await run(api, input, ctx);
    } catch (e) {
      // Connected before sending was added: the sign-in has read access only.
      if (e instanceof ProviderError && e.status === 403) throw new Error(`${from} hasn't allowed ALRO to send yet. Reconnect ${from} in Settings → Sources (sign in again) and approve this again.`);
      throw e;
    }
  },
});

/** RFC 2047, so non-ASCII subjects and names survive. */
const header = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);
const noBreaks = (value: string) => value.replace(/[\r\n]+/g, " ");

/** A plain-text email as RFC 822, ready for Gmail's `raw`. */
export function rfc822(i: EmailInput, now = new Date()): string {
  const lines = [
    `To: ${i.to.map(noBreaks).join(", ")}`,
    ...(i.cc?.length ? [`Cc: ${i.cc.map(noBreaks).join(", ")}`] : []),
    `Subject: ${header(noBreaks(i.subject))}`,
    `Date: ${now.toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(i.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return lines.join("\r\n");
}
