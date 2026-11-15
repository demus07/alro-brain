import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { fetchGitlab, gitlab, gitlabApiRoot } from "./gitlab";

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
const sumedh = { id: 1, username: "sumedhk", name: "Sumedh Kudav", state: "active" };
const jash = { id: 2, username: "jashd", name: "Jash Doshi", state: "active" };
const guest = { id: 3, username: "intern", name: "Asha Rao", state: "active" };

const issue = {
  id: 1001,
  iid: 12,
  title: "Fix login",
  description: "Login fails on Safari.",
  state: "opened",
  web_url: "https://gitlab.com/alro/brain/-/issues/12",
  author: sumedh,
  assignees: [jash],
  labels: ["bug", "auth"],
  milestone: { title: "v1", due_date: "2026-11-20" },
  due_date: "2026-11-10",
  confidential: false,
  user_notes_count: 2,
  created_at: "2026-10-20T09:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
};
const payroll = { ...issue, id: 1002, iid: 13, title: "Payroll export", description: null, assignees: [guest], labels: [], milestone: null, due_date: null, confidential: true, user_notes_count: 0 };
const mr = {
  id: 2001,
  iid: 7,
  title: "Safari cookie fix",
  description: "Closes #12",
  state: "merged",
  web_url: "https://gitlab.com/alro/brain/-/merge_requests/7",
  author: jash,
  assignees: [],
  reviewers: [sumedh],
  labels: [],
  milestone: null,
  user_notes_count: 0,
  source_branch: "fix-safari",
  target_branch: "main",
  created_at: "2026-10-30T09:00:00.000Z",
  updated_at: "2026-11-01T11:00:00.000Z",
};

