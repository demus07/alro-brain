import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { clockSeconds, fathom } from "./fathom";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown>; body?: unknown }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query, body: opts.body });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const ctx = { credentials: { apiKey: "k", email: "sumedh@example.com" }, accountId: "sumedh@example.com", now: NOW };

const meeting = {
  recording_id: 123,
  title: "Pricing review",
  meeting_title: "Acme / ALRO",
  url: "https://fathom.video/calls/123",
  share_url: "https://fathom.video/share/abc",
  created_at: "2026-11-01T10:40:00Z",
  scheduled_start_time: "2026-11-01T10:00:00Z",
  recording_start_time: "2026-11-01T10:01:00Z",
  recording_end_time: "2026-11-01T10:33:00Z",
  calendar_invitees_domains_type: "one_or_more_external",
  recorded_by: { name: "Sumedh Kudav", email: "Sumedh@example.com" },
  calendar_invitees: [
    { name: "Sumedh Kudav", email: "sumedh@example.com", is_external: false },
    { name: null, matched_speaker_display_name: "Priya Shah", email: "Priya@acme.com", is_external: true },
    { name: "No Email", email: null },
  ],
  transcript: [
    { speaker: { display_name: "Sumedh Kudav", matched_calendar_invitee_email: "sumedh@example.com" }, text: "Let's settle pricing.", timestamp: "00:00:02" },
    { speaker: { display_name: "Sumedh Kudav", matched_calendar_invitee_email: null }, text: "I'd go with 55k per site.", timestamp: "00:00:05" },
    { speaker: { display_name: "Priya Shah", matched_calendar_invitee_email: null }, text: "Works for me.", timestamp: "00:01:05" },
    { speaker: { display_name: "Guest", matched_calendar_invitee_email: null }, text: "  ", timestamp: "00:01:10" },
    { speaker: { display_name: "Guest", matched_calendar_invitee_email: null }, text: "Send me the deck.", timestamp: "00:01:12" },
  ],
  default_summary: { template_name: "General", markdown_formatted: "## Pricing\nAgreed 55k per site." },
  action_items: [{ description: "Send the deck", completed: false, assignee: { name: "Sumedh Kudav", email: "sumedh@example.com" } }],
};

