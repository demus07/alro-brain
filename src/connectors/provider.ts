import type { ToolSet } from "ai";
import type { NormalizedMessage, NormalizedPerson, NormalizedRecord, NormalizedThread } from "@/ingest/types";
import type { Api } from "./api";
import type { OAuthApp } from "./oauth";

/** One input on a source's connect form. */
export interface Field {
  name: string;
  label: string;
  placeholder?: string;
  /** Tokens and passwords: shown as a password input. */
  secret?: boolean;
  optional?: boolean;
}

export interface NormalizedEvent {
  externalId: string;
  title: string;
  description?: string;
  location?: string;
  url?: string;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  organizer?: string;
  attendees: { email?: string; name?: string }[];
  cancelled?: boolean;
}

/** What one sync found. Everything is optional except the cursor to resume from. */
export interface Fetched {
  people?: NormalizedPerson[];
  threads?: NormalizedThread[];
  messages?: NormalizedMessage[];
  records?: NormalizedRecord[];
  /** Calendar events, for calendar sources. */
  events?: NormalizedEvent[];
  cursor: Record<string, unknown>;
  /** For documents stored as versions: document id → the current version's message externalId. Older versions are retired. */
  versions?: Map<string, string>;
}

export interface SyncContext {
  /** What the person typed on the connect form (token sources). Empty for sign-in sources. */
  credentials: Record<string, string>;
  /** The account id `identify` returned when the source was connected. */
  accountId: string;
  now: Date;
}

export type Auth =
  | {
      kind: "token";
      fields: Field[];
      /** One or two sentences on where to get the token. Shown on the connect form. */
      setup: string;
      docsUrl?: string;
      api(credentials: Record<string, string>): Api;
    }
  | {
      /** Sign in with Google or Microsoft; needs that OAuth app's client id and secret in the environment. */
      kind: "oauth";
      app: OAuthApp;
      scopes: string[];
      baseUrl: string;
      hosts?: string[];
    };

/**
 * A source ALRO can connect to directly. `sync` reads what's new into memory;
 * `tools` lets the agent query the app live. A provider has one or both.
 * Labels and badges live in src/lib/sources.ts under the same id.
 */
export interface Provider {
  id: string;
  /** 'org' when one connection covers a whole workspace; 'personal' for one person's mailbox, calendar or account. */
  scope: "org" | "personal";
  auth: Auth;
  /** Checks the credential works and names the account (workspace id, mailbox, site). Throws with a message fit for the connect form. */
  identify(api: Api, credentials: Record<string, string>): Promise<{ accountId: string; label?: string }>;
  sync?(api: Api, cursor: Record<string, unknown> | undefined, ctx: SyncContext): Promise<Fetched>;
  tools?(api: Api): ToolSet;
}
