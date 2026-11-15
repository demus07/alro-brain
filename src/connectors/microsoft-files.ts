import { officeKind, officeText } from "@/ingest/office";
import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { ProviderError, type Api } from "./api";
import type { Fetched, Provider } from "./provider";

const GRAPH = "https://graph.microsoft.com/v1.0/";
const BACKFILL_DAYS = 90;
/** Files downloaded per sync; the rest wait for the next one. */
const MAX_FILES = 200;
/** Delta pages read per sync, across all drives. */
const MAX_DELTA_PAGES = 40;
const MAX_OFFICE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 1_000_000;
/** After an expired delta link, re-read from a day before the last finished round. */
const RESYNC_OVERLAP_MS = 86_400_000;
const MAX_SITES = 100;
const MAX_DRIVES = 200;
/** SharePoint sites and their libraries are looked up again once a day. */
const REDISCOVER_MS = 86_400_000;

const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tsv"]);
const TEXT_MIME = new Set(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values"]);

interface Identity {
  id?: string | null;
  displayName?: string | null;
  email?: string | null;
  loginName?: string | null;
}
interface IdentitySet {
  user?: Identity | null;
  group?: Identity | null;
  siteUser?: Identity | null;
  siteGroup?: Identity | null;
}
interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: { mimeType?: string } | null;
  deleted?: unknown;
  parentReference?: { driveId?: string } | null;
  lastModifiedBy?: { user?: Identity | null } | null;
}
interface Permission {
  roles?: string[];
  expirationDateTime?: string | null;
  link?: { scope?: string; type?: string } | null;
  grantedToV2?: IdentitySet | null;
  grantedToIdentitiesV2?: IdentitySet[] | null;
  invitation?: { email?: string | null } | null;
}
interface DeltaPage {
  value: DriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/** Where one drive's change tracking stands. */
export interface DriveState {
  /** The delta round's next page, or the delta link that starts the next round. */
  link?: string;
  /** During the first round: files last changed before this are left out. */
  floor?: string;
  /** When the last round finished. */
  syncedAt?: string;
}

export type OneDriveCursor = DriveState;

export interface SharePointCursor {
  drives?: Record<string, DriveState & { name?: string; site?: string }>;
  discoveredAt?: string;
}

const fileExt = (name = "") => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/** "office" or "text" when the file is one ALRO reads and small enough to download. */
function readable(item: DriveItem): "office" | "text" | undefined {
  if (!item.file || item.deleted) return undefined;
  const size = item.size ?? 0;
  if (officeKind(item.name ?? "") || officeKind(item.file.mimeType ?? "")) return size <= MAX_OFFICE_BYTES ? "office" : undefined;
  if (TEXT_EXT.has(fileExt(item.name)) || TEXT_MIME.has((item.file.mimeType ?? "").split(";")[0].trim())) return size <= MAX_TEXT_BYTES ? "text" : undefined;
  return undefined;
}

/**
 * Reads one drive's changes from where its state left off: the first round starts at a timestamp
 * 90 days back, later rounds follow the stored delta link. Stops early when the page or file budget
 * runs out, keeping the next page's link so the following sync carries on.
 */
async function readDelta(api: Api, rootDelta: string, state: DriveState, budget: { pages: number; files: number }, now: Date): Promise<{ items: DriveItem[]; state: DriveState }> {
  let next: DriveState = { ...state };
  if (!next.link) {
    const from = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
    next = { ...next, floor: from, link: `${rootDelta}?token=${encodeURIComponent(from)}` };
  }
  const items = new Map<string, DriveItem>();
  let wanted = 0;
  while (next.link && budget.pages > 0 && wanted < budget.files) {
    let page: DeltaPage;
    try {
      page = await api<DeltaPage>("GET", next.link);
    } catch (e) {
      // 410: the delta link expired. Start a new round from shortly before the last one finished.
      if (e instanceof ProviderError && e.status === 410) {
        const from = new Date((next.syncedAt ? Date.parse(next.syncedAt) : now.getTime() - BACKFILL_DAYS * 86_400_000) - RESYNC_OVERLAP_MS).toISOString().replace(/\.\d+Z$/, "Z");
        next = { ...next, floor: from, link: `${rootDelta}?token=${encodeURIComponent(from)}` };
        budget.pages--;
        continue;
      }
      // Only OneDrive for Business and SharePoint take a timestamp; elsewhere read everything and keep the floor.
      if (e instanceof ProviderError && e.status === 400 && next.link === `${rootDelta}?token=${encodeURIComponent(next.floor ?? "")}`) {
        next = { ...next, link: rootDelta };
        budget.pages--;
        continue;
      }
      throw e;
    }
    budget.pages--;
    for (const item of page.value ?? []) {
      if (next.floor && item.lastModifiedDateTime && Date.parse(item.lastModifiedDateTime) < Date.parse(next.floor)) continue;
      // An item can appear more than once in a round; the last one is current.
      if (readable(item) && !items.has(item.id)) wanted++;
      items.set(item.id, item);
    }
    if (page["@odata.deltaLink"]) {
      next = { link: page["@odata.deltaLink"], syncedAt: now.toISOString() };
      break;
    }
    next = { ...next, link: page["@odata.nextLink"] };
  }
  budget.files -= wanted;
  return { items: [...items.values()].filter((i) => readable(i)), state: next };
}

/** A downloaded file as text, or undefined when it holds none. */
async function fileText(api: Api, driveId: string | undefined, item: DriveItem): Promise<string | undefined> {
  // Graph answers /content with a redirect to a short-lived, pre-authenticated download URL on a
  // SharePoint host. fetch follows it and drops the Authorization header when the host changes, so the
  // token only ever goes to graph.microsoft.com.
  const path = driveId ? `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}/content` : `me/drive/items/${encodeURIComponent(item.id)}/content`;
  let bytes: Uint8Array;
  try {
    bytes = await api<Uint8Array>("GET", path, { headers: { accept: "*/*" }, as: "bytes" });
  } catch (e) {
    // Deleted or locked away since the delta was read.
    if (e instanceof ProviderError && (e.status === 403 || e.status === 404)) return undefined;
    throw e;
  }
  const raw = readable(item) === "office" ? officeText(bytes, item.name ?? "") ?? officeText(bytes, item.file?.mimeType ?? "") : new TextDecoder("utf-8").decode(bytes);
  const text = raw
    ?.replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? text.slice(0, MAX_TEXT_CHARS) : undefined;
}

/** Who a file is shared with, as far as Graph says, and whether everyone in the organisation can open it. */
async function sharing(api: Api, driveId: string | undefined, item: DriveItem, now: Date): Promise<{ people: Identity[]; everyone: boolean }> {
  const path = driveId ? `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}/permissions` : `me/drive/items/${encodeURIComponent(item.id)}/permissions`;
  const r = await api<{ value: Permission[] }>("GET", path).catch((e) => {
    if (e instanceof ProviderError && (e.status === 403 || e.status === 404)) return { value: [] as Permission[] };
    throw e;
  });
  const people: Identity[] = [];
  let everyone = false;
  for (const p of r.value ?? []) {
    if (p.expirationDateTime && Date.parse(p.expirationDateTime) < now.getTime()) continue;
    // "Anyone with the link" and "People in <org> with the link" both open the file to the whole organisation.
    if (p.link?.scope === "organization" || p.link?.scope === "anonymous") everyone = true;
    for (const set of [p.grantedToV2, ...(p.grantedToIdentitiesV2 ?? [])]) {
      if (!set) continue;
      // SharePoint's "Everyone except external users" (and "Everyone") are claims granted like a user.
      if ([set.user, set.group, set.siteUser, set.siteGroup].some((i) => i?.loginName && /spo-grid-all-users|^c:0\(\.s\|true$/i.test(i.loginName))) everyone = true;
      for (const u of [set.user, set.siteUser]) if (u?.email?.includes("@")) people.push(u);
    }
    if (p.invitation?.email?.includes("@")) people.push({ email: p.invitation.email });
  }
  return { people, everyone };
}

type Visibility = (item: DriveItem, driveId: string | undefined) => Promise<{ visibility: "org" | "members"; members: Identity[] }>;

/** Turns changed files into versioned document threads. */
async function toDocuments(
  api: Api,
  found: { item: DriveItem; driveId?: string; threadId: string; metadata: Record<string, unknown> }[],
  visibility: Visibility,
  out: { people: Map<string, NormalizedPerson>; threads: NormalizedThread[]; messages: NormalizedMessage[]; versions: Map<string, string> },
) {
  const personKey = (who?: Identity | null) => {
    const email = who?.email?.trim().toLowerCase();
    if (!email?.includes("@")) return undefined;
    const key = `email:${email}`;
    if (!out.people.has(key)) out.people.set(key, { key, provider: "email", externalId: email, displayName: who?.displayName || email, email });
    return key;
  };
  for (const { item, driveId, threadId, metadata } of found) {
    const text = await fileText(api, driveId, item);
    if (!text) continue;
    const seen = await visibility(item, driveId);
    const changed = item.lastModifiedDateTime ?? new Date(0).toISOString();
    const externalId = `${threadId}@${changed}`;
    const title = item.name ?? "Untitled";
    out.versions.set(threadId, externalId);
    out.threads.push({
      externalId: threadId,
      kind: "doc",
      title,
      url: item.webUrl,
      visibility: seen.visibility,
      memberKeys: [...new Set(seen.members.map(personKey).filter((k): k is string => !!k))],
      metadata: { mimeType: item.file?.mimeType, ...metadata },
    });
    out.messages.push({ threadExternalId: threadId, externalId, kind: "note", authorKey: personKey(item.lastModifiedBy?.user), sentAt: new Date(changed), subject: title, text, url: item.webUrl });
  }
}

const emptyOut = () => ({ people: new Map<string, NormalizedPerson>(), threads: [] as NormalizedThread[], messages: [] as NormalizedMessage[], versions: new Map<string, string>() });

/**
 * The person's OneDrive: Word, PowerPoint, Excel and plain-text files changed since the last sync,
 * or in the last 90 days on the first one. Each file is a document thread holding its text as a version.
 * Visible to the owner (added by the sync as this is a personal source) and to the people Graph says
 * the file is shared with by email. A sharing link alone never opens a OneDrive file to the whole company.
 */
export async function fetchOneDrive(api: Api, cursor: OneDriveCursor = {}, now = new Date()): Promise<Fetched> {
  const budget = { pages: MAX_DELTA_PAGES, files: MAX_FILES };
  const { items, state } = await readDelta(api, "me/drive/root/delta", cursor, budget, now);
  const out = emptyOut();
  await toDocuments(
    api,
    items.map((item) => ({ item, driveId: item.parentReference?.driveId, threadId: item.id, metadata: {} })),
    async (item, driveId) => ({ visibility: "members", members: (await sharing(api, driveId, item, now)).people }),
    out,
  );
  return { people: [...out.people.values()], threads: out.threads, messages: out.messages, versions: out.versions, cursor: state as Record<string, unknown> };
}

interface Site {
  id: string;
  displayName?: string;
  name?: string;
  webUrl?: string;
}
interface Drive {
  id: string;
  name?: string;
  driveType?: string;
}

/** Document libraries of the SharePoint sites the person can find (not personal OneDrives). */
async function discoverDrives(api: Api): Promise<Record<string, { name?: string; site?: string }>> {
  const sites: Site[] = [];
  let next: string | undefined = "sites";
  let query: Record<string, string> | undefined = { search: "*" };
  while (next && sites.length < MAX_SITES) {
    const r: { value: Site[]; "@odata.nextLink"?: string } = await api("GET", next, { query });
    sites.push(...r.value.filter((s) => !/-my\.sharepoint\.[a-z.]+\/personal\//i.test(s.webUrl ?? "")));
    next = r["@odata.nextLink"];
    query = undefined;
  }
  const drives: Record<string, { name?: string; site?: string }> = {};
  for (const site of sites.slice(0, MAX_SITES)) {
    const r = await api<{ value: Drive[] }>("GET", `sites/${encodeURIComponent(site.id)}/drives`).catch((e) => {
      if (e instanceof ProviderError && (e.status === 403 || e.status === 404)) return { value: [] as Drive[] };
      throw e;
    });
    for (const d of r.value ?? []) if (d.driveType === "documentLibrary" && Object.keys(drives).length < MAX_DRIVES) drives[d.id] = { name: d.name, site: site.displayName ?? site.name };
  }
  return drives;
}

/**
 * Files in the document libraries of SharePoint sites the connecting person can read, changed since
 * the last sync (or in the last 90 days), tracked per library with Graph's delta links.
 *
 * Who can see a file in ALRO:
 * - "org" only when Graph itself says everyone in the organisation can open it: a sharing link scoped to
 *   the organisation (or anyone), or a grant to SharePoint's "Everyone except external users" claim.
 * - Otherwise "members": the connecting person (they can read it, or Graph wouldn't have listed it) plus
 *   anyone Graph names by email in the file's permissions. SharePoint groups ("Site Members") are not
 *   expanded, and Graph only shows a non-owner the permissions that apply to them, so this list can be
 *   shorter than SharePoint's; it is never longer.
 */
export async function fetchSharePoint(api: Api, self: string, cursor: SharePointCursor = {}, now = new Date()): Promise<Fetched> {
  let drives = { ...cursor.drives };
  let discoveredAt = cursor.discoveredAt;
  if (!discoveredAt || now.getTime() - Date.parse(discoveredAt) > REDISCOVER_MS) {
    const found = await discoverDrives(api);
    // Libraries no longer found are dropped; ones still there keep their delta state.
    drives = Object.fromEntries(Object.entries(found).map(([id, d]) => [id, { ...drives[id], ...d }]));
    discoveredAt = now.toISOString();
  }

  const me: Identity = { email: self };
  const budget = { pages: MAX_DELTA_PAGES, files: MAX_FILES };
  const out = emptyOut();
  // Libraries read longest ago go first, so a busy one can't starve the rest.
  const order = Object.keys(drives).sort((a, b) => (drives[a].syncedAt ?? "").localeCompare(drives[b].syncedAt ?? ""));
  for (const driveId of order) {
    if (budget.pages <= 0 || budget.files <= 0) break;
    const d = drives[driveId];
    let read: Awaited<ReturnType<typeof readDelta>>;
    try {
      read = await readDelta(api, `drives/${encodeURIComponent(driveId)}/root/delta`, d, budget, now);
    } catch (e) {
      // A library the person lost access to since discovery: leave it for the next discovery.
      if (e instanceof ProviderError && (e.status === 403 || e.status === 404)) continue;
      throw e;
    }
    drives[driveId] = { ...read.state, name: d.name, site: d.site };
    await toDocuments(
      api,
      read.items.map((item) => ({ item, driveId, threadId: `${driveId}:${item.id}`, metadata: { site: d.site, library: d.name } })),
      async (item) => {
        const { people, everyone } = await sharing(api, driveId, item, now);
        return everyone ? { visibility: "org", members: [] } : { visibility: "members", members: [me, ...people] };
      },
      out,
    );
  }
  return { people: [...out.people.values()], threads: out.threads, messages: out.messages, versions: out.versions, cursor: { drives, discoveredAt } };
}

async function whoAmI(api: Api, refused: string): Promise<string> {
  const me = await api<{ mail?: string | null; userPrincipalName: string }>("GET", "me", { query: { $select: "mail,userPrincipalName" } }).catch((e) => {
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error(refused);
    throw e;
  });
  return (me.mail ?? me.userPrincipalName).toLowerCase();
}

/** The person's OneDrive files (Word, PowerPoint, Excel, text), as text. */
export const onedrive: Provider = {
  id: "onedrive",
  scope: "personal",
  auth: { kind: "oauth", app: "microsoft", scopes: ["User.Read", "Files.Read"], baseUrl: GRAPH },
  async identify(api) {
    const account = await whoAmI(api, "Microsoft didn't allow access to OneDrive. Sign in again and allow ALRO to read your files.");
    return { accountId: account, label: account };
  },
  async sync(api, cursor, ctx) {
    return fetchOneDrive(api, cursor as OneDriveCursor | undefined, ctx.now);
  },
};

/** Document libraries of the SharePoint sites the connecting person can read. */
export const sharepoint: Provider = {
  id: "sharepoint",
  scope: "org",
  auth: { kind: "oauth", app: "microsoft", scopes: ["User.Read", "Sites.Read.All", "Files.Read.All"], baseUrl: GRAPH },
  async identify(api) {
    const account = await whoAmI(api, "Microsoft didn't allow access to SharePoint. Sign in again and allow ALRO to read your sites.");
    return { accountId: account, label: account };
  },
  async sync(api, cursor, ctx) {
    return fetchSharePoint(api, ctx.accountId, cursor as SharePointCursor | undefined, ctx.now);
  },
};
