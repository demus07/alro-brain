import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { httpApi, ProviderError, type Api } from "./api";
import { speakerTurns } from "./fireflies";
import type { Provider } from "./provider";

const DAY_MS = 86_400_000;
const BACKFILL_DAYS = 90;
/** Each sync re-reads this much before its cursor: a meeting is listed by when it was created, but its transcript only arrives once processing finishes. */
const OVERLAP_MS = DAY_MS;
/** Fathom returns 10 meetings a page and has no page-size parameter; transcript pages are "heavy" calls (30 a minute, sometimes 5), so stop at 10 pages and carry on next sync. */
const MAX_PAGES = 10;

export interface FathomCursor {
  /** Creation time (ISO) of the newest meeting read in a finished pass. */
  since?: string;
  /** A pass cut short by the page cap or a rate limit: the query it was running and where to pick it up. */
  pending?: { createdAfter: string; page: string; newest?: string };
}

interface Invitee {
  name?: string | null;
  matched_speaker_display_name?: string | null;
  email?: string | null;
  is_external?: boolean | null;
}
interface TranscriptItem {
  speaker?: { display_name?: string | null; matched_calendar_invitee_email?: string | null } | null;
  text?: string | null;
  /** "HH:MM:SS" from the start of the recording. */
  timestamp?: string | null;
}
interface ActionItem {
  description?: string | null;
  completed?: boolean | null;
  recording_timestamp?: string | null;
  assignee?: { name?: string | null; email?: string | null } | null;
}
interface Meeting {
  recording_id: number | string;
  title?: string | null;
  meeting_title?: string | null;
  url?: string | null;
  share_url?: string | null;
  created_at?: string | null;
  scheduled_start_time?: string | null;
  recording_start_time?: string | null;
  recording_end_time?: string | null;
  calendar_invitees_domains_type?: string | null;
  recorded_by?: { name?: string | null; email?: string | null } | null;
  calendar_invitees?: Invitee[] | null;
  transcript?: TranscriptItem[] | null;
  default_summary?: { markdown_formatted?: string | null } | null;
  action_items?: ActionItem[] | null;
}
interface MeetingPage {
  items?: Meeting[] | null;
  next_cursor?: string | null;
}

/** "HH:MM:SS" (or "MM:SS") to seconds. */
export function clockSeconds(stamp: string | null | undefined): number {
  if (!stamp) return 0;
  return stamp.split(":").reduce((total, part) => total * 60 + (Number(part) || 0), 0);
}

const dateOf = (s: string | null | undefined) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const cleanEmail = (e: string | null | undefined) => {
  const email = e?.trim().toLowerCase();
  return email?.includes("@") ? email : undefined;
};

