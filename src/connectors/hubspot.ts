import { tool } from "ai";
import { z } from "zod";
import { bearer, httpApi } from "./api";
import type { Provider } from "./provider";

const PROPERTIES: Record<string, string[]> = {
  contacts: ["firstname", "lastname", "email", "phone", "company", "jobtitle", "lifecyclestage"],
  companies: ["name", "domain", "industry", "city", "country", "annualrevenue", "numberofemployees"],
  deals: ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id"],
  tickets: ["subject", "content", "hs_pipeline_stage", "hs_ticket_priority"],
};

/** HubSpot CRM, read live when someone asks: nothing is copied into memory. */
export const hubspot: Provider = {
  id: "hubspot",
  scope: "org",
  auth: {
    kind: "token",
    fields: [{ name: "token", label: "Private app access token", placeholder: "pat-…", secret: true }],
    setup: "In HubSpot, create a private app (Settings → Integrations → Private Apps) with read scopes for contacts, companies, deals and tickets, and paste its access token.",
    docsUrl: "https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
    api: (c) => httpApi({ baseUrl: "https://api.hubapi.com/", headers: bearer(c.token) }),
  },
  async identify(api) {
    const account = await api<{ portalId: number; uiDomain?: string }>("GET", "account-info/v3/details");
    return { accountId: `hubspot:${account.portalId}`, label: `Portal ${account.portalId}` };
  },
  tools(api) {
    return {
      hubspot_search: tool({
        description:
          "Search the company's HubSpot CRM, live: contacts, companies, deals or tickets, most recently changed first. Use for current pipeline, deal amounts and stages, and who a contact is. Say the answer came from HubSpot.",
        inputSchema: z.object({
          object: z.enum(["contacts", "companies", "deals", "tickets"]),
          query: z.string().nullish().describe("Words to match (name, email, company). Leave empty for the most recently changed."),
          limit: z.number().int().min(1).max(50).nullish(),
        }),
        execute: async ({ object, query, limit }) => {
          const r = await api<{ total: number; results: { id: string; properties: Record<string, string | null> }[] }>("POST", `crm/v3/objects/${object}/search`, {
            body: { query: query || undefined, limit: limit ?? 20, properties: PROPERTIES[object], sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }] },
          });
          return { total: r.total, results: r.results.map((x) => ({ id: x.id, ...Object.fromEntries(Object.entries(x.properties).filter(([, v]) => v !== null && v !== "")) })) };
        },
      }),
    };
  },
};
