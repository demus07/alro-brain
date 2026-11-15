import { tool } from "ai";
import { z } from "zod";
import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { parseVtt } from "@/ingest/parsers/vtt";
import { httpApi, mintedBearer, postForm, ProviderError, type Api } from "./api";
import { speakerTurns } from "./fireflies";
import type { Provider } from "./provider";

const API_BASE = "https://api.zoom.us/v2/";
const TOKEN_URL = "https://zoom.us/oauth/token";
const DAY_MS = 86_400_000;
const BACKFILL_DAYS = 90;
/** Re-read this much before the cursor: a transcript is dated at the meeting's start but only appears once Zoom has processed it. */
const OVERLAP_MS = 2 * DAY_MS;
/** Zoom lists recordings for at most a month per request; 28 days stays inside any month. */
const WINDOW_DAYS = 28;
const PAGE = 300;
/** Meetings read in one sync (each is a transcript download and a participants call); the next sync continues. */
const MAX_MEETINGS = 100;
const MAX_LIST_PAGES = 20;

export interface ZoomCursor {
  /** Start (ISO) of the newest meeting read. */
  since?: string;
  /** Meetings already read inside the overlap, by uuid → start (ISO), so they aren't downloaded again. */
  seen?: Record<string, string>;
}

interface User {
  id: string;
  email?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}
interface RecordingFile {
  id?: string;
  file_type?: string | null;
  file_extension?: string | null;
  download_url?: string | null;
  recording_start?: string | null;
  status?: string | null;
}
interface Meeting {
  uuid: string;
  id?: number | string;
  host_id?: string | null;
  topic?: string | null;
  start_time?: string | null;
  /** Minutes. */
  duration?: number | null;
  share_url?: string | null;
  recording_files?: RecordingFile[] | null;
}
interface Participant {
  id?: string | null;
  name?: string | null;
  user_email?: string | null;
}

/** Trades the app's keys for an hour-long access token (Server-to-Server OAuth). */
export async function mintZoomToken(c: Record<string, string>): Promise<{ accessToken: string; expiresIn?: number }> {
  const basicAuth = Buffer.from(`${(c.clientId ?? "").trim()}:${(c.clientSecret ?? "").trim()}`).toString("base64");
  const r = await postForm(TOKEN_URL, { grant_type: "account_credentials", account_id: (c.accountId ?? "").trim() }, { authorization: `Basic ${basicAuth}` });
  if (typeof r.access_token !== "string") throw new ProviderError("Zoom returned no access token", 502);
  return { accessToken: r.access_token, expiresIn: Number(r.expires_in) || 3600 };
}

/**
 * Calls api.zoom.us, and Zoom's own web hosts (zoom.us, us06web.zoom.us, acme.zoom.us) for
 * recording downloads, whose host varies by account. The token never leaves *.zoom.us.
 */
export function zoomApi(credentials: Record<string, string>, mint = mintZoomToken): Api {
  const headers = mintedBearer(() => mint(credentials));
  const main = httpApi({ baseUrl: API_BASE, headers });
  const web = new Map<string, Api>();
  return <T,>(method: Parameters<Api>[0], path: string, opts?: Parameters<Api>[2]) => {
    if (/^https:\/\//i.test(path)) {
      const host = new URL(path).host;
      if (host !== "api.zoom.us" && (host === "zoom.us" || host.endsWith(".zoom.us"))) {
        let api = web.get(host);
        if (!api) web.set(host, (api = httpApi({ baseUrl: `https://${host}/`, headers })));
        return api<T>(method, path, opts);
      }
    }
    return main<T>(method, path, opts);
  };
}

