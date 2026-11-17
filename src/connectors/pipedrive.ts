import { tool } from "ai";
import { z } from "zod";
import { listOf } from "@/lib/tool-input";
import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { httpApi, ProviderError, type Api } from "./api";
import type { ActionDef, Fetched, Provider, ToolContext } from "./provider";
import { htmlToText } from "./teams";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** Each pass re-reads this much before the newest change it saw, in case Pipedrive's filter is exclusive. */
const OVERLAP_MS = 60_000;
const PAGE_SIZE = 100;
/** Pages of notes, and of activities, read per sync: at most 600 items, so a sync finishes in minutes. */
const MAX_PAGES = 3;
/** Pipedrive takes up to 100 ids in one lookup. */
const ID_CHUNK = 100;
const MAX_RESULTS = 25;

/** Where each change feed continues from. */
interface Stream {
  /** Items changed at or after this (RFC 3339) are read. */
  since: string;
  /** Set only when a pass was cut short and couldn't move `since` forward: the notes offset, or the activities page cursor. */
  start?: number;
  next?: string;
}
export interface PipedriveCursor {
  notes?: Stream;
  activities?: Stream;
}

interface V1<T> {
  data?: T | null;
  additional_data?: { pagination?: { more_items_in_collection?: boolean; next_start?: number } };
}
interface V2<T> {
  data?: T | null;
  additional_data?: { next_cursor?: string | null };
}
interface User {
  id: number;
  name?: string | null;
  email?: string | null;
}
interface Note {
  id: number;
  content?: string | null;
  deal_id?: number | null;
  person_id?: number | null;
  user_id?: number | null;
  active_flag?: boolean;
  add_time: string;
  update_time?: string | null;
}
interface Activity {
  id: number;
  subject?: string | null;
  type?: string | null;
  owner_id?: number | null;
  creator_user_id?: number | null;
  is_deleted?: boolean;
  deal_id?: number | null;
  person_id?: number | null;
  participants?: { person_id?: number | null; primary?: boolean }[] | null;
  due_date?: string | null;
  due_time?: string | null;
  done?: boolean;
  note?: string | null;
  add_time: string;
  update_time?: string | null;
}
interface Deal {
  id: number;
  title?: string | null;
  owner_id?: number | null;
  person_id?: number | null;
  org_id?: number | null;
  pipeline_id?: number | null;
  stage_id?: number | null;
  value?: number | null;
  currency?: string | null;
  status?: string | null;
  visible_to?: number | string | null;
  expected_close_date?: string | null;
  update_time?: string | null;
  is_deleted?: boolean;
  next_activity_id?: number | null;
}
interface Person {
  id: number;
  name?: string | null;
  emails?: { value?: string | null; primary?: boolean }[] | null;
}
interface Named {
  id: number;
  name?: string | null;
  pipeline_id?: number | null;
  order_nr?: number | null;
}

/** "acme", "acme.pipedrive.com" or a pasted link, as the company subdomain. Anything not on pipedrive.com is refused, so the token only ever goes to Pipedrive. */
export function domainOf(credentials: Record<string, string>): string {
  const host = (credentials.domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  const sub = host.endsWith(".pipedrive.com") ? host.slice(0, -".pipedrive.com".length) : host;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(sub) || ["api", "app", "www", "developers", "oauth"].includes(sub)) {
    throw new Error("Enter your Pipedrive company domain: the acme in acme.pipedrive.com.");
  }
  return sub;
}

const appUrl = (domain: string, kind: "deal" | "person" | "organization", id: number) => `https://${domain}.pipedrive.com/${kind}/${id}`;

/** A Pipedrive time ("2026-11-01 10:00:00" in v1, RFC 3339 in v2) as RFC 3339 in UTC, without milliseconds. */
function iso(t: string | null | undefined): string | undefined {
  if (!t) return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(t) ? `${t.replace(" ", "T")}Z` : t);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** "12 Nov 2026" for a YYYY-MM-DD date. */
