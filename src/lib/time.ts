/** "Fri 2026-09-04 12:10 +05:30": local wall time with weekday and offset, so a model can resolve "by Friday". */
export function formatLocal(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", "");
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${offset}`;
}

/** Short human date in the org's zone, e.g. "Fri 4 Sep, 18:00". */
export function formatShort(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** Start and end (exclusive) of the local calendar day before `now`, as instants. */
export function previousLocalDay(now: Date, timeZone: string): { start: Date; end: Date } {
  const end = startOfLocalDay(now, timeZone);
  return { start: startOfLocalDay(new Date(end.getTime() - 1), timeZone), end };
}

/** Local midnight at or before `date`, as an instant. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((x) => [x.type, Number(x.value)]),
  );
  // Local midnight = now minus the local time of day (ignores a DST jump inside the day).
  const elapsed = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + date.getMilliseconds();
  return new Date(date.getTime() - elapsed);
}
