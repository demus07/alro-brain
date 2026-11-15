import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { clickup, fetchClickup } from "./clickup";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown> }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const ms = (iso: string) => String(Date.parse(iso));

const sumedh = { id: 11, username: "Sumedh Kudav", email: "Sumedh@Example.com" };
const jash = { id: 12, username: "Jash Doshi", email: "jash@example.com" };

const task = (id: string, name: string, updated: string, extra: Record<string, unknown> = {}) => ({
  id,
  custom_id: null,
  name,
  text_content: "Users can't log in when SSO is on.",
  status: { status: "in progress" },
  date_created: ms("2026-10-30T09:00:00Z"),
  date_updated: ms(updated),
  due_date: ms("2026-11-20T00:00:00Z"),
  creator: { id: 11, username: "Sumedh Kudav" },
  assignees: [jash],
  tags: [{ name: "auth" }, { name: "customer" }],
  priority: { priority: "urgent" },
  list: { id: "l1", name: "Sprint 12", access: true },
  folder: { id: "f1", name: "Mobile", hidden: false, access: true },
  space: { id: "s1" },
  url: `https://app.clickup.com/t/${id}`,
  ...extra,
});

const routes = {
  "team/900/space": () => ({
    spaces: [
      { id: "s1", name: "Product", private: false },
      { id: "s2", name: "Founders", private: true, members: [{ user: { id: 11, username: "Sumedh Kudav" } }] },
      { id: "s3", name: "Locked", private: true, members: [] },
    ],
  }),
  "team/900/task": () => ({
    tasks: [
      task("86a1", "Fix login", "2026-11-01T10:00:00Z", { custom_id: "ENG-123" }),
      task("86a2", "Fundraise plan", "2026-11-01T11:00:00Z", { space: { id: "s2" }, folder: { id: "f0", name: "hidden", hidden: true }, list: { id: "l2", name: "Board" }, assignees: [], tags: [], priority: null, due_date: null }),
      task("86a3", "Unreadable", "2026-11-01T12:00:00Z", { space: { id: "s3" } }),
    ],
    last_page: true,
  }),
  "task/86a1/comment": () => ({
    comments: [
      { id: "502", comment_text: "Fix is on staging.", user: jash, date: ms("2026-10-31T09:00:00Z"), reply_count: 1 },
      { id: "501", comment_text: "Reproduced it.", user: sumedh, date: ms("2026-10-31T08:00:00Z"), reply_count: 0 },
    ],
  }),
  "task/86a2/comment": () => ({ comments: [] }),
  "comment/502/reply": () => ({ comments: [{ id: "503", comment_text: "Verified, shipping.", user: sumedh, date: ms("2026-10-31T10:00:00Z") }] }),
};

