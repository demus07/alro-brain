import { tool } from "ai";
import { z } from "zod";
import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { httpApi, mintedBearer, postForm, ProviderError, type Api } from "./api";
import type { ActionDef, Fetched, Provider } from "./provider";
import { htmlToText } from "./teams";

/** Salesforce REST API version: Winter '27, live on production orgs since October 2026. */
export const SALESFORCE_VERSION = "v68.0";
/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** Each sync re-reads this much before the last change it saw, unless it stopped at a cap. */
const OVERLAP_MS = 5 * 60_000;
/** Records read per object per sync; the next sync continues from the last one read. Each note costs one more call for its text. */
const CAPS = { Task: 200, Event: 100, EmailMessage: 100, ContentNote: 50, Note: 100, Contact: 200 } as const;
const MAX_PIPELINE_ROWS = 2000;
const MAX_RESULTS = 25;
const MAX_TEXT = 8000;

type SObject = keyof typeof CAPS;

/** "acme", "acme.my.salesforce.com", a Lightning URL or a pasted link, as the My Domain host. */
export function myDomain(credentials: Record<string, string>): string {
  let host = (credentials.domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#:].*$/, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) host = `${host}.my.salesforce.com`;
  host = host.replace(/\.lightning\.force\.com$/, ".my.salesforce.com");
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)?\.my\.salesforce\.com$/.test(host)) {
    throw new Error("Enter your Salesforce My Domain URL, like https://acme.my.salesforce.com (Setup → My Domain shows it; sandboxes end in .sandbox.my.salesforce.com).");
  }
  return host;
}

/** A Salesforce record id (15 or 18 characters). */
const sfId = z.string().regex(/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/, "a Salesforce record id");
/** A value inside single quotes in SOQL. */
const quote = (v: string) => `'${v.replace(/[\\']/g, "\\$&")}'`;
/** A value inside LIKE '%…%', with its wildcards taken literally. */
const like = (v: string) => `'%${v.replace(/[\\'%_]/g, "\\$&")}%'`;
/** A SOQL datetime literal (no quotes, no milliseconds). */
const soqlTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const recordUrl = (host: string, id: string) => `https://${host}/${id}`;

interface Named {
  Name?: string | null;
  Type?: string | null;
  Email?: string | null;
}
interface Row {
  Id: string;
  [field: string]: unknown;
}
interface QueryResult<T> {
  records?: T[];
  done?: boolean;
  nextRecordsUrl?: string;
}

