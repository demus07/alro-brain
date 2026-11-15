import { tool } from "ai";
import { z } from "zod";
import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { httpApi, mintedBearer, postForm, ProviderError, type Api } from "./api";
import type { ActionDef, Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** Each sync re-reads this much before the last change it saw, unless it stopped at a cap. */
const OVERLAP_MS = 5 * 60_000;
const PER_PAGE = 200;
/** Records read per module per sync (Zoho's maximum page is 200). The next sync continues from the last one read. */
const CAPS = { Notes: 200, Tasks: 150, Calls: 100, Events: 100, Contacts: 200 } as const;
/** Deals read for the pipeline summary. */
const MAX_PIPELINE_DEALS = 1000;
const MAX_RESULTS = 25;

type Module = keyof typeof CAPS;
const ACTIVITY_MODULES = ["Notes", "Tasks", "Calls", "Events"] as const satisfies readonly Module[];

/** Zoho's data centres: what the founder types → the accounts server, API domain and web app. */
const DATA_CENTRES: Record<string, { accounts: string; api: string; web: string }> = {
  com: { accounts: "accounts.zoho.com", api: "www.zohoapis.com", web: "crm.zoho.com" },
  in: { accounts: "accounts.zoho.in", api: "www.zohoapis.in", web: "crm.zoho.in" },
  eu: { accounts: "accounts.zoho.eu", api: "www.zohoapis.eu", web: "crm.zoho.eu" },
  "com.au": { accounts: "accounts.zoho.com.au", api: "www.zohoapis.com.au", web: "crm.zoho.com.au" },
  jp: { accounts: "accounts.zoho.jp", api: "www.zohoapis.jp", web: "crm.zoho.jp" },
  ca: { accounts: "accounts.zohocloud.ca", api: "www.zohoapis.ca", web: "crm.zohocloud.ca" },
  sa: { accounts: "accounts.zoho.sa", api: "www.zohoapis.sa", web: "crm.zoho.sa" },
  "com.cn": { accounts: "accounts.zoho.com.cn", api: "www.zohoapis.com.cn", web: "crm.zoho.com.cn" },
};

/** Read everything; create only notes and tasks (for the approved actions). */
export const ZOHO_SCOPES = ["ZohoCRM.modules.READ", "ZohoCRM.users.READ", "ZohoCRM.org.READ", "ZohoCRM.modules.notes.CREATE", "ZohoCRM.modules.tasks.CREATE"];

/** "com", ".in", "zoho.eu", "accounts.zoho.com.au" or a pasted CRM URL, as one of Zoho's data centres. */
export function zohoDc(credentials: Record<string, string>): string {
  const raw = (credentials.dc ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^.*?\bzoho(apis|cloud)?\./, "")
    .replace(/^\./, "");
  const dc = raw || "com";
  if (!DATA_CENTRES[dc]) throw new Error(`Zoho data centre "${credentials.dc}" isn't one ALRO knows. Use one of: ${Object.keys(DATA_CENTRES).join(", ")} (the end of your Zoho address, e.g. "in" for crm.zoho.in).`);
  return dc;
}

interface Lookup {
  id: string;
  name?: string | null;
  email?: string | null;
  module?: { api_name?: string; id?: string } | null;
}
interface ZohoRecord {
  id: string;
  Owner?: Lookup | null;
  Created_By?: Lookup | null;
  Created_Time?: string;
  Modified_Time: string;
  [field: string]: unknown;
}
interface Page {
  data?: ZohoRecord[];
  info?: { more_records?: boolean };
}
interface User {
  id: string;
  full_name?: string | null;
  email?: string | null;
}

const lookup = (v: unknown): Lookup | undefined => (v && typeof v === "object" && "id" in v ? (v as Lookup) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** The web app's tab for each module (Deals are "Potentials" in Zoho's URLs). */
const TABS: Record<string, string> = { Deals: "Potentials" };
const recordUrl = (dc: string, module: string, id: string) => `https://${DATA_CENTRES[dc].web}/crm/tab/${TABS[module] ?? module}/${id}`;
const SINGULAR: Record<string, string> = { Deals: "Deal", Accounts: "Account", Contacts: "Contact", Leads: "Lead", Tasks: "Task", Calls: "Call", Events: "Meeting", Notes: "Note", Cases: "Case" };

export interface ZohoCursor {
  /** Newest Modified_Time read, per module. */
  since?: Partial<Record<Module, string>>;
  /** Modules whose last sync stopped at its cap: the next one continues exactly where it stopped. */
  full?: Module[];
}

/** One module's records changed since `since`, oldest change first, up to `cap`. */
async function changed(api: Api, module: Module, fields: string[], since: Date, cap: number) {
  const all: ZohoRecord[] = [];
  for (let page = 1; all.length < cap; page++) {
    const r = await api<Page>("GET", module, {
      query: { fields: fields.join(","), sort_by: "Modified_Time", sort_order: "asc", per_page: PER_PAGE, page },
      headers: { "If-Modified-Since": iso(since) },
    });
    all.push(...(r.data ?? []));
    if (!r.info?.more_records || !r.data?.length) break;
  }
  return all.slice(0, cap);
}

const FIELDS: Record<Module, string[]> = {
  Notes: ["Note_Title", "Note_Content", "Parent_Id", "Owner", "Created_By", "Created_Time", "Modified_Time"],
  Tasks: ["Subject", "Description", "Due_Date", "Status", "Priority", "What_Id", "Who_Id", "Owner", "Created_Time", "Modified_Time"],
  Calls: ["Subject", "Description", "Call_Type", "Call_Start_Time", "Call_Duration", "Call_Result", "What_Id", "Who_Id", "Owner", "Created_Time", "Modified_Time"],
  Events: ["Event_Title", "Description", "Start_DateTime", "End_DateTime", "Venue", "What_Id", "Who_Id", "Participants", "Owner", "Created_Time", "Modified_Time"],
  Contacts: ["Full_Name", "Email", "Modified_Time"],
};

/** The record an activity belongs to: its deal or account first, else the contact or lead, as [module, lookup]. */
function parentOf(module: Module, r: ZohoRecord): [string, Lookup] | undefined {
  if (module === "Notes") {
    const p = lookup(r.Parent_Id);
    return p?.module?.api_name ? [p.module.api_name, p] : undefined;
  }
  const what = lookup(r.What_Id);
  const whatModule = str(r.$se_module) ?? what?.module?.api_name;
  if (what && whatModule) return [whatModule, what];
  const who = lookup(r.Who_Id);
  return who ? ["Contacts", who] : undefined;
}

/** One activity as the text a person would read in the CRM. */
function describe(module: Module, r: ZohoRecord): { title: string; text: string; at: Date } {
  const who = lookup(r.Who_Id)?.name;
  const owner = r.Owner?.name;
  const body = (k: string) => str(r[k])?.slice(0, 8000);
  switch (module) {
    case "Notes": {
      const title = str(r.Note_Title) ?? "Note";
      return { title, text: [`Note: ${title}`, owner && `By: ${owner}`, body("Note_Content") && `\n${body("Note_Content")}`].filter(Boolean).join("\n"), at: new Date(r.Modified_Time) };
    }
    case "Tasks": {
      const title = str(r.Subject) ?? "Task";
      const head = [`Status: ${str(r.Status) ?? "unknown"}`, str(r.Priority) && `Priority: ${r.Priority}`, str(r.Due_Date) && `Due: ${r.Due_Date}`].filter(Boolean).join(" · ");
      return { title, text: [`Task: ${title}`, head, owner && `Owner: ${owner}`, who && `With: ${who}`, body("Description") && `\n${body("Description")}`].filter(Boolean).join("\n"), at: new Date(r.Modified_Time) };
    }
    case "Calls": {
      const title = str(r.Subject) ?? "Call";
      const head = [str(r.Call_Type) && `${r.Call_Type} call`, str(r.Call_Start_Time) && `at ${r.Call_Start_Time}`, str(r.Call_Duration) && `for ${r.Call_Duration}`].filter(Boolean).join(" ");
      return {
        title,
        text: [`Call: ${title}`, head, owner && `Owner: ${owner}`, who && `With: ${who}`, str(r.Call_Result) && `Result: ${r.Call_Result}`, body("Description") && `\n${body("Description")}`].filter(Boolean).join("\n"),
        at: new Date(str(r.Call_Start_Time) ?? r.Modified_Time),
      };
    }
    default: {
      const title = str(r.Event_Title) ?? "Meeting";
      const participants = Array.isArray(r.Participants) ? (r.Participants as { name?: string | null; Email?: string | null }[]).map((p) => p.name || p.Email).filter(Boolean) : [];
      return {
        title,
        text: [
          `Meeting: ${title}`,
          str(r.Start_DateTime) && `When: ${r.Start_DateTime}${str(r.End_DateTime) ? ` to ${r.End_DateTime}` : ""}`,
          str(r.Venue) && `Where: ${r.Venue}`,
          owner && `Host: ${owner}`,
          (participants.length || who) && `With: ${[who, ...participants].filter(Boolean).join(", ")}`,
          body("Description") && `\n${body("Description")}`,
        ]
          .filter(Boolean)
          .join("\n"),
        at: new Date(str(r.Start_DateTime) ?? r.Modified_Time),
      };
    }
  }
}

/**
 * Notes, tasks, calls and meetings changed since the last sync, each kept under the deal or
 * account it belongs to (else its contact or lead) as one document thread per record. Each
 * activity is a versioned note, so an edited task replaces its old text. People are the CRM's
 * users and its contacts that have an email.
 *
 * Everything is shared with the whole company: Zoho's API doesn't say who else can see a record
 * (that follows roles, profiles and sharing rules), so the founder is told to connect as an admin
 * whose CRM data the company may see.
 */
export async function fetchZoho(api: Api, dc: string, cursor: ZohoCursor = {}, now = new Date()): Promise<Fetched> {
  const people = new Map<string, NormalizedPerson>();
  const addUser = (u: { id: string; name?: string | null; email?: string | null }) => {
    const key = `zoho:${u.id}`;
    if (!people.has(key)) people.set(key, { key, provider: "zoho", externalId: u.id, displayName: u.name || u.email || "Zoho user", email: u.email?.toLowerCase() || undefined });
    return key;
  };
  for (let page = 1; page <= 5; page++) {
    const r = await api<{ users?: User[]; info?: { more_records?: boolean } }>("GET", "users", { query: { type: "AllUsers", per_page: PER_PAGE, page } });
    for (const u of r.users ?? []) addUser({ id: u.id, name: u.full_name, email: u.email });
    if (!r.info?.more_records) break;
  }

  const floor = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const since: Partial<Record<Module, string>> = { ...cursor.since };
  const full: Module[] = [];
  const from = (m: Module) => {
    const last = cursor.since?.[m];
    if (!last) return floor;
    return new Date(Date.parse(last) - (cursor.full?.includes(m) ? 0 : OVERLAP_MS));
  };
  const read = async (m: Module) => {
    const records = await changed(api, m, FIELDS[m], from(m), CAPS[m]).catch((e) => {
      // A module this account can't read (no permission, or renamed away): skip it, keep the rest.
      if (e instanceof ProviderError && [400, 403, 404].includes(e.status)) return [];
      throw e;
    });
    if (records.length >= CAPS[m]) full.push(m);
    const newest = records.at(-1)?.Modified_Time;
    if (newest) since[m] = newest;
    return records;
  };

  for (const c of await read("Contacts")) {
    const email = str(c.Email)?.toLowerCase();
    if (!email) continue;
    const key = `zoho:contact:${c.id}`;
    people.set(key, { key, provider: "zoho", externalId: c.id, displayName: str(c.Full_Name) ?? email, email });
  }

  const threads = new Map<string, NormalizedThread>();
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const m of ACTIVITY_MODULES) {
    for (const r of await read(m)) {
      const { title, text, at } = describe(m, r);
      if (!text.trim()) continue;
      const parent = parentOf(m, r);
      const [threadModule, threadId, threadTitle] = parent ? [parent[0], parent[1].id, `${SINGULAR[parent[0]] ?? parent[0]}: ${parent[1].name || parent[1].id}`] : [m, r.id, `${SINGULAR[m]}: ${title}`];
      if (!threads.has(threadId)) {
        threads.set(threadId, { externalId: threadId, kind: "doc", title: threadTitle, url: recordUrl(dc, threadModule, threadId), visibility: "org", memberKeys: [], metadata: { module: threadModule } });
      }
      const author = r.Created_By ?? r.Owner;
      const externalId = `${r.id}@${r.Modified_Time}`;
      versions.set(r.id, externalId);
      messages.push({
        threadExternalId: threadId,
        externalId,
        kind: "note",
        authorKey: author?.id ? addUser(author) : undefined,
        sentAt: Number.isNaN(at.getTime()) ? new Date(r.Modified_Time) : at,
        subject: title,
        text,
        url: m === "Notes" ? recordUrl(dc, threadModule, threadId) : recordUrl(dc, m, r.id),
      });
    }
  }

  return { people: [...people.values()], threads: [...threads.values()], messages, versions, cursor: { since, full } satisfies ZohoCursor };
}

