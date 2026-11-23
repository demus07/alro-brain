import { z } from "zod";
import { sendWhatsApp } from "@/channels/channels";
import type { ActionDef } from "@/connectors/provider";

/** Actions ALRO takes itself rather than through a connected app. They wait for approval like any other. */
export const BUILTIN_PREFIX = "alro_";

const whatsappInput = z.object({
  to: z.string().min(10).describe("The customer's phone number with country code, digits only"),
  text: z.string().min(1).max(4000).describe("The message"),
  /** Set when the customer hasn't written in the last 24 hours: WhatsApp then only accepts an approved template. */
  template: z.object({ name: z.string(), language: z.string(), params: z.array(z.string()) }).nullish(),
});
type WhatsAppInput = z.infer<typeof whatsappInput>;

export const BUILTIN_ACTIONS: Record<string, { label: string; def: ActionDef<WhatsAppInput> }> = {
  alro_whatsapp_send: {
    label: "WhatsApp",
    def: {
      description: "Send a WhatsApp message to a customer from the company's WhatsApp number.",
      input: whatsappInput,
      audience: () => "external",
      summary: (i) => `WhatsApp to +${i.to}: ${i.text.replace(/\s+/g, " ").slice(0, 60)}${i.text.length > 60 ? "…" : ""}`,
      body: (i) => i.text,
      // An edited message can't be sent as the approved template (its words are fixed), so it goes as plain text: that works while the customer has written within 24 hours, and fails with WhatsApp's reason otherwise.
      withBody: (i, text) => (text === i.text ? i : { ...i, text, template: null }),
      async run(_api, input) {
        await sendWhatsApp(input.to, input.template ? { template: input.template } : { text: input.text });
        return { detail: input.template ? "Sent on WhatsApp as a template message" : "Sent on WhatsApp" };
      },
    },
  },
};