const dayOf = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const typeLabel = (type: string | null | undefined) => {
  const t = (type || "activity").replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Records looked up by id, 100 at a time. Ids Pipedrive can't show this account are left out. */
async function byIds<T extends { id: number }>(api: Api, path: string, ids: Iterable<number>, query: Record<string, string> = {}): Promise<Map<number, T>> {
  const found = new Map<number, T>();
  for (const chunk of chunks([...new Set(ids)], ID_CHUNK)) {
    const r = await api<V2<T[]>>("GET", path, { query: { ...query, ids: chunk.join(","), limit: ID_CHUNK } });
    for (const x of r.data ?? []) found.set(x.id, x);
  }
  return found;
}

/** Moves a feed forward past the newest change read, or keeps its page position when a capped pass made no progress in time. */
function advance(s: Stream, times: (string | undefined)[], more: boolean, position: { start?: number; next?: string }): Stream {
  const newest = times.reduce<string | undefined>((a, t) => (t && (!a || t > a) ? t : a), undefined);
  const restart = newest && iso(new Date(Date.parse(newest) - OVERLAP_MS).toISOString());
  if (restart && restart > s.since) return { since: restart };
  return more ? { since: s.since, ...position } : { since: s.since };
}

/** Who can see a deal, from its `visible_to`. */
type Audience = "org" | "owner" | "owner+followers" | "skip";

/**
 * Pipedrive's `visible_to` means different things on different plans. Light, Growth and Professional
 * offer 1 (owner and followers) and 3 (entire company); Premium and Ultimate offer 1 (owner only),
 * 3 (owner's visibility group), 5 (group and sub-groups) and 7 (entire company). The plan shows in
 * which values the deal fields offer. Visibility groups can't be read, so those deals are skipped.
 */
export function audienceOf(visibleTo: number | string | null | undefined, offered: Set<string> | undefined): Audience {
  const v = String(visibleTo ?? "");
  if (v === "7") return "org";
  if (!offered?.size) return v === "1" ? "owner" : "skip";
  const groups = offered.has("7") || offered.has("5");
  if (v === "1") return groups ? "owner" : "owner+followers";
  if (v === "3") return groups ? "skip" : "org";
  return "skip";
}

/**
 * Deal notes and activities changed since the last sync, grouped by deal: one document thread per deal
 * with a versioned summary (stage, value, owner, contact), each note, and each activity as a short line
 * ("Call with Priya Shah: Send revised quote — due 12 Nov 2026, not done"). Notes and activities not on
 * a deal are left out. Deals only their owner (and followers) can see go to those people only.
 */
export async function fetchPipedrive(api: Api, domain: string, cursor: PipedriveCursor = {}, now = new Date()): Promise<Fetched> {
  const floor = iso(new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString())!;
  const notesFrom: Stream = cursor.notes ?? { since: floor };
  const activitiesFrom: Stream = cursor.activities ?? { since: floor };

  const notes: Note[] = [];
  let start = notesFrom.start ?? 0;
  let moreNotes = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await api<V1<Note[]>>("GET", "v1/notes", { query: { updated_since: notesFrom.since, sort: "update_time ASC", start, limit: PAGE_SIZE } });
    notes.push(...(r.data ?? []));
    const p = r.additional_data?.pagination;
    moreNotes = !!p?.more_items_in_collection;
    start = p?.next_start ?? start + PAGE_SIZE;
    if (!moreNotes) break;
  }

  const activities: Activity[] = [];
  let next = activitiesFrom.next;
  let moreActivities = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await api<V2<Activity[]>>("GET", "v2/activities", { query: { updated_since: activitiesFrom.since, sort_by: "update_time", sort_direction: "asc", limit: PAGE_SIZE, cursor: next } });
    activities.push(...(r.data ?? []));
    next = r.additional_data?.next_cursor ?? undefined;
    moreActivities = !!next;
    if (!moreActivities) break;
  }

  const after: PipedriveCursor = {
    notes: advance(notesFrom, notes.map((n) => iso(n.update_time ?? n.add_time)), moreNotes, { start }),
    activities: advance(activitiesFrom, activities.map((a) => iso(a.update_time ?? a.add_time)), moreActivities, { next }),
  };

  const liveNotes = notes.filter((n) => n.deal_id && n.active_flag !== false && htmlToText(n.content ?? ""));
  const liveActivities = activities.filter((a) => a.deal_id && !a.is_deleted);
  const dealIds = new Set([...liveNotes.map((n) => n.deal_id!), ...liveActivities.map((a) => a.deal_id!)]);
  if (!dealIds.size) return { people: [], threads: [], messages: [], cursor: after as Record<string, unknown> };

  const deals = await byIds<Deal>(api, "v2/deals", dealIds);
  const users = new Map<number, User>();
  for (const u of (await api<V1<User[]>>("GET", "v1/users")).data ?? []) users.set(u.id, u);
  const personIds = new Set<number>();
  for (const d of deals.values()) if (d.person_id) personIds.add(d.person_id);
  for (const n of liveNotes) if (n.person_id) personIds.add(n.person_id);
  for (const a of liveActivities) for (const id of [a.person_id, ...(a.participants ?? []).map((p) => p.person_id)]) if (id) personIds.add(id);
  const persons = await byIds<Person>(api, "v2/persons", personIds);
  const orgs = await byIds<Named>(api, "v2/organizations", [...deals.values()].flatMap((d) => (d.org_id ? [d.org_id] : [])));
  const stages = new Map<number, Named>();
  for (const s of (await api<V2<Named[]>>("GET", "v2/stages", { query: { limit: 500 } }).catch(() => ({ data: [] as Named[] }))).data ?? []) stages.set(s.id, s);
  const fields = await api<V1<{ key?: string; options?: { id: number | string }[] | null }[]>>("GET", "v1/dealFields", { query: { start: 0, limit: 500 } }).catch(() => undefined);
  const visibleTo = fields?.data?.find((f) => f.key === "visible_to")?.options;
  const offered = visibleTo ? new Set(visibleTo.map((o) => String(o.id))) : undefined;

  const people = new Map<string, NormalizedPerson>();
  const user = (id: number | null | undefined) => {
    if (!id) return undefined;
    const u = users.get(id);
    const key = `pipedrive:${id}`;
    if (!people.has(key)) people.set(key, { key, provider: "pipedrive", externalId: String(id), displayName: u?.name || u?.email || "Pipedrive user", email: u?.email?.toLowerCase() || undefined });
    return key;
  };
  const person = (id: number | null | undefined) => {
    const p = id ? persons.get(id) : undefined;
    if (!p) return undefined;
    const key = `pipedrive:person:${p.id}`;
    const email = (p.emails?.find((e) => e.primary && e.value) ?? p.emails?.find((e) => e.value))?.value?.trim().toLowerCase() || undefined;
    if (!people.has(key)) people.set(key, { key, provider: "pipedrive", externalId: `person:${p.id}`, displayName: p.name || email || "Pipedrive contact", email });
    return key;
  };
  const nameOf = (id: number | null | undefined) => (id ? persons.get(id)?.name || undefined : undefined);

  /** Each deal's audience, or undefined when it can't be told and the deal is skipped. */
  const audiences = new Map<number, { visibility: "org" | "members"; memberKeys: string[] } | undefined>();
  for (const d of deals.values()) {
    const who = audienceOf(d.visible_to, offered);
    if (d.is_deleted || d.status === "deleted" || who === "skip" || (who !== "org" && !d.owner_id)) {
      audiences.set(d.id, undefined);
      continue;
    }
    if (who === "org") {
      audiences.set(d.id, { visibility: "org", memberKeys: [] });
      continue;
    }
    const keys = new Set([user(d.owner_id)!]);
    if (who === "owner+followers") {
      // Followers that can't be read leave the owner alone: fewer people, never more.
      const f = await api<V2<{ user_id?: number | null }[]>>("GET", `v2/deals/${d.id}/followers`, { query: { limit: 500 } }).catch(() => undefined);
      for (const x of f?.data ?? []) if (x.user_id) keys.add(user(x.user_id)!);
    }
    audiences.set(d.id, { visibility: "members", memberKeys: [...keys] });
  }

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const d of deals.values()) {
    const audience = audiences.get(d.id);
    if (!audience) continue;
    const id = `deal:${d.id}`;
    const org = d.org_id ? orgs.get(d.org_id)?.name : undefined;
    const title = `${d.title?.trim() || `Deal ${d.id}`}${org ? ` (${org})` : ""}`;
    const url = appUrl(domain, "deal", d.id);
    threads.push({ externalId: id, kind: "doc", title, url, ...audience });

    const contact = d.person_id ? persons.get(d.person_id) : undefined;
    const contactKey = person(d.person_id);
    const head = [
      title,
      `Status: ${d.status ?? "open"}`,
      d.stage_id && stages.get(d.stage_id)?.name && `Stage: ${stages.get(d.stage_id)!.name}`,
      d.value != null && `Value: ${d.value} ${d.currency ?? ""}`.trim(),
      d.owner_id && `Owner: ${users.get(d.owner_id)?.name ?? "Unknown"}`,
      contact && `Contact: ${contact.name ?? "Unknown"}${contactKey && people.get(contactKey)?.email ? ` (${people.get(contactKey)!.email})` : ""}`,
      d.expected_close_date && `Expected close: ${d.expected_close_date}`,
    ].filter((l): l is string => !!l);
    const stamp = iso(d.update_time) ?? now.toISOString();
    versions.set(id, `${id}@${stamp}`);
    messages.push({ threadExternalId: id, externalId: `${id}@${stamp}`, kind: "note", authorKey: user(d.owner_id), sentAt: new Date(stamp), subject: title, text: head.join("\n"), url });
  }

  for (const n of liveNotes) {
    if (!audiences.get(n.deal_id!)) continue;
    const doc = `note:${n.id}`;
    const added = iso(n.add_time)!;
    const updated = iso(n.update_time) ?? added;
    versions.set(doc, `${doc}@${updated}`);
    person(n.person_id);
    messages.push({
      threadExternalId: `deal:${n.deal_id}`,
      externalId: `${doc}@${updated}`,
      kind: "note",
      authorKey: user(n.user_id),
      sentAt: new Date(added),
      editedAt: updated !== added ? new Date(updated) : undefined,
      text: htmlToText(n.content ?? ""),
      url: appUrl(domain, "deal", n.deal_id!),
    });
  }

  for (const a of liveActivities) {
    if (!audiences.get(a.deal_id!)) continue;
    const doc = `activity:${a.id}`;
    const added = iso(a.add_time)!;
    const updated = iso(a.update_time) ?? added;
    const kind = typeLabel(a.type);
    const withIds = [...new Set([a.person_id, ...(a.participants ?? []).map((p) => p.person_id)].filter((x): x is number => !!x))];
    for (const pid of withIds) person(pid);
    const names = withIds.map(nameOf).filter((x): x is string => !!x);
    const subject = a.subject?.trim();
    const owner = a.owner_id ? users.get(a.owner_id)?.name : undefined;
    const line = [
      `${kind}${names.length ? ` with ${names.join(", ")}` : ""}${subject && subject.toLowerCase() !== kind.toLowerCase() ? `: ${subject}` : ""}`,
      ` — ${a.due_date ? `due ${dayOf(a.due_date)}` : "no due date"}, ${a.done ? "done" : "not done"}`,
      owner ? ` (${owner})` : "",
    ].join("");
    const note = htmlToText(a.note ?? "");
    versions.set(doc, `${doc}@${updated}`);
    messages.push({
      threadExternalId: `deal:${a.deal_id}`,
      externalId: `${doc}@${updated}`,
      kind: "note",
      authorKey: user(a.creator_user_id ?? a.owner_id),
      sentAt: new Date(added),
      editedAt: updated !== added ? new Date(updated) : undefined,
      text: note ? `${line}\n${note}` : line,
      url: appUrl(domain, "deal", a.deal_id!),
    });
  }

  return { people: [...people.values()], threads, messages, versions, cursor: after as Record<string, unknown> };
}