/** Key fields worth showing for each module; everything else is dropped. */
const KEY_FIELDS: Record<string, string[]> = {
  Leads: ["Full_Name", "Company", "Email", "Phone", "Lead_Status", "Lead_Source", "Owner"],
  Contacts: ["Full_Name", "Email", "Phone", "Mobile", "Title", "Account_Name", "Owner"],
  Accounts: ["Account_Name", "Website", "Phone", "Industry", "Account_Type", "Billing_City", "Owner"],
  Deals: ["Deal_Name", "Stage", "Amount", "Currency", "Closing_Date", "Probability", "Account_Name", "Contact_Name", "Next_Step", "Lead_Source", "Owner"],
};
const SEARCHABLE = ["Leads", "Contacts", "Accounts", "Deals"] as const;
const RECORD_MODULES = ["Leads", "Contacts", "Accounts", "Deals"] as const;

/** A record trimmed to its key fields, with lookups as names. */
function trim(module: string, r: ZohoRecord, extra: string[] = []) {
  const out: Record<string, unknown> = { id: r.id };
  for (const f of [...(KEY_FIELDS[module] ?? []), ...extra]) {
    const v = r[f];
    if (v === null || v === undefined || v === "") continue;
    const l = lookup(v);
    out[f] = l ? (l.name ?? l.id) : typeof v === "string" ? v.slice(0, 500) : v;
  }
  return out;
}

