import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { ProviderError, type Api } from "./api";
import { speakerTurns } from "./fireflies";
import type { Provider } from "./provider";

const DAY_MS = 86_400_000;
/** Meet deletes transcript entries 30 days after a call ends, so there is nothing older to read. */
const BACKFILL_DAYS = 30;
/** Each sync re-lists calls that ended this long before its cursor: a transcript can still be processing when the call ends. */
const OVERLAP_MS = DAY_MS;
/** Calls read per sync (each is several requests); the next sync continues. */
const MAX_RECORDS = 25;
const MAX_LISTED = 2000;
const MAX_ENTRIES = 5000;
const MAX_PARTICIPANTS = 1000;
/** People join a little early or late: a calendar event this close to the call can still be it. */
const SLACK_MS = 30 * 60_000;
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary";

export interface GoogleMeetCursor {
  /** End time (ISO) of the newest call read. */
  since?: string;
  /** Calls already read that end within the overlap, so they aren't read again. */
  done?: string[];
}

interface ConferenceRecord {
  /** conferenceRecords/{id} */
  name: string;
  startTime?: string;
  endTime?: string;
  /** spaces/{id} */
  space?: string;
}
interface Space {
  meetingUri?: string;
  meetingCode?: string;
}
interface Transcript {
  name: string;
  state?: "STATE_UNSPECIFIED" | "STARTED" | "ENDED" | "FILE_GENERATED";
  startTime?: string;
  docsDestination?: { document?: string; exportUri?: string };
}
interface Entry {
  participant?: string;
  text?: string;
  startTime?: string;
  endTime?: string;
}
interface Participant {
  name: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}
interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  conferenceData?: { conferenceId?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
}

/** Every item of a paged Meet or Calendar list, up to `max`. */
async function listAll<T>(api: Api, path: string, key: string, query: Record<string, string | number | undefined>, max: number): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const r = await api<Record<string, unknown>>("GET", path, { query: { ...query, pageToken } });
    out.push(...((r[key] as T[] | undefined) ?? []));
    pageToken = r.nextPageToken as string | undefined;
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

const sameCode = (a?: string, b?: string) => !!a && !!b && a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();

/**
 * The person's Calendar event for a call: same Meet code, and timed within half an hour of the call.
 * Undefined when there is none, so nobody is added to the meeting on a guess.
 */
async function calendarEvent(api: Api, meetingCode: string, start: number, end: number): Promise<CalendarEvent | undefined> {
  const events = await listAll<CalendarEvent>(
    api,
    `${CALENDAR}/events`,
    "items",
    { singleEvents: "true", timeMin: new Date(start - SLACK_MS).toISOString(), timeMax: new Date(end + SLACK_MS).toISOString(), maxResults: 50 },
    200,
  );
  const startOf = (e: CalendarEvent) => Date.parse(e.start?.dateTime ?? "");
  return events
    .filter((e) => e.status !== "cancelled" && sameCode(e.conferenceData?.conferenceId, meetingCode) && Number.isFinite(startOf(e)))
    .sort((a, b) => Math.abs(startOf(a) - start) - Math.abs(startOf(b) - start))[0];
}

/**
 * Google Meet calls the person organised that ended since the last sync (or in the last 30 days on the
 * first one) and were transcribed. Each is one meeting thread of speaker turns, visible to the people
 * invited on its Calendar event; when no event matches, only to the person who connected Meet.
 */
