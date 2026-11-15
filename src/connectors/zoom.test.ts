import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { encodeUuid, mintZoomToken, zoom, zoomApi } from "./zoom";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, opts: Parameters<Api>[2]) => unknown>) {
  const calls: { path: string; query: Record<string, unknown>; headers?: Record<string, string> }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query, headers: opts.headers });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const ctx = { credentials: { accountId: "acc1", clientId: "c", clientSecret: "s" }, accountId: "zoom:acc1", now: NOW };
const DOWNLOAD = "https://us06web.zoom.us/rec/download/abc";

const VTT = `WEBVTT

1
00:00:01.500 --> 00:00:03.000
Sumedh Kudav: Let's settle pricing.

2
00:00:03.000 --> 00:00:06.000
Sumedh Kudav: I'd go with 55k per site.

3
00:01:05.200 --> 00:01:06.000
Jash Doshi: Works for me.

4
00:01:12.000 --> 00:01:14.000
Guest Caller: Send me the deck.
`;

const users = [
  { id: "U1", email: "Sumedh@example.com", display_name: "Sumedh Kudav" },
  { id: "U2", email: "jash@example.com", first_name: "Jash", last_name: "Doshi" },
];
const meeting = {
  uuid: "/abc//==",
  id: 81234,
  topic: "Pricing review",
  start_time: "2026-11-01T10:00:00Z",
  duration: 32,
  share_url: "https://us06web.zoom.us/rec/share/xyz",
  recording_files: [
    { id: "F1", file_type: "MP4", download_url: "https://us06web.zoom.us/rec/download/mp4", status: "completed" },
    { id: "F2", file_type: "TRANSCRIPT", file_extension: "VTT", download_url: DOWNLOAD, recording_start: "2026-11-01T10:00:00Z", status: "completed" },
  ],
};
const noTranscript = { uuid: "NT", topic: "No transcript", start_time: "2026-11-01T09:00:00Z", recording_files: [{ id: "F3", file_type: "MP4", download_url: "https://zoom.us/rec/download/x" }] };

/** Recordings by user, filtered by the from/to dates the way Zoom does. */
const routes = (byUser: Record<string, { start_time: string }[]>) => ({
  ...Object.fromEntries(
    Object.entries(byUser).map(([id, meetings]) => [
      `users/${id}/recordings`,
      (q: Record<string, unknown>) => ({ meetings: meetings.filter((m) => m.start_time.slice(0, 10) >= String(q.from) && m.start_time.slice(0, 10) <= String(q.to)) }),
    ]),
  ),
  users: () => ({ users, next_page_token: "" }),
  "users/me": () => ({ id: "U1", email: "Sumedh@example.com", account_id: "acc1", company: "Alro" }),
  "past_meetings/*": () => ({ participants: [{ id: "U2", name: "Jash Doshi", user_email: "jash@example.com" }, { name: "Dial-in", user_email: "" }] }),
  [DOWNLOAD]: () => VTT,
});