const recordId = z.string().regex(/^\d{1,25}$/, "a Zoho record id (digits only)");
const moduleName = z.enum(RECORD_MODULES);
/** Zoho's word search refuses brackets, quotes and other punctuation. */
const searchWord = (q: string) => q.replace(/[^\p{L}\p{N}\s@.\-_'+]/gu, " ").replace(/\s+/g, " ").trim();
const isClosed = (stage: string) => /\bclosed\b/i.test(stage);

/** The org's home currency, for deals without their own. */
async function orgCurrency(api: Api) {
  const r = await api<{ org?: { iso_code?: string | null; currency?: string | null }[] }>("GET", "org").catch(() => ({ org: [] }));
  return r.org?.[0]?.iso_code || r.org?.[0]?.currency || undefined;
}

function zohoTools(api: Api, dc: string) {
  return {
    zoho_search: tool({
      description:
        "Search the company's Zoho CRM, live, for leads, contacts, accounts or deals matching a word (a name, company, email). Returns ids to open with zoho_record. Say the answer came from Zoho CRM.",
      inputSchema: z.object({
        query: z.string().min(2).describe("A name, company, email or other word to find"),
        module: z.enum(SEARCHABLE).nullish().describe("Only this kind of record. Leave empty to search all four."),
      }),
      execute: async ({ query, module }) => {
        const word = searchWord(query);
        if (word.length < 2) return { error: "Zoho needs at least two letters or digits to search." };
        const modules = module ? [module] : SEARCHABLE;
        const each = module ? MAX_RESULTS : 8;
        const found = await Promise.all(
          modules.map(async (m) => {
            const r = await api<Page>("GET", `${m}/search`, { query: { word, per_page: each, page: 1 } }).catch((e) => {
              if (e instanceof ProviderError && [204, 400, 403, 404].includes(e.status)) return {} as Page;
              throw e;
            });
            return (r.data ?? []).slice(0, each).map((x) => ({ module: m, ...trim(m, x), url: recordUrl(dc, m, x.id) }));
          }),
        );
        return { results: found.flat() };
      },
    }),
    zoho_record: tool({
      description:
        "Open one Zoho CRM record, live: a deal (stage, amount, closing date, owner), account, contact or lead, with its open tasks. Use after zoho_search, or with an id someone gave. Say the answer came from Zoho CRM.",
      inputSchema: z.object({ module: moduleName, id: recordId }),
      execute: async ({ module, id }) => {
        const r = await api<Page>("GET", `${module}/${id}`).catch((e) => {
          if (e instanceof ProviderError && [204, 400, 404].includes(e.status)) return {} as Page;
          throw e;
        });
        const record = r.data?.[0];
        if (!record) return { error: `No ${SINGULAR[module].toLowerCase()} ${id} in Zoho CRM.` };
        const tasks = await api<Page>("GET", `${module}/${id}/Tasks`, { query: { fields: "Subject,Due_Date,Status,Priority,Owner", per_page: 50 } }).catch(() => ({}) as Page);
        const open = (tasks.data ?? [])
          .filter((t) => !/completed/i.test(str(t.Status) ?? ""))
          .slice(0, 10)
          .map((t) => ({ subject: str(t.Subject), due: str(t.Due_Date), status: str(t.Status), owner: t.Owner?.name ?? undefined }));
        const out: Record<string, unknown> = { module, ...trim(module, record, ["Description"]), openTasks: open, url: recordUrl(dc, module, id) };
        if (module === "Deals" && out.Amount !== undefined && !out.Currency) return { ...out, Currency: await orgCurrency(api) };
        return out;
      },
    }),
    zoho_pipeline: tool({
      description:
        "Summarise the open deals in Zoho CRM, live: how many deals and how much money sits in each stage, with totals per currency. Use for pipeline, forecast or 'how much is in negotiation' questions. Say the answer came from Zoho CRM.",
      inputSchema: z.object({}),
      execute: async () => {
        const base = ["Deal_Name", "Stage", "Amount", "Closing_Date"];
        const read = (fields: string[]) => async () => {
          const all: ZohoRecord[] = [];
          for (let page = 1; all.length < MAX_PIPELINE_DEALS; page++) {
            const r = await api<Page>("GET", "Deals", { query: { fields: fields.join(","), sort_by: "Modified_Time", sort_order: "desc", per_page: PER_PAGE, page } });
            all.push(...(r.data ?? []));
            if (!r.info?.more_records || !r.data?.length) break;
          }
          return all;
        };
        // Only multi-currency orgs have a Currency field on deals; ask without it if Zoho refuses.
        const deals = await read([...base, "Currency"])().catch((e) => {
          if (e instanceof ProviderError && e.status === 400) return read(base)();
          throw e;
        });
        const home = deals.some((d) => !str(d.Currency)) ? await orgCurrency(api) : undefined;
        const stages = new Map<string, { stage: string; deals: number; totals: Map<string, number> }>();
        let open = 0;
        for (const d of deals) {
          const stage = str(d.Stage) ?? "(no stage)";
          if (isClosed(stage)) continue;
          open++;
          const s = stages.get(stage) ?? { stage, deals: 0, totals: new Map() };
          s.deals++;
          const amount = typeof d.Amount === "number" ? d.Amount : Number(d.Amount ?? 0) || 0;
          const currency = str(d.Currency) ?? home ?? "org currency";
          s.totals.set(currency, (s.totals.get(currency) ?? 0) + amount);
          stages.set(stage, s);
        }
        const overall = new Map<string, number>();
        for (const s of stages.values()) for (const [c, v] of s.totals) overall.set(c, (overall.get(c) ?? 0) + v);
        const money = (m: Map<string, number>) => [...m].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }));
        return {
          openDeals: open,
          stages: [...stages.values()].map((s) => ({ stage: s.stage, deals: s.deals, totals: money(s.totals) })),
          totals: money(overall),
          note: deals.length >= MAX_PIPELINE_DEALS ? `Read the ${MAX_PIPELINE_DEALS} most recently changed deals only.` : undefined,
        };
      },
    }),
  };
}