/** Runs one SOQL query, following Salesforce's next-page links up to `max` rows. */
export async function soql<T = Row>(api: Api, q: string, max = 2000): Promise<T[]> {
  const all: T[] = [];
  let r = await api<QueryResult<T>>("GET", "query", { query: { q } });
  for (;;) {
    all.push(...(r.records ?? []));
    if (r.done !== false || !r.nextRecordsUrl || all.length >= max) break;
    r = await api<QueryResult<T>>("GET", r.nextRecordsUrl.replace(/^\/services\/data\/v[\d.]+\//, ""));
  }
  return all.slice(0, max);
}

const named = (v: unknown): Named | undefined => (v && typeof v === "object" ? (v as Named) : undefined);
/** An object this account can't query (not enabled, no permission): skip it and carry on. */
const unavailable = (e: unknown) => e instanceof ProviderError && [400, 403, 404].includes(e.status);

export interface SalesforceCursor {
  /** Newest change read (SystemModstamp, or LastModifiedDate for notes), per object. */
  since?: Partial<Record<SObject, string>>;
  /** Objects whose last sync stopped at its cap: the next one continues exactly where it stopped. */
  full?: SObject[];
}

/** One activity on its way to becoming a message. */
interface Item {
  id: string;
  stamp: string;
  kind: "note" | "email";
  title: string;
  text: string;
  at: Date;
  ownerId?: string;
  /** The record it belongs to (an opportunity, account, contact, lead, case…). */
  parent?: { type: string; id: string; name?: string };
  /** Private to its owner in Salesforce (a private event or note). */
  private?: boolean;
}

const lines = (...l: (string | false | null | undefined)[]) => l.filter(Boolean).join("\n");
const clip = (s: string | undefined) => (s ? s.slice(0, MAX_TEXT) : undefined);

/** The record an activity is filed under: its opportunity, else its account, else whatever it's related to or about. */
function activityParent(r: Row): Item["parent"] {
  const what = named(r.What);
  if (r.WhatId && what?.Type === "Opportunity") return { type: "Opportunity", id: String(r.WhatId), name: what.Name ?? undefined };
  if (r.AccountId) return { type: "Account", id: String(r.AccountId), name: named(r.Account)?.Name ?? undefined };
  if (r.WhatId && what?.Type) return { type: what.Type, id: String(r.WhatId), name: what.Name ?? undefined };
  const who = named(r.Who);
  if (r.WhoId && who?.Type) return { type: who.Type, id: String(r.WhoId), name: who.Name ?? undefined };
  return undefined;
}

/** Organization-wide defaults: whether everyone in the company can read records of each type. */
type Defaults = Partial<Record<"DefaultAccountAccess" | "DefaultContactAccess" | "DefaultOpportunityAccess" | "DefaultLeadAccess" | "DefaultCaseAccess", string>>;
const OWD_FIELD: Record<string, keyof Defaults> = {
  Account: "DefaultAccountAccess",
  Contact: "DefaultContactAccess",
  Opportunity: "DefaultOpportunityAccess",
  Lead: "DefaultLeadAccess",
  Case: "DefaultCaseAccess",
};
/** True only when the org's default lets every user read this type. Anything unknown counts as private. */
function readableByAll(type: string, d: Defaults): boolean {
  const field = OWD_FIELD[type];
  let v = field ? d[field] : undefined;
  if (type === "Contact" && v === "ControlledByParent") v = d.DefaultAccountAccess;
  return !!v && v !== "None" && !v.startsWith("Controlled");
}

/**
 * Tasks, calls, meetings, emails and notes changed since the last sync, each filed under the
 * opportunity or account it belongs to (else its case, contact or lead) as one document thread
 * per record. Tasks, events and notes are versioned notes, so an edit replaces the old text.
 * People are Salesforce users and contacts with an email.
 *
 * Who sees what: Salesforce sharing (role hierarchy, sharing rules, teams) can't be read cheaply,
 * so ALRO is conservative. A record type the org shares with everyone (its organization-wide
 * default is Read or Edit) is visible to the company; otherwise only the record's owner sees it
 * here. Private events and notes go to their owner only; anything whose owner isn't a person
 * (a queue) is skipped.
 */
export async function fetchSalesforce(api: Api, host: string, cursor: SalesforceCursor = {}, now = new Date()): Promise<Fetched> {
  const [org] = await soql<Defaults>(
    api,
    "SELECT Id, DefaultAccountAccess, DefaultContactAccess, DefaultOpportunityAccess, DefaultLeadAccess, DefaultCaseAccess FROM Organization LIMIT 1",
  ).catch((e) => {
    if (unavailable(e)) return [{} as Defaults];
    throw e;
  });
  const defaults = org ?? {};

  const people = new Map<string, NormalizedPerson>();
  const users = new Set<string>();
  for (const u of await soql<Row>(api, "SELECT Id, Name, Email FROM User WHERE UserType = 'Standard' ORDER BY Id LIMIT 2000")) {
    const key = `salesforce:${u.Id}`;
    users.add(u.Id);
    people.set(key, { key, provider: "salesforce", externalId: u.Id, displayName: str(u.Name) ?? str(u.Email) ?? "Salesforce user", email: str(u.Email)?.toLowerCase() });
  }
  const userKey = (id: unknown) => (typeof id === "string" && users.has(id) ? `salesforce:${id}` : undefined);

  const floor = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const since: Partial<Record<SObject, string>> = { ...cursor.since };
  const full: SObject[] = [];
  const read = async (object: SObject, fields: string, stampField = "SystemModstamp", where = "") => {
    const last = cursor.since?.[object];
    const from = last ? new Date(Date.parse(last) - (cursor.full?.includes(object) ? 0 : OVERLAP_MS)) : floor;
    const rows = await soql<Row>(api, `SELECT ${fields}, ${stampField} FROM ${object} WHERE ${stampField} > ${soqlTime(from)}${where} ORDER BY ${stampField} ASC LIMIT ${CAPS[object]}`, CAPS[object]).catch(
      (e) => {
        if (unavailable(e)) return [] as Row[];
        throw e;
      },
    );
    if (rows.length >= CAPS[object]) full.push(object);
    const newest = str(rows.at(-1)?.[stampField]);
    if (newest) since[object] = newest;
    return rows.map((r): Row & { stamp: string } => ({ ...r, stamp: String(r[stampField]) }));
  };

  for (const c of await read("Contact", "Id, Name, Email", "SystemModstamp", " AND Email != null")) {
    const email = str(c.Email)?.toLowerCase();
    if (!email) continue;
    const key = `salesforce:${c.Id}`;
    people.set(key, { key, provider: "salesforce", externalId: c.Id, displayName: str(c.Name) ?? email, email });
  }

  const items: Item[] = [];
  const related = "WhatId, What.Name, What.Type, WhoId, Who.Name, Who.Type, AccountId, Account.Name, OwnerId";
  for (const t of await read("Task", `Id, Subject, Description, Status, Priority, ActivityDate, TaskSubtype, CallDurationInSeconds, CallDisposition, LastModifiedDate, ${related}`)) {
    const isCall = t.TaskSubtype === "Call";
    const title = str(t.Subject) ?? (isCall ? "Call" : "Task");
    const who = named(t.Who)?.Name;
    items.push({
      id: t.Id,
      stamp: t.stamp,
      kind: "note",
      title,
      text: lines(
        `${isCall ? "Call" : "Task"}: ${title}`,
        [`Status: ${str(t.Status) ?? "unknown"}`, str(t.Priority) && `Priority: ${t.Priority}`, str(t.ActivityDate) && `Due: ${t.ActivityDate}`].filter(Boolean).join(" · "),
        who && `With: ${who}`,
        typeof t.CallDurationInSeconds === "number" && `Duration: ${Math.round(t.CallDurationInSeconds / 60)} min`,
        str(t.CallDisposition) && `Result: ${t.CallDisposition}`,
        clip(str(t.Description)) && `\n${clip(str(t.Description))}`,
      ),
      at: new Date(str(t.LastModifiedDate) ?? t.stamp),
      ownerId: str(t.OwnerId),
      parent: activityParent(t),
    });
  }
  for (const e of await read("Event", `Id, Subject, Description, Location, StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate, IsPrivate, ${related}`)) {
    const title = str(e.Subject) ?? "Meeting";
    const who = named(e.Who)?.Name;
    const when = e.IsAllDayEvent ? str(e.ActivityDate) : [str(e.StartDateTime), str(e.EndDateTime)].filter(Boolean).join(" to ");
    items.push({
      id: e.Id,
      stamp: e.stamp,
      kind: "note",
      title,
      text: lines(`Meeting: ${title}`, when && `When: ${when}`, str(e.Location) && `Where: ${e.Location}`, who && `With: ${who}`, clip(str(e.Description)) && `\n${clip(str(e.Description))}`),
      at: new Date(str(e.StartDateTime) ?? str(e.ActivityDate) ?? e.stamp),
      ownerId: str(e.OwnerId),
      parent: activityParent(e),
      private: e.IsPrivate === true,
    });
  }
  for (const m of await read("EmailMessage", "Id, Subject, TextBody, FromName, FromAddress, ToAddress, CcAddress, MessageDate, Incoming, RelatedToId, RelatedTo.Name, RelatedTo.Type, CreatedById")) {
    const title = str(m.Subject) ?? "(no subject)";
    const to = named(m.RelatedTo);
    items.push({
      id: m.Id,
      stamp: m.stamp,
      kind: "email",
      title,
      text: lines(
        `Email: ${title}`,
        `From: ${[str(m.FromName), str(m.FromAddress) && `<${m.FromAddress}>`].filter(Boolean).join(" ")}`,
        str(m.ToAddress) && `To: ${m.ToAddress}`,
        str(m.CcAddress) && `Cc: ${m.CcAddress}`,
        clip(str(m.TextBody)) && `\n${clip(str(m.TextBody))}`,
      ),
      at: new Date(str(m.MessageDate) ?? m.stamp),
      ownerId: str(m.CreatedById),
      parent: m.RelatedToId && to?.Type ? { type: to.Type, id: String(m.RelatedToId), name: to.Name ?? undefined } : undefined,
    });
  }
  for (const n of await read("Note", "Id, Title, Body, IsPrivate, ParentId, Parent.Name, Parent.Type, OwnerId")) {
    const title = str(n.Title) ?? "Note";
    const parent = named(n.Parent);
    items.push({
      id: n.Id,
      stamp: n.stamp,
      kind: "note",
      title,
      text: lines(`Note: ${title}`, clip(str(n.Body)) && `\n${clip(str(n.Body))}`),
      at: new Date(n.stamp),
      ownerId: str(n.OwnerId),
      parent: n.ParentId && parent?.Type ? { type: parent.Type, id: String(n.ParentId), name: parent.Name ?? undefined } : undefined,
      private: n.IsPrivate === true,
    });
  }

  // Enhanced notes: the record a note is on comes from its document links; its text is fetched one by one.
  const notes = await read("ContentNote", "Id, Title, TextPreview, OwnerId", "LastModifiedDate");
  const links = new Map<string, { id: string; type: string; name?: string }[]>();
  for (let i = 0; i < notes.length; i += 100) {
    const ids = notes.slice(i, i + 100).map((n) => quote(n.Id));
    const rows = await soql<Row>(api, `SELECT ContentDocumentId, LinkedEntityId, LinkedEntity.Name, LinkedEntity.Type FROM ContentDocumentLink WHERE ContentDocumentId IN (${ids.join(", ")})`).catch((e) => {
      if (unavailable(e)) return [] as Row[];
      throw e;
    });
    for (const l of rows) {
      const entity = named(l.LinkedEntity);
      if (!entity?.Type || entity.Type === "User") continue;
      const doc = String(l.ContentDocumentId);
      links.set(doc, [...(links.get(doc) ?? []), { id: String(l.LinkedEntityId), type: entity.Type, name: entity.Name ?? undefined }]);
    }
  }
  for (const n of notes) {
    const title = str(n.Title) ?? "Note";
    const body = await api<string>("GET", `sobjects/ContentNote/${n.Id}/Content`, { as: "text", headers: { accept: "*/*" } })
      .then((html) => htmlToText(html))
      .catch((e) => {
        if (unavailable(e)) return str(n.TextPreview) ?? "";
        throw e;
      });
    const on = links.get(n.Id) ?? [];
    const parent = on.find((l) => l.type === "Opportunity") ?? on.find((l) => l.type === "Account") ?? on[0];
    // A note linked to no record is its owner's own.
    items.push({ id: n.Id, stamp: n.stamp, kind: "note", title, text: lines(`Note: ${title}`, body && `\n${clip(body)}`), at: new Date(n.stamp), ownerId: str(n.OwnerId), parent, private: !parent });
  }

  // Owners of records the org doesn't share with everyone: they are who may see those threads here.
  const owners = new Map<string, string | undefined>();
  const restricted = new Map<string, Set<string>>();
  for (const it of items) {
    if (it.parent && !it.private && !readableByAll(it.parent.type, defaults) && /^\w+$/.test(it.parent.type)) {
      restricted.set(it.parent.type, (restricted.get(it.parent.type) ?? new Set()).add(it.parent.id));
    }
  }
  for (const [type, ids] of restricted) {
    const all = [...ids];
    for (let i = 0; i < all.length; i += 100) {
      const rows = await soql<Row>(api, `SELECT Id, OwnerId FROM ${type} WHERE Id IN (${all.slice(i, i + 100).map(quote).join(", ")})`).catch((e) => {
        if (unavailable(e)) return [] as Row[];
        throw e;
      });
      for (const r of rows) owners.set(r.Id, str(r.OwnerId));
    }
  }

  const threads = new Map<string, NormalizedThread>();
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const it of items) {
    if (!it.text.trim()) continue;
    let thread: NormalizedThread;
    if (it.parent && !it.private) {
      const open = readableByAll(it.parent.type, defaults);
      const owner = open ? undefined : userKey(owners.get(it.parent.id));
      if (!open && !owner) continue;
      thread = {
        externalId: it.parent.id,
        kind: "doc",
        title: `${it.parent.type}: ${it.parent.name || it.parent.id}`,
        url: recordUrl(host, it.parent.id),
        visibility: open ? "org" : "members",
        memberKeys: owner ? [owner] : [],
        metadata: { object: it.parent.type },
      };
    } else {
      const owner = userKey(it.ownerId);
      if (!owner) continue;
      thread = { externalId: it.id, kind: "doc", title: it.title, url: recordUrl(host, it.id), visibility: "members", memberKeys: [owner] };
    }
    if (!threads.has(thread.externalId)) threads.set(thread.externalId, thread);
    const externalId = it.kind === "email" ? it.id : `${it.id}@${it.stamp}`;
    if (it.kind !== "email") versions.set(it.id, externalId);
    messages.push({
      threadExternalId: thread.externalId,
      externalId,
      kind: it.kind,
      authorKey: userKey(it.ownerId),
      sentAt: Number.isNaN(it.at.getTime()) ? new Date(it.stamp) : it.at,
      subject: it.title,
      text: it.text,
      url: recordUrl(host, it.id),
    });
  }

  return { people: [...people.values()], threads: [...threads.values()], messages, versions, cursor: { since, full } satisfies SalesforceCursor };
}

/** SOSL treats these as operators; a search term must escape them. */
const sosl = (term: string) => term.replace(/[?&|!{}[\]()^~*:\\"'+-]/g, "\\$&");

/** Whether opportunities carry their own currency, else the org's one currency (looked up once). */
function currencies(api: Api) {
  let found: Promise<{ multi: boolean; home: string | undefined }> | undefined;
  return () =>
    (found ??= soql(api, "SELECT Id, CurrencyIsoCode FROM Opportunity LIMIT 1")
      .then(() => ({ multi: true, home: undefined }))
      .catch(async () => {
        const [o] = await soql<{ DefaultCurrencyIsoCode?: string }>(api, "SELECT DefaultCurrencyIsoCode FROM Organization LIMIT 1").catch(() => []);
        return { multi: false, home: o?.DefaultCurrencyIsoCode ?? undefined };
      }));
}

/** A row's fields with lookups flattened to names and Salesforce's bookkeeping dropped. */
function flat(r: Row) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "attributes" || v === null || v === undefined || v === "") continue;
    if (typeof v === "object") {
      const n = named(v)?.Name;
      if (n) out[k] = n;
      continue;
    }
    out[k] = typeof v === "string" ? v.slice(0, 500) : v;
  }
  return out;
}