describe("Fathom", () => {
  it("turns each recording into a meeting thread of speaker turns plus Fathom's summary, visible to its invitees", async () => {
    const processing = { ...meeting, recording_id: 124, created_at: "2026-11-01T11:00:00Z", transcript: null };
    const { api, calls } = fakeApi({ meetings: () => ({ items: [meeting, processing], next_cursor: null }) });
    const found = await fathom.sync!(api, undefined, ctx);

    expect(found.threads).toEqual([
      {
        externalId: "123",
        kind: "meeting",
        title: "Pricing review",
        url: "https://fathom.video/calls/123",
        visibility: "members",
        memberKeys: ["email:sumedh@example.com", "email:priya@acme.com"],
        metadata: {
          startedAt: "2026-11-01T10:01:00.000Z",
          durationMinutes: 32,
          participants: ["sumedh@example.com", "priya@acme.com"],
          organizer: "sumedh@example.com",
          external: true,
        },
      },
    ]);
    expect(found.messages!.map((m) => [m.kind, m.authorKey, m.text, m.sentAt.toISOString()])).toEqual([
      ["transcript", "email:sumedh@example.com", "Let's settle pricing. I'd go with 55k per site.", "2026-11-01T10:01:02.000Z"],
      ["transcript", "email:priya@acme.com", "Works for me.", "2026-11-01T10:02:05.000Z"],
      ["transcript", "name:guest", "Send me the deck.", "2026-11-01T10:02:12.000Z"],
      ["note", undefined, "Fathom summary\n\n## Pricing\nAgreed 55k per site.\n\nAction items:\n- [ ] Send the deck (Sumedh Kudav)", "2026-11-01T10:33:00.000Z"],
    ]);
    expect(found.messages!.map((m) => m.externalId)).toEqual(["123#1", "123#2", "123#3", "123#summary"]);
    expect(found.people).toEqual([
      { key: "email:sumedh@example.com", provider: "email", externalId: "sumedh@example.com", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
      { key: "email:priya@acme.com", provider: "email", externalId: "priya@acme.com", displayName: "Priya Shah", email: "priya@acme.com" },
      { key: "name:guest", provider: "meeting", externalId: "guest", displayName: "Guest", email: undefined },
    ]);
    // The newest meeting seen, even one still processing; the overlap reads it again next time.
    expect(found.cursor).toEqual({ since: "2026-11-01T11:00:00.000Z" });
    expect(calls[0]).toMatchObject({
      path: "meetings",
      query: { created_after: "2026-08-04T12:00:00.000Z", include_transcript: "true", include_summary: "true", include_action_items: "true", cursor: undefined },
    });
  });

  it("asks only for meetings created since the cursor, a day back for transcripts that finished late", async () => {
    const { api, calls } = fakeApi({ meetings: () => ({ items: [], next_cursor: null }) });
    const found = await fathom.sync!(api, { since: "2026-11-01T10:40:00.000Z" }, ctx);
    expect(calls[0].query.created_after).toBe("2026-10-31T10:40:00.000Z");
    expect(found.messages).toEqual([]);
    expect(found.cursor).toEqual({ since: "2026-11-01T10:40:00.000Z" });
  });

  it("follows next_cursor, and carries an unfinished pass over to the next sync", async () => {
    const { api, calls } = fakeApi({
      meetings: (q) => ({ items: [{ ...meeting, recording_id: `R${q.cursor ?? 0}` }], next_cursor: `${Number(q.cursor ?? 0) + 1}` }),
    });
    const found = await fathom.sync!(api, undefined, ctx);
    expect(calls).toHaveLength(10);
    expect(found.threads).toHaveLength(10);
    expect(found.cursor).toEqual({ pending: { createdAfter: "2026-08-04T12:00:00.000Z", page: "10", newest: "2026-11-01T10:40:00.000Z" } });

    const rest = fakeApi({ meetings: () => ({ items: [{ ...meeting, created_at: "2026-11-02T09:00:00Z" }], next_cursor: null }) });
    const done = await fathom.sync!(rest.api, found.cursor, ctx);
    expect(rest.calls[0].query).toMatchObject({ created_after: "2026-08-04T12:00:00.000Z", cursor: "10" });
    expect(done.cursor).toEqual({ since: "2026-11-02T09:00:00.000Z" });
  });

  it("stops at a rate limit part-way and resumes there", async () => {
    const { api } = fakeApi({
      meetings: (q) => {
        if (q.cursor) throw new ProviderError("429 slow down", 429);
        return { items: [meeting], next_cursor: "p2" };
      },
    });
    const found = await fathom.sync!(api, { since: "2026-10-01T00:00:00.000Z" }, ctx);
    expect(found.threads).toHaveLength(1);
    expect(found.cursor).toEqual({
      since: "2026-10-01T00:00:00.000Z",
      pending: { createdAfter: "2026-09-30T00:00:00.000Z", page: "p2", newest: "2026-11-01T10:40:00.000Z" },
    });
  });

  it("reads Fathom's clock timestamps", () => {
    expect([clockSeconds("01:02:03"), clockSeconds("02:05"), clockSeconds(null)]).toEqual([3723, 125, 0]);
  });

  it("names the account by the email given, proves the key, and says so plainly when it's refused", async () => {
    const { api, calls } = fakeApi({ meetings: () => ({ items: [], next_cursor: null }) });
    expect(await fathom.identify(api, { apiKey: "k", email: " Sumedh@Example.com " })).toEqual({ accountId: "sumedh@example.com", label: "sumedh@example.com" });
    expect(calls[0].path).toBe("meetings");
    expect(calls[0].query.include_transcript).toBeUndefined();

    await expect(fathom.identify(api, { apiKey: "k", email: "nope" })).rejects.toThrow("Enter the email you sign in to Fathom with.");

    const refused = fakeApi({
      meetings: () => {
        throw new ProviderError("401", 401);
      },
    });
    await expect(fathom.identify(refused.api, { apiKey: "k", email: "a@b.co" })).rejects.toThrow("Fathom didn't accept that API key.");
  });
});