/** Zoom wants a meeting UUID double-encoded when it starts with "/" or contains "//". */
export const encodeUuid = (uuid: string) => (uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(encodeURIComponent(uuid)) : encodeURIComponent(uuid));

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms: number) => Date.parse(day(ms));
const valid = (iso?: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : undefined);
const nameOf = (u: User) => u.display_name?.trim() || [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || u.id;

/** Every page of a Zoom list (`next_page_token` paging). */
async function listAll<T>(api: Api, path: string, key: string, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const r = await api<Record<string, unknown>>("GET", path, { query: { ...query, page_size: PAGE, next_page_token: token } });
    items.push(...((r[key] as T[] | undefined) ?? []));
    token = (r.next_page_token as string | undefined) || undefined;
    if (!token) break;
  }
  return items;
}

/** The audio transcript of a meeting, once Zoom has finished it. */
const transcriptOf = (m: Meeting) =>
  m.recording_files?.find((f) => f.file_type === "TRANSCRIPT" && f.download_url && (!f.status || f.status === "completed"));

const refused = (e: unknown) => e instanceof ProviderError && (e.status === 401 || e.status === 403);
const isVtt = (text: string) => text.replace(/^﻿/, "").trimStart().startsWith("WEBVTT");

/**
 * Downloads a transcript with the account token; if Zoom refuses that, asks for the meeting's
 * own download token and tries once more.
 */
async function download(api: Api, m: Meeting, file: RecordingFile): Promise<string> {
  try {
    const text = await api<string>("GET", file.download_url!, { as: "text" });
    if (isVtt(text)) return text;
  } catch (e) {
    if (!refused(e)) throw e;
  }
  const r = await api<{ download_access_token?: string; recording_files?: RecordingFile[] }>("GET", `meetings/${encodeUuid(m.uuid)}/recordings`, {
    query: { include_fields: "download_access_token" },
  });
  const url = r.recording_files?.find((f) => f.id === file.id)?.download_url ?? file.download_url!;
  if (r.download_access_token) {
    const text = await api<string>("GET", url, { as: "text", headers: { authorization: `Bearer ${r.download_access_token}` } });
    if (isVtt(text)) return text;
  }
  throw new ProviderError(
    `Zoom wouldn't let ALRO download the transcript of "${m.topic ?? m.uuid}". Check the Zoom app has the cloud recording scopes and that recording downloads aren't turned off for the account.`,
    403,
  );
}

/** Who was in the meeting, with emails; empty when Zoom won't say (plan, scope or a one-person meeting). */
async function participantsOf(api: Api, m: Meeting): Promise<Participant[]> {
  try {
    return await listAll<Participant>(api, `past_meetings/${encodeUuid(m.uuid)}/participants`, "participants");
  } catch (e) {
    if (e instanceof ProviderError && e.status < 500 && e.status !== 429) return [];
    throw e;
  }
}

/** Zoom writes "Speaker Name: words" in each cue rather than WebVTT voice tags. */
function splitSpeaker<C extends { speaker?: string; text: string }>(cue: C): C {
  if (cue.speaker) return cue;
  const m = cue.text.match(/^([^:\n]{1,80}?):\s+([\s\S]+)$/);
  return m ? { ...cue, speaker: m[1].trim(), text: m[2].trim() } : cue;
}

/**
 * Cloud-recording transcripts since the last sync, or from the last 90 days on the first one.
 * Each meeting instance is one thread, visible to its host and participants, with one message per speaker turn.
 */