function salesforceTools(api: Api, host: string) {
  const currency = currencies(api);
  const OPPORTUNITY = "Id, Name, StageName, Amount, CloseDate, Probability, ForecastCategoryName, NextStep, Type, LeadSource, IsClosed, IsWon, Description, Account.Name, Owner.Name, LastActivityDate";
  return {
    salesforce_search: tool({
      description:
        "Search the company's Salesforce, live, for accounts, contacts, opportunities and leads matching words (a name, company, email, phone). Returns ids to open with salesforce_opportunity. Say the answer came from Salesforce.",
      inputSchema: z.object({ query: z.string().min(2).describe("Words to find") }),
      execute: async ({ query }) => {
        const term = sosl(query.trim().slice(0, 100));
        const each = 8;
        const q = `FIND {${term}} IN ALL FIELDS RETURNING Account(Id, Name, Industry, Website, Owner.Name LIMIT ${each}), Contact(Id, Name, Email, Phone, Title, Account.Name LIMIT ${each}), Opportunity(Id, Name, StageName, Amount, CloseDate, Account.Name LIMIT ${each}), Lead(Id, Name, Company, Email, Status WHERE IsConverted = false LIMIT ${each})`;
        const r = await api<{ searchRecords?: (Row & { attributes?: { type?: string } })[] }>("GET", "search", { query: { q } });
        const { home } = await currency();
        const results = (r.searchRecords ?? []).slice(0, MAX_RESULTS).map((x) => ({
          type: x.attributes?.type,
          ...flat(x),
          ...(x.attributes?.type === "Opportunity" && typeof x.Amount === "number" && home ? { currency: home } : {}),
          url: recordUrl(host, x.Id),
        }));
        return { results };
      },
    }),
    salesforce_opportunity: tool({
      description:
        "Open one Salesforce opportunity, live: stage, amount, close date, owner, account, next step and its open tasks. Give its id (from salesforce_search) or part of its name. Say the answer came from Salesforce.",
      inputSchema: z.object({ id: sfId.nullish(), name: z.string().min(2).max(120).nullish().describe("Part of the opportunity's name, when you don't have its id") }),
      execute: async ({ id, name }) => {
        if (!id && !name) return { error: "Give the opportunity's id or part of its name." };
        const { multi, home } = await currency();
        const fields = multi ? `${OPPORTUNITY}, CurrencyIsoCode` : OPPORTUNITY;
        const found = await soql<Row>(api, `SELECT ${fields} FROM Opportunity WHERE ${id ? `Id = ${quote(id)}` : `Name LIKE ${like(name!)}`} ORDER BY LastModifiedDate DESC LIMIT 5`, 5);
        if (!found.length) return { error: `No Salesforce opportunity matches ${id ?? `"${name}"`}.` };
        if (found.length > 1) return { matches: found.map((o) => ({ id: o.Id, name: o.Name, stage: o.StageName, account: named(o.Account)?.Name })), note: "Several match; ask again with one id." };
        const o = found[0];
        const tasks = await soql<Row>(api, `SELECT Id, Subject, ActivityDate, Status, Priority, Owner.Name FROM Task WHERE WhatId = ${quote(o.Id)} AND IsClosed = false ORDER BY ActivityDate ASC NULLS LAST LIMIT 10`, 10).catch(
          () => [] as Row[],
        );
        const { CurrencyIsoCode, Description, ...rest } = flat(o);
        return {
          ...rest,
          currency: (CurrencyIsoCode as string | undefined) ?? home,
          description: typeof Description === "string" ? Description : undefined,
          openTasks: tasks.map((t) => ({ subject: t.Subject, due: t.ActivityDate ?? undefined, status: t.Status, priority: t.Priority, owner: named(t.Owner)?.Name })),
          url: recordUrl(host, o.Id),
        };
      },
    }),
    salesforce_pipeline: tool({
      description:
        "Summarise open Salesforce opportunities, live: how many and how much money sits in each stage, with totals per currency. Optionally only those closing by a date. Use for pipeline and forecast questions. Say the answer came from Salesforce.",
      inputSchema: z.object({ closingBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullish().describe("Only opportunities with a close date on or before this day") }),
      execute: async ({ closingBy }) => {
        const { multi, home } = await currency();
        const rows = await soql<Row>(
          api,
          `SELECT StageName, Amount${multi ? ", CurrencyIsoCode" : ""} FROM Opportunity WHERE IsClosed = false${closingBy ? ` AND CloseDate <= ${closingBy}` : ""} LIMIT ${MAX_PIPELINE_ROWS}`,
          MAX_PIPELINE_ROWS,
        );
        const order = await soql<Row>(api, "SELECT ApiName, MasterLabel, SortOrder FROM OpportunityStage WHERE IsActive = true ORDER BY SortOrder").catch(() => [] as Row[]);
        const rank = (stage: string) => {
          const i = order.findIndex((s) => s.ApiName === stage || s.MasterLabel === stage);
          return i < 0 ? order.length : i;
        };
        const stages = new Map<string, { deals: number; totals: Map<string, number> }>();
        for (const r of rows) {
          const stage = str(r.StageName) ?? "(no stage)";
          const s = stages.get(stage) ?? { deals: 0, totals: new Map() };
          s.deals++;
          const c = str(r.CurrencyIsoCode) ?? home ?? "org currency";
          s.totals.set(c, (s.totals.get(c) ?? 0) + (typeof r.Amount === "number" ? r.Amount : 0));
          stages.set(stage, s);
        }
        const money = (m: Map<string, number>) => [...m].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }));
        const overall = new Map<string, number>();
        for (const s of stages.values()) for (const [c, v] of s.totals) overall.set(c, (overall.get(c) ?? 0) + v);
        return {
          openOpportunities: rows.length,
          stages: [...stages]
            .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
            .map(([stage, s]) => ({ stage, opportunities: s.deals, totals: money(s.totals) })),
          totals: money(overall),
          note: rows.length >= MAX_PIPELINE_ROWS ? `Counted the first ${MAX_PIPELINE_ROWS} open opportunities only.` : undefined,
        };
      },
    }),
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** Plain text as the HTML body a Salesforce note stores (base64, one paragraph per line). */
export const noteContent = (text: string) =>
  Buffer.from(
    text
      .split(/\r?\n/)
      .map((l) => `<p>${escapeHtml(l)}</p>`)
      .join(""),
    "utf8",
  ).toString("base64");