interface Created {
  data?: { code?: string; status?: string; message?: string; details?: { id?: string } }[];
}
const created = (r: Created, what: string) => {
  const row = r.data?.[0];
  if (row?.status !== "success") throw new Error(`Zoho CRM didn't add the ${what}: ${row?.message ?? row?.code ?? "no reason given"}`);
  return row.details?.id;
};

const noteInput = z.object({
  module: moduleName.describe("What the note is on"),
  recordId: recordId.describe("That record's Zoho id (from zoho_search)"),
  title: z.string().max(120).nullish(),
  content: z.string().min(1).max(30000),
});
const taskInput = z.object({
  subject: z.string().min(1).max(255),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullish(),
  module: moduleName.nullish().describe("The kind of record the task is about"),
  recordId: recordId.nullish().describe("That record's Zoho id"),
  description: z.string().max(30000).nullish(),
});

const zohoActions = {
  zoho_add_note: {
    description: "Add a note to a deal, account, contact or lead in Zoho CRM (visible to the company's CRM users).",
    input: noteInput,
    audience: () => "internal",
    summary: (i) => `Zoho CRM note on ${SINGULAR[i.module].toLowerCase()} ${i.recordId}${i.title ? `: ${i.title}` : ""}`,
    body: (i) => i.content,
    withBody: (i, content) => ({ ...i, content }),
    async run(api, i, ctx) {
      const r = await api<Created>("POST", "Notes", {
        body: { data: [{ Note_Title: i.title || undefined, Note_Content: i.content, Parent_Id: { module: { api_name: i.module }, id: i.recordId } }] },
      });
      created(r, "note");
      return { url: recordUrl(zohoDc(ctx.credentials), i.module, i.recordId), detail: "Note added" };
    },
  } satisfies ActionDef<z.infer<typeof noteInput>>,
  zoho_create_task: {
    description: "Create a task in Zoho CRM, optionally on a deal, account, contact or lead, owned by the connected Zoho user.",
    input: taskInput,
    audience: () => "internal",
    summary: (i) => `Zoho CRM task: ${i.subject}${i.dueDate ? ` (due ${i.dueDate})` : ""}`,
    body: (i) => i.description ?? "",
    withBody: (i, description) => ({ ...i, description }),
    async run(api, i, ctx) {
      if (!!i.module !== !!i.recordId) throw new Error("Give both the kind of record and its id, or neither.");
      const link =
        i.module && i.recordId ? (i.module === "Contacts" ? { Who_Id: { id: i.recordId } } : { What_Id: { id: i.recordId }, $se_module: i.module }) : {};
      const r = await api<Created>("POST", "Tasks", { body: { data: [{ Subject: i.subject, Due_Date: i.dueDate || undefined, Description: i.description || undefined, ...link }] } });
      const id = created(r, "task");
      return { url: id ? recordUrl(zohoDc(ctx.credentials), "Tasks", id) : undefined, detail: "Task created" };
    },
  } satisfies ActionDef<z.infer<typeof taskInput>>,
};

