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
}

export type ThreadKind =
  | "channel"
  | "dm"
  | "group_dm"
  | "email"
  | "whatsapp"
  | "meeting"
  | "crm_timeline"
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
  metadata?: Record<string, unknown>;
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
}
