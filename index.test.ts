import { test, expect } from "bun:test";
import { formatUsage, buildCalendarEvents, buildGoogleCalendarUrl } from "./index.ts";

test("formatUsage renders 5h and 7d", () => {
  const usage = {
    five_hour: { utilization: 75, resets_at: "2026-08-28T14:40:00+00:00" },
    seven_day: { utilization: 30, resets_at: "2026-09-02T19:00:00+00:00" },
    extra_usage: null,
    limits: [],
  };
  const out = formatUsage(usage as any);
  expect(out).toContain("5-hour");
  expect(out).toContain("75%");
  expect(out).toContain("7-day");
  expect(out).toContain("30%");
});

test("buildCalendarEvents creates 2 events with kind", () => {
  const usage = {
    five_hour: { utilization: 100, resets_at: "2026-08-28T14:39:59.766841+00:00" },
    seven_day: { utilization: 44, resets_at: "2026-09-02T18:59:59.766865+00:00" },
    limits: [],
  } as any;
  const events = buildCalendarEvents(usage);
  expect(events.length).toBe(2);
  expect(events[0]!.summary).toContain("5-hour");
  expect(events[0]!.kind).toBe("five_hour");
  expect(events[1]!.summary).toContain("weekly");
  expect(events[1]!.kind).toBe("weekly");
});

test("buildGoogleCalendarUrl formats correctly", () => {
  const ev = {
    summary: "Claude Code 5-hour limit reset",
    description: "test",
    startIso: "2026-08-28T14:39:59.766841+00:00",
    durationMinutes: 15,
  };
  const url = buildGoogleCalendarUrl(ev);
  expect(url).toContain("calendar.google.com/calendar/render");
  expect(url).toContain("20260828T143959Z");
  expect(url).toContain("20260828T145459Z");
});


