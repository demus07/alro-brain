/**
 * How sources are named in the UI. A connection's provider is either a direct
 * connector ("slack") or an upload ("upload:whatsapp", "upload:crm:zoho");
 * both map to the same source key so they show up under one name.
 * This file has no server imports: client components use it too.
 */
export interface SourceInfo {
  key: string;
  label: string;
  /** One or two letters for the source's badge. */
  mark: string;
}

const SOURCES: Record<string, Omit<SourceInfo, "key">> = {
  slack: { label: "Slack", mark: "Sl" },
  teams: { label: "Teams", mark: "Te" },
  email: { label: "Email", mark: "@" },
  imap: { label: "Email (IMAP)", mark: "@" },
  gmail: { label: "Gmail", mark: "G" },
  outlook: { label: "Outlook", mark: "O" },
  "google-calendar": { label: "Google Calendar", mark: "Gc" },
  "outlook-calendar": { label: "Outlook Calendar", mark: "Oc" },
  "google-drive": { label: "Google Drive", mark: "Gd" },
  "google-sheets": { label: "Google Sheets", mark: "Gs" },
  notion: { label: "Notion", mark: "N" },
  confluence: { label: "Confluence", mark: "Cf" },
  jira: { label: "Jira", mark: "J" },
  linear: { label: "Linear", mark: "Li" },
  github: { label: "GitHub", mark: "Gh" },
  gitlab: { label: "GitLab", mark: "Gl" },
  asana: { label: "Asana", mark: "A" },
  clickup: { label: "ClickUp", mark: "Cu" },
  zendesk: { label: "Zendesk", mark: "Zd" },
  fireflies: { label: "Fireflies", mark: "Ff" },
  whatsapp: { label: "WhatsApp", mark: "W" },
  meetings: { label: "Meetings", mark: "M" },
  hubspot: { label: "HubSpot", mark: "H" },
  salesforce: { label: "Salesforce", mark: "Sf" },
  zoho: { label: "Zoho CRM", mark: "Z" },
  notes: { label: "Notes", mark: "✎" },
  other: { label: "CRM", mark: "C" },
};

/** Sources that only arrive as uploaded exports today. */
export const UPLOAD_ONLY = ["whatsapp", "meetings"];
/** Not built yet. */
export const COMING = ["salesforce", "zoho"];

export function sourceOf(provider: string): SourceInfo {
  const key = provider.replace(/^upload:/, "").replace(/^crm:/, "");
  return { key, ...(SOURCES[key] ?? { label: key, mark: key.slice(0, 1).toUpperCase() }) };
}

export const isUpload = (provider: string) => provider.startsWith("upload:");
