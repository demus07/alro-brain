import type { ReactNode } from "react";
import { sourceOf } from "@/lib/sources";

/**
 * Official full-colour logos in /public/brands, one file per source key.
 *  - Most come from theSVG (github.com/glincker/thesvg, v4.0.3: CC0, MIT, or marked as used to identify the
 *    product), the "default" variant; Stripe is its "S" mark, in Stripe's purple.
 *  - Freshdesk is the icon Freshworks serves on freshworks.com/freshdesk; Fireflies and Fathom (the
 *    meeting recorder at fathom.video, not Fathom Analytics) are the app icons from their own sites.
 * They are copied into the repo rather than installed, so nothing changes under us.
 */
const LOGOS: Record<string, string> = {
  slack: "slack.svg",
  teams: "teams.svg",
  "teams-channels": "teams.svg",
  discord: "discord.svg",
  telegram: "telegram.svg",
  gmail: "gmail.svg",
  outlook: "outlook.svg",
  "outlook-calendar": "outlook-calendar.svg",
  "google-calendar": "google-calendar.svg",
  "google-drive": "google-drive.svg",
  "google-meet": "google-meet.svg",
  "google-sheets": "google-sheets.svg",
  zoom: "zoom.svg",
  onedrive: "onedrive.svg",
  sharepoint: "sharepoint.svg",
  notion: "notion.svg",
  confluence: "confluence.svg",
  jira: "jira.svg",
  linear: "linear.svg",
  github: "github.svg",
  gitlab: "gitlab.svg",
  asana: "asana.svg",
  clickup: "clickup.svg",
  zendesk: "zendesk.svg",
  fireflies: "fireflies.png",
  fathom: "fathom.png",
  whatsapp: "whatsapp.svg",
  hubspot: "hubspot.svg",
  pipedrive: "pipedrive.svg",
  salesforce: "salesforce.svg",
  zoho: "zoho.svg",
  freshdesk: "freshdesk.svg",
  intercom: "intercom.svg",
  stripe: "stripe.svg",
  razorpay: "razorpay.svg",
  xero: "xero.svg",
  quickbooks: "quickbooks.svg",
  shopify: "shopify.svg",
};

/** Sources that aren't a brand: a plain line icon. */
const GENERIC: Record<string, ReactNode> = {
  email: <path d="M4 6h16v12H4zM4 7l8 6 8-6" />,
  imap: <path d="M4 6h16v12H4zM4 7l8 6 8-6" />,
  meetings: <path d="M4 7h11v10H4zM15 10.5l5-3v9l-5-3" />,
  notes: <path d="M5 19h4L19 9l-4-4L5 15v4zM13 7l4 4" />,
  other: <path d="M4 20V8h6V4h10v16H4zM8 12h.01M8 16h.01M14 8h2M14 12h2M14 16h2" />,
};

/**
 * A source's icon: its official logo on a light tile (so every brand shows in its own colours in
 * both themes), a line icon for non-brands, or its letters as a last resort.
 * `size="sm"` is the inline version used next to a source's name in feeds and lists.
 */
export function SourceIcon({ provider, size = "md" }: { provider: string; size?: "sm" | "md" }) {
  const { key, label, mark } = sourceOf(provider);
  const className = `source-icon${size === "sm" ? " sm" : ""}`;
  const logo = LOGOS[key];
  if (logo) {
    return (
      <span className={`${className} logo`} title={label}>
        <img src={`/brands/${logo}`} alt="" width={20} height={20} decoding="async" />
      </span>
    );
  }
  return (
    <span className={className} title={label}>
      {GENERIC[key] ? (
        <svg viewBox="0 0 24 24" aria-hidden className="line">
          {GENERIC[key]}
        </svg>
      ) : (
        <span className="source-letter" aria-hidden>
          {mark}
        </span>
      )}
    </span>
  );
}