/** Trades the one-time grant code from Zoho's API console for a lasting refresh token. */
async function exchange(c: Record<string, string>): Promise<Record<string, string>> {
  const dc = zohoDc(c);
  const clientId = (c.clientId ?? "").trim();
  const clientSecret = (c.clientSecret ?? "").trim();
  const code = (c.code ?? "").trim();
  if (!clientId || !clientSecret || !code) throw new Error("Paste the Client ID, Client secret and grant code from your Zoho Self Client.");
  const r = await postForm(`https://${DATA_CENTRES[dc].accounts}/oauth/v2/token`, { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code }).catch((e) => {
    const why = String(e instanceof Error ? e.message : e);
    if (/invalid_code/i.test(why)) throw new Error("Zoho says that grant code was already used or has expired (they last a few minutes). Generate a new one and connect straight away.");
    if (/invalid_client/i.test(why)) throw new Error(`Zoho didn't recognise that Client ID and secret in the "${dc}" data centre. Check both, and that the data centre matches your Zoho address.`);
    throw e;
  });
  const refreshToken = typeof r.refresh_token === "string" ? r.refresh_token : "";
  if (!refreshToken) throw new Error("Zoho didn't return a refresh token for that grant code. Generate a new code (with the scopes listed) and try again.");
  return { dc, clientId, clientSecret, refreshToken };
}