describe("ClickUp", () => {
  it("maps tasks, comments and replies on the first sync; private spaces go to their members only", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await fetchClickup(api, "900", undefined, NOW, 0);

    expect(r.threads).toEqual([
      { externalId: "86a1", kind: "doc", title: "ENG-123 Fix login", url: "https://app.clickup.com/t/86a1", visibility: "org", memberKeys: [] },
      { externalId: "86a2", kind: "doc", title: "Fundraise plan", url: "https://app.clickup.com/t/86a2", visibility: "members", memberKeys: ["clickup:11"] },
    ]);
    const mine = r.messages!.filter((m) => m.threadExternalId === "86a1");
    expect(mine[0]).toMatchObject({ externalId: `86a1@${ms("2026-11-01T10:00:00Z")}`, kind: "note", authorKey: "clickup:11", subject: "ENG-123 Fix login" });
    expect(mine[0].sentAt.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect(mine[0].text).toBe(
      "ENG-123 Fix login\nStatus: in progress\nAssignee: Jash Doshi\nPriority: urgent\nTags: auth, customer\nDue: 2026-11-20\nList: Product / Mobile / Sprint 12\nCreated: 2026-10-30\n\nUsers can't log in when SSO is on.",
    );
    expect(mine.slice(1).map((m) => [m.externalId, m.kind, m.authorKey, m.text, m.replyToExternalId])).toEqual([
      ["501", "chat", "clickup:11", "Reproduced it.", undefined],
      ["502", "chat", "clickup:12", "Fix is on staging.", undefined],
      ["503", "chat", "clickup:11", "Verified, shipping.", "502"],
    ]);
    expect(mine[1].url).toBe("https://app.clickup.com/t/86a1?comment=501");
    expect(r.messages!.find((m) => m.threadExternalId === "86a2")!.text).toBe("Fundraise plan\nStatus: in progress\nList: Founders / Board\nCreated: 2026-10-30\n\nUsers can't log in when SSO is on.");
    expect(r.versions).toEqual(new Map([["86a1", `86a1@${ms("2026-11-01T10:00:00Z")}`], ["86a2", `86a2@${ms("2026-11-01T11:00:00Z")}`]]));
    expect(r.people).toEqual([
      { key: "clickup:12", provider: "clickup", externalId: "12", displayName: "Jash Doshi", email: "jash@example.com" },
      { key: "clickup:11", provider: "clickup", externalId: "11", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
    ]);

    expect(calls.find((c) => c.path === "team/900/task")!.query).toEqual({ page: 0, order_by: "updated", reverse: "true", subtasks: "true", include_closed: "true", date_updated_gt: Date.parse("2026-08-04T12:00:00Z") });
    expect(calls.some((c) => c.path === "task/86a3/comment")).toBe(false);
    expect(r.cursor).toEqual({ since: Date.parse("2026-11-01T12:00:00Z") });
  });

  it("asks only for tasks updated since the cursor, with a ten-minute overlap", async () => {
    const { api, calls } = fakeApi({ ...routes, "team/900/task": () => ({ tasks: [], last_page: true }) });
    const since = Date.parse("2026-11-01T12:00:00Z");
    const r = await fetchClickup(api, "900", { since }, NOW, 0);
    expect(calls.find((c) => c.path === "team/900/task")!.query.date_updated_gt).toBe(Date.parse("2026-11-01T11:50:00Z"));
    expect(r.cursor).toEqual({ since });
  });

  it("stops at the cap and carries on from the newest task read", async () => {
    const batch = (n: number) => Array.from({ length: 100 }, (_, i) => task(`t${n * 100 + i}`, `Task ${n * 100 + i}`, new Date(Date.parse("2026-10-01T00:00:00Z") + (n * 100 + i) * 60_000).toISOString()));
    const { api, calls } = fakeApi({ ...routes, "team/900/task": (q) => ({ tasks: batch(Number(q.page)), last_page: false }), "task/*": () => ({ comments: [] }) });
    const first = await fetchClickup(api, "900", undefined, NOW, 0);
    expect(calls.filter((c) => c.path === "team/900/task").map((c) => c.query.page)).toEqual([0, 1]);
    expect(first.threads).toHaveLength(200);
    const newest = Date.parse("2026-10-01T00:00:00Z") + 199 * 60_000;
    expect(first.cursor).toEqual({ since: newest, more: true });

    const next = fakeApi({ ...routes, "team/900/task": () => ({ tasks: [], last_page: true }) });
    await fetchClickup(next.api, "900", first.cursor, NOW, 0);
    expect(next.calls.find((c) => c.path === "team/900/task")!.query.date_updated_gt).toBe(newest - 1);
  });

  it("asks the other way round when ClickUp lists the newest change first", async () => {
    const { api, calls } = fakeApi({
      ...routes,
      "team/900/task": (q) => {
        const tasks = [task("86a1", "Fix login", "2026-11-01T10:00:00Z"), task("86a4", "Ship v2", "2026-11-01T11:00:00Z")];
        return { tasks: q.reverse === "true" ? tasks.reverse() : tasks, last_page: true };
      },
      "task/*": () => ({ comments: [] }),
    });
    const r = await fetchClickup(api, "900", undefined, NOW, 0);
    expect(calls.filter((c) => c.path === "team/900/task").map((c) => c.query.reverse)).toEqual(["true", "false"]);
    expect(r.threads!.map((t) => t.externalId)).toEqual(["86a1", "86a4"]);
  });

  it("identifies the workspace; asks which one when the token sees several", async () => {
    const one = fakeApi({ team: () => ({ teams: [{ id: "900", name: "ALRO" }] }) });
    expect(await clickup.identify(one.api, { token: "pk_1" })).toEqual({ accountId: "clickup:900", label: "ALRO" });
    expect(one.calls.map((c) => c.path)).toEqual(["team"]);

    const two = fakeApi({ team: () => ({ teams: [{ id: "900", name: "ALRO" }, { id: "901", name: "Side project" }] }) });
    await expect(clickup.identify(two.api, { token: "pk_1" })).rejects.toThrow("several workspaces: ALRO (900), Side project (901)");
    expect(await clickup.identify(two.api, { token: "pk_1", workspace: " 901 " })).toEqual({ accountId: "clickup:901", label: "Side project" });

    const refused: Api = async () => {
      throw new ProviderError("401", 401);
    };
    await expect(clickup.identify(refused, { token: "bad" })).rejects.toThrow("ClickUp didn't accept that token.");
  });
});
