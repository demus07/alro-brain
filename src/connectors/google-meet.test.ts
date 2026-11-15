import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { googleMeet } from "./google-meet";

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
const ctx = { credentials: {}, accountId: "sumedh@example.com", now: NOW };
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary";

const record = (id: string, startTime: string, endTime: string, space = "spaces/S1") => ({ name: `conferenceRecords/${id}`, startTime, endTime, space });
const entry = (participant: string, text: string, startTime: string, endTime: string) => ({ participant: `conferenceRecords/R1/participants/${participant}`, text, startTime, endTime });

const routes = (over: Record<string, (q: Record<string, unknown>) => unknown> = {}) => ({
  "v2/conferenceRecords": () => ({
    conferenceRecords: [
      record("R3", "2026-11-02T09:00:00Z", "2026-11-02T09:30:00Z"),
      record("R2", "2026-11-01T15:00:00Z", "2026-11-01T15:20:00Z", "spaces/S2"),
      record("R1", "2026-11-01T10:00:00.250Z", "2026-11-01T10:40:00.500Z"),
      { name: "conferenceRecords/LIVE", startTime: "2026-11-02T11:30:00Z" },
    ],
  }),
  "v2/conferenceRecords/R1/transcripts": () => ({
    transcripts: [{ name: "conferenceRecords/R1/transcripts/T1", state: "FILE_GENERATED", docsDestination: { document: "DOC1", exportUri: "https://docs.google.com/document/d/DOC1/export" } }],
  }),
  "v2/conferenceRecords/R1/transcripts/T1/entries": (q: Record<string, unknown>) =>
    q.pageToken
      ? { transcriptEntries: [entry("p3", "Send me the deck.", "2026-11-01T10:01:12.250Z", "2026-11-01T10:01:14Z")] }
      : {
          transcriptEntries: [
            entry("p1", "Let's settle pricing.", "2026-11-01T10:00:01.750Z", "2026-11-01T10:00:03Z"),
            entry("p1", "I'd go with 55k per site.", "2026-11-01T10:00:03Z", "2026-11-01T10:00:06Z"),
            entry("p2", "Works for me.", "2026-11-01T10:01:05.250Z", "2026-11-01T10:01:06Z"),
          ],
          nextPageToken: "e2",
        },
  "v2/conferenceRecords/R1/participants": () => ({
    participants: [
      { name: "conferenceRecords/R1/participants/p1", signedinUser: { user: "users/111", displayName: "Sumedh Kudav" } },
      { name: "conferenceRecords/R1/participants/p2", signedinUser: { user: "users/222", displayName: "Jash Doshi" } },
      { name: "conferenceRecords/R1/participants/p3", anonymousUser: { displayName: "Guest" } },
    ],
  }),
  "v2/spaces/S1": () => ({ name: "spaces/S1", meetingCode: "abc-mnop-xyz", meetingUri: "https://meet.google.com/abc-mnop-xyz" }),
  [`${CAL}/events`]: () => ({
    items: [
      // At the same time, but a different call.
      { id: "other", summary: "Other call", start: { dateTime: "2026-11-01T10:00:00Z" }, end: { dateTime: "2026-11-01T10:30:00Z" }, conferenceData: { conferenceId: "zzz-zzzz-zzz" } },
      {
        id: "EV1",
        summary: "Pricing review",
        start: { dateTime: "2026-11-01T15:30:00+05:30" },
        end: { dateTime: "2026-11-01T16:15:00+05:30" },
        conferenceData: { conferenceId: "ABC-MNOP-XYZ" },
        attendees: [
          { email: "Sumedh@example.com", displayName: "Sumedh Kudav", self: true, responseStatus: "accepted" },
          { email: "jash@example.com", displayName: "Jash Doshi", responseStatus: "accepted" },
          { email: "priya@client.com", responseStatus: "declined" },
          { email: "room@resource.calendar.google.com", resource: true },
        ],
      },
    ],
  }),
  // R2 was not transcribed.
  "v2/conferenceRecords/R2/transcripts": () => ({}),
  // R3 is still being written out.
  "v2/conferenceRecords/R3/transcripts": () => ({ transcripts: [{ name: "conferenceRecords/R3/transcripts/T3", state: "ENDED" }] }),
  "v2/conferenceRecords/R3/transcripts/T3/entries": () => ({}),
  ...over,
});

