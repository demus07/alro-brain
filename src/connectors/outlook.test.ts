import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { outlook } from "./outlook";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown>; as?: string }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query, as: opts.as });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const ctx = { credentials: {}, accountId: "sumedh@example.com", now: NOW };
const NEXT = "https://graph.microsoft.com/v1.0/me/messages?$skip=100";

const mime = (id: string, subject: string, time = "18:30", extra = "") =>
  `From: Jash Doshi <jash@example.com>\r\nTo: Sumedh Kudav <sumedh@example.com>\r\nSubject: ${subject}\r\nDate: Sun, 01 Nov 2026 ${time}:00 +0530\r\nMessage-ID: <${id}@example.com>\r\n${extra}Content-Type: text/plain; charset=UTF-8\r\n\r\nDetails for ${subject}.\r\n`;

const routes = {
  me: () => ({ mail: "Sumedh@example.com", userPrincipalName: "sumedh@example.onmicrosoft.com" }),
  "me/mailFolders/junkemail": () => ({ id: "JUNK" }),
  "me/mailFolders/deleteditems": () => ({ id: "BIN" }),
  "me/messages": () => ({
    value: [
      { id: "A2=", receivedDateTime: "2026-11-01T13:05:00Z", isDraft: false, parentFolderId: "SENT" },
      { id: "D1", receivedDateTime: "2026-11-01T13:02:00Z", isDraft: true, parentFolderId: "DRAFTS" },
      { id: "J1", receivedDateTime: "2026-11-01T13:01:00Z", isDraft: false, parentFolderId: "JUNK" },
    ],
    "@odata.nextLink": NEXT,
  }),
  [NEXT]: () => ({ value: [{ id: "A1", receivedDateTime: "2026-11-01T13:00:00Z", isDraft: false, parentFolderId: "INBOX" }, { id: "GONE", receivedDateTime: "2026-10-30T09:00:00Z", parentFolderId: "INBOX" }] }),
  "me/messages/A1/$value": () => mime("a1", "Site visit"),
  "me/messages/A2%3D/$value": () => mime("a2", "Re: Site visit", "18:35", "In-Reply-To: <a1@example.com>\r\n"),
};

describe("Outlook", () => {
  it("reads the last 90 days of mail as MIME on the first sync, skipping drafts and junk", async () => {
    const { api, calls } = fakeApi(routes);
    const found = await outlook.sync!(api, undefined, ctx);

    expect(found.threads!.map((t) => [t.externalId, t.kind, t.title, t.visibility, t.memberKeys])).toEqual([
      ["<a1@example.com>", "email", "Site visit", "members", ["email:jash@example.com", "email:sumedh@example.com"]],
    ]);
    expect(found.messages!.map((m) => [m.kind, m.subject, m.text, m.authorKey, m.replyToExternalId])).toEqual([
      ["email", "Site visit", "Details for Site visit.", "email:jash@example.com", undefined],
      ["email", "Re: Site visit", "Details for Re: Site visit.", "email:jash@example.com", "<a1@example.com>"],
    ]);
    expect(found.people!.map((p) => [p.displayName, p.email])).toEqual([
      ["Jash Doshi", "jash@example.com"],
      ["Sumedh Kudav", "sumedh@example.com"],
    ]);
    expect(found.cursor).toEqual({ since: "2026-11-01T13:05:00Z" });

    const list = calls.find((c) => c.path === "me/messages")!.query;
    expect(list).toMatchObject({ $filter: "receivedDateTime ge 2026-08-04T12:00:00Z", $orderby: "receivedDateTime desc" });
    expect(calls.find((c) => c.path === NEXT)!.query).toEqual({});
    expect(calls.filter((c) => c.as === "text").map((c) => c.path)).toEqual(["me/messages/A2%3D/$value", "me/messages/A1/$value", "me/messages/GONE/$value"]);
  });

  it("asks only for mail since the cursor, oldest first", async () => {
    const { api, calls } = fakeApi({ ...routes, "me/messages": () => ({ value: [] }) });
    const found = await outlook.sync!(api, { since: "2026-11-01T13:05:00Z" }, ctx);
    expect(calls.find((c) => c.path === "me/messages")!.query).toMatchObject({ $filter: "receivedDateTime ge 2026-11-01T13:00:00Z", $orderby: "receivedDateTime asc" });
    expect(found.messages).toEqual([]);
    expect(found.cursor).toEqual({ since: "2026-11-01T13:05:00Z" });
  });

  it("stops at 500 messages and resumes from the last one read", async () => {
    const page = (n: number) => ({
      value: Array.from({ length: 100 }, (_, i) => ({ id: `M${n * 100 + i}`, receivedDateTime: new Date(Date.parse("2026-11-01T00:00:00Z") + (n * 100 + i) * 60_000).toISOString().replace(".000Z", "Z") })),
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/messages?$skip=${(n + 1) * 100}`,
    });
    const { api, calls } = fakeApi({
      "me/mailFolders/*": () => ({ id: "X" }),
      "me/messages": () => page(0),
      "https://graph.microsoft.com/v1.0/me/messages?$skip=*": () => page(calls.filter((c) => c.path.includes("$skip=")).length),
      "me/messages/*": () => mime("same", "Same"),
    });
    const found = await outlook.sync!(api, { since: "2026-10-31T00:00:00Z" }, ctx);
    expect(calls.filter((c) => c.as === "text")).toHaveLength(500);
    expect(found.cursor).toEqual({ since: "2026-11-01T08:19:00Z" });
  });

  it("identifies the mailbox, and says so plainly when access is refused", async () => {
    const { api } = fakeApi(routes);
    expect(await outlook.identify(api, {})).toEqual({ accountId: "sumedh@example.com", label: "sumedh@example.com" });

    const refused = fakeApi({
      me: () => {
        throw new ProviderError("GET graph.microsoft.com/v1.0/me: 401 InvalidAuthenticationToken", 401);
      },
    });
    await expect(outlook.identify(refused.api, {})).rejects.toThrow("Microsoft didn't allow access to this mailbox.");
  });
});