interface Saved {
  id?: string;
  success?: boolean;
  errors?: { message?: string }[];
}
const saved = (r: Saved, what: string) => {
  if (!r.id || r.success === false) throw new Error(`Salesforce didn't save the ${what}: ${r.errors?.map((e) => e.message).join("; ") || "no reason given"}`);
  return r.id;
};

const taskInput = z.object({
  subject: z.string().min(1).max(255),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullish(),
  whatId: sfId.nullish().describe("The opportunity, account or case it's about"),
  whoId: sfId.nullish().describe("The contact or lead it's about"),
  description: z.string().max(32000).nullish(),
});
const noteInput = z.object({
  recordId: sfId.describe("The opportunity, account, contact, lead or case the note is on"),
  title: z.string().min(1).max(255),
  body: z.string().min(1).max(100000),
});

const salesforceActions = {
  salesforce_create_task: {
    description: "Create a task in Salesforce, optionally on an opportunity/account (whatId) and a contact/lead (whoId). It is owned by the connected integration user.",
    input: taskInput,
    audience: () => "internal",
    summary: (i) => `Salesforce task: ${i.subject}${i.dueDate ? ` (due ${i.dueDate})` : ""}`,
    body: (i) => i.description ?? "",
    withBody: (i, description) => ({ ...i, description }),
    async run(api, i, ctx) {
      const r = await api<Saved>("POST", "sobjects/Task", {
        body: { Subject: i.subject, ActivityDate: i.dueDate || undefined, WhatId: i.whatId || undefined, WhoId: i.whoId || undefined, Description: i.description || undefined },
      });
      const id = saved(r, "task");
      return { url: recordUrl(myDomain(ctx.credentials), id), detail: "Task created" };
    },
  } satisfies ActionDef<z.infer<typeof taskInput>>,
  salesforce_log_note: {
    description: "Add a note to a Salesforce opportunity, account, contact, lead or case (shown in its Notes list to everyone who can see that record).",
    input: noteInput,
    audience: () => "internal",
    summary: (i) => `Salesforce note on ${i.recordId}: ${i.title}`,
    body: (i) => i.body,
    withBody: (i, body) => ({ ...i, body }),
    async run(api, i, ctx) {
      const id = saved(await api<Saved>("POST", "sobjects/ContentNote", { body: { Title: i.title, Content: noteContent(i.body) } }), "note");
      await api<Saved>("POST", "sobjects/ContentDocumentLink", { body: { ContentDocumentId: id, LinkedEntityId: i.recordId, ShareType: "I" } }).catch((e) => {
        throw new Error(`Salesforce saved the note but couldn't attach it to ${i.recordId} (${e instanceof Error ? e.message : e}). It's in the integration user's Notes as "${i.title}".`);
      });
      return { url: recordUrl(myDomain(ctx.credentials), i.recordId), detail: "Note added" };
    },
  } satisfies ActionDef<z.infer<typeof noteInput>>,
};