export async function fetchZoom(
  api: Api,
  cursor: ZoomCursor = {},
  now = new Date(),
): Promise<{ people: NormalizedPerson[]; threads: NormalizedThread[]; messages: NormalizedMessage[]; cursor: ZoomCursor }> {
  const from = dayStart(cursor.since ? Date.parse(cursor.since) - OVERLAP_MS : now.getTime() - BACKFILL_DAYS * DAY_MS);
  const seen = new Map(Object.entries(cursor.seen ?? {}));
  const users = await listAll<User>(api, "users", "users", { status: "active" });
  const userById = new Map(users.map((u) => [u.id, u]));

  const people = new Map<string, NormalizedPerson>();
  const keyFor = (name: string | undefined, email?: string) => {
    const key = email ? `email:${email}` : `name:${name!.toLowerCase()}`;
    const known = people.get(key);
    if (!known || (name && known.displayName === email)) {
      people.set(key, { key, provider: email ? "email" : "meeting", externalId: email ?? name!.toLowerCase(), displayName: name ?? email!, email });
    }
    return key;
  };

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  let since = cursor.since;
  let read = 0;

  for (let start = from; start <= now.getTime() && read < MAX_MEETINGS; start += WINDOW_DAYS * DAY_MS) {
    const window = { from: day(start), to: day(Math.min(start + (WINDOW_DAYS - 1) * DAY_MS, now.getTime())) };
    const found = new Map<string, Meeting>();
    for (const u of users) {
      let meetings: Meeting[];
      try {
        meetings = await listAll<Meeting>(api, `users/${encodeURIComponent(u.id)}/recordings`, "meetings", window);
      } catch (e) {
        // 404: this user has no cloud recordings (or no cloud recording licence).
        if (e instanceof ProviderError && e.status === 404) continue;
        throw e;
      }
      for (const m of meetings) if (m.uuid && valid(m.start_time) && transcriptOf(m) && !seen.has(m.uuid)) found.set(m.uuid, { host_id: u.id, ...m });
    }
    const due = [...found.values()].sort((a, b) => Date.parse(a.start_time!) - Date.parse(b.start_time!));

    for (const m of due.slice(0, MAX_MEETINGS - read)) {
      read++;
      const startedAt = valid(m.start_time)!;
      seen.set(m.uuid, startedAt.toISOString());
      if (!since || startedAt.toISOString() > since) since = startedAt.toISOString();

      const file = transcriptOf(m)!;
      const turns = speakerTurns(
        parseVtt(await download(api, m, file)).cues.map(splitSpeaker).map((c) => ({ speaker_name: c.speaker, text: c.text, start_time: c.startMs / 1000, end_time: c.endMs / 1000 })),
      );
      if (!turns.length) continue;

      const attendees = new Map<string, string | undefined>();
      const host = m.host_id ? userById.get(m.host_id) : undefined;
      const hostEmail = host?.email?.trim().toLowerCase();
      if (hostEmail) attendees.set(hostEmail, nameOf(host!));
      for (const p of await participantsOf(api, m)) {
        const email = p.user_email?.trim().toLowerCase();
        if (email?.includes("@")) attendees.set(email, attendees.get(email) ?? (p.name?.trim() || undefined));
      }
      const emailByName = new Map([...attendees].filter(([, name]) => name).map(([email, name]) => [name!.toLowerCase(), email]));
      const speakerKey = (name: string) => keyFor(name, emailByName.get(name.toLowerCase()));
      const memberKeys = new Set([...attendees].map(([email, name]) => keyFor(name, email)));
      for (const turn of turns) if (turn.speaker) memberKeys.add(speakerKey(turn.speaker));

      const base = valid(file.recording_start) ?? startedAt;
      const url = m.share_url ?? undefined;
      threads.push({
        externalId: m.uuid,
        kind: "meeting",
        title: m.topic?.trim() || "Zoom meeting",
        url,
        visibility: "members",
        memberKeys: [...memberKeys],
        metadata: { startedAt: startedAt.toISOString(), durationMinutes: m.duration ?? undefined, meetingId: m.id, participants: [...attendees.keys()], organizer: hostEmail },
      });
      turns.forEach((turn, i) => {
        messages.push({
          threadExternalId: m.uuid,
          externalId: `${m.uuid}#${i + 1}`,
          kind: "transcript",
          authorKey: turn.speaker ? speakerKey(turn.speaker) : undefined,
          sentAt: new Date(base.getTime() + turn.startMs),
          text: turn.text,
          url,
          raw: { turn: i + 1, startMs: turn.startMs, endMs: turn.endMs },
        });
      });
    }
  }

  // Keep only what the next sync's overlap will list again.
  const keepFrom = since ? dayStart(Date.parse(since) - OVERLAP_MS) : 0;
  const kept = Object.fromEntries([...seen].filter(([, at]) => Date.parse(at) >= keepFrom));
  return { people: [...people.values()], threads, messages, cursor: { since, seen: kept } };
}