/** Zoho CRM: activities synced into memory, records read live, notes and tasks added on approval. */
export const zohoCrm: Provider = {
  id: "zoho",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "dc", label: "Data centre", placeholder: "com, in, eu, com.au, jp, ca, sa or com.cn (from crm.zoho.in → in)" },
      { name: "clientId", label: "Client ID", placeholder: "1000.…" },
      { name: "clientSecret", label: "Client secret", secret: true },
      { name: "code", label: "Grant code", secret: true },
    ],
    setup: `Signed in to Zoho as a CRM admin, open api-console.zoho.com, add a Self Client, and under Generate Code enter the scopes ${ZOHO_SCOPES.join(",")} with the longest duration. Paste its Client ID, Client secret and the code here within those minutes. ALRO reads the CRM and only adds notes and tasks you approve.`,
    docsUrl: "https://www.zoho.com/crm/developer/docs/api/v8/auth-request.html",
    exchange,
    api: (c) => {
      const dc = zohoDc(c);
      return httpApi({
        baseUrl: `https://${DATA_CENTRES[dc].api}/crm/v8/`,
        headers: mintedBearer(async () => {
          const r = await postForm(`https://${DATA_CENTRES[dc].accounts}/oauth/v2/token`, {
            grant_type: "refresh_token",
            client_id: c.clientId ?? "",
            client_secret: c.clientSecret ?? "",
            refresh_token: c.refreshToken ?? "",
          });
          if (typeof r.access_token !== "string") throw new ProviderError("Zoho didn't return an access token. Reconnect Zoho CRM in Settings.", 401);
          return { accessToken: r.access_token, expiresIn: typeof r.expires_in === "number" ? r.expires_in : undefined };
        }),
      });
    },
  },
  async identify(api) {
    const r = await api<{ org?: { id?: string; company_name?: string | null; domain_name?: string | null }[] }>("GET", "org").catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Zoho CRM refused that connection. Generate a new grant code with the scopes listed and connect again.");
      throw e;
    });
    const org = r.org?.[0];
    if (!org?.id) throw new Error("Zoho didn't name a CRM organization for this account. Is Zoho CRM set up for it?");
    return { accountId: `zoho:${org.id}`, label: org.company_name || org.domain_name || `Zoho CRM ${org.id}` };
  },
  async sync(api, cursor, ctx) {
    return fetchZoho(api, zohoDc(ctx.credentials), cursor as ZohoCursor | undefined, ctx.now);
  },
  tools: (api, ctx) => zohoTools(api, zohoDc(ctx.credentials)),
  actions: zohoActions,
};