/** Plain text as Pipedrive note HTML: escaped, with line breaks kept. */
const asHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");

const addNoteInput = z
  .object({
    content: z.string().min(1).describe("The note, in plain text."),
    dealId: z.number().int().nullish().describe("The deal to add it to."),
    personId: z.number().int().nullish().describe("Or the person."),
    orgId: z.number().int().nullish().describe("Or the organization."),
  })
  .refine((x) => x.dealId || x.personId || x.orgId, { message: "Name a deal, person or organization for the note." });
type AddNote = z.infer<typeof addNoteInput>;

const scheduleInput = z.object({
  subject: z.string().min(1).describe("What to do, e.g. 'Send revised quote'."),
  type: z.string().min(1).describe("Activity type key: call, meeting, task, deadline, email or lunch (or a custom type the company uses)."),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD."),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullish().describe("HH:MM in UTC; leave empty for an all-day activity."),
  dealId: z.number().int().describe("The deal it follows up."),
  note: z.string().nullish().describe("Optional details for whoever does it."),
});
type Schedule = z.infer<typeof scheduleInput>;

const target = (x: AddNote) => (x.dealId ? `deal #${x.dealId}` : x.personId ? `person #${x.personId}` : `organization #${x.orgId}`);
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const addNote: ActionDef<AddNote> = {
  description: "Add a note to a Pipedrive deal, person or organization. Use to record what was agreed or learned, for the team to see in Pipedrive.",
  input: addNoteInput,
  audience: () => "internal",
  summary: (x) => `Pipedrive note on ${target(x)}: ${short(x.content.replace(/\s+/g, " "))}`,
  body: (x) => x.content,
  withBody: (x, body) => ({ ...x, content: body }),
  async run(api, x, ctx) {
    const r = await api<{ data?: { id?: number } }>("POST", "v1/notes", {
      body: { content: asHtml(x.content), deal_id: x.dealId ?? undefined, person_id: x.personId ?? undefined, org_id: x.orgId ?? undefined },
    });
    const domain = domainOf(ctx.credentials);
    const url = x.dealId ? appUrl(domain, "deal", x.dealId) : x.personId ? appUrl(domain, "person", x.personId) : appUrl(domain, "organization", x.orgId!);
    return { url, detail: `Added note ${r.data?.id ?? ""} to ${target(x)}`.replace("  ", " ") };
  },
};