export async function fetchGoogleMeet(
  api: Api,
  cursor: GoogleMeetCursor = {},
  now = new Date(),
): Promise<{ people: NormalizedPerson[]; threads: NormalizedThread[]; messages: NormalizedMessage[]; cursor: GoogleMeetCursor }> {
  const after = cursor.since ? Date.parse(cursor.since) - OVERLAP_MS : now.getTime() - BACKFILL_DAYS * DAY_MS;
  // Listed newest first; read oldest first so a capped sync continues where it stopped.
  const records = (
    await listAll<ConferenceRecord>(api, "v2/conferenceRecords", "conferenceRecords", { filter: `end_time>="${new Date(after).toISOString()}"`, pageSize: 100 }, MAX_LISTED)
  )
    .filter((r) => r.startTime && r.endTime)
    .sort((a, b) => Date.parse(a.endTime!) - Date.parse(b.endTime!));
  const done = new Set(cursor.done ?? []);
  const todo = records.filter((r) => !done.has(r.name));
  const batch = todo.slice(0, MAX_RECORDS);

  const people = new Map<string, NormalizedPerson>();
  const emailKey = (email: string, name?: string) => {
    const key = `email:${email}`;
    const known = people.get(key);
    if (!known || (name && known.displayName === email)) people.set(key, { key, provider: "email", externalId: email, displayName: name || email, email });
    return key;
  };
  const addPerson = (p: NormalizedPerson) => {
    if (!people.has(p.key)) people.set(p.key, p);
    return p.key;
  };

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  for (const r of batch) {
    const transcripts = await listAll<Transcript>(api, `v2/${r.name}/transcripts`, "transcripts", { pageSize: 100 }, 100);
    // Still transcribing: try again next sync.
    if (transcripts.some((t) => t.state === "STARTED")) continue;
    const entries: Entry[] = [];
    for (const t of transcripts) entries.push(...(await listAll<Entry>(api, `v2/${t.name}/entries`, "transcriptEntries", { pageSize: 100 }, MAX_ENTRIES)));
    if (!entries.length) {
      // No transcript, or one Meet is still writing out.
      if (!transcripts.length || transcripts.every((t) => t.state === "FILE_GENERATED")) done.add(r.name);
      continue;
    }
    done.add(r.name);

    const start = Date.parse(r.startTime!);
    const end = Date.parse(r.endTime!);
    const space = r.space
      ? await api<Space>("GET", `v2/${r.space}`).catch((e) => {
          // Without the space there is no Meet code to find the Calendar event by; the call is still read.
          if (e instanceof ProviderError && (e.status === 403 || e.status === 404)) return undefined;
          throw e;
        })
      : undefined;
    const event = space?.meetingCode ? await calendarEvent(api, space.meetingCode, start, end) : undefined;
    const participants = new Map(
      (await listAll<Participant>(api, `v2/${r.name}/participants`, "participants", { pageSize: 250 }, MAX_PARTICIPANTS)).map((p) => [p.name, p]),
    );

    const invited = (event?.attendees ?? []).filter((a) => !a.resource && a.email?.includes("@") && a.responseStatus !== "declined");
    const memberKeys = new Set(invited.map((a) => emailKey(a.email!.trim().toLowerCase(), a.displayName?.trim())));
    // A speaker is linked to an invitee only when exactly one invitee has that display name.
    const named = new Map<string, string | null>();
    for (const a of invited) {
      const name = a.displayName?.trim().toLowerCase();
      if (name) named.set(name, named.has(name) ? null : a.email!.trim().toLowerCase());
    }
    const speakerKey = (participant: string) => {
      const p = participants.get(participant);
      if (!p) return undefined;
      const name = (p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName)?.trim();
      const email = name ? named.get(name.toLowerCase()) : undefined;
      if (email) return emailKey(email, name);
      const user = p.signedinUser?.user;
      if (user) return addPerson({ key: `google-meet:${user}`, provider: "google-meet", externalId: user, displayName: name || "Google Meet participant" });
      if (name) return addPerson({ key: `name:${name.toLowerCase()}`, provider: "meeting", externalId: name.toLowerCase(), displayName: name });
      return undefined;
    };

    const turns = speakerTurns(
      entries
        .map((e) => ({ speaker_name: e.participant, text: e.text, start_time: (Date.parse(e.startTime ?? "") - start) / 1000, end_time: (Date.parse(e.endTime ?? "") - start) / 1000 }))
        .sort((a, b) => (a.start_time || 0) - (b.start_time || 0)),
    );
    if (!turns.length) continue;

    const id = r.name.replace(/^conferenceRecords\//, "");
    const doc = transcripts.find((t) => t.docsDestination?.document)?.docsDestination?.document;
    const url = doc ? `https://docs.google.com/document/d/${doc}/edit` : space?.meetingUri;
    const title = event?.summary?.trim() || ["Google Meet", space?.meetingCode, r.startTime!.slice(0, 10)].filter(Boolean).join(" ");
    threads.push({
      externalId: id,
      kind: "meeting",
      title,
      url,
      visibility: "members",
      memberKeys: [...memberKeys],
      metadata: {
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(end).toISOString(),
        durationMinutes: Math.round((end - start) / 60_000),
        meetingCode: space?.meetingCode,
        participants: invited.map((a) => a.email!.trim().toLowerCase()),
        calendarEventId: event?.id,
        transcriptDocId: doc,
      },
    });
    turns.forEach((turn, i) => {
      messages.push({
        threadExternalId: id,
        externalId: `${id}#${i + 1}`,
        kind: "transcript",
        authorKey: turn.speaker ? speakerKey(turn.speaker) : undefined,
        sentAt: new Date(start + turn.startMs),
        text: turn.text,
        url,
        raw: { turn: i + 1, startMs: turn.startMs, endMs: turn.endMs },
      });
    });
  }

  // Capped: continue from the last call read. Otherwise everything listed has been seen.
  const last = todo.length > batch.length ? batch.at(-1) : records.at(-1);
  const since = last && (!cursor.since || Date.parse(last.endTime!) > Date.parse(cursor.since)) ? new Date(last.endTime!).toISOString() : cursor.since;
  const keepFrom = since ? Date.parse(since) - OVERLAP_MS : 0;
  const ended = new Map(records.map((r) => [r.name, Date.parse(r.endTime!)]));
  return {
    people: [...people.values()],
    threads,
    messages,
    cursor: { since, done: [...done].filter((n) => (ended.get(n) ?? -1) >= keepFrom) },
  };
}

/** Transcripts of the Google Meet calls the person organised, read with their Google sign-in. */
export const googleMeet: Provider = {
  id: "google-meet",
  scope: "personal",
  auth: {
    kind: "oauth",
    app: "google",
    // Meet transcripts, plus Calendar to title each call and know who was invited.
    scopes: ["https://www.googleapis.com/auth/meetings.space.readonly", "https://www.googleapis.com/auth/calendar.readonly"],
    baseUrl: "https://meet.googleapis.com/",
    hosts: ["www.googleapis.com"],
  },
  async identify(api) {
    try {
      const cal = await api<{ id: string }>("GET", CALENDAR);
      await api("GET", "v2/conferenceRecords", { query: { pageSize: 1 } });
      return { accountId: cal.id.toLowerCase(), label: cal.id.toLowerCase() };
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
        throw new Error("Google didn't allow ALRO to read your Meet calls. Sign in again and allow access to Google Meet and Calendar.");
      }
      throw e;
    }
  },
  async sync(api, cursor, ctx) {
    const { cursor: next, ...found } = await fetchGoogleMeet(api, cursor as GoogleMeetCursor | undefined, ctx.now);
    return { ...found, cursor: next as Record<string, unknown> };
  },
};