const routes = {
  user: () => ({ id: 1, username: "sumedhk", name: "Sumedh Kudav" }),
  projects: () => [
    { id: 10, path: "brain", path_with_namespace: "alro/brain", visibility: "internal", issues_access_level: "enabled", merge_requests_access_level: "enabled" },
    { id: 11, path: "infra", path_with_namespace: "alro/infra", visibility: "private", issues_access_level: "enabled", merge_requests_access_level: "disabled" },
    { id: 12, path: "vault", path_with_namespace: "alro/vault", visibility: "private", issues_access_level: "enabled", merge_requests_access_level: "disabled" },
  ],
  "projects/10/issues": () => [issue, payroll],
  "projects/10/merge_requests": () => [mr],
  "projects/10/issues/12/notes": () => [
    { id: 501, body: "Reproduced on Safari 18", author: jash, created_at: "2026-10-31T08:00:00.000Z", updated_at: "2026-10-31T08:00:00.000Z", system: false },
    { id: 502, body: "changed the milestone to v1", author: sumedh, created_at: "2026-10-31T09:00:00.000Z", system: true },
    { id: 503, body: "Customer is threatening to churn", author: sumedh, created_at: "2026-10-31T09:30:00.000Z", system: false, internal: true },
    { id: 504, body: "Fixed in !7", author: sumedh, created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-01T10:05:00.000Z", system: false },
  ],
  "projects/10/members/all": () => [
    { ...sumedh, access_level: 50 },
    { ...jash, access_level: 30 },
    { ...guest, access_level: 10 },
  ],
  "projects/11/issues": () => [{ ...issue, id: 3001, iid: 3, title: "Rotate keys", web_url: "https://gitlab.com/alro/infra/-/issues/3", assignees: [], user_notes_count: 0 }],
  "projects/11/members/all": () => [
    { ...sumedh, access_level: 40 },
    { id: 4, username: "left", name: "Left Already", state: "blocked", access_level: 30 },
    { id: 5, username: "project_11_bot_ab12", name: "deploy token", state: "active", access_level: 30 },
  ],
  "projects/12/issues": () => [{ ...issue, id: 4001, title: "Hidden" }],
  "projects/12/members/all": () => {
    throw new ProviderError("GET gitlab.com/api/v4/projects/12/members/all: 403 Forbidden", 403);
  },
  "users/1": () => ({ ...sumedh, public_email: "Sumedh@example.com" }),
  "users/*": () => ({ public_email: "" }),
};

describe("GitLab", () => {
  it("maps issues, merge requests and comments into document threads, keeping private and confidential items to who can see them", async () => {
    const { api, calls } = fakeApi(routes);
    const { people, threads, messages, versions, cursor } = await fetchGitlab(api, {}, NOW);

    expect(threads).toEqual([
      { externalId: "issue:1001", kind: "doc", title: "brain#12 Fix login", url: "https://gitlab.com/alro/brain/-/issues/12", visibility: "org", memberKeys: [] },
      // Confidential: Planner and up (not the Guest role), plus the author and assignees.
      { externalId: "issue:1002", kind: "doc", title: "brain#13 Payroll export", url: "https://gitlab.com/alro/brain/-/issues/12", visibility: "members", memberKeys: ["gitlab:1", "gitlab:2", "gitlab:3"] },
      { externalId: "mr:2001", kind: "doc", title: "brain!7 Safari cookie fix", url: "https://gitlab.com/alro/brain/-/merge_requests/7", visibility: "org", memberKeys: [] },
      // Private project: its active members. alro/vault's members can't be listed, so it is left out.
      { externalId: "issue:3001", kind: "doc", title: "infra#3 Rotate keys", url: "https://gitlab.com/alro/infra/-/issues/3", visibility: "members", memberKeys: ["gitlab:1"] },
    ]);
    expect(messages!.map((m) => [m.threadExternalId, m.externalId, m.kind, m.authorKey])).toEqual([
      ["issue:1001", "issue:1001@2026-11-01T10:00:00.000Z", "note", "gitlab:1"],
      ["issue:1001", "501", "chat", "gitlab:2"],
      ["issue:1001", "504", "chat", "gitlab:1"],
      ["issue:1002", "issue:1002@2026-11-01T10:00:00.000Z", "note", "gitlab:1"],
      ["mr:2001", "mr:2001@2026-11-01T11:00:00.000Z", "note", "gitlab:2"],
      ["issue:3001", "issue:3001@2026-11-01T10:00:00.000Z", "note", "gitlab:1"],
    ]);
    expect(messages![0].text).toBe(
      "brain#12 Fix login\nProject: alro/brain\nType: Issue\nStatus: opened\nAssignee: Jash Doshi\nLabels: bug, auth\nMilestone: v1\nDue: 2026-11-10\nCreated: 2026-10-20\n\nLogin fails on Safari.",
    );
    expect(messages![2]).toMatchObject({ text: "Fixed in !7", sentAt: new Date("2026-11-01T10:00:00.000Z"), editedAt: new Date("2026-11-01T10:05:00.000Z"), url: "https://gitlab.com/alro/brain/-/issues/12#note_504" });
    expect(messages![4].text).toBe(
      "brain!7 Safari cookie fix\nProject: alro/brain\nType: Merge request\nStatus: merged\nReviewers: Sumedh Kudav\nBranch: fix-safari → main\nCreated: 2026-10-30\n\nCloses #12",
    );
    expect(versions!.get("mr:2001")).toBe("mr:2001@2026-11-01T11:00:00.000Z");
    expect(people!.map((p) => [p.key, p.displayName, p.email])).toEqual([
      ["gitlab:2", "Jash Doshi", undefined],
      ["gitlab:1", "Sumedh Kudav", "sumedh@example.com"],
      ["gitlab:3", "Asha Rao", undefined],
    ]);

    expect(calls.find((c) => c.path === "projects")!.query).toMatchObject({ membership: "true", archived: "false" });
    expect(calls.find((c) => c.path === "projects/10/issues")!.query).toMatchObject({ updated_after: "2026-08-04T12:00:00.000Z", order_by: "updated_at", sort: "asc" });
    expect(calls.some((c) => c.path === "projects/11/merge_requests")).toBe(false);
    // Each listing resumes just after its last item; the skipped project keeps no cursor and is tried again.
    expect(cursor).toEqual({ since: { "10/issues": "2026-11-01T10:00:00.001Z", "10/merge_requests": "2026-11-01T11:00:00.001Z", "11/issues": "2026-11-01T10:00:00.001Z" } });
  });

  it("asks each project only for what changed since its cursor", async () => {
    const { api, calls } = fakeApi({ ...routes, "projects/10/issues": () => [], "projects/10/merge_requests": () => [{ ...mr, updated_at: "2026-11-02T12:14:30.000Z" }] });
    const before = { "10/issues": "2026-11-01T10:00:00.001Z", "10/merge_requests": "2026-11-01T11:00:00.001Z" };
    const { cursor } = await fetchGitlab(api, { since: before }, new Date("2026-11-02T12:15:00Z"));
    expect(calls.find((c) => c.path === "projects/10/issues")!.query.updated_after).toBe("2026-11-01T10:00:00.001Z");
    expect(calls.find((c) => c.path === "projects/10/merge_requests")!.query.updated_after).toBe("2026-11-01T11:00:00.001Z");
    // Nothing new keeps the cursor; something changed seconds ago is re-read next time (2 minute overlap).
    expect(cursor.since).toMatchObject({ "10/issues": "2026-11-01T10:00:00.001Z", "10/merge_requests": "2026-11-02T12:13:00.000Z" });
  });

  it("stops at 500 items and continues that listing from the last one read", async () => {
    const at = (i: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000).toISOString();
    const many = Array.from({ length: 600 }, (_, i) => ({ ...issue, id: 5000 + i, iid: i + 1, user_notes_count: 0, updated_at: at(i) }));
    const { api, calls } = fakeApi({ ...routes, "projects/10/issues": (q) => many.slice((Number(q.page) - 1) * 100, Number(q.page) * 100) });
    const { threads, cursor } = await fetchGitlab(api, {}, NOW);
    expect(threads).toHaveLength(500);
    expect(cursor).toEqual({ since: { "10/issues": "2026-10-01T08:18:59.999Z" } });
    expect(calls.some((c) => c.path === "projects/10/merge_requests" || c.path === "projects/11/issues")).toBe(false);
  });

  it("names the account and its GitLab host, and says so plainly when the token is refused", async () => {
    const { api } = fakeApi(routes);
    expect(await gitlab.identify(api, { token: "t" })).toEqual({ accountId: "gitlab:gitlab.com:1", label: "Sumedh Kudav (gitlab.com)" });
    expect(await gitlab.identify(api, { token: "t", url: "git.alro.ai/" })).toEqual({ accountId: "gitlab:git.alro.ai:1", label: "Sumedh Kudav (git.alro.ai)" });

    const refused: Api = async () => {
      throw new ProviderError("GET gitlab.com/api/v4/user: 401 Unauthorized", 401);
    };
    await expect(gitlab.identify(refused, {})).rejects.toThrow("gitlab.com didn't accept that token");
  });

  it("builds the API root from a self-hosted URL, and refuses anything but a public https host", () => {
    expect(gitlabApiRoot()).toBe("https://gitlab.com/api/v4/");
    expect(gitlabApiRoot("https://git.alro.ai/gitlab/")).toBe("https://git.alro.ai/gitlab/api/v4/");
    expect(() => gitlabApiRoot("http://git.alro.ai")).toThrow("https://");
    expect(() => gitlabApiRoot("https://localhost")).toThrow("public hostname");
    expect(() => gitlabApiRoot("https://10.0.0.5")).toThrow("public hostname");
    expect(() => gitlabApiRoot("https://[::1]")).toThrow("public hostname");
  });
});
