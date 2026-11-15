import { randomInt } from "node:crypto";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { channelLinkCodes, channelLinks, channelMessages } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { CHANNELS, type ChannelId } from "./channels";

const CODE_TTL_MS = 15 * 60 * 1000;
/** WhatsApp only lets a business message someone freely within 24 hours of their last message. */
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A one-time code the member sends from the messaging app, proving the account is theirs. */
export async function createLinkCode(db: Db, viewer: Viewer, now = new Date()): Promise<string> {
  await db.delete(channelLinkCodes).where(eq(channelLinkCodes.personId, viewer.personId));
  await db.delete(channelLinkCodes).where(lt(channelLinkCodes.expiresAt, now));
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  await db.insert(channelLinkCodes).values({ code, orgId: viewer.orgId, personId: viewer.personId, expiresAt: new Date(now.getTime() + CODE_TTL_MS) });
  return code;
}

/** Links a messaging account to whoever generated the code. The code is used up either way. */
export async function redeemLinkCode(
  db: Db,
  channel: ChannelId,
  externalUserId: string,
  code: string,
  now = new Date(),
  address?: Record<string, string>,
): Promise<Viewer | undefined> {
  const [row] = await db.delete(channelLinkCodes).where(and(eq(channelLinkCodes.code, code), gt(channelLinkCodes.expiresAt, now))).returning();
  if (!row) return undefined;
  await db
    .insert(channelLinks)
    .values({ orgId: row.orgId, personId: row.personId, channel, externalUserId, address })
    .onConflictDoUpdate({ target: [channelLinks.channel, channelLinks.externalUserId], set: { orgId: row.orgId, personId: row.personId, address } });
  return { orgId: row.orgId, personId: row.personId };
}

export async function linkedViewer(db: Db, channel: ChannelId, externalUserId: string): Promise<Viewer | undefined> {
  const [row] = await db
    .select({ orgId: channelLinks.orgId, personId: channelLinks.personId })
    .from(channelLinks)
    .where(and(eq(channelLinks.channel, channel), eq(channelLinks.externalUserId, externalUserId)));
  return row;
}

/**
 * Sends a message to a member in every messaging app they've linked. Used for briefs,
 * reminders and scheduled results. Returns the channels it went out on; a failure in
 * one channel doesn't stop the others.
 */
export async function notifyPerson(db: Db, orgId: string, personId: string, text: string, now = new Date()): Promise<ChannelId[]> {
  const links = await db.select().from(channelLinks).where(and(eq(channelLinks.orgId, orgId), eq(channelLinks.personId, personId)));
  const sent: ChannelId[] = [];
  for (const link of links) {
    const channel = CHANNELS[link.channel as ChannelId];
    if (!channel?.configured()) continue;
    if (channel.id === "whatsapp") {
      const [last] = await db
        .select({ at: channelMessages.createdAt })
        .from(channelMessages)
        .where(and(eq(channelMessages.personId, personId), eq(channelMessages.channel, "whatsapp"), eq(channelMessages.role, "user")))
        .orderBy(desc(channelMessages.createdAt))
        .limit(1);
      if (!last || now.getTime() - last.at.getTime() > WHATSAPP_WINDOW_MS) continue;
    }
    try {
      await channel.send(link.externalUserId, text, link.address);
      await db.insert(channelMessages).values({ orgId, personId, channel: channel.id, role: "assistant", text });
      sent.push(channel.id);
    } catch (e) {
      console.error(`${channel.id} message to ${personId} failed`, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

/** Keeps where to reach a linked account up to date (Teams can move a conversation to another service URL). */
export async function rememberAddress(db: Db, channel: ChannelId, externalUserId: string, address: Record<string, string>) {
  await db.update(channelLinks).set({ address }).where(and(eq(channelLinks.channel, channel), eq(channelLinks.externalUserId, externalUserId)));
}