const SCOPES = [
  "cloud_recording:read:list_user_recordings:admin",
  "cloud_recording:read:list_recording_files:admin",
  "user:read:list_users:admin",
  "user:read:user:admin",
  "meeting:read:list_past_participants:admin",
  "meeting:read:list_meetings:admin",
];

/** Zoom cloud-recording transcripts for the whole account, read with a Server-to-Server OAuth app. */
export const zoom: Provider = {
  id: "zoom",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "accountId", label: "Account ID" },
      { name: "clientId", label: "Client ID" },
      { name: "clientSecret", label: "Client secret", secret: true },
    ],
    setup: `As a Zoom admin, open the Zoom App Marketplace, choose Develop → Build App → Server-to-Server OAuth app, add the read-only scopes ${SCOPES.join(", ")}, activate it, and paste its Account ID, Client ID and Client secret. ALRO only reads meeting transcripts, users and who attended.`,
    docsUrl: "https://developers.zoom.us/docs/internal-apps/s2s-oauth/",
    api: (c) => zoomApi(c),
  },
  async identify(api, credentials) {
    let me: { id?: string; email?: string | null; account_id?: string | null; company?: string | null };
    try {
      me = await api("GET", "users/me");
    } catch (e) {
      if (refused(e)) throw new Error("Zoom didn't accept those app credentials. Check the Account ID, Client ID and Client secret, and that the app is activated.");
      const missing = e instanceof ProviderError && String(e.message).match(/does not contain scopes:?\s*\[?([^\]"]+)/)?.[1];
      if (missing) throw new Error(`The Zoom app is missing these scopes: ${missing.trim()}. Add them under Scopes and try again.`);
      throw e;
    }
    const accountId = (me.account_id || credentials.accountId || "").trim();
    return { accountId: `zoom:${accountId}`, label: me.company?.trim() || me.email?.toLowerCase() || `Zoom ${accountId}` };
  },
  async sync(api, cursor, ctx) {
    const { cursor: next, ...found } = await fetchZoom(api, cursor as ZoomCursor | undefined, ctx.now);
    return { ...found, cursor: next as Record<string, unknown> };
  },
  tools(api) {
    return {
      zoom_meetings: tool({
        description:
          "List a person's Zoom meetings, live: upcoming ones, or recent past ones. Use to answer when someone meets next, what's on their Zoom schedule, or which Zoom calls they had recently. Say the answer came from Zoom.",
        inputSchema: z.object({
          email: z.string().describe("The Zoom user's email address."),
          when: z.enum(["upcoming", "recent"]).nullish().describe("Upcoming (the default) or recent past meetings."),
        }),
        execute: async ({ email, when }) => {
          const recent = when === "recent";
          const r = await api<{ meetings?: { id: number; topic?: string; type?: number; start_time?: string; duration?: number; timezone?: string; agenda?: string }[] }>(
            "GET",
            `users/${encodeURIComponent(email.trim().toLowerCase())}/meetings`,
            { query: { type: recent ? "previous_meetings" : "upcoming_meetings", page_size: 100 } },
          );
          const meetings = (r.meetings ?? [])
            .filter((m) => m.start_time)
            .sort((a, b) => (recent ? -1 : 1) * (Date.parse(a.start_time!) - Date.parse(b.start_time!)))
            .slice(0, 25)
            .map((m) => ({ id: m.id, topic: m.topic, startsAt: m.start_time, durationMinutes: m.duration, timezone: m.timezone, agenda: m.agenda?.slice(0, 200) || undefined }));
          return { email, when: recent ? "recent" : "upcoming", meetings };
        },
      }),
    };
  },
};