describe("Google Meet", () => {
  it("turns each transcribed call into a meeting of speaker turns, visible to the people invited on its Calendar event", async () => {
    const { api, calls } = fakeApi(routes());
    const found = await googleMeet.sync!(api, undefined, ctx);

    expect(found.threads).toEqual([
      {
        externalId: "R1",
        kind: "meeting",
        title: "Pricing review",
        url: "https://docs.google.com/document/d/DOC1/edit",
        visibility: "members",
        memberKeys: ["email:sumedh@example.com", "email:jash@example.com"],
        metadata: {
          startedAt: "2026-11-01T10:00:00.250Z",
          endedAt: "2026-11-01T10:40:00.500Z",
          durationMinutes: 40,
          meetingCode: "abc-mnop-xyz",
          participants: ["sumedh@example.com", "jash@example.com"],
          calendarEventId: "EV1",
          transcriptDocId: "DOC1",
        },
      },
    ]);
    expect(found.messages!.map((m) => [m.externalId, m.kind, m.authorKey, m.text, m.sentAt.toISOString()])).toEqual([
      ["R1#1", "transcript", "email:sumedh@example.com", "Let's settle pricing. I'd go with 55k per site.", "2026-11-01T10:00:01.750Z"],
      ["R1#2", "transcript", "email:jash@example.com", "Works for me.", "2026-11-01T10:01:05.250Z"],
      ["R1#3", "transcript", "name:guest", "Send me the deck.", "2026-11-01T10:01:12.250Z"],
    ]);
    expect(found.people).toEqual([
      { key: "email:sumedh@example.com", provider: "email", externalId: "sumedh@example.com", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
      { key: "email:jash@example.com", provider: "email", externalId: "jash@example.com", displayName: "Jash Doshi", email: "jash@example.com" },
      { key: "name:guest", provider: "meeting", externalId: "guest", displayName: "Guest" },
    ]);
    // The call still in progress isn't counted; R3's transcript is retried next time.
    expect(found.cursor).toEqual({ since: "2026-11-02T09:30:00.000Z", done: ["conferenceRecords/R1", "conferenceRecords/R2"] });

    expect(calls[0].query).toMatchObject({ filter: 'end_time>="2026-10-03T12:00:00.000Z"', pageSize: 100 });
    expect(calls.find((c) => c.path === `${CAL}/events`)!.query).toMatchObject({ singleEvents: "true", timeMin: "2026-11-01T09:30:00.250Z", timeMax: "2026-11-01T11:10:00.500Z" });
    expect(calls.filter((c) => c.path.endsWith("/entries") && c.path.includes("R1")).map((c) => c.query.pageToken)).toEqual([undefined, "e2"]);
    // Nothing more is asked about a call with no transcript.
    expect(calls.some((c) => c.path === "v2/spaces/S2")).toBe(false);
  });

  it("without a matching Calendar event, titles the call by its code and date and adds nobody on a guess", async () => {
    const { api } = fakeApi(routes({ [`${CAL}/events`]: () => ({ items: [] }) }));
    const found = await googleMeet.sync!(api, undefined, ctx);
    expect(found.threads![0]).toMatchObject({ title: "Google Meet abc-mnop-xyz 2026-11-01", memberKeys: [], metadata: { participants: [], calendarEventId: undefined } });
    expect(found.messages!.map((m) => m.authorKey)).toEqual(["google-meet:users/111", "google-meet:users/222", "name:guest"]);
    expect(found.people!.find((p) => p.key === "google-meet:users/111")).toEqual({ key: "google-meet:users/111", provider: "google-meet", externalId: "users/111", displayName: "Sumedh Kudav" });
  });

  it("asks only for calls that ended since the cursor, a day back, and skips calls already read", async () => {
    const { api, calls } = fakeApi(routes());
    const found = await googleMeet.sync!(api, { since: "2026-11-02T09:30:00.000Z", done: ["conferenceRecords/R1", "conferenceRecords/R2"] }, ctx);
    expect(calls[0].query.filter).toBe('end_time>="2026-11-01T09:30:00.000Z"');
    expect(calls.some((c) => c.path.startsWith("v2/conferenceRecords/R1/"))).toBe(false);
    expect(calls.filter((c) => c.path === "v2/conferenceRecords/R3/transcripts")).toHaveLength(1);
    expect(found.threads).toEqual([]);
    expect(found.cursor).toEqual({ since: "2026-11-02T09:30:00.000Z", done: ["conferenceRecords/R1", "conferenceRecords/R2"] });
  });

  it("reads at most 25 calls a sync, oldest first, and continues from the last one read", async () => {
    const many = Array.from({ length: 30 }, (_, i) => record(`M${i}`, new Date(Date.parse("2026-10-20T10:00:00Z") + i * 3_600_000).toISOString(), new Date(Date.parse("2026-10-20T10:30:00Z") + i * 3_600_000).toISOString()));
    const { api, calls } = fakeApi({ "v2/conferenceRecords": () => ({ conferenceRecords: [...many].reverse() }), "v2/conferenceRecords/*": () => ({}) });
    const found = await googleMeet.sync!(api, undefined, ctx);
    const read = calls.filter((c) => c.path.endsWith("/transcripts")).map((c) => c.path);
    expect(read).toHaveLength(25);
    expect(read[0]).toBe("v2/conferenceRecords/M0/transcripts");
    expect(found.cursor.since).toBe(many[24].endTime);
  });

  it("identifies the Google account, and says so plainly when access is refused", async () => {
    const { api, calls } = fakeApi({ [CAL]: () => ({ id: "Sumedh@example.com" }), "v2/conferenceRecords": () => ({}) });
    expect(await googleMeet.identify(api, {})).toEqual({ accountId: "sumedh@example.com", label: "sumedh@example.com" });
    expect(calls.map((c) => c.path)).toEqual([CAL, "v2/conferenceRecords"]);

    const refused = fakeApi({
      [CAL]: () => ({ id: "sumedh@example.com" }),
      "v2/conferenceRecords": () => {
        throw new ProviderError("GET meet.googleapis.com/v2/conferenceRecords: 403 PERMISSION_DENIED", 403);
      },
    });
    await expect(googleMeet.identify(refused.api, {})).rejects.toThrow("Google didn't allow ALRO to read your Meet calls.");
  });
});
