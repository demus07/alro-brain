import { asana } from "./asana";
import { clickup } from "./clickup";
import { confluence } from "./confluence";
import { discord } from "./discord";
import { fathom } from "./fathom";
import { fireflies } from "./fireflies";
import { freshdesk } from "./freshdesk";
import { github } from "./github";
import { gitlab } from "./gitlab";
import { gmail } from "./gmail";
import { googleCalendar, googleSheets } from "./google";
import { googleDrive } from "./google-drive";
import { googleMeet } from "./google-meet";
import { hubspot } from "./hubspot";
import { imap } from "./imap";
import { intercom } from "./intercom";
import { jira } from "./jira";
import { linear } from "./linear";
import { outlookCalendar } from "./microsoft";
import { onedrive, sharepoint } from "./microsoft-files";
import { notion } from "./notion";
import { outlook } from "./outlook";
import { pipedrive } from "./pipedrive";
import type { Provider } from "./provider";
import { quickbooks } from "./quickbooks";
import { razorpay } from "./razorpay";
import { salesforce } from "./salesforce";
import { shopify } from "./shopify";
import { slack } from "./slack";
import { stripe } from "./stripe";
import { teams, teamsChannels } from "./teams";
import { xero } from "./xero";
import { zendesk } from "./zendesk";
import { zohoCrm } from "./zoho-crm";
import { zoom } from "./zoom";

/** Every source ALRO connects to directly. To add one, see .claude/skills/build-connector. */
const ALL: Provider[] = [
  // Where people talk
  slack,
  teams,
  teamsChannels,
  discord,
  gmail,
  outlook,
  imap,
  // Calls and calendars
  googleMeet,
  zoom,
  fireflies,
  fathom,
  googleCalendar,
  outlookCalendar,
  // Documents
  notion,
  confluence,
  googleDrive,
  onedrive,
  sharepoint,
  // Work tracking
  jira,
  linear,
  github,
  gitlab,
  asana,
  clickup,
  // Customers
  hubspot,
  pipedrive,
  zohoCrm,
  salesforce,
  zendesk,
  freshdesk,
  intercom,
  // Money and orders (live)
  stripe,
  razorpay,
  xero,
  quickbooks,
  shopify,
  googleSheets,
];

export const PROVIDERS: ReadonlyMap<string, Provider> = new Map(ALL.map((p) => [p.id, p]));

export const providerOf = (id: string): Provider | undefined => PROVIDERS.get(id);
