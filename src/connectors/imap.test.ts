import { describe, expect, it } from "vitest";
import { ProviderError } from "./api";
import { imapWith, type MailSession } from "./imap";

const NOW = new Date("2026-11-02T12:00:00Z");
const credentials = { host: "imap.example.com", email: "Sumedh@example.com", password: "app-pass" };
const ctx = { credentials, accountId: "sumedh@example.com", now: NOW };

const eml = (id: string, subject: string, from = "Jash Doshi <jash@example.com>", to = "sumedh@example.com") =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Sun, 01 Nov 2026 18:30:00 +0530\r\nMessage-ID: <${id}@example.com>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nDetails for ${subject}.\r\n`;

interface Folder {
  specialUse?: string;
  uidValidity: string;
  messages: Record<number, string>;
}

/** An IMAP mailbox held in memory; records every call. */
function fakeMailbox(folders: Record<string, Folder>) {
  const calls: unknown[][] = [];
  let current: Folder;
  const session: MailSession = {
    folders: async () => Object.entries(folders).map(([path, f]) => ({ path, specialUse: f.specialUse })),
    async open(path) {
      calls.push(["open", path]);
      current = folders[path];
      return { uidValidity: current.uidValidity };
    },
    async search(query) {
      calls.push(["search", query]);
      const uids = Object.keys(current.messages).map(Number);
      // Like a real server, "n:*" always includes the newest message.
      return "afterUid" in query ? uids.filter((u) => u > query.afterUid || u === Math.max(...uids)) : uids;
    },
    async fetch(uids) {
      calls.push(["fetch", uids]);
      return uids.map((uid) => ({ uid, source: current.messages[uid] }));
    },
    async close() {
      calls.push(["close"]);
    },
  };
  const opened: Record<string, string>[] = [];
  const provider = imapWith(async (c) => {
    opened.push(c);
    return session;
  });
  return { provider, calls, opened };
}

/** IMAP never touches the HTTP API the framework hands over. */
const noApi = undefined as never;

describe("IMAP", () => {
  const mailbox = () =>
    fakeMailbox({
      INBOX: { uidValidity: "7", messages: { 101: eml("m1", "Site visit"), 102: eml("m2", "Invoice") } },
      Archive: { uidValidity: "1", messages: { 1: eml("old", "Archived") } },
      "[Gmail]/Sent Mail": {
        specialUse: "\\Sent",
        uidValidity: "9",
        messages: { 40: `${eml("m3", "Re: Site visit", "Sumedh Kudav <sumedh@example.com>", "jash@example.com")}`.replace("Message-ID", "In-Reply-To: <m1@example.com>\r\nMessage-ID") },
      },
    });

  it("reads the last 90 days of INBOX and Sent on the first sync and keeps each folder's UID", async () => {
    const { provider, calls } = mailbox();
    const found = await provider.sync!(noApi, undefined, ctx);

    expect(calls.filter((c) => c[0] === "open").map((c) => c[1])).toEqual(["INBOX", "[Gmail]/Sent Mail"]);
    expect(calls.filter((c) => c[0] === "search").map((c) => c[1])).toEqual([{ since: new Date("2026-08-04T12:00:00Z") }, { since: new Date("2026-08-04T12:00:00Z") }]);
    expect(found.messages!.map((m) => [m.kind, m.subject, m.authorKey, m.threadExternalId])).toEqual([
      ["email", "Site visit", "email:jash@example.com", "<m1@example.com>"],
      ["email", "Invoice", "email:jash@example.com", "<m2@example.com>"],
      ["email", "Re: Site visit", "email:sumedh@example.com", "<m1@example.com>"],
    ]);
    expect(found.threads!.map((t) => [t.kind, t.title, t.visibility])).toEqual([
      ["email", "Site visit", "members"],
      ["email", "Invoice", "members"],
    ]);
    expect(found.people!.map((p) => p.email).sort()).toEqual(["jash@example.com", "sumedh@example.com"]);
    expect(found.cursor).toEqual({ folders: { INBOX: { uidValidity: "7", lastUid: 102 }, "[Gmail]/Sent Mail": { uidValidity: "9", lastUid: 40 } } });
    expect(calls.at(-1)).toEqual(["close"]);
  });

  it("asks only for UIDs above the cursor, and starts a folder over when its UIDVALIDITY changed", async () => {
    const { provider, calls } = mailbox();
    const found = await provider.sync!(noApi, { folders: { INBOX: { uidValidity: "7", lastUid: 101 }, "[Gmail]/Sent Mail": { uidValidity: "9", lastUid: 40 } } }, ctx);
    expect(calls.filter((c) => c[0] === "search").map((c) => c[1])).toEqual([{ afterUid: 101 }, { afterUid: 40 }]);
    expect(calls.filter((c) => c[0] === "fetch").map((c) => c[1])).toEqual([[102], []]);
    expect(found.messages!.map((m) => m.subject)).toEqual(["Invoice"]);
    expect(found.cursor).toEqual({ folders: { INBOX: { uidValidity: "7", lastUid: 102 }, "[Gmail]/Sent Mail": { uidValidity: "9", lastUid: 40 } } });

    const renumbered = mailbox();
    await renumbered.provider.sync!(noApi, { folders: { INBOX: { uidValidity: "6", lastUid: 5000 } } }, ctx);
    expect(renumbered.calls.find((c) => c[0] === "search")![1]).toEqual({ since: new Date("2026-08-04T12:00:00Z") });
  });

  it("caps a first sync at 500 messages, newest first, shared between the folders", async () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, eml(`in${i + 1}`, `Mail ${i + 1}`)]));
    const { provider, calls } = fakeMailbox({
      INBOX: { uidValidity: "1", messages: many(600) },
      Sent: { specialUse: "\\Sent", uidValidity: "2", messages: { 9: eml("s9", "Sent one") } },
    });
    const found = await provider.sync!(noApi, undefined, ctx);
    const fetched = calls.filter((c) => c[0] === "fetch").map((c) => c[1] as number[]);
    expect([fetched[0].length, fetched[0][0], fetched[0].at(-1)]).toEqual([250, 351, 600]);
    expect(fetched[1]).toEqual([9]);
    expect(found.messages).toHaveLength(251);
    expect(found.cursor).toEqual({ folders: { INBOX: { uidValidity: "1", lastUid: 600 }, Sent: { uidValidity: "2", lastUid: 9 } } });
  });

  it("identifies the mailbox by signing in, and says so plainly when the password is refused", async () => {
    const { provider, calls, opened } = mailbox();
    expect(await provider.identify(noApi, credentials)).toEqual({ accountId: "sumedh@example.com", label: "sumedh@example.com" });
    expect(opened).toEqual([credentials]);
    expect(calls).toEqual([["close"]]);

    const refused = imapWith(async () => {
      throw Object.assign(new Error("Command failed"), { authenticationFailed: true });
    });
    const error = await refused.identify(noApi, credentials).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toBe("The mail server didn't accept that email address and app password.");

    const unreachable = imapWith(async () => {
      throw new Error("getaddrinfo ENOTFOUND imap.example.com");
    });
    await expect(unreachable.identify(noApi, credentials)).rejects.toThrow("Couldn't connect to imap.example.com");
    await expect(refused.identify(noApi, { ...credentials, password: "" })).rejects.toThrow("Enter the mail server");
  });

  it("has no HTTP API", async () => {
    const { auth } = mailbox().provider;
    if (auth.kind !== "token") throw new Error("imap is a token source");
    await expect(auth.api({})("GET", "anything")).rejects.toThrow("IMAP doesn't use HTTP");
  });
});
