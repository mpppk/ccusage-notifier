import { test, expect } from "bun:test";
import { formatUsage, shouldNotify, buildCalendarEvents, buildGoogleCalendarUrl, generateIcs } from "./index.ts";

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

test("shouldNotify respects thresholds", () => {
  const usage = {
    five_hour: { utilization: 90, resets_at: null },
    seven_day: { utilization: 40, resets_at: null },
    limits: [],
  } as any;
  expect(shouldNotify(usage, 80, 80).notify).toBe(true);
  expect(shouldNotify(usage, 95, 80).notify).toBe(false);
  expect(shouldNotify(usage, 95, 80).reasons).toEqual([]);
});

test("shouldNotify triggers on critical limit", () => {
  const usage = {
    five_hour: { utilization: 10, resets_at: null },
    seven_day: { utilization: 10, resets_at: null },
    limits: [{ kind: "session", group: "session", percent: 100, severity: "critical", resets_at: null, is_active: true }],
  } as any;
  const res = shouldNotify(usage, 80, 80);
  expect(res.notify).toBe(true);
  expect(res.reasons.join(" ")).toContain("critical");
});

test("buildCalendarEvents creates 2 events", () => {
  const usage = {
    five_hour: { utilization: 100, resets_at: "2026-08-28T14:39:59.766841+00:00" },
    seven_day: { utilization: 44, resets_at: "2026-09-02T18:59:59.766865+00:00" },
    limits: [],
  } as any;
  const events = buildCalendarEvents(usage);
  expect(events.length).toBe(2);
  expect(events[0]!.summary).toContain("5-hour");
  expect(events[1]!.summary).toContain("weekly");
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

test("generateIcs produces valid VCALENDAR", () => {
  const events = [
    { summary: "Claude Code 5-hour limit reset", description: "desc", startIso: "2026-08-28T14:39:59.766841+00:00", durationMinutes: 15 },
    { summary: "Claude Code weekly limit reset", description: "desc2", startIso: "2026-09-02T18:59:59.766865+00:00", durationMinutes: 15 },
  ];
  const ics = generateIcs(events);
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain("BEGIN:VEVENT");
  expect(ics).toContain("DTSTART:20260828T143959Z");
  expect(ics).toContain("DTSTART:20260902T185959Z");
  expect(ics).toContain("END:VCALENDAR");
});
