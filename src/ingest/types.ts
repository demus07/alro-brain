/**
 * The one shape every connector and importer produces. The writer turns a
 * batch into rows; nothing downstream knows which tool the data came from.
 */

export interface NormalizedPerson {
  /** Stable key within the batch, e.g. "slack:U01ROHAN" or "email:rohan@alro.ai". */
  key: string;
  provider: string;
  externalId: string;
  displayName: string;
  email?: string;
  /** E.164, e.g. +919820011223. */
  phone?: string;
  /** What the source says about the account: true when it was deactivated or deleted (the person left), false when it's active. Unset when the source doesn't say. */
  deactivated?: boolean;
}

export type ThreadKind =
  | "channel"
  | "dm"
  | "group_dm"
  | "email"
  | "whatsapp"
  | "meeting"
  | "crm_timeline"
  | "doc"
  | "upload";

export interface NormalizedThread {
  externalId: string;
  kind: ThreadKind;
  title?: string;
  url?: string;
  /** 'org' only for things everyone in the company could see in the source (public channels). */
  visibility: "org" | "members";
  /** Person keys of everyone who can see it in the source. */
  memberKeys: string[];
  /**
   * True only when `memberKeys` is the source's whole, current member list, read to the end (a private
   * channel's members, a chat's roster): the writer then removes anyone no longer on it. Leave unset for
   * partial lists (an email's participants, a meeting's attendees), which only ever grow.
   */
  membersComplete?: boolean;
  /** Set only when the thread was read to the end for a stretch of time: stored messages from then that the batch lacks were deleted in the source. */
  complete?: CompleteWindow;
  metadata?: Record<string, unknown>;
}

/** "The batch holds every message of this thread sent from `from` to `to` (inclusive) that still exists in the source." */
export interface CompleteWindow {
  from: Date;
  to: Date;
  /** Replies were only read under parents sent in the window (Slack reads replies parent by parent), so replies to older messages are left alone. */
  repliesUnderParentsOnly?: boolean;
}

export type MessageKind = "chat" | "email" | "transcript" | "note" | "record_change" | "calendar_event";

export interface NormalizedMessage {
  threadExternalId: string;
  externalId: string;
  kind: MessageKind;
  authorKey?: string;
  recipientKeys?: string[];
  sentAt: Date;
  text: string;
  subject?: string;
  replyToExternalId?: string;
  attachments?: { name: string; mimeType?: string; url?: string; size?: number }[];
  url?: string;
  raw?: unknown;
  editedAt?: Date;
  deleted?: boolean;
}

/** A CRM object's current state. The writer diffs it against what's stored and logs changes as record_change messages. */
export interface NormalizedRecord {
  /** deal | account | contact | lead | task | note | ticket | ... */
  type: string;
  externalId: string;
  title: string;
  fields: Record<string, string>;
  ownerKey?: string;
  url?: string;
  sourceUpdatedAt?: Date;
}

export interface NormalizedBatch {
  connection: {
    provider: string;
    scope: "org" | "personal";
    /** Workspace id, mailbox, phone number or upload name: identifies the connection within the org. */
    externalAccountId: string;
    /** Person key of whoever connected or uploaded it (required for personal scope). */
    ownerKey?: string;
  };
  people: NormalizedPerson[];
  threads: NormalizedThread[];
  messages: NormalizedMessage[];
  records?: NormalizedRecord[];
  /** External ids of messages the source says were deleted (as do messages sent with `deleted: true`). */
  deletedMessageIds?: string[];
  /**
   * External ids of threads the connection can no longer read at all (deleted in the source, or the connected
   * account was taken out of them). Nobody can be shown to still have access, so they are hidden from everyone
   * until a later sync reads them again.
   */
  lostThreads?: string[];
}
