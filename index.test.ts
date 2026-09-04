import { test, expect } from "bun:test";
import {
  formatUsage,
  buildCalendarEvents,
  buildGoogleCalendarUrl,
  formatCodexUsage,
  buildCodexCalendarEvents,
  buildCombinedCalendarEvents,
  formatCombinedUsage,
} from "./index.ts";

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

test("formatCodexUsage renders 5h and weekly", () => {
  const codexUsage = {
    plan_type: "plus",
    five_hour: { utilization: 7, resets_at: "2026-09-03T10:06:48.000Z" },
    seven_day: { utilization: 82, resets_at: "2026-09-07T06:54:10.000Z" },
    primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_at: 1788430008, reset_after_seconds: 12500 },
    secondary_window: { used_percent: 82, limit_window_seconds: 604800, reset_at: 1788764050, reset_after_seconds: 346500 },
    raw: {} as any,
  } as any;
  const out = formatCodexUsage(codexUsage);
  expect(out).toContain("Codex Usage");
  expect(out).toContain("5-hour");
  expect(out).toContain("7%");
  expect(out).toContain("weekly");
  expect(out).toContain("82%");
  expect(out).toContain("plus");
});

test("buildCodexCalendarEvents creates 2 events with codex kind/product", () => {
  const codexUsage = {
    plan_type: "plus",
    five_hour: { utilization: 7, resets_at: "2026-09-03T10:06:48.000Z" },
    seven_day: { utilization: 82, resets_at: "2026-09-07T06:54:10.000Z" },
    primary_window: null,
    secondary_window: null,
    raw: {} as any,
  } as any;
  const events = buildCodexCalendarEvents(codexUsage);
  expect(events.length).toBe(2);
  expect(events[0]!.summary).toContain("Codex");
  expect(events[0]!.summary).toContain("5-hour");
  expect(events[0]!.kind).toBe("codex_five_hour");
  expect(events[0]!.product).toBe("codex");
  expect(events[1]!.kind).toBe("codex_weekly");
  expect(events[1]!.product).toBe("codex");
});

test("buildCombinedCalendarEvents merges claude and codex", () => {
  const claudeUsage = {
    five_hour: { utilization: 15, resets_at: "2026-09-03T09:59:59.000Z" },
    seven_day: { utilization: 4, resets_at: "2026-09-09T19:00:00.000Z" },
  } as any;
  const codexUsage = {
    plan_type: "plus",
    five_hour: { utilization: 7, resets_at: "2026-09-03T10:06:48.000Z" },
    seven_day: { utilization: 82, resets_at: "2026-09-07T06:54:10.000Z" },
    primary_window: null,
    secondary_window: null,
    raw: {} as any,
  } as any;
  const events = buildCombinedCalendarEvents({ claude: claudeUsage, codex: codexUsage });
  expect(events.length).toBe(4);
  expect(events.filter((e) => e.product === "claude").length).toBe(2);
  expect(events.filter((e) => e.product === "codex").length).toBe(2);
});

test("formatCombinedUsage includes both headers", () => {
  const claudeUsage = {
    five_hour: { utilization: 15, resets_at: "2026-09-03T09:59:59.000Z" },
    seven_day: { utilization: 4, resets_at: "2026-09-09T19:00:00.000Z" },
    extra_usage: null,
    limits: [],
  } as any;
  const codexUsage = {
    plan_type: "plus",
    five_hour: { utilization: 7, resets_at: "2026-09-03T10:06:48.000Z" },
    seven_day: { utilization: 82, resets_at: "2026-09-07T06:54:10.000Z" },
    primary_window: null,
    secondary_window: null,
    raw: { rate_limit: { allowed: true } },
  } as any;
  const out = formatCombinedUsage({ claude: claudeUsage, codex: codexUsage });
  expect(out).toContain("Claude Code Usage");
  expect(out).toContain("Codex Usage");
});

test("buildCodexCalendarEvents handles null resets", () => {
  const codexUsage = {
    plan_type: "plus",
    five_hour: { utilization: null, resets_at: null },
    seven_day: { utilization: 82, resets_at: "2026-09-07T06:54:10.000Z" },
    primary_window: null,
    secondary_window: null,
    raw: {} as any,
  } as any;
  const events = buildCodexCalendarEvents(codexUsage);
  expect(events.length).toBe(1);
  expect(events[0]!.kind).toBe("codex_weekly");
});


