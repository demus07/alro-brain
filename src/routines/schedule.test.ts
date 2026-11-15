import { describe, expect, it } from "vitest";
import { describeSchedule, localToInstant, nextRun, onceInstant } from "./schedule";

const IST = "Asia/Kolkata";
const iso = (d: Date | null) => d?.toISOString();

describe("schedules", () => {
  it("turns a local wall time into the right instant, across daylight saving", () => {
    expect(iso(localToInstant(2026, 11, 16, 7, 0, IST))).toBe("2026-11-16T01:30:00.000Z");
    // New York: 07:00 is UTC-4 in summer and UTC-5 in winter.
    expect(iso(localToInstant(2026, 7, 1, 7, 0, "America/New_York"))).toBe("2026-07-01T11:00:00.000Z");
    expect(iso(localToInstant(2026, 12, 1, 7, 0, "America/New_York"))).toBe("2026-12-01T12:00:00.000Z");
  });

  it("finds the next daily, weekday and weekly run", () => {
    // Sunday 15 Nov 2026, 09:40 IST.
    const now = new Date("2026-11-15T04:10:00Z");
    expect(iso(nextRun({ kind: "daily", time: "07:00" }, IST, now))).toBe("2026-11-16T01:30:00.000Z");
    expect(iso(nextRun({ kind: "daily", time: "18:00" }, IST, now))).toBe("2026-11-15T12:30:00.000Z");
    expect(iso(nextRun({ kind: "weekdays", time: "18:00" }, IST, now))).toBe("2026-11-16T12:30:00.000Z");
    expect(iso(nextRun({ kind: "weekly", weekday: 1, time: "08:00" }, IST, now))).toBe("2026-11-16T02:30:00.000Z");
    expect(iso(nextRun({ kind: "weekly", weekday: 0, time: "08:00" }, IST, now))).toBe("2026-11-22T02:30:00.000Z");
  });

  it("runs a one-off once, at its local time", () => {
    const now = new Date("2026-11-15T04:10:00Z");
    expect(iso(nextRun({ kind: "once", at: "2026-11-16T05:00" }, IST, now))).toBe("2026-11-15T23:30:00.000Z");
    expect(nextRun({ kind: "once", at: "2026-11-14T05:00" }, IST, now)).toBeNull();
    expect(iso(onceInstant("2026-11-16T05:00:00+05:30", "UTC") ?? null)).toBe("2026-11-15T23:30:00.000Z");
    expect(onceInstant("soon", IST)).toBeUndefined();
  });

  it("describes a schedule in words", () => {
    expect(describeSchedule({ kind: "weekly", weekday: 1, time: "08:00" })).toBe("Every Monday at 08:00");
    expect(describeSchedule({ kind: "weekdays", time: "07:00" })).toBe("Weekdays at 07:00");
  });
});
