import { generateText } from "ai";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { messages, profileNotes, profiles } from "@/db/schema";
import type { Viewer } from "@/db/scope";

/**
 * The personal brain: what ALRO knows about one member (goals, preferences, how they
 * decide) and how they write. It shapes answers and drafts for that member only; nobody
 * else can read it. These helpers run as the table owner and always filter by person.
 */
export const NOTE_CATEGORIES = ["goal", "preference", "decision", "about"] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export interface Profile {
  style: string | null;
  notes: { id: string; category: string; text: string }[];
}

const MAX_NOTES = 60;
const STYLE_SAMPLES = 40;
const STYLE_MIN = 8;

export async function loadProfile(db: Db, viewer: Viewer): Promise<Profile> {
  const [profile] = await db.select({ style: profiles.style }).from(profiles).where(eq(profiles.personId, viewer.personId));
  const notes = await db
    .select({ id: profileNotes.id, category: profileNotes.category, text: profileNotes.text })
    .from(profileNotes)
    .where(and(eq(profileNotes.orgId, viewer.orgId), eq(profileNotes.personId, viewer.personId)))
    .orderBy(desc(profileNotes.createdAt))
    .limit(MAX_NOTES);
  return { style: profile?.style ?? null, notes };
}

export async function rememberNote(db: Db, viewer: Viewer, note: { category: NoteCategory; text: string; source?: "chat" | "interview" | "manual" }): Promise<string> {
  const [row] = await db
    .insert(profileNotes)
    .values({ orgId: viewer.orgId, personId: viewer.personId, category: note.category, text: note.text.trim().slice(0, 600), source: note.source ?? "chat" })
    .returning({ id: profileNotes.id });
  return row.id;
}

export async function forgetNote(db: Db, viewer: Viewer, id: string) {
  await db.delete(profileNotes).where(and(eq(profileNotes.id, id), eq(profileNotes.personId, viewer.personId)));
}

const LABEL: Record<string, string> = { goal: "Goals", preference: "Preferences", decision: "How they decide", about: "About them" };

/** The part of the agent's instructions that makes it this member's assistant. Empty when nothing is known yet. */
export function profileInstructions(profile: Profile, name: string): string {
  const groups = NOTE_CATEGORIES.map((c) => ({ title: LABEL[c], items: profile.notes.filter((n) => n.category === c).map((n) => n.text) })).filter((g) => g.items.length);
  if (!groups.length && !profile.style) return "";
  return [
    `\n\nWhat you know about ${name} (their personal brain; private to them). Use it to judge what matters and how to phrase things. Don't cite it and don't recite it back.`,
    ...groups.map((g) => `${g.title}:\n${g.items.map((i) => `- ${i}`).join("\n")}`),
    ...(profile.style ? [`How ${name} writes. Write drafts in this voice:\n${profile.style}`] : []),
  ].join("\n");
}

const STYLE_INSTRUCTIONS = `You are given messages one person wrote at work. Describe how they write, so an assistant can draft messages in their voice.
Write 5 to 8 short bullet points: tone, typical length, greetings and sign-offs, punctuation and capitalisation habits, languages they mix, phrases they repeat, how direct they are when asking for something.
Describe only what the samples show. No preamble.`;

/**
 * Learns how a member writes from their own recent messages. Returns false when there
 * are too few to tell.
 */
export async function learnStyle(db: Db, viewer: Viewer, models: Models, now = new Date()): Promise<boolean> {
  const samples = await db
    .select({ text: messages.text })
    .from(messages)
    .where(and(eq(messages.orgId, viewer.orgId), eq(messages.authorPersonId, viewer.personId), isNull(messages.deletedAt), sql`length(${messages.text}) between 30 and 1200`))
    .orderBy(desc(messages.sentAt))
    .limit(STYLE_SAMPLES);
  if (samples.length < STYLE_MIN) return false;
  const { text, usage } = await generateText({ model: models.extract, instructions: STYLE_INSTRUCTIONS, prompt: samples.map((s, i) => `(${i + 1}) ${s.text}`).join("\n\n") });
  await recordRun(db, { orgId: viewer.orgId, stage: "profile", model: models.extract, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  const style = text.trim();
  await db
    .insert(profiles)
    .values({ personId: viewer.personId, orgId: viewer.orgId, style, styleAt: now })
    .onConflictDoUpdate({ target: profiles.personId, set: { style, styleAt: now, updatedAt: now } });
  return true;
}
