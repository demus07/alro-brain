import type { NormalizedBatch, NormalizedMessage, NormalizedPerson, NormalizedThread } from "../types";

export interface TranscriptCue {
  startMs: number;
  endMs: number;
  speaker?: string;
  text: string;
}

export interface Transcript {
  title?: string;
  startedAt?: Date;
  attendees: { name: string; email?: string }[];
  cues: TranscriptCue[];
}

const toMs = (t: string) => {
  const parts = t.split(":").map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  return Math.round(((h * 60 + m) * 60 + s) * 1000);
};

/** Parses WebVTT with <v Speaker> voice tags and an optional NOTE header (Title, Date, Attendees). */
export function parseVtt(source: string): Transcript {
  const blocks = source.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const transcript: Transcript = { attendees: [], cues: [] };

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length || lines[0].startsWith("WEBVTT")) continue;

    if (lines[0].startsWith("NOTE")) {
      const note = lines.join("\n").replace(/^NOTE\s*/, "");
      transcript.title ??= note.match(/^\s*Title:\s*(.+)$/m)?.[1].trim();
      const date = note.match(/^\s*Date:\s*(.+)$/m)?.[1].trim();
      if (date && !transcript.startedAt) transcript.startedAt = new Date(date);
      for (const m of note.matchAll(/([A-Z][\p{L}.' -]+?)\s*[<(]([^>)\s]+@[^>)\s]+)[>)]/gu)) {
        transcript.attendees.push({ name: m[1].replace(/^[-*\s]*(Attendees:\s*)?/, "").trim(), email: m[2].toLowerCase() });
      }
      continue;
    }

    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;
    const [start, end] = lines[timingIndex].split("-->").map((s) => s.trim().split(/\s+/)[0]);
    const payload = lines.slice(timingIndex + 1).join(" ");
    const voice = payload.match(/^<v(?:\.[^ >]+)?\s+([^>]+)>/);
    const text = payload.replace(/<\/?v[^>]*>/g, "").replace(/<[^>]+>/g, "").trim();
    if (text) transcript.cues.push({ startMs: toMs(start), endMs: toMs(end), speaker: voice?.[1].trim(), text });
  }
  return transcript;
}

/** One meeting per file becomes one thread; each cue becomes a transcript message, visible to the attendees. */
export function transcriptsToBatch(
  files: { name: string; content: string }[],
  account: string,
): NormalizedBatch {
  const people = new Map<string, NormalizedPerson>();
  const keyFor = (name: string, email?: string) => {
    const key = email ? `email:${email}` : `name:${name.toLowerCase()}`;
    if (!people.has(key)) {
      people.set(key, {
        key,
        provider: email ? "email" : "meeting",
        externalId: email ?? name.toLowerCase(),
        displayName: name,
        email,
      });
    }
    return key;
  };

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];

  for (const file of files) {
    const t = parseVtt(file.content);
    if (!t.startedAt || Number.isNaN(t.startedAt.getTime())) throw new Error(`${file.name}: missing NOTE Date`);
    const emailByName = new Map(t.attendees.map((a) => [a.name.toLowerCase(), a.email]));
    const speakerKey = (name: string) => keyFor(name, emailByName.get(name.toLowerCase()));
    const memberKeys = new Set(t.attendees.map((a) => keyFor(a.name, a.email)));
    for (const c of t.cues) if (c.speaker) memberKeys.add(speakerKey(c.speaker));

    const threadId = `meeting:${file.name}`;
    threads.push({
      externalId: threadId,
      kind: "meeting",
      title: t.title ?? file.name,
      visibility: "members",
      memberKeys: [...memberKeys],
      metadata: { startedAt: t.startedAt.toISOString(), file: file.name },
    });
    t.cues.forEach((c, i) => {
      messages.push({
        threadExternalId: threadId,
        externalId: `${threadId}#${i + 1}`,
        kind: "transcript",
        authorKey: c.speaker ? speakerKey(c.speaker) : undefined,
        sentAt: new Date(t.startedAt!.getTime() + c.startMs),
        text: c.text,
        raw: { cue: i + 1, startMs: c.startMs, endMs: c.endMs },
      });
    });
  }

  return {
    connection: { provider: "upload:meetings", scope: "org", externalAccountId: account },
    people: [...people.values()],
    threads,
    messages,
  };
}
