import { tool } from "ai";
import { z } from "zod";
import { bearer, httpApi } from "./api";
import type { ActionDef, Provider } from "./provider";

const PROPERTIES: Record<string, string[]> = {
  contacts: ["firstname", "lastname", "email", "phone", "company", "jobtitle", "lifecyclestage"],
  companies: ["name", "domain", "industry", "city", "country", "annualrevenue", "numberofemployees"],
  deals: ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id"],
  tickets: ["subject", "content", "hs_pipeline_stage", "hs_ticket_priority"],
};

/** HubSpot's own association type ids, record → note and record → task. */
const NOTE_TO = { contacts: 202, companies: 190, deals: 214 } as const;
const TASK_TO = { contacts: 204, companies: 192, deals: 216 } as const;

const onRecord = {
  object: z.enum(["contacts", "companies", "deals"]),
  recordId: z.string().describe("The record's HubSpot id, from hubspot_search"),
};
const noteInput = z.object({ ...onRecord, note: z.string().min(1) });
const taskInput = z.object({ ...onRecord, subject: z.string().min(1), details: z.string().nullish(), dueDate: z.iso.date().describe("YYYY-MM-DD") });

const association = (object: keyof typeof NOTE_TO, recordId: string, typeId: number) => [
  { to: { id: recordId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] },
];

/** HubSpot CRM, read live when someone asks: nothing is copied into memory. */
export const hubspot: Provider = {
  id: "hubspot",
  scope: "org",
  auth: {
    kind: "token",
    fields: [{ name: "token", label: "Private app access token", placeholder: "pat-…", secret: true }],
    setup:
      "In HubSpot, create a private app (Settings → Integrations → Private Apps) with read scopes for contacts, companies, deals and tickets, and paste its access token. To let ALRO add notes and tasks you approve, also give it write scopes for contacts, companies and deals.",
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
  actions: {
    hubspot_add_note: {
      description: "Add a note to a HubSpot contact, company or deal (a call summary, what was agreed).",
      input: noteInput,
      audience: () => "internal",
      summary: (i) => `HubSpot note on ${i.object.replace(/s$/, "")} ${i.recordId}`,
      body: (i) => i.note,
      withBody: (i, note) => ({ ...i, note }),
      async run(api, i) {
        const r = await api<{ id: string }>("POST", "crm/v3/objects/notes", {
          body: { properties: { hs_note_body: i.note, hs_timestamp: new Date().toISOString() }, associations: association(i.object, i.recordId, NOTE_TO[i.object]) },
        });
        return { detail: `Note ${r.id} added` };
      },
    } satisfies ActionDef<z.infer<typeof noteInput>>,
    hubspot_create_task: {
      description: "Create a follow-up task in HubSpot on a contact, company or deal, with a due date.",
      input: taskInput,
      audience: () => "internal",
      summary: (i) => `HubSpot task "${i.subject}" due ${i.dueDate}`,
      body: (i) => i.details ?? "",
      withBody: (i, details) => ({ ...i, details }),
      async run(api, i) {
        const r = await api<{ id: string }>("POST", "crm/v3/objects/tasks", {
          body: {
            properties: { hs_task_subject: i.subject, hs_task_body: i.details ?? "", hs_timestamp: new Date(`${i.dueDate}T09:00:00Z`).toISOString(), hs_task_status: "NOT_STARTED" },
            associations: association(i.object, i.recordId, TASK_TO[i.object]),
          },
        });
        return { detail: `Task ${r.id} created` };
      },
    } satisfies ActionDef<z.infer<typeof taskInput>>,
  },
};