/** Plain-English reasons for Salesforce's client-credentials refusals. */
function explain(e: unknown): never {
  const why = e instanceof Error ? e.message : String(e);
  if (/no client credentials user enabled/i.test(why)) throw new Error("Salesforce has no Run As user for this app. In the app's OAuth policies, enable the Client Credentials Flow and pick a Run As user.");
  if (/not supported on this domain/i.test(why)) throw new Error("Salesforce only allows this sign-in on your My Domain URL (https://yourcompany.my.salesforce.com), not login.salesforce.com.");
  if (/invalid_client|client identifier invalid|invalid client credentials/i.test(why)) throw new Error("Salesforce didn't accept that consumer key and secret. Copy both again from the app's settings (new apps can take up to 10 minutes to work).");
  if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Salesforce refused the connection. Check the app's Client Credentials Flow, its Run As user and that the user has API access.");
  throw e;
}

/** Salesforce: activities synced into memory, opportunities read live, tasks and notes added on approval. */
export const salesforce: Provider = {
  id: "salesforce",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "domain", label: "My Domain URL", placeholder: "https://acme.my.salesforce.com" },
      { name: "clientId", label: "Consumer key" },
      { name: "clientSecret", label: "Consumer secret", secret: true },
    ],
    setup:
      "In Salesforce Setup, create an External Client App (or Connected App) with OAuth scope 'Manage user data via APIs (api)', enable the Client Credentials Flow and set its Run As user to an integration user who can read accounts, opportunities, contacts, leads, activities and notes (and create tasks and notes, for actions you approve). Paste your My Domain URL with the app's consumer key and secret.",
    docsUrl: "https://help.salesforce.com/s/articleView?id=xcloud.connected_app_client_credentials_setup.htm",
    api: (c) => {
      const host = myDomain(c);
      return httpApi({
        baseUrl: `https://${host}/services/data/${SALESFORCE_VERSION}/`,
        headers: mintedBearer(async () => {
          const r = await postForm(`https://${host}/services/oauth2/token`, { grant_type: "client_credentials", client_id: (c.clientId ?? "").trim(), client_secret: (c.clientSecret ?? "").trim() });
          if (typeof r.access_token !== "string") throw new ProviderError("Salesforce didn't return an access token. Reconnect Salesforce in Settings.", 401);
          // Salesforce doesn't say how long a session lasts; the shortest session timeout is 15 minutes.
          return { accessToken: r.access_token, expiresIn: 15 * 60 };
        }),
      });
    },
  },
  async identify(api, credentials) {
    const host = myDomain(credentials);
    const [org] = await soql<{ Id: string; Name?: string }>(api, "SELECT Id, Name FROM Organization LIMIT 1").catch(explain);
    if (!org?.Id) throw new Error("Salesforce didn't name the organization. Does the Run As user have API access?");
    return { accountId: `salesforce:${org.Id}`, label: `${org.Name ?? "Salesforce"} (${host})` };
  },
  async sync(api, cursor, ctx) {
    return fetchSalesforce(api, myDomain(ctx.credentials), cursor as SalesforceCursor | undefined, ctx.now);
  },
  tools: (api, ctx) => salesforceTools(api, myDomain(ctx.credentials)),
  actions: salesforceActions,
};