/** Fathom's summary and action items as one note. */
function summaryText(m: Meeting): string {
  const parts: string[] = [];
  const summary = m.default_summary?.markdown_formatted?.trim();
  if (summary) parts.push(summary);
  const items = (m.action_items ?? []).filter((a) => a.description?.trim());
  if (items.length) {
    const lines = items.map((a) => {
      const who = a.assignee?.name?.trim() || cleanEmail(a.assignee?.email);
      return `- ${a.completed ? "[x]" : "[ ]"} ${a.description!.trim()}${who ? ` (${who})` : ""}`;
    });
    parts.push(`Action items:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Meetings recorded since the last sync, or in the last 90 days on the first one. Each recording is one meeting
 * thread, visible to its invitees, recorder and identified speakers, with one message per speaker turn and
 * Fathom's own summary and action items as a note.
 */
export async function fetchFathom(
  api: Api,
  cursor: FathomCursor = {},
  now = new Date(),
): Promise<{ people: NormalizedPerson[]; threads: NormalizedThread[]; messages: NormalizedMessage[]; cursor: FathomCursor }> {
  const createdAfter =
    cursor.pending?.createdAfter ?? new Date(cursor.since ? Date.parse(cursor.since) - OVERLAP_MS : now.getTime() - BACKFILL_DAYS * DAY_MS).toISOString();
  let page = cursor.pending?.page;
  let newest = cursor.pending?.newest;
  const meetings: Meeting[] = [];
  let finished = false;
  for (let n = 0; n < MAX_PAGES; n++) {
    let r: MeetingPage;
    try {
      r = await api<MeetingPage>("GET", "meetings", {
        query: { created_after: createdAfter, include_transcript: "true", include_summary: "true", include_action_items: "true", cursor: page },
      });
    } catch (e) {
      // Rate limited part-way: keep what was read and pick up here next time.
      if (n > 0 && e instanceof ProviderError && e.status === 429) break;
      throw e;
    }
    meetings.push(...(r.items ?? []));
    page = r.next_cursor ?? undefined;
    if (!page) {
      finished = true;
      break;
    }
  }

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
  for (const m of meetings) {
    const created = dateOf(m.created_at);
    if (created && (!newest || created.toISOString() > newest)) newest = created.toISOString();
    const items = (m.transcript ?? []).filter((t) => t.text?.trim());
    if (!items.length) continue; // still processing; the overlap reads it again
    const startedAt = dateOf(m.recording_start_time) ?? dateOf(m.scheduled_start_time) ?? created;
    if (!startedAt) continue;
    const id = String(m.recording_id);

    // Everyone invited, the recorder, and each speaker Fathom matched to an invitee.
    const attendees = new Map<string, string | undefined>();
    const recorder = cleanEmail(m.recorded_by?.email);
    if (recorder) attendees.set(recorder, m.recorded_by?.name?.trim() || undefined);
    const emailByName = new Map<string, string>();
    for (const inv of m.calendar_invitees ?? []) {
      const email = cleanEmail(inv.email);
      if (!email) continue;
      const name = inv.name?.trim() || inv.matched_speaker_display_name?.trim() || attendees.get(email);
      attendees.set(email, name);
      for (const n of [inv.name, inv.matched_speaker_display_name]) if (n?.trim()) emailByName.set(n.trim().toLowerCase(), email);
    }
    for (const t of items) {
      const name = t.speaker?.display_name?.trim();
      const email = cleanEmail(t.speaker?.matched_calendar_invitee_email);
      if (!name || !email) continue;
      emailByName.set(name.toLowerCase(), email);
      if (!attendees.get(email)) attendees.set(email, name);
    }
    if (recorder && m.recorded_by?.name?.trim()) emailByName.set(m.recorded_by.name.trim().toLowerCase(), recorder);

    const speakerKey = (name: string) => keyFor(name, emailByName.get(name.toLowerCase()));
    const memberKeys = [...attendees].map(([email, name]) => keyFor(name, email));

    const turns = speakerTurns(
      items.map((t, i) => ({
        speaker_name: t.speaker?.display_name,
        text: t.text,
        start_time: clockSeconds(t.timestamp),
        end_time: clockSeconds(items[i + 1]?.timestamp ?? t.timestamp),
      })),
    );
    const url = m.url ?? m.share_url ?? undefined;
    const endedAt = dateOf(m.recording_end_time);
    threads.push({
      externalId: id,
      kind: "meeting",
      title: m.title?.trim() || m.meeting_title?.trim() || "Meeting",
      url,
      visibility: "members",
      memberKeys,
      metadata: {
        startedAt: startedAt.toISOString(),
        durationMinutes: endedAt ? Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000) : undefined,
        participants: [...attendees.keys()],
        organizer: recorder,
        external: m.calendar_invitees_domains_type === "one_or_more_external",
      },
    });
    turns.forEach((turn, i) => {
      messages.push({
        threadExternalId: id,
        externalId: `${id}#${i + 1}`,
        kind: "transcript",
        authorKey: turn.speaker ? speakerKey(turn.speaker) : undefined,
        sentAt: new Date(startedAt.getTime() + turn.startMs),
        text: turn.text,
        url,
        raw: { turn: i + 1, startMs: turn.startMs, endMs: turn.endMs },
      });
    });
    const summary = summaryText(m);
    if (summary) {
      messages.push({
        threadExternalId: id,
        externalId: `${id}#summary`,
        kind: "note",
        sentAt: endedAt ?? startedAt,
        text: `Fathom summary\n\n${summary}`,
        url,
      });
    }
  }

  const next: FathomCursor = finished
    ? { since: newest && (!cursor.since || newest > cursor.since) ? newest : cursor.since }
    : { ...(cursor.since ? { since: cursor.since } : {}), pending: { createdAfter, page: page!, newest } };
  return { people: [...people.values()], threads, messages, cursor: next };
}

/** Fathom AI notetaker recordings, read with the person's own API key. */
export const fathom: Provider = {
  id: "fathom",
  scope: "personal",
  auth: {
    kind: "token",
    fields: [
      { name: "apiKey", label: "API key", secret: true },
      { name: "email", label: "Your Fathom email", placeholder: "you@company.com" },
    ],
    setup:
      "In Fathom, open your User Settings, go to API Access and generate an API key. ALRO reads the calls you recorded or that were shared with you; it can't change anything.",
    docsUrl: "https://developers.fathom.ai/quickstart",
    api: (c) => httpApi({ baseUrl: "https://api.fathom.ai/external/v1/", headers: () => ({ "x-api-key": c.apiKey.trim() }) }),
  },
  async identify(api, credentials) {
    // Fathom has no "who am I" call, so the key is proven with a cheap list and the account is the email typed in.
    const email = cleanEmail(credentials.email);
    if (!email) throw new Error("Enter the email you sign in to Fathom with.");
    try {
      await api("GET", "meetings", { query: { created_after: new Date().toISOString() } });
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Fathom didn't accept that API key.");
      throw e;
    }
    return { accountId: email, label: email };
  },
  async sync(api, cursor, ctx) {
    const { cursor: next, ...found } = await fetchFathom(api, cursor as FathomCursor | undefined, ctx.now);
    return { ...found, cursor: next as Record<string, unknown> };
  },
};
