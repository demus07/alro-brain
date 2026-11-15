import { tool } from "ai";
import { z } from "zod";
import type { NormalizedEvent, Provider } from "./provider";

const DAY_MS = 86_400_000;
/** Each sync re-reads this window, so moved and cancelled meetings are picked up. */
const BACK_DAYS = 1;
const AHEAD_DAYS = 14;

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
}

/** The person's primary Google Calendar: yesterday to two weeks out, recurring meetings expanded. */
export const googleCalendar: Provider = {
  id: "google-calendar",
  scope: "personal",
  auth: { kind: "oauth", app: "google", scopes: ["https://www.googleapis.com/auth/calendar.readonly"], baseUrl: "https://www.googleapis.com/" },
  async identify(api) {
    const cal = await api<{ id: string }>("GET", "calendar/v3/calendars/primary");
    return { accountId: cal.id.toLowerCase(), label: cal.id.toLowerCase() };
  },
  async sync(api, _cursor, ctx) {
    const events: NormalizedEvent[] = [];
    let pageToken: string | undefined;
    do {
      const r = await api<{ items?: GoogleEvent[]; nextPageToken?: string }>("GET", "calendar/v3/calendars/primary/events", {
        query: {
          singleEvents: "true",
          orderBy: "startTime",
          showDeleted: "true",
          timeMin: new Date(ctx.now.getTime() - BACK_DAYS * DAY_MS).toISOString(),
          timeMax: new Date(ctx.now.getTime() + AHEAD_DAYS * DAY_MS).toISOString(),
          maxResults: 250,
          pageToken,
        },
      });
      for (const e of r.items ?? []) {
        const start = e.start?.dateTime ?? e.start?.date;
        const end = e.end?.dateTime ?? e.end?.date ?? start;
        if (!start || !end) continue;
        const declined = e.attendees?.some((a) => a.self && a.responseStatus === "declined");
        events.push({
          externalId: e.id,
          title: e.summary ?? "(no title)",
          description: e.description,
          location: e.location,
          url: e.hangoutLink ?? e.htmlLink,
          startsAt: new Date(start),
          endsAt: new Date(end),
          allDay: !e.start?.dateTime,
          organizer: e.organizer?.email,
          attendees: (e.attendees ?? []).filter((a) => !a.resource && !a.self).map((a) => ({ email: a.email, name: a.displayName })),
          cancelled: e.status === "cancelled" || declined,
        });
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
    return { events, cursor: { syncedAt: ctx.now.toISOString() } };
  },
};

const MAX_ROWS = 200;

/** Google Sheets, read live when someone asks: nothing is copied into memory. */
export const googleSheets: Provider = {
  id: "google-sheets",
  scope: "personal",
  auth: {
    kind: "oauth",
    app: "google",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly", "https://www.googleapis.com/auth/drive.metadata.readonly"],
    baseUrl: "https://www.googleapis.com/",
    hosts: ["sheets.googleapis.com"],
  },
  async identify(api) {
    const about = await api<{ user: { emailAddress: string } }>("GET", "drive/v3/about", { query: { fields: "user(emailAddress)" } });
    return { accountId: about.user.emailAddress.toLowerCase(), label: about.user.emailAddress.toLowerCase() };
  },
  tools(api) {
    return {
      sheets_find: tool({
        description: "Find the asker's Google Sheets by name. Returns ids to read with sheets_read. Use for live numbers kept in spreadsheets (cash, receivables, stock, sales logs).",
        inputSchema: z.object({ name: z.string().describe("Part of the spreadsheet's name") }),
        execute: async ({ name }) => {
          const r = await api<{ files?: { id: string; name: string; modifiedTime: string; webViewLink: string }[] }>("GET", "drive/v3/files", {
            query: {
              q: `mimeType='application/vnd.google-apps.spreadsheet' and name contains '${name.replace(/['\\]/g, "\\$&")}' and trashed=false`,
              fields: "files(id,name,modifiedTime,webViewLink)",
              orderBy: "modifiedTime desc",
              pageSize: 10,
            },
          });
          return { spreadsheets: r.files ?? [] };
        },
      }),
      sheets_read: tool({
        description: `Read cells from a Google Sheet, live. Returns the tab names and up to ${MAX_ROWS} rows. Say which spreadsheet and tab a number came from.`,
        inputSchema: z.object({
          spreadsheetId: z.string(),
          range: z.string().nullish().describe("A1 notation such as 'Receivables!A1:H200'. Leave empty to read the first tab."),
        }),
        execute: async ({ spreadsheetId, range }) => {
          const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
          const meta = await api<{ properties: { title: string }; sheets: { properties: { title: string } }[] }>("GET", base, { query: { fields: "properties.title,sheets.properties.title" } });
          const tabs = meta.sheets.map((s) => s.properties.title);
          const wanted = range || tabs[0];
          const r = await api<{ range: string; values?: string[][] }>("GET", `${base}/values/${encodeURIComponent(wanted)}`);
          const rows = r.values ?? [];
          return { spreadsheet: meta.properties.title, tabs, range: r.range, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS ? `${rows.length - MAX_ROWS} more rows; ask for a narrower range` : undefined };
        },
      }),
    };
  },
};
