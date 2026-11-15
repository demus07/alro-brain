import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { asana, fetchAsana } from "./asana";

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
const sumedh = { gid: "101", name: "Sumedh Kudav" };
const jash = { gid: "102", name: "Jash Doshi" };

const task = (over: Record<string, unknown>) => ({
  gid: "9001",
  name: "Fix login",
  notes: "Login fails on Safari.",
  completed: false,
  completed_at: null,
  assignee: jash,
  due_on: "2026-11-10",
  due_at: null,
  created_at: "2026-10-20T09:00:00.000Z",
  modified_at: "2026-11-01T10:00:00.000Z",
  created_by: { gid: "101" },
  permalink_url: "https://app.asana.com/0/501/9001",
  projects: [{ gid: "501" }],
  memberships: [{ project: { gid: "501", name: "Website" }, section: { name: "In progress" } }],
  tags: [{ name: "bug" }],
  ...over,
});

const routes = {
  "users/me": () => ({ data: { gid: "101", name: "Sumedh Kudav", workspaces: [{ gid: "77", name: "ALRO" }] } }),
  users: () => ({ data: [{ ...sumedh, email: "Sumedh@example.com" }, { ...jash, email: "jash@example.com" }], next_page: null }),
  projects: () => ({
    data: [
      { gid: "501", name: "Website", privacy_setting: "public_to_workspace" },
      { gid: "502", name: "Hiring", privacy_setting: "private" },
      { gid: "503", name: "Board", privacy_setting: "private" },
    ],
    next_page: null,
  }),
  "projects/502": () => ({ data: { members: [sumedh] } }),
  "projects/503": () => {
    throw new ProviderError("GET app.asana.com/api/1.0/projects/503: 403 Forbidden", 403);
  },
  tasks: (q: Record<string, unknown>) => ({
    data:
      q.project === "501"
        ? [task({}), task({ gid: "9002", name: "", notes: "" })]
        : q.project === "502"
          ? [task({ gid: "9003", name: "Offer for Priya", notes: "", assignee: null, due_on: null, completed: true, completed_at: "2026-11-01T09:00:00.000Z", permalink_url: "https://app.asana.com/0/502/9003", projects: [{ gid: "502" }], memberships: [{ project: { gid: "502", name: "Hiring" }, section: { name: "Untitled section" } }], tags: [] })]
          : [task({ gid: "9004", name: "Hidden", projects: [{ gid: "503" }] })],
    next_page: null,
  }),
  "tasks/9001/stories": () => ({
    data: [
      { gid: "s1", resource_subtype: "comment_added", text: "Reproduced on Safari 18", created_at: "2026-10-31T08:00:00.000Z", created_by: jash },
      { gid: "s2", resource_subtype: "assigned", text: "Sumedh assigned to Jash", created_at: "2026-10-31T08:30:00.000Z", created_by: sumedh },
      { gid: "s3", resource_subtype: "comment_added", text: "Fix is live", created_at: "2026-11-01T10:00:00.000Z", created_by: sumedh },
    ],
    next_page: null,
  }),
  "tasks/*": () => ({ data: [], next_page: null }),
};