const scheduleActivity: ActionDef<Schedule> = {
  description: "Schedule a follow-up activity (call, meeting, task, deadline) on a Pipedrive deal, owned by whoever connected Pipedrive. Use when someone commits to a next step on a deal.",
  input: scheduleInput,
  audience: () => "internal",
  summary: (x) => `Pipedrive ${x.type} on deal #${x.dealId}: ${short(x.subject)}, due ${x.dueDate}${x.dueTime ? ` ${x.dueTime}` : ""}`,
  body: (x) => x.note ?? "",
  withBody: (x, body) => ({ ...x, note: body || undefined }),
  async run(api, x, ctx) {
    const r = await api<{ data?: { id?: number } }>("POST", "v2/activities", {
      body: { subject: x.subject, type: x.type.trim().toLowerCase(), due_date: x.dueDate, due_time: x.dueTime ?? undefined, deal_id: x.dealId, note: x.note ? asHtml(x.note) : undefined },
    });
    return { url: appUrl(domainOf(ctx.credentials), "deal", x.dealId), detail: `Scheduled ${x.type} ${r.data?.id ?? ""} on deal #${x.dealId}, due ${x.dueDate}`.replace("  ", " ") };
  },
};

function tools(api: Api, ctx: ToolContext) {
  const domain = domainOf(ctx.credentials);
  const today = () => new Date().toISOString().slice(0, 10);
  const userName = async (id: number | null | undefined) => (id ? (await api<V1<User>>("GET", `v1/users/${id}`).catch(() => undefined))?.data?.name ?? undefined : undefined);

  return {
    pipedrive_search: tool({
      description:
        "Search the company's Pipedrive CRM, live, for deals, people (contacts) or organizations by name, email, phone or deal title. Returns ids to open with pipedrive_deal. Say the answer came from Pipedrive.",
      inputSchema: z.object({
        term: z.string().min(2).describe("Words to match: a name, email, phone or deal title."),
        types: listOf(["deal", "person", "organization"]).nullish().describe("Limit to these kinds. Leave empty for all three."),
        limit: z.number().int().min(1).max(MAX_RESULTS).nullish(),
      }),
      execute: async ({ term, types, limit }) => {
        type Item = {
          id: number;
          type: string;
          title?: string;
          name?: string;
          value?: number | null;
          currency?: string | null;
          status?: string | null;
          stage?: { name?: string } | null;
          person?: { name?: string } | null;
          organization?: { name?: string } | null;
          emails?: string[] | null;
          phones?: string[] | null;
          owner?: { id?: number } | null;
        };
        const r = await api<V2<{ items?: { result_score?: number; item: Item }[] }>>("GET", "v2/itemSearch", {
          query: { term, item_types: (types?.length ? types : ["deal", "person", "organization"]).join(","), limit: limit ?? 10 },
        });
        const kinds = { deal: "deal", person: "person", organization: "organization" } as const;
        return {
          results: (r.data?.items ?? []).slice(0, limit ?? 10).map(({ item: x }) => ({
            type: x.type,
            id: x.id,
            name: x.title ?? x.name,
            value: x.value ?? undefined,
            currency: x.value != null ? (x.currency ?? undefined) : undefined,
            status: x.status ?? undefined,
            stage: x.stage?.name,
            person: x.type === "person" ? undefined : x.person?.name,
            organization: x.type === "organization" ? undefined : x.organization?.name,
            emails: x.emails?.slice(0, 3),
            phones: x.phones?.slice(0, 2),
            url: x.type in kinds ? appUrl(domain, kinds[x.type as keyof typeof kinds], x.id) : undefined,
          })),
        };
      },
    }),

    pipedrive_deal: tool({
      description:
        "Open one Pipedrive deal, live: stage, value and currency, status, owner, organization and contact, expected close date, the next activity (and whether it's overdue) and the latest notes. Find the id with pipedrive_search first. Say the answer came from Pipedrive.",
      inputSchema: z.object({ dealId: z.number().int() }),
      execute: async ({ dealId }) => {
        const d = (await api<V2<Deal>>("GET", `v2/deals/${dealId}`)).data;
        if (!d) return { error: `Pipedrive has no deal ${dealId} that this account can see.` };
        const [owner, org, contact, stage, upcoming, notes] = await Promise.all([
          userName(d.owner_id),
          d.org_id ? api<V2<Named>>("GET", `v2/organizations/${d.org_id}`).catch(() => undefined) : undefined,
          d.person_id ? api<V2<Person>>("GET", `v2/persons/${d.person_id}`).catch(() => undefined) : undefined,
          d.stage_id ? api<V2<Named>>("GET", `v2/stages/${d.stage_id}`).catch(() => undefined) : undefined,
          api<V2<Activity[]>>("GET", "v2/activities", { query: { deal_id: dealId, done: "false", sort_by: "due_date", sort_direction: "asc", limit: 10 } }).catch(() => undefined),
          api<V1<(Note & { user?: { name?: string } | null })[]>>("GET", "v1/notes", { query: { deal_id: dealId, sort: "add_time DESC", start: 0, limit: 5 } }).catch(() => undefined),
        ]);
        const pipeline = stage?.data?.pipeline_id ? await api<V2<Named>>("GET", `v2/pipelines/${stage.data.pipeline_id}`).catch(() => undefined) : undefined;
        const open = upcoming?.data ?? [];
        const nextUp = open.find((a) => a.due_date) ?? open[0];
        const email = contact?.data?.emails?.find((e) => e.primary && e.value)?.value ?? contact?.data?.emails?.find((e) => e.value)?.value;
        return {
          id: d.id,
          title: d.title,
          status: d.status,
          pipeline: pipeline?.data?.name ?? undefined,
          stage: stage?.data?.name ?? undefined,
          value: d.value ?? undefined,
          currency: d.currency ?? undefined,
          owner,
          organization: org?.data?.name ?? undefined,
          contact: contact?.data ? { name: contact.data.name ?? undefined, email: email?.toLowerCase() ?? undefined } : undefined,
          expectedCloseDate: d.expected_close_date ?? undefined,
          nextActivity: nextUp
            ? { type: nextUp.type ?? undefined, subject: nextUp.subject ?? undefined, dueDate: nextUp.due_date ?? undefined, dueTime: nextUp.due_time ?? undefined, overdue: !!nextUp.due_date && nextUp.due_date < today() }
            : undefined,
          recentNotes: (notes?.data ?? []).map((n) => ({ date: iso(n.add_time)?.slice(0, 10), author: n.user?.name, text: short(htmlToText(n.content ?? ""), 500) })),
          url: appUrl(domain, "deal", d.id),
        };
      },
    }),

    pipedrive_pipeline: tool({
      description:
        "Summarise the Pipedrive pipeline, live: open deals by stage with counts and total value per currency, and the open deals whose next activity is overdue (oldest first). Use for 'how's the pipeline', 'what's stuck' or 'which follow-ups did we miss'. Say the answer came from Pipedrive.",
      inputSchema: z.object({ pipelineId: z.number().int().nullish().describe("One pipeline's id. Leave empty for all pipelines.") }),
      execute: async ({ pipelineId }) => {
        const deals: Deal[] = [];
        let next: string | undefined;
        let truncated = false;
        for (let i = 0; i < 2; i++) {
          const r = await api<V2<Deal[]>>("GET", "v2/deals", {
            query: { status: "open", pipeline_id: pipelineId ?? undefined, include_fields: "next_activity_id", limit: 500, cursor: next },
          });
          deals.push(...(r.data ?? []));
          next = r.additional_data?.next_cursor ?? undefined;
          truncated = !!next;
          if (!next) break;
        }
        const [stages, pipelines, users] = await Promise.all([
          api<V2<Named[]>>("GET", "v2/stages", { query: { pipeline_id: pipelineId ?? undefined, limit: 500 } }),
          api<V2<Named[]>>("GET", "v2/pipelines", { query: { limit: 500 } }),
          api<V1<User[]>>("GET", "v1/users").catch(() => undefined),
        ]);
        const stageOf = new Map((stages.data ?? []).map((s) => [s.id, s]));
        const pipelineOf = new Map((pipelines.data ?? []).map((p) => [p.id, p.name ?? undefined]));
        const ownerOf = new Map((users?.data ?? []).map((u) => [u.id, u.name ?? undefined]));

        const byStage = new Map<number, { pipeline?: string; stage?: string; order: number; deals: number; totals: Map<string, number> }>();
        for (const d of deals) {
          const s = d.stage_id ? stageOf.get(d.stage_id) : undefined;
          const row = byStage.get(d.stage_id ?? 0) ?? { pipeline: pipelineOf.get(s?.pipeline_id ?? d.pipeline_id ?? 0), stage: s?.name ?? undefined, order: s?.order_nr ?? 0, deals: 0, totals: new Map() };
          row.deals++;
          if (d.value) row.totals.set(d.currency ?? "", (row.totals.get(d.currency ?? "") ?? 0) + d.value);
          byStage.set(d.stage_id ?? 0, row);
        }

        const nextIds = deals.flatMap((d) => (d.next_activity_id ? [d.next_activity_id] : []));
        const nextActivity = await byIds<Activity>(api, "v2/activities", nextIds.slice(0, 5 * ID_CHUNK));
        const now = today();
        const overdue = deals
          .flatMap((d) => {
            const a = d.next_activity_id ? nextActivity.get(d.next_activity_id) : undefined;
            return a?.due_date && !a.done && a.due_date < now ? [{ d, a }] : [];
          })
          .sort((x, y) => x.a.due_date!.localeCompare(y.a.due_date!));

        return {
          openDeals: deals.length,
          truncated: truncated ? "More than 1,000 open deals; totals cover the first 1,000. Ask about one pipeline for a full count." : undefined,
          stages: [...byStage.values()]
            .sort((a, b) => (a.pipeline ?? "").localeCompare(b.pipeline ?? "") || a.order - b.order)
            .map((r) => ({ pipeline: r.pipeline, stage: r.stage, deals: r.deals, totals: [...r.totals].map(([currency, value]) => ({ value: Math.round(value * 100) / 100, currency: currency || undefined })) })),
          withoutNextActivity: deals.filter((d) => !d.next_activity_id).length,
          overdue: overdue.slice(0, MAX_RESULTS).map(({ d, a }) => ({
            id: d.id,
            title: d.title,
            value: d.value ?? undefined,
            currency: d.currency ?? undefined,
            owner: d.owner_id ? ownerOf.get(d.owner_id) : undefined,
            nextActivity: { type: a.type ?? undefined, subject: a.subject ?? undefined, dueDate: a.due_date },
            daysOverdue: Math.round((Date.parse(now) - Date.parse(a.due_date!)) / 86_400_000),
            url: appUrl(domain, "deal", d.id),
          })),
          moreOverdue: overdue.length > MAX_RESULTS ? overdue.length - MAX_RESULTS : undefined,
        };
      },
    }),
  };
}

