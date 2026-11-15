import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { bearer, httpApi, ProviderError, type Api } from "./api";
import type { Provider } from "./provider";

const DAY_MS = 86_400_000;
const BACKFILL_DAYS = 90;
/** Each sync re-reads this much before its cursor: a transcript is dated at the meeting's start but only appears once it has been processed. */
const OVERLAP_MS = DAY_MS;
/** Fireflies returns at most 50 transcripts per query; sentences make them heavy, so ask for fewer. */
const PAGE = 25;
const MAX_TRANSCRIPTS = 200;
const MAX_TURN_CHARS = 1500;

export interface FirefliesCursor {
  /** Start time (ISO) of the newest meeting read. */
  since?: string;
}

interface Sentence {
  speaker_name?: string | null;
  text?: string | null;
  /** Seconds from the start of the recording. */
  start_time?: number | string | null;
  end_time?: number | string | null;
}
interface Transcript {
  id: string;
  title?: string | null;
  /** Milliseconds since the epoch. */
  date?: number | string | null;
  /** Minutes. */
  duration?: number | null;
  organizer_email?: string | null;
  participants?: (string | null)[] | null;
  transcript_url?: string | null;
  meeting_attendees?: { displayName?: string | null; name?: string | null; email?: string | null }[] | null;
  sentences?: Sentence[] | null;
}

const TRANSCRIPTS = `query Transcripts($fromDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, limit: $limit, skip: $skip) {
    id title date duration organizer_email participants transcript_url
    meeting_attendees { displayName name email }
    sentences { speaker_name text start_time end_time }
  }
}`;

async function gql<T>(api: Api, query: string, variables?: Record<string, unknown>): Promise<T> {
  const r = await api<{ data?: T | null; errors?: { message: string; code?: string; extensions?: { status?: number } }[] }>("POST", "graphql", { body: { query, variables } });
  if (r.errors?.length) {
    const status = r.errors.map((e) => e.extensions?.status).find((s) => s) ?? (r.errors.some((e) => /auth/i.test(e.code ?? "")) ? 401 : 400);
    throw new ProviderError(`Fireflies: ${r.errors.map((e) => e.message).join("; ")}`, status);
  }
  if (!r.data) throw new ProviderError("Fireflies returned no data", 502);
  return r.data;
}

