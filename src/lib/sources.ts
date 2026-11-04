/**
 * How sources are named in the UI. A connection's provider is either a live
 * connector ("slack") or an upload ("upload:whatsapp", "upload:crm:zoho");
 * both map to the same source key so they show up as one connector.
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
  gmail: { label: "Gmail", mark: "G" },
  notion: { label: "Notion", mark: "N" },
  outlook: { label: "Outlook", mark: "O" },
  whatsapp: { label: "WhatsApp", mark: "W" },
  meetings: { label: "Meetings", mark: "M" },
  hubspot: { label: "HubSpot", mark: "H" },
  salesforce: { label: "Salesforce", mark: "Sf" },
  zoho: { label: "Zoho CRM", mark: "Z" },
  other: { label: "CRM", mark: "C" },
};

/** Connectors shown under "Add a source" until they're connected. */
export const CATALOG = ["slack", "gmail", "notion", "outlook", "teams", "whatsapp", "meetings", "hubspot", "salesforce", "zoho"];

export function sourceOf(provider: string): SourceInfo {
  const key = provider.replace(/^upload:/, "").replace(/^crm:/, "");
  return { key, ...(SOURCES[key] ?? { label: key, mark: key.slice(0, 1).toUpperCase() }) };
}

export const isUpload = (provider: string) => provider.startsWith("upload:");