/** Pipedrive deals: notes and activities synced into memory, live lookups of the pipeline, and approved notes and follow-ups. */
export const pipedrive: Provider = {
  id: "pipedrive",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "domain", label: "Company domain", placeholder: "acme (from acme.pipedrive.com)" },
      { name: "token", label: "Personal API token", secret: true },
    ],
    setup:
      "In Pipedrive, open your profile menu → Personal preferences → API, copy your personal API token and paste it with your company domain. Use an admin's token so ALRO sees every deal the team can. Pipedrive tokens can't be limited to reading: ALRO reads deals, notes and activities, and only adds a note or schedules a follow-up after someone approves it.",
    docsUrl: "https://support.pipedrive.com/en/article/how-can-i-find-my-personal-api-key",
    api: (c) => httpApi({ baseUrl: `https://${domainOf(c)}.pipedrive.com/api/`, headers: () => ({ "x-api-token": (c.token ?? "").trim() }) }),
  },
  async identify(api, credentials) {
    const domain = domainOf(credentials);
    // Pipedrive answers 401 both for a wrong token and for a company domain that doesn't exist.
    const refused = `Pipedrive didn't accept that API token for ${domain}.pipedrive.com. Check the token and the company domain.`;
    const me = await api<V1<{ id?: number; company_id?: number; company_name?: string; company_domain?: string }>>("GET", "v1/users/me").catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403 || e.status === 404)) throw new Error(refused);
      throw e;
    });
    const u = me.data;
    if (!u?.id || !u.company_id) throw new Error(refused);
    if (u.company_domain && u.company_domain.toLowerCase() !== domain) {
      throw new Error(`That API token belongs to ${u.company_domain}.pipedrive.com, not ${domain}.pipedrive.com.`);
    }
    return { accountId: `pipedrive:${u.company_id}`, label: u.company_name ? `${u.company_name} (${domain}.pipedrive.com)` : `${domain}.pipedrive.com` };
  },
  async sync(api, cursor, ctx) {
    return fetchPipedrive(api, domainOf(ctx.credentials), cursor as PipedriveCursor | undefined, ctx.now);
  },
  tools,
  actions: { pipedrive_add_note: addNote, pipedrive_schedule_activity: scheduleActivity },
};
