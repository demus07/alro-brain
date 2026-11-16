import { strFromU8, unzipSync } from "fflate";
import type { NormalizedBatch, NormalizedMessage, NormalizedPerson, NormalizedThread, ThreadKind } from "../types";

/** Relative path → file contents, e.g. "eng/2026-09-04.json". */
export type ExportFiles = Map<string, string>;

export function unzipSlackExport(zip: Uint8Array): ExportFiles {
  const entries = Object.entries(unzipSync(zip)).filter(
    ([name]) => name.endsWith(".json") && !name.startsWith("__MACOSX/"),
  );
  // Some zips wrap everything in one top-level folder; strip it so users.json sits at the root.
  const users = entries.find(([name]) => name.endsWith("users.json"))?.[0] ?? "users.json";
  const prefix = users.slice(0, -"users.json".length);
  return new Map(
    entries.filter(([name]) => name.startsWith(prefix)).map(([name, data]) => [name.slice(prefix.length), strFromU8(data)]),
  );
}

interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: { real_name?: string; display_name?: string; email?: string; phone?: string };
}

interface SlackConversation {
  id: string;
  name?: string;
  members?: string[];
  is_general?: boolean;
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface SlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  edited?: { ts: string };
  files?: { name?: string; mimetype?: string; url_private?: string; size?: number }[];
}

const json = <T>(files: ExportFiles, path: string): T | undefined => {
  const content = files.get(path);
  return content ? (JSON.parse(content) as T) : undefined;
};

const SKIPPED_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "bot_add", "pinned_item"]);

/**
 * Parses a Slack workspace export. Public channels are visible to the whole
 * org; private channels, DMs and group DMs only to their members.
 */
export function slackExportToBatch(files: ExportFiles, workspace: { teamId: string; domain?: string }): NormalizedBatch {
  const users = json<SlackUser[]>(files, "users.json") ?? [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const nameOf = (id: string) => {
    const u = userById.get(id);
    return u?.profile?.real_name || u?.real_name || u?.profile?.display_name || u?.name || id;
  };

  const people: NormalizedPerson[] = users
    .filter((u) => !u.is_bot)
    .map((u) => ({
      key: `slack:${u.id}`,
      provider: "slack",
      externalId: u.id,
      displayName: nameOf(u.id),
      email: u.profile?.email?.toLowerCase(),
      phone: u.profile?.phone || undefined,
      // Slack marks a deactivated account `deleted`.
      deactivated: u.deleted,
    }));

  const conversations: { conv: SlackConversation; folder: string; kind: ThreadKind; visibility: "org" | "members" }[] = [
    ...(json<SlackConversation[]>(files, "channels.json") ?? []).map((c) => ({ conv: c, folder: c.name!, kind: "channel" as const, visibility: "org" as const })),
    ...(json<SlackConversation[]>(files, "groups.json") ?? []).map((c) => ({ conv: c, folder: c.name!, kind: "channel" as const, visibility: "members" as const })),
    ...(json<SlackConversation[]>(files, "dms.json") ?? []).map((c) => ({ conv: c, folder: c.id, kind: "dm" as const, visibility: "members" as const })),
    ...(json<SlackConversation[]>(files, "mpims.json") ?? []).map((c) => ({ conv: c, folder: c.name ?? c.id, kind: "group_dm" as const, visibility: "members" as const })),
  ];

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const base = workspace.domain ? `https://${workspace.domain}.slack.com/archives` : undefined;

  for (const { conv, folder, kind, visibility } of conversations) {
    const members = conv.members ?? [];
    threads.push({
      externalId: conv.id,
      kind,
      title: kind === "channel" ? `#${conv.name}` : members.map(nameOf).join(", "),
      url: base ? `${base}/${conv.id}` : undefined,
      visibility,
      memberKeys: members.map((id) => `slack:${id}`),
      metadata: { topic: conv.topic?.value, purpose: conv.purpose?.value },
    });

    const days = [...files.keys()].filter((p) => p.startsWith(`${folder}/`) && /\d{4}-\d{2}-\d{2}\.json$/.test(p)).sort();
    for (const day of days) {
      for (const m of json<SlackMessage[]>(files, day) ?? []) {
        if (m.type !== "message" || (m.subtype && SKIPPED_SUBTYPES.has(m.subtype))) continue;
        const text = renderMrkdwn(m.text ?? "", nameOf);
        const mentions = [...(m.text ?? "").matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((x) => `slack:${x[1]}`);
        messages.push({
          threadExternalId: conv.id,
          externalId: `${conv.id}:${m.ts}`,
          kind: "chat",
          authorKey: m.user ? `slack:${m.user}` : undefined,
          recipientKeys: mentions,
          sentAt: new Date(Number(m.ts) * 1000),
          text,
          replyToExternalId: m.thread_ts && m.thread_ts !== m.ts ? `${conv.id}:${m.thread_ts}` : undefined,
          attachments: m.files?.map((f) => ({ name: f.name ?? "file", mimeType: f.mimetype, url: f.url_private, size: f.size })),
          url: base ? `${base}/${conv.id}/p${m.ts.replace(".", "")}` : undefined,
          editedAt: m.edited ? new Date(Number(m.edited.ts) * 1000) : undefined,
          // A deleted message that had replies stays as a "tombstone" so the replies keep their place.
          deleted: m.subtype === "tombstone" || undefined,
          raw: m,
        });
      }
    }
  }

  return {
    connection: { provider: "slack", scope: "org", externalAccountId: workspace.teamId },
    people,
    threads,
    messages,
  };
}

/** Slack mrkdwn → plain text: <@U1> → @Name, <#C1|eng> → #eng, <url|label> → label (url). */
export function renderMrkdwn(text: string, nameOf: (id: string) => string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${nameOf(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