const startOf = (t: Transcript) => {
  if (t.date == null || t.date === "") return undefined;
  const ms = Number(t.date);
  const d = new Date(Number.isFinite(ms) ? ms : String(t.date));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const toMs = (seconds: number | string | null | undefined) => Math.round((Number(seconds) || 0) * 1000);

export interface Turn {
  speaker?: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** A transcript as speaker turns: consecutive sentences by one speaker are joined, and a long turn is cut at a sentence boundary near 1500 characters. */
export function speakerTurns(sentences: Sentence[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of sentences) {
    const text = s.text?.trim();
    if (!text) continue;
    const speaker = s.speaker_name?.trim() || undefined;
    const last = turns.at(-1);
    if (last && last.speaker === speaker && last.text.length + text.length < MAX_TURN_CHARS) {
      last.text += ` ${text}`;
      last.endMs = toMs(s.end_time);
    } else {
      turns.push({ speaker, text, startMs: toMs(s.start_time), endMs: toMs(s.end_time) });
    }
  }
  return turns;
}

/**
 * Meetings recorded since the last sync, or in the last 90 days on the first one.
 * Each transcript is one meeting thread, visible to its participants, with one message per speaker turn.
 */
export async function fetchFireflies(
  api: Api,
  cursor: FirefliesCursor = {},
  now = new Date(),
): Promise<{ people: NormalizedPerson[]; threads: NormalizedThread[]; messages: NormalizedMessage[]; cursor: FirefliesCursor }> {
  const fromDate = new Date(cursor.since ? Date.parse(cursor.since) - OVERLAP_MS : now.getTime() - BACKFILL_DAYS * DAY_MS).toISOString();
  const transcripts: Transcript[] = [];
  for (let skip = 0; skip < MAX_TRANSCRIPTS; skip += PAGE) {
    const page = (await gql<{ transcripts: Transcript[] | null }>(api, TRANSCRIPTS, { fromDate, limit: PAGE, skip })).transcripts ?? [];
    transcripts.push(...page);
    if (page.length < PAGE) break;
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
  let since = cursor.since;
  for (const t of transcripts) {
    const startedAt = startOf(t);
    if (!startedAt) continue;
    if (!since || startedAt.toISOString() > since) since = startedAt.toISOString();
    const turns = speakerTurns(t.sentences ?? []);
    if (!turns.length) continue;

    const attendees = new Map<string, string | undefined>();
    for (const p of [t.organizer_email, ...(t.participants ?? [])]) {
      for (const email of (p ?? "").split(",").map((e) => e.trim().toLowerCase())) if (email.includes("@")) attendees.set(email, undefined);
    }
    for (const a of t.meeting_attendees ?? []) {
      const email = a.email?.trim().toLowerCase();
      if (email?.includes("@")) attendees.set(email, a.displayName?.trim() || a.name?.trim() || attendees.get(email));
    }
    const emailByName = new Map([...attendees].filter(([, name]) => name).map(([email, name]) => [name!.toLowerCase(), email]));
    const speakerKey = (name: string) => keyFor(name, emailByName.get(name.toLowerCase()));
    const memberKeys = new Set([...attendees].map(([email, name]) => keyFor(name, email)));
    for (const turn of turns) if (turn.speaker) memberKeys.add(speakerKey(turn.speaker));

    const url = t.transcript_url ?? `https://app.fireflies.ai/view/${t.id}`;
    threads.push({
      externalId: t.id,
      kind: "meeting",
      title: t.title?.trim() || "Meeting",
      url,
      visibility: "members",
      memberKeys: [...memberKeys],
      metadata: { startedAt: startedAt.toISOString(), durationMinutes: t.duration ?? undefined, participants: [...attendees.keys()], organizer: t.organizer_email?.toLowerCase() },
    });
    turns.forEach((turn, i) => {
      messages.push({
        threadExternalId: t.id,
        externalId: `${t.id}#${i + 1}`,
        kind: "transcript",
        authorKey: turn.speaker ? speakerKey(turn.speaker) : undefined,
        sentAt: new Date(startedAt.getTime() + turn.startMs),
        text: turn.text,
        url,
        raw: { turn: i + 1, startMs: turn.startMs, endMs: turn.endMs },
      });
    });
  }
  return { people: [...people.values()], threads, messages, cursor: { since } };
}

/** Fireflies.ai meeting transcripts, read with the person's own API key. */
export const fireflies: Provider = {
  id: "fireflies",
  scope: "personal",
  auth: {
    kind: "token",
    fields: [{ name: "apiKey", label: "API key", secret: true }],
    setup: "In Fireflies, open Integrations, choose Fireflies API and copy your API key. ALRO only reads your meeting transcripts.",
    docsUrl: "https://docs.fireflies.ai/fundamentals/authorization",
    api: (c) => httpApi({ baseUrl: "https://api.fireflies.ai/", headers: bearer(c.apiKey.trim()) }),
  },
  async identify(api) {
    let me: { user_id: string; email?: string | null; name?: string | null };
    try {
      me = (await gql<{ user: typeof me }>(api, "query { user { user_id email name } }")).user;
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Fireflies didn't accept that API key.");
      throw e;
    }
    const email = me.email?.toLowerCase();
    return { accountId: email ?? `fireflies:${me.user_id}`, label: email ?? me.name ?? undefined };
  },
  async sync(api, cursor, ctx) {
    const { cursor: next, ...found } = await fetchFireflies(api, cursor as FirefliesCursor | undefined, ctx.now);
    return { ...found, cursor: next as Record<string, unknown> };
  },
};