describe("Asana", () => {
  it("maps tasks and comments into document threads, keeping private projects to their members", async () => {
    const { api, calls } = fakeApi(routes);
    const { people, threads, messages, versions, cursor } = await fetchAsana(api, "77", {}, NOW);

    expect(threads).toEqual([
      { externalId: "9001", kind: "doc", title: "Fix login", url: "https://app.asana.com/0/501/9001", visibility: "org", memberKeys: [] },
      // Project 503 is private and its members can't be read, so its task is left out; so is the nameless one.
      { externalId: "9003", kind: "doc", title: "Offer for Priya", url: "https://app.asana.com/0/502/9003", visibility: "members", memberKeys: ["asana:101"] },
    ]);
    expect(messages!.map((m) => [m.threadExternalId, m.externalId, m.kind, m.authorKey])).toEqual([
      ["9001", "9001@2026-11-01T10:00:00.000Z", "note", "asana:101"],
      ["9001", "s1", "chat", "asana:102"],
      ["9001", "s3", "chat", "asana:101"],
      ["9003", "9003@2026-11-01T10:00:00.000Z", "note", "asana:101"],
    ]);
    expect(messages![0].text).toBe("Fix login\nStatus: Open\nAssignee: Jash Doshi\nDue: 2026-11-10\nProject: Website › In progress\nTags: bug\nCreated: 2026-10-20\n\nLogin fails on Safari.");
    expect(messages![2]).toMatchObject({ text: "Fix is live", sentAt: new Date("2026-11-01T10:00:00.000Z"), url: "https://app.asana.com/0/501/9001" });
    expect(messages![3].text).toBe("Offer for Priya\nStatus: Completed 2026-11-01\nProject: Hiring\nCreated: 2026-10-20");
    expect(versions!.get("9001")).toBe("9001@2026-11-01T10:00:00.000Z");
    expect(people).toEqual([
      { key: "asana:102", provider: "asana", externalId: "102", displayName: "Jash Doshi", email: "jash@example.com" },
      { key: "asana:101", provider: "asana", externalId: "101", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
    ]);

    expect(calls.find((c) => c.path === "projects")!.query).toMatchObject({ workspace: "77", archived: "false" });
    expect(calls.find((c) => c.path === "tasks")!.query).toMatchObject({ project: "501", modified_since: "2026-08-04T12:00:00.000Z", limit: 100 });
    expect(calls.find((c) => c.path === "tasks/9001/stories")!.query).toMatchObject({ resource_subtype: "comment_added" });
    expect(cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("asks only for tasks modified since the cursor", async () => {
    const { api, calls } = fakeApi(routes);
    await fetchAsana(api, "77", { since: "2026-11-02T11:50:00.000Z" }, new Date("2026-11-02T12:15:00Z"));
    expect(calls.filter((c) => c.path === "tasks").map((c) => c.query.modified_since)).toEqual(Array(3).fill("2026-11-02T11:50:00.000Z"));
  });

  it("stops at the cap and continues the same pass from that project and page", async () => {
    const page = (start: number) => Array.from({ length: 100 }, (_, i) => task({ gid: String(20_000 + start + i) }));
    const tasks = (q: Record<string, unknown>) => {
      if (q.project !== "501") return { data: [], next_page: null };
      const n = q.offset ? Number(q.offset) : 0;
      return { data: page(n), next_page: n < 400 ? { offset: String(n + 100) } : null };
    };
    const first = fakeApi({ ...routes, tasks });
    const a = await fetchAsana(first.api, "77", {}, NOW);
    expect(a.threads).toHaveLength(300);
    expect(a.cursor).toEqual({ since: "2026-08-04T12:00:00.000Z", started: NOW.toISOString(), project: "501", offset: "300" });

    const second = fakeApi({ ...routes, tasks });
    const b = await fetchAsana(second.api, "77", a.cursor, new Date("2026-11-02T12:15:00Z"));
    expect(second.calls.filter((c) => c.path === "tasks").map((c) => [c.query.project, c.query.offset, c.query.modified_since])).toEqual([
      ["501", "300", "2026-08-04T12:00:00.000Z"],
      ["501", "400", "2026-08-04T12:00:00.000Z"],
      ["502", undefined, "2026-08-04T12:00:00.000Z"],
      ["503", undefined, "2026-08-04T12:00:00.000Z"],
    ]);
    expect(b.threads).toHaveLength(200);
    // The next pass starts from when this one began, less the overlap.
    expect(b.cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("restarts a project when Asana has expired the saved page", async () => {
    const { api, calls } = fakeApi({
      ...routes,
      tasks: (q) => {
        if (q.offset) throw new ProviderError("GET app.asana.com/api/1.0/tasks: 400 offset: Your pagination token has expired.", 400);
        return { data: q.project === "502" ? [task({ gid: "9003", projects: [{ gid: "502" }] })] : [], next_page: null };
      },
    });
    const { threads, cursor } = await fetchAsana(api, "77", { since: "2026-08-04T12:00:00.000Z", started: "2026-11-02T12:00:00.000Z", project: "502", offset: "stale" }, new Date("2026-11-02T12:15:00Z"));
    expect(calls.filter((c) => c.path === "tasks").map((c) => [c.query.project, c.query.offset])).toEqual([["502", "stale"], ["502", undefined], ["503", undefined]]);
    expect(threads!.map((t) => t.externalId)).toEqual(["9003"]);
    expect(cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("names the workspace, asks which one when there are several, and says so plainly when the token is refused", async () => {
    const { api } = fakeApi(routes);
    expect(await asana.identify(api, { token: "t" })).toEqual({ accountId: "asana:77", label: "ALRO" });

    const two = fakeApi({ "users/me": () => ({ data: { gid: "101", workspaces: [{ gid: "77", name: "ALRO" }, { gid: "78", name: "Personal" }] } }) });
    await expect(asana.identify(two.api, { token: "t" })).rejects.toThrow("more than one Asana workspace (ALRO, Personal)");
    expect(await asana.identify(two.api, { token: "t", workspace: " alro " })).toEqual({ accountId: "asana:77", label: "ALRO" });
    await expect(asana.identify(two.api, { token: "t", workspace: "Acme" })).rejects.toThrow('can\'t see a workspace called "Acme"');

    const refused: Api = async () => {
      throw new ProviderError("GET app.asana.com/api/1.0/users/me: 401 Not Authorized", 401);
    };
    await expect(asana.identify(refused, {})).rejects.toThrow("Asana didn't accept that token");
  });
});
