import { test, expect } from "bun:test";
import { formatUsage, shouldNotify } from "./index.ts";

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