describe("Zoom", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns each recorded meeting's transcript into a meeting thread, visible to its host and participants", async () => {
    const { api, calls } = fakeApi(routes({ U1: [meeting, noTranscript], U2: [] }));
    const found = await zoom.sync!(api, undefined, ctx);

    expect(found.threads).toEqual([
      {
        externalId: "/abc//==",
        kind: "meeting",
        title: "Pricing review",
        url: "https://us06web.zoom.us/rec/share/xyz",
        visibility: "members",
        memberKeys: ["email:sumedh@example.com", "email:jash@example.com", "name:guest caller"],
        metadata: { startedAt: "2026-11-01T10:00:00.000Z", durationMinutes: 32, meetingId: 81234, participants: ["sumedh@example.com", "jash@example.com"], organizer: "sumedh@example.com" },
      },
    ]);
    expect(found.messages!.map((m) => [m.kind, m.authorKey, m.text, m.sentAt.toISOString()])).toEqual([
      ["transcript", "email:sumedh@example.com", "Let's settle pricing. I'd go with 55k per site.", "2026-11-01T10:00:01.500Z"],
      ["transcript", "email:jash@example.com", "Works for me.", "2026-11-01T10:01:05.200Z"],
      ["transcript", "name:guest caller", "Send me the deck.", "2026-11-01T10:01:12.000Z"],
    ]);
    expect(found.people!.map((p) => [p.key, p.displayName])).toEqual([
      ["email:sumedh@example.com", "Sumedh Kudav"],
      ["email:jash@example.com", "Jash Doshi"],
      ["name:guest caller", "Guest Caller"],
    ]);
    expect(found.cursor).toEqual({ since: "2026-11-01T10:00:00.000Z", seen: { "/abc//==": "2026-11-01T10:00:00.000Z" } });

    // 90 days back, in windows Zoom accepts (at most a month each), for every user.
    const windows = calls.filter((c) => c.path === "users/U1/recordings").map((c) => [c.query.from, c.query.to]);
    expect(windows).toEqual([
      ["2026-08-04", "2026-08-31"],
      ["2026-09-01", "2026-09-28"],
      ["2026-09-29", "2026-10-26"],
      ["2026-10-27", "2026-11-02"],
    ]);
    expect(calls.some((c) => c.path === "users/U2/recordings")).toBe(true);
    // The UUID starts with "/", so it's double-encoded; the MP4 is never downloaded.
    expect(calls.some((c) => c.path === "past_meetings/%252Fabc%252F%252F%253D%253D/participants")).toBe(true);
    expect(calls.filter((c) => c.path.startsWith("https://")).map((c) => c.path)).toEqual([DOWNLOAD]);
  });

  it("asks only for meetings since the cursor and doesn't download ones already read", async () => {
    const later = { ...meeting, uuid: "M2", topic: "Hiring", start_time: "2026-11-02T08:00:00Z" };
    const { api, calls } = fakeApi(routes({ U1: [meeting, later], U2: [] }));
    const found = await zoom.sync!(api, { since: "2026-11-01T10:00:00.000Z", seen: { "/abc//==": "2026-11-01T10:00:00.000Z", OLD: "2026-10-01T00:00:00.000Z" } }, ctx);

    expect(calls.filter((c) => c.path === "users/U1/recordings").map((c) => [c.query.from, c.query.to])).toEqual([["2026-10-30", "2026-11-02"]]);
    expect(found.threads!.map((t) => t.externalId)).toEqual(["M2"]);
    expect(calls.filter((c) => c.path.startsWith("https://"))).toHaveLength(1);
    expect(found.cursor).toEqual({ since: "2026-11-02T08:00:00.000Z", seen: { "/abc//==": "2026-11-01T10:00:00.000Z", M2: "2026-11-02T08:00:00.000Z" } });
  });

  it("shows a meeting to its host only when Zoom won't list participants", async () => {
    const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nSumedh Kudav: Just me today.\n";
    const { api } = fakeApi({
      ...routes({ U1: [meeting], U2: [] }),
      "past_meetings/*": () => Promise.reject(new ProviderError('400 {"code":4711,"message":"does not contain scopes"}', 400)),
      [DOWNLOAD]: () => vtt,
    });
    const found = await zoom.sync!(api, undefined, ctx);
    expect(found.threads![0]).toMatchObject({ visibility: "members", memberKeys: ["email:sumedh@example.com"] });
  });

  it("falls back to the meeting's download token when the account token is refused", async () => {
    const { api, calls } = fakeApi({
      ...routes({ U1: [meeting], U2: [] }),
      [DOWNLOAD]: (_q, o) => (o?.headers?.authorization === "Bearer dl-token" ? VTT : "<html>Sign in</html>"),
      "meetings/*": () => ({ download_access_token: "dl-token", recording_files: [{ id: "F2", download_url: DOWNLOAD }] }),
    });
    const found = await zoom.sync!(api, undefined, ctx);
    expect(found.messages).toHaveLength(3);
    expect(calls.find((c) => c.path.startsWith("meetings/"))).toMatchObject({ path: "meetings/%252Fabc%252F%252F%253D%253D/recordings", query: { include_fields: "download_access_token" } });
  });

  it("stops at the per-sync cap and resumes from the last meeting read", async () => {
    const many = Array.from({ length: 105 }, (_, i) => ({ ...meeting, uuid: `M${i}`, start_time: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 3_600_000).toISOString() }));
    const { api } = fakeApi(routes({ U1: many, U2: [] }));
    const found = await zoom.sync!(api, undefined, ctx);
    expect(found.threads).toHaveLength(100);
    expect((found.cursor as { since: string }).since).toBe(many[99].start_time);

    const next = await zoom.sync!(fakeApi(routes({ U1: many, U2: [] })).api, found.cursor, ctx);
    expect(next.threads!.map((t) => t.externalId)).toEqual(["M100", "M101", "M102", "M103", "M104"]);
  });

  it("identifies the account, and says so plainly when the keys are refused", async () => {
    const { api } = fakeApi(routes({}));
    expect(await zoom.identify(api, ctx.credentials)).toEqual({ accountId: "zoom:acc1", label: "Alro" });

    const refused = fakeApi({ "users/me": () => Promise.reject(new ProviderError("zoom.us refused the credentials: invalid_client", 401)) });
    await expect(zoom.identify(refused.api, ctx.credentials)).rejects.toThrow("Zoom didn't accept those app credentials");

    const scopes = fakeApi({ "users/me": () => Promise.reject(new ProviderError('GET api.zoom.us/v2/users/me: 400 {"code":4711,"message":"Invalid access token, does not contain scopes:[user:read:user:admin]."}', 400)) });
    await expect(zoom.identify(scopes.api, ctx.credentials)).rejects.toThrow("The Zoom app is missing these scopes: user:read:user:admin.");
  });

  it("zoom_meetings lists a person's upcoming meetings, trimmed", async () => {
    const { api, calls } = fakeApi({
      "users/*": () => ({
        meetings: [
          { id: 2, topic: "Board", type: 2, start_time: "2026-11-05T10:00:00Z", duration: 60, timezone: "Asia/Kolkata", join_url: "https://zoom.us/j/2?pwd=x", uuid: "u2" },
          { id: 1, topic: "Standup", type: 8, start_time: "2026-11-03T04:00:00Z", duration: 15, timezone: "Asia/Kolkata", agenda: "" },
          { id: 3, topic: "No fixed time", type: 3 },
        ],
      }),
    });
    const tools = zoom.tools!(api, { accountId: "zoom:acc1", credentials: {} });
    const run = (input: unknown) => (tools.zoom_meetings.execute as (input: unknown, options: unknown) => Promise<unknown>)(input, {});
    const out = await run({ email: "Jash@Example.com", when: null });
    expect(calls[0]).toMatchObject({ path: "users/jash%40example.com/meetings", query: { type: "upcoming_meetings" } });
    expect(out).toEqual({
      email: "Jash@Example.com",
      when: "upcoming",
      meetings: [
        { id: 1, topic: "Standup", startsAt: "2026-11-03T04:00:00Z", durationMinutes: 15, timezone: "Asia/Kolkata", agenda: undefined },
        { id: 2, topic: "Board", startsAt: "2026-11-05T10:00:00Z", durationMinutes: 60, timezone: "Asia/Kolkata", agenda: undefined },
      ],
    });

    await run({ email: "jash@example.com", when: "recent" });
    expect(calls[1].query.type).toBe("previous_meetings");
  });

  it("mints a token with the app's keys, and sends it only to Zoom hosts", async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      if (u === "https://zoom.us/oauth/token") return new Response(JSON.stringify({ access_token: "tok", expires_in: 3599 }), { status: 200 });
      return new Response(u.includes("/rec/download/") ? "WEBVTT\n" : JSON.stringify({ ok: true, auth: (init?.headers as Record<string, string>).authorization }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await mintZoomToken({ accountId: " acc1 ", clientId: "cid", clientSecret: "sec" })).toEqual({ accessToken: "tok", expiresIn: 3599 });
    const [, init] = fetchMock.mock.calls[0];
    expect((init!.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(String(init!.body)).toBe("grant_type=account_credentials&account_id=acc1");

    const api = zoomApi({ accountId: "acc1", clientId: "cid", clientSecret: "sec" });
    expect(await api("GET", "users/me")).toEqual({ ok: true, auth: "Bearer tok" });
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe("https://api.zoom.us/v2/users/me");
    expect(await api("GET", "https://acme.zoom.us/rec/download/abc", { as: "text" })).toBe("WEBVTT\n");
    await expect(api("GET", "https://evil.example.com/rec/download/abc")).rejects.toThrow("Refusing to call evil.example.com");
    await expect(api("GET", "https://zoom.us.evil.com/x")).rejects.toThrow("Refusing to call");
    // One token for the direct mint above, and one reused for every call through the api.
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === "https://zoom.us/oauth/token")).toHaveLength(2);
  });

  it("double-encodes only the UUIDs Zoom asks for", () => {
    expect(encodeUuid("abc+def==")).toBe("abc%2Bdef%3D%3D");
    expect(encodeUuid("/abc")).toBe("%252Fabc");
  });
});
