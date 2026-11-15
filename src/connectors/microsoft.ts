import type { NormalizedEvent, Provider } from "./provider";

const DAY_MS = 86_400_000;
const GRAPH = "https://graph.microsoft.com/v1.0/";

interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  webLink?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: { displayName?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  // With the Prefer header below these are UTC wall times without a zone suffix.
  start: { dateTime: string };
  end: { dateTime: string };
  organizer?: { emailAddress?: { address?: string } };
  attendees?: { type?: string; emailAddress?: { address?: string; name?: string }; status?: { response?: string } }[];
}

const utc = (wallTime: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(wallTime) ? wallTime : `${wallTime}Z`);

/** The person's Outlook calendar (Microsoft 365): yesterday to two weeks out, recurring meetings expanded. */
export const outlookCalendar: Provider = {
  id: "outlook-calendar",
  scope: "personal",
  auth: { kind: "oauth", app: "microsoft", scopes: ["User.Read", "Calendars.Read"], baseUrl: GRAPH },
  async identify(api) {
    const me = await api<{ mail?: string; userPrincipalName: string }>("GET", "me");
    const mailbox = (me.mail ?? me.userPrincipalName).toLowerCase();
    return { accountId: mailbox, label: mailbox };
  },
  async sync(api, _cursor, ctx) {
    const events: NormalizedEvent[] = [];
    const me = (await api<{ mail?: string; userPrincipalName: string }>("GET", "me"));
    const self = (me.mail ?? me.userPrincipalName).toLowerCase();
    let next: string | undefined = "me/calendarView";
    let query: Record<string, string | number> | undefined = {
      startDateTime: new Date(ctx.now.getTime() - DAY_MS).toISOString(),
      endDateTime: new Date(ctx.now.getTime() + 14 * DAY_MS).toISOString(),
      $top: 100,
      $orderby: "start/dateTime",
    };
    for (let page = 0; next && page < 20; page++) {
      const r: { value: GraphEvent[]; "@odata.nextLink"?: string } = await api("GET", next, { query, headers: { Prefer: 'outlook.timezone="UTC"' } });
      for (const e of r.value) {
        events.push({
          externalId: e.id,
          title: e.subject ?? "(no title)",
          description: e.bodyPreview,
          location: e.location?.displayName || undefined,
          url: e.onlineMeeting?.joinUrl ?? e.webLink,
          startsAt: utc(e.start.dateTime),
          endsAt: utc(e.end.dateTime),
          allDay: e.isAllDay,
          organizer: e.organizer?.emailAddress?.address,
          attendees: (e.attendees ?? [])
            .filter((a) => a.type !== "resource" && a.emailAddress?.address?.toLowerCase() !== self)
            .map((a) => ({ email: a.emailAddress?.address, name: a.emailAddress?.name })),
          cancelled: e.isCancelled,
        });
      }
      // The next link already carries the query.
      next = r["@odata.nextLink"];
      query = undefined;
    }
    return { events, cursor: { syncedAt: ctx.now.toISOString() } };
  },
};
