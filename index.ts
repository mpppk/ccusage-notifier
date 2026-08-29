#!/usr/bin/env bun

/**
 * ccusage-notifier - Claude Code usage fetcher & notifier
 *
 * Fetches usage via Anthropic OAuth API using the token stored in macOS Keychain.
 * The token is stored by Claude Code as "Claude Code-credentials" generic password.
 */

type UsageBucket = {
  utilization: number | null;
  resets_at: string | null;
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
};

type ClaudeUsage = {
  five_hour: UsageBucket | null;
  seven_day: UsageBucket | null;
  seven_day_oauth_apps?: unknown;
  seven_day_opus?: unknown;
  seven_day_sonnet?: unknown;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number;
  } | null;
  limits?: Array<{
    kind: string;
    group: string;
    percent: number;
    severity: string;
    resets_at: string | null;
    is_active: boolean;
  }>;
  spend?: unknown;
  [k: string]: unknown;
};

export type NotifierOptions = {
  thresholdFiveHour?: number; // 0-100
  thresholdSevenDay?: number;
  json?: boolean;
  notify?: boolean;
  watchIntervalSec?: number;
  token?: string;
  calendar?: boolean;
  calendarOut?: string;
  calendarOpen?: boolean;
  calendarApi?: boolean;
  calendarId?: string;
  calendarAuth?: boolean;
  calendarAuthPort?: number;
};

// ---------------------------------------------------------------------------
// Token retrieval
// ---------------------------------------------------------------------------

export async function getClaudeToken(): Promise<string> {
  // 1. env var override (useful for CI / Linux)
  const envToken =
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??
    process.env.ANTHROPIC_OAUTH_TOKEN ??
    process.env.CLAUDE_TOKEN;
  if (envToken) return envToken.trim();

  // 2. macOS Keychain via `security`
  const user = process.env.USER;
  if (!user) throw new Error("USER env var is not set; cannot read keychain");

  const proc = Bun.spawn(
    ["security", "find-generic-password", "-s", "Claude Code-credentials", "-a", user, "-w"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const raw = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(
      `Could not read Claude Code credentials from Keychain (exit ${exitCode}): ${errText.trim() || raw.trim() || "no output"}. ` +
        `Try setting CLAUDE_CODE_OAUTH_TOKEN env var or ensure Claude Code is logged in.`,
    );
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Keychain returned empty credentials");

  try {
    const parsed = JSON.parse(trimmed);
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length > 0) return token;
    // Fallback: maybe raw is already a token string
    if (typeof parsed === "string" && parsed.startsWith("sk-ant-")) return parsed;
    throw new Error("claudeAiOauth.accessToken not found in keychain JSON");
  } catch (e) {
    // If JSON parse failed, maybe raw itself is the token
    if (trimmed.startsWith("sk-ant-")) return trimmed;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Usage fetch
// ---------------------------------------------------------------------------

export async function getClaudeUsage(token: string): Promise<ClaudeUsage> {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`usage fetch failed: ${res.status} ${body}`);
  }
  return (await res.json()) as ClaudeUsage;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatResetsAt(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // Show both UTC and JST for convenience
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (date: Date) =>
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  // UTC string + JST in parentheses, plus relative
  const now = Date.now();
  const diffMs = d.getTime() - now;
  const relative = formatDuration(diffMs);
  return `${fmt(d)} UTC (${fmt(jst)} JST, ${relative})`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "already reset";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0) return `in ${m}m ${s}s`;
  return `in ${s}s`;
}

function bar(percent: number | null | undefined, width = 20): string {
  if (percent == null) return "-".repeat(width);
  const filled = Math.round((percent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function severityEmoji(percent: number | null | undefined): string {
  if (percent == null) return "⬜";
  if (percent >= 100) return "🔴";
  if (percent >= 80) return "🟡";
  if (percent >= 50) return "🟢";
  return "⚪";
}

export function formatUsage(usage: ClaudeUsage): string {
  const five = usage.five_hour;
  const seven = usage.seven_day;
  const lines: string[] = [];
  lines.push("Claude Code Usage");
  lines.push("────────────────────────────────────────");
  lines.push(
    `${severityEmoji(five?.utilization)} 5-hour : ${five?.utilization ?? "-"}% ${bar(five?.utilization)}  reset: ${formatResetsAt(five?.resets_at)}`,
  );
  lines.push(
    `${severityEmoji(seven?.utilization)} 7-day  : ${seven?.utilization ?? "-"}% ${bar(seven?.utilization)}  reset: ${formatResetsAt(seven?.resets_at)}`,
  );
  if (usage.extra_usage) {
    const e = usage.extra_usage as { is_enabled: boolean; utilization: number; monthly_limit: number; used_credits: number };
    lines.push(`   extra_usage: ${e.is_enabled ? "enabled" : "disabled"} ${e.utilization}% (used ${e.used_credits}/${e.monthly_limit})`);
  }
  if (usage.limits && usage.limits.length > 0) {
    lines.push("────────────────────────────────────────");
    lines.push("Limits:");
    for (const lim of usage.limits) {
      lines.push(`  - ${lim.kind} (${lim.group}): ${lim.percent}% [${lim.severity}] active=${lim.is_active} reset=${formatResetsAt(lim.resets_at)}`);
    }
  }
  return lines.join("\n");
}

export function shouldNotify(
  usage: ClaudeUsage,
  thresholdFiveHour = 80,
  thresholdSevenDay = 80,
): { notify: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const five = usage.five_hour?.utilization;
  const seven = usage.seven_day?.utilization;
  if (typeof five === "number" && five >= thresholdFiveHour) {
    reasons.push(`5-hour ${five}% >= ${thresholdFiveHour}%`);
  }
  if (typeof seven === "number" && seven >= thresholdSevenDay) {
    reasons.push(`7-day ${seven}% >= ${thresholdSevenDay}%`);
  }
  // Also notify if any limit is critical/active
  for (const lim of usage.limits ?? []) {
    if (lim.is_active && lim.severity === "critical") {
      reasons.push(`limit ${lim.kind} is critical (${lim.percent}%)`);
    }
  }
  return { notify: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Google Calendar integration
// ---------------------------------------------------------------------------

export type CalendarEventInput = {
  summary: string;
  description: string;
  startIso: string; // ISO 8601
  durationMinutes?: number;
  // Used to identify/match existing events for upsert (patch instead of create)
  kind?: "five_hour" | "weekly";
};

function toGoogleCalendarDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function toIcsDate(iso: string): string {
  return toGoogleCalendarDate(iso);
}

export function buildGoogleCalendarUrl(event: CalendarEventInput): string {
  const start = toGoogleCalendarDate(event.startIso);
  const dur = event.durationMinutes ?? 15;
  const endDate = new Date(new Date(event.startIso).getTime() + dur * 60 * 1000);
  const end = toGoogleCalendarDate(endDate.toISOString());
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.summary,
    dates: `${start}/${end}`,
    details: event.description,
    ctz: "UTC",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function buildCalendarEvents(usage: ClaudeUsage): CalendarEventInput[] {
  const events: CalendarEventInput[] = [];
  if (usage.five_hour?.resets_at) {
    const util = usage.five_hour.utilization;
    events.push({
      summary: "Claude Code 5-hour limit reset",
      description: `Claude Code 5-hour usage ${util ?? "-"}% resets. Weekly: ${usage.seven_day?.utilization ?? "-"}%.\nGenerated by ccusage-notifier at ${new Date().toISOString()}`,
      startIso: usage.five_hour.resets_at,
      durationMinutes: 15,
      kind: "five_hour",
    });
  }
  if (usage.seven_day?.resets_at) {
    const util = usage.seven_day.utilization;
    events.push({
      summary: "Claude Code weekly limit reset",
      description: `Claude Code 7-day usage ${util ?? "-"}% resets. 5-hour: ${usage.five_hour?.utilization ?? "-"}%.\nGenerated by ccusage-notifier at ${new Date().toISOString()}`,
      startIso: usage.seven_day.resets_at,
      durationMinutes: 15,
      kind: "weekly",
    });
  }
  return events;
}

export function generateIcs(events: CalendarEventInput[]): string {
  const nowIcs = toIcsDate(new Date().toISOString());
  const uidSuffix = "@ccusage-notifier";
  const escapeIcs = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//ccusage-notifier//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  for (const ev of events) {
    const start = toIcsDate(ev.startIso);
    const end = toIcsDate(new Date(new Date(ev.startIso).getTime() + (ev.durationMinutes ?? 15) * 60 * 1000).toISOString());
    const uid = `${start}-${escapeIcs(ev.summary).replace(/\s+/g, "-")}${uidSuffix}`;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${nowIcs}`);
    lines.push(`DTSTART:${start}`);
    lines.push(`DTEND:${end}`);
    lines.push(`SUMMARY:${escapeIcs(ev.summary)}`);
    lines.push(`DESCRIPTION:${escapeIcs(ev.description)}`);
    lines.push("STATUS:CONFIRMED");
    lines.push("TRANSP:TRANSPARENT");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export async function writeIcsFile(path: string, events: CalendarEventInput[]): Promise<void> {
  const ics = generateIcs(events);
  await Bun.write(path, ics);
}

export async function insertGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<unknown> {
  const start = new Date(event.startIso);
  const end = new Date(start.getTime() + (event.durationMinutes ?? 15) * 60 * 1000);
  const body: Record<string, unknown> = {
    summary: event.summary,
    description: event.description,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    reminders: { useDefault: true },
    // Mark events for future upsert matching via private extended properties
    extendedProperties: {
      private: {
        source: "ccusage-notifier",
        kind: event.kind ?? (event.summary.includes("weekly") ? "weekly" : "five_hour"),
      },
    },
  };
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Calendar API failed: ${res.status} ${text}`);
  }
  return await res.json();
}

export async function patchGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: CalendarEventInput,
): Promise<unknown> {
  const start = new Date(event.startIso);
  const end = new Date(start.getTime() + (event.durationMinutes ?? 15) * 60 * 1000);
  const body: Record<string, unknown> = {
    summary: event.summary,
    description: event.description,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        source: "ccusage-notifier",
        kind: event.kind ?? (event.summary.includes("weekly") ? "weekly" : "five_hour"),
      },
    },
  };
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Calendar PATCH failed: ${res.status} ${text}`);
  }
  return await res.json();
}

export async function deleteGoogleCalendarEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`Google Calendar DELETE failed: ${res.status} ${text}`);
  }
}

export async function listGoogleCalendarEvents(
  accessToken: string,
  calendarId: string,
  opts: { q?: string; timeMin?: string; timeMax?: string; maxResults?: number } = {},
): Promise<Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string }; extendedProperties?: { private?: Record<string, string> } }>> {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.timeMin) params.set("timeMin", opts.timeMin);
  if (opts.timeMax) params.set("timeMax", opts.timeMax);
  params.set("singleEvents", "true");
  params.set("orderBy", "startTime");
  params.set("maxResults", String(opts.maxResults ?? 50));
  // Prefer filtering by our marker when possible; fallback to q search if not indexed yet
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google Calendar LIST failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string }; extendedProperties?: { private?: Record<string, string> } }> };
  return data.items ?? [];
}

export async function upsertGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<{ action: "created" | "updated" | "moved"; id: string; htmlLink?: string }> {
  const kind = event.kind ?? (event.summary.includes("weekly") ? "weekly" : "five_hour");
  // Search window: from 1 day ago to 30 days ahead to find existing instances
  const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const items = await listGoogleCalendarEvents(accessToken, calendarId, {
    q: "Claude Code",
    timeMin,
    timeMax,
    maxResults: 50,
  });

  // Filter to our events by summary + (extendedProperties marker if present or legacy fallback by summary)
  const candidates = items.filter((it) => {
    if (!it.summary) return false;
    const isSameKind =
      (kind === "five_hour" && it.summary.includes("5-hour")) || (kind === "weekly" && it.summary.includes("weekly"));
    if (!isSameKind) return false;
    // If event has marker, check it; otherwise fallback to summary match (covers legacy events before marker)
    const marker = it.extendedProperties?.private?.source;
    if (marker) return marker === "ccusage-notifier";
    return true; // legacy fallback
  });

  // Sort by start time
  candidates.sort((a, b) => {
    const ta = a.start?.dateTime ? new Date(a.start.dateTime).getTime() : 0;
    const tb = b.start?.dateTime ? new Date(b.start.dateTime).getTime() : 0;
    return ta - tb;
  });

  const toSec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
  const wantedSec = toSec(event.startIso);

  if (candidates.length === 0) {
    const created = (await insertGoogleCalendarEvent(accessToken, calendarId, event)) as { id: string; htmlLink?: string };
    return { action: "created", id: created.id, htmlLink: created.htmlLink };
  }

  // Pick the first candidate as primary; if its time already matches (second precision), treat as updated, else move
  const primary = candidates[0]!;
  const primarySec = primary.start?.dateTime ? toSec(primary.start.dateTime) : null;
  const isSameTime = primarySec === wantedSec;

  const patched = (await patchGoogleCalendarEvent(accessToken, calendarId, primary.id, event)) as {
    id: string;
    htmlLink?: string;
  };

  // Clean up duplicates beyond primary
  if (candidates.length > 1) {
    for (let i = 1; i < candidates.length; i++) {
      try {
        await deleteGoogleCalendarEvent(accessToken, calendarId, candidates[i]!.id);
        console.log(`[calendar] Cleaned duplicate ${candidates[i]!.summary} (${candidates[i]!.id})`);
      } catch (e) {
        console.warn(`[calendar] Failed to delete duplicate ${candidates[i]!.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { action: isSameTime ? "updated" : "moved", id: patched.id, htmlLink: patched.htmlLink };
}

// Token file helpers (XDG + fallback)
function getGoogleTokenFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? "."}/.config`;
  return `${xdg}/ccusage-notifier/google-calendar-token.json`;
}

type StoredGoogleToken = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
  token_type?: string;
  obtained_at?: string;
  client_id?: string;
  client_secret?: string;
};

async function readStoredGoogleToken(): Promise<StoredGoogleToken | null> {
  const candidates = [
    getGoogleTokenFilePath(),
    `${process.env.HOME ?? "."}/.ccusage-notifier-google-token.json`,
    "./.google-calendar-token.json",
  ];
  for (const p of candidates) {
    try {
      const file = Bun.file(p);
      if (await file.exists()) {
        const json = await file.json();
        if (json?.access_token) return json as StoredGoogleToken;
      }
    } catch {}
  }
  return null;
}

async function writeStoredGoogleToken(token: StoredGoogleToken): Promise<string> {
  const path = getGoogleTokenFilePath();
  const dir = path.substring(0, path.lastIndexOf("/"));
  // ensure dir exists
  const proc = Bun.spawn(["mkdir", "-p", dir], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  await Bun.write(path, JSON.stringify(token, null, 2));
  // chmod 600
  const chmod = Bun.spawn(["chmod", "600", path], { stdout: "pipe", stderr: "pipe" });
  await chmod.exited;
  return path;
}

async function refreshGoogleAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<StoredGoogleToken> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) throw new Error(`refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number; scope?: string; token_type?: string };
  return {
    access_token: data.access_token,
    refresh_token: refreshToken,
    expires_at: Date.now() + data.expires_in * 1000 - 60_000,
    scope: data.scope,
    token_type: data.token_type,
    obtained_at: new Date().toISOString(),
  };
}

export async function getGoogleAccessToken(clientId?: string, clientSecret?: string): Promise<string | null> {
  // Resolve client credentials first (for refresh flows) - try env, then stored file
  const storedForCreds = await readStoredGoogleToken();
  const resolvedClientId =
    clientId ??
    process.env.GOOGLE_CLIENT_ID ??
    process.env.GOOGLE_OAUTH_CLIENT_ID ??
    storedForCreds?.client_id;
  const resolvedClientSecret =
    clientSecret ??
    process.env.GOOGLE_CLIENT_SECRET ??
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
    storedForCreds?.client_secret;

  // 0. If refresh_token is provided via env, try to obtain fresh access_token immediately (preferred for persistence)
  const envRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (envRefreshToken && resolvedClientId && resolvedClientSecret) {
    try {
      const refreshed = await refreshGoogleAccessToken(envRefreshToken, resolvedClientId, resolvedClientSecret);
      refreshed.refresh_token = envRefreshToken;
      refreshed.client_id = resolvedClientId;
      refreshed.client_secret = resolvedClientSecret;
      const path = await writeStoredGoogleToken(refreshed);
      console.log(`[calendar] Refreshed access token from GOOGLE_REFRESH_TOKEN, saved to ${path}`);
      return refreshed.access_token;
    } catch (e) {
      console.warn(`[calendar] Refresh from GOOGLE_REFRESH_TOKEN failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 1. env var access token (highest priority for one-off, e.g. Playground)
  const envToken = process.env.GOOGLE_OAUTH_TOKEN ?? process.env.GOOGLE_CALENDAR_TOKEN ?? process.env.GOOGLE_ACCESS_TOKEN;
  if (envToken) {
    if (!envRefreshToken) {
      console.log("[calendar] Using GOOGLE_OAUTH_TOKEN from env (expires in ~1h, no refresh). For persistence, set GOOGLE_REFRESH_TOKEN or use --calendar-auth");
    }
    return envToken.trim();
  }

  // 2. stored file
  const stored = storedForCreds ?? (await readStoredGoogleToken());
  if (!stored) return null;

  if (stored.expires_at && stored.expires_at > Date.now() + 30_000) {
    return stored.access_token;
  }

  if (stored.refresh_token && resolvedClientId && resolvedClientSecret) {
    try {
      console.log("[calendar] Access token expired, refreshing via stored refresh_token...");
      const refreshed = await refreshGoogleAccessToken(stored.refresh_token, resolvedClientId, resolvedClientSecret);
      refreshed.refresh_token = stored.refresh_token;
      refreshed.client_id = resolvedClientId;
      refreshed.client_secret = resolvedClientSecret;
      const path = await writeStoredGoogleToken(refreshed);
      console.log(`[calendar] Refreshed token saved to ${path}`);
      return refreshed.access_token;
    } catch (e) {
      console.warn(`[calendar] Refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      return stored.access_token;
    }
  }

  if (stored.expires_at && stored.expires_at <= Date.now()) {
    if (stored.refresh_token && (!resolvedClientId || !resolvedClientSecret)) {
      console.warn("[calendar] Stored access token expired and refresh_token exists but GOOGLE_CLIENT_ID/SECRET not found. Set them or re-run --calendar-auth");
    } else {
      console.warn("[calendar] Stored access token expired and no refresh_token available. Re-run with --calendar-auth or set GOOGLE_REFRESH_TOKEN");
    }
  }
  return stored.access_token;
}

export async function runGoogleCalendarAuth(opts: { port?: number; clientId?: string; clientSecret?: string } = {}): Promise<StoredGoogleToken> {
  const clientId = opts.clientId ?? process.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(`
[calendar-auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is required.

1. Create a GCP project at https://console.cloud.google.com/
2. Enable Google Calendar API: APIs & Services > Enable APIs > Google Calendar API
3. Create OAuth consent screen (External, add your email, scope: .../auth/calendar.events)
4. Create Credentials > OAuth client ID > Desktop app (or Web app)
   - For Web app, add redirect URI: http://localhost:${opts.port ?? 8085}/callback
   - For Desktop app, no redirect needed but we use http://localhost:${opts.port ?? 8085}/callback
5. Copy Client ID and Client Secret, then run:

  GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com" GOOGLE_CLIENT_SECRET="GOCSPX-xxx" bun run index.ts --calendar-auth
  # or
  bun run index.ts --calendar-auth --calendar-id primary

Alternatively, use OAuth Playground (no GCP needed, 2 min):
  1. Go to https://developers.google.com/oauthplayground
  2. Select scope: https://www.googleapis.com/auth/calendar.events > Authorize APIs
  3. Exchange code for tokens > copy Access token
  4. GOOGLE_OAUTH_TOKEN="ya29..." bun run index.ts --calendar --calendar-api

`);
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
  }

  const port = opts.port ?? 8085;
  const redirectUri = `http://localhost:${port}/callback`;
  const scope = "https://www.googleapis.com/auth/calendar.events";
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log(`\n[calendar-auth] Starting local server on http://localhost:${port}/callback`);
  console.log(`[calendar-auth] Opening browser for consent:\n  ${authUrl.toString()}\n`);
  console.log(`[calendar-auth] If browser doesn't open, manually visit the URL above.\n`);

  let resolveCode: (code: string) => void;
  let rejectCode: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) {
          rejectCode(new Error(`OAuth error: ${error}`));
          return new Response(`<h1>Auth failed: ${error}</h1><p>Close this window and try again.</p>`, { headers: { "Content-Type": "text/html" } });
        }
        if (!code) {
          return new Response(`<h1>Missing code</h1>`, { status: 400, headers: { "Content-Type": "text/html" } });
        }
        resolveCode(code);
        return new Response(
          `<h1>Authenticated!</h1><p>You can close this window and return to terminal.</p><script>window.close()</script>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });

  // open browser
  const openProc = Bun.spawn(["open", authUrl.toString()], { stdout: "pipe", stderr: "pipe" });
  await openProc.exited;

  console.log("[calendar-auth] Waiting for OAuth callback... (Ctrl+C to cancel)");

  // timeout 5 minutes
  const timeout = setTimeout(() => rejectCode(new Error("OAuth callback timeout (5 min). Try again.")), 5 * 60 * 1000);

  let code: string;
  try {
    code = await codePromise;
  } finally {
    clearTimeout(timeout);
    server.stop();
  }

  console.log("[calendar-auth] Code received, exchanging for tokens...");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`);
  }
  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
    token_type: string;
  };

  const stored: StoredGoogleToken = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000 - 60_000,
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    obtained_at: new Date().toISOString(),
    client_id: clientId,
    client_secret: clientSecret,
  };

  const savedPath = await writeStoredGoogleToken(stored);
  console.log(`\n[calendar-auth] ✓ Tokens saved to ${savedPath}`);
  console.log(`  Access token: ${stored.access_token.slice(0, 20)}... (expires in ${tokenData.expires_in}s)`);
  if (stored.refresh_token) console.log(`  Refresh token: ${stored.refresh_token.slice(0, 20)}... (stored for auto-refresh)`);
  else console.log(`  Note: No refresh_token returned. Re-auth will be needed when access token expires. Ensure prompt=consent.`);

  console.log(`\n[calendar-auth] Next step: bun run index.ts --calendar --calendar-api`);

  return stored;
}

export async function triggerClaudePing(pingMessage = "ping"): Promise<{ success: boolean; output?: string; error?: string }> {
  console.log(`[calendar] 5-hour reset is null (0%), triggering claude -p ping to start new session...`);
  try {
    const proc = Bun.spawn(["claude", "-p", pingMessage, "--output-format", "json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (exit !== 0) {
      console.warn(`[calendar] claude ping failed (exit ${exit}): ${err.slice(0, 500)}`);
      return { success: false, error: err };
    }
    // Try to parse output for cost, but not required
    try {
      const parsed = JSON.parse(out);
      if (parsed?.total_cost_usd) console.log(`[calendar] claude ping succeeded, cost $${parsed.total_cost_usd}`);
    } catch {}
    return { success: true, output: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[calendar] claude ping spawn failed: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function ensureFiveHourReset(
  usage: ClaudeUsage,
  claudeToken: string,
  maxRetries = 5,
): Promise<ClaudeUsage> {
  if (usage.five_hour?.resets_at) return usage;
  // Only ping when 5h is 0% or null and no reset
  const isZero = (usage.five_hour?.utilization ?? 0) === 0;
  if (!isZero) return usage;
  const ping = await triggerClaudePing("ping");
  if (!ping.success) {
    console.warn("[calendar] Skipping 5h reset refresh due to ping failure");
    return usage;
  }
  // Poll for new reset (API may take a few seconds to update)
  for (let i = 0; i < maxRetries; i++) {
    await Bun.sleep(2000);
    try {
      const refreshed = await getClaudeUsage(claudeToken);
      if (refreshed.five_hour?.resets_at) {
        console.log(`[calendar] New 5-hour reset obtained: ${refreshed.five_hour.resets_at} (after ${i + 1} poll(s))`);
        // Merge weekly from refreshed (keep latest)
        return refreshed;
      }
      console.log(`[calendar] Poll ${i + 1}/${maxRetries}: 5h reset still null, retrying...`);
    } catch (e) {
      console.warn(`[calendar] Poll ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.warn("[calendar] 5h reset still null after poll, proceeding with original usage");
  return usage;
}

export async function handleCalendar(usage: ClaudeUsage, opts: NotifierOptions): Promise<void> {
  // If 5h reset is null (0%), try to start a new session via claude ping so we can move the calendar event instead of deleting
  let effectiveUsage = usage;
  if (!usage.five_hour?.resets_at && opts.calendar) {
    const isZero = (usage.five_hour?.utilization ?? 0) === 0;
    if (isZero) {
      try {
        const claudeToken = opts.token ?? (await getClaudeToken());
        effectiveUsage = await ensureFiveHourReset(usage, claudeToken);
      } catch (e) {
        console.warn(`[calendar] ensureFiveHourReset failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const events = buildCalendarEvents(effectiveUsage);

  // Determine which kinds are missing (reset is null) - need to delete old events for those (only weekly now; 5h is handled via ping)
  const missingKinds: Array<"five_hour" | "weekly"> = [];
  // 5h: if still null after ping attempt, don't delete - will be handled as no event (user said deletion not needed, always move)
  // So only weekly null leads to deletion
  if (!effectiveUsage.seven_day?.resets_at) missingKinds.push("weekly");
  // For 5h, if still null after ping, we skip deletion and just don't create event (no move)
  const hasFiveHourNullAfterPing = !effectiveUsage.five_hour?.resets_at;

  if (events.length === 0) {
    console.log("[calendar] No reset times available in usage data (both resets_at are null)");
    if (missingKinds.length > 0 && opts.calendarApi) {
      const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      const token = await getGoogleAccessToken(clientId, clientSecret);
      if (!token) {
        console.error("[calendar] No auth for deletion");
        return;
      }
      const calendarId = opts.calendarId ?? process.env.GOOGLE_CALENDAR_ID ?? "primary";
      for (const kind of missingKinds) {
        const count = await deleteCalendarEventsByKind(token, calendarId, kind);
        console.log(`[calendar] Deleted ${count} stale event(s) for ${kind} (reset is null)`);
      }
    }
    return;
  }

  console.log("\n[calendar] Reset events:");
  for (const ev of events) {
    const url = buildGoogleCalendarUrl(ev);
    console.log(`  - ${ev.summary}: ${ev.startIso} (${toGoogleCalendarDate(ev.startIso)})`);
    console.log(`    Google Calendar URL: ${url}`);
  }
  if (missingKinds.length > 0) {
    for (const k of missingKinds) {
      const label = k === "five_hour" ? "5-hour" : "weekly";
      console.log(`  - ${label}: reset is null -> existing events for ${k} will be deleted`);
    }
  }

  // ICS file
  const outPath = opts.calendarOut ?? "ccusage-reset.ics";
  await writeIcsFile(outPath, events);
  console.log(`\n[calendar] ICS file written: ${outPath} (${events.length} events)`);
  console.log(`  Import via: Google Calendar > Settings > Import & export > Import > select ${outPath}`);
  console.log(`  Or drag & drop ${outPath} into Google Calendar web UI`);

  if (opts.calendarOpen) {
    for (const ev of events) {
      const url = buildGoogleCalendarUrl(ev);
      console.log(`[calendar] Opening browser: ${url}`);
      const proc = Bun.spawn(["open", url], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    }
  }

  if (opts.calendarApi) {
    const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const token = await getGoogleAccessToken(clientId, clientSecret);
    if (!token) {
      console.error(
        "[calendar] --calendar-api requires auth. Either:\n" +
          "  1) Set GOOGLE_OAUTH_TOKEN env var, or\n" +
          "  2) Run: bun run index.ts --calendar-auth (then --calendar --calendar-api)\n" +
          "  See README for OAuth setup. Scope required: https://www.googleapis.com/auth/calendar.events",
      );
      return;
    }
    const calendarId = opts.calendarId ?? process.env.GOOGLE_CALENDAR_ID ?? "primary";

    // First, delete stale events for missing kinds
    for (const kind of missingKinds) {
      try {
        const count = await deleteCalendarEventsByKind(token, calendarId, kind);
        if (count > 0) console.log(`[calendar] Deleted ${count} stale event(s) for ${kind} (reset is null)`);
        else console.log(`[calendar] No stale events to delete for ${kind}`);
      } catch (e) {
        console.error(`[calendar] Failed to delete ${kind} events: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(`[calendar] Upserting ${events.length} event(s) via API to calendar: ${calendarId} (existing events will be moved)`);
    for (const ev of events) {
      try {
        const result = await upsertGoogleCalendarEvent(token, calendarId, ev);
        const label = result.action === "moved" ? "moved" : result.action === "updated" ? "updated (already at correct time)" : "created";
        console.log(`  ✓ ${ev.summary} [${label}] -> ${result.htmlLink ?? result.id}`);
      } catch (e) {
        console.error(`  ✗ ${ev.summary} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

export async function deleteCalendarEventsByKind(
  accessToken: string,
  calendarId: string,
  kind: "five_hour" | "weekly",
): Promise<number> {
  const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const items = await listGoogleCalendarEvents(accessToken, calendarId, {
    q: "Claude Code",
    timeMin,
    timeMax,
    maxResults: 50,
  });
  const targets = items.filter((it) => {
    if (!it.summary) return false;
    const isSameKind =
      (kind === "five_hour" && it.summary.includes("5-hour")) || (kind === "weekly" && it.summary.includes("weekly"));
    if (!isSameKind) return false;
    const marker = it.extendedProperties?.private?.source;
    if (marker) return marker === "ccusage-notifier";
    return true;
  });
  for (const it of targets) {
    await deleteGoogleCalendarEvent(accessToken, calendarId, it.id);
  }
  return targets.length;
}

// ---------------------------------------------------------------------------
// macOS notification
// ---------------------------------------------------------------------------

export async function sendMacNotification(title: string, body: string, subtitle?: string): Promise<void> {
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const script = subtitle
    ? `display notification "${escape(body)}" with title "${escape(title)}" subtitle "${escape(subtitle)}"`
    : `display notification "${escape(body)}" with title "${escape(title)}"`;
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    console.warn(`[ccusage-notifier] osascript notification failed: ${err.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): NotifierOptions & { help?: boolean; once?: boolean } {
  const opts: NotifierOptions & { help?: boolean; once?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--notify") opts.notify = true;
    else if (a === "--once") opts.once = true;
    else if (a === "--calendar") opts.calendar = true;
    else if (a === "--calendar-open") opts.calendarOpen = true;
    else if (a === "--calendar-api") opts.calendarApi = true;
    else if (a === "--calendar-auth") opts.calendarAuth = true;
    else if (a === "--calendar-out") opts.calendarOut = argv[++i];
    else if (a === "--calendar-id") opts.calendarId = argv[++i];
    else if (a.startsWith("--calendar-out=")) opts.calendarOut = a.split("=").slice(1).join("=");
    else if (a.startsWith("--calendar-id=")) opts.calendarId = a.split("=").slice(1).join("=");
    else if (a.startsWith("--calendar-auth-port=")) opts.calendarAuthPort = Number(a.split("=").slice(1).join("="));
    else if (a === "--calendar-auth-port") opts.calendarAuthPort = Number(argv[++i]);
    else if (a === "--threshold-five" || a === "--threshold-five-hour") {
      opts.thresholdFiveHour = Number(argv[++i]);
    } else if (a === "--threshold-week" || a === "--threshold-seven" || a === "--threshold-seven-day") {
      opts.thresholdSevenDay = Number(argv[++i]);
    } else if (a === "--threshold" || a === "-t") {
      const v = Number(argv[++i]);
      opts.thresholdFiveHour = v;
      opts.thresholdSevenDay = v;
    } else if (a === "--watch" || a === "-w") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && !isNaN(Number(next))) {
        opts.watchIntervalSec = Number(argv[++i]);
      } else {
        opts.watchIntervalSec = 300; // default 5min
      }
    } else if (a === "--interval") {
      opts.watchIntervalSec = Number(argv[++i]);
    } else if (a.startsWith("--threshold-five=")) {
      opts.thresholdFiveHour = Number(a.split("=")[1]);
    } else if (a.startsWith("--threshold-week=") || a.startsWith("--threshold-seven=")) {
      opts.thresholdSevenDay = Number(a.split("=")[1]);
    } else if (a.startsWith("--watch=")) {
      opts.watchIntervalSec = Number(a.split("=")[1]);
    }
  }
  // --calendar-open / --calendar-api implies --calendar
  if (opts.calendarOpen) opts.calendar = true;
  if (opts.calendarApi) opts.calendar = true;
  return opts;
}

function printHelp() {
  console.log(`
ccusage-notifier - Claude Code usage fetcher & notifier

Usage:
  bun run index.ts [options]
  bun index.ts [options]

Options:
  --json                          Output raw JSON instead of pretty table
  --notify                        Send macOS notification when threshold exceeded
  --threshold <n>                 Set both 5h and 7-day thresholds (default 80)
  --threshold-five <n>            5-hour threshold percent (default 80)
  --threshold-week <n>            7-day threshold percent (default 80)
  --watch [sec]                   Poll every <sec> seconds (default 300) until Ctrl+C
  --interval <sec>                Alias for --watch
  --calendar                      Generate Google Calendar events for reset times (ICS + URL)
  --calendar-out <path>           ICS output path (default: ccusage-reset.ics)
  --calendar-open                 Also open Google Calendar template URL in browser
  --calendar-api                  Insert events via Google Calendar API (needs GOOGLE_OAUTH_TOKEN or stored token)
                                  When 5h is 0% with no reset, auto-runs 'claude -p ping' to start new session and moves calendar event
  --calendar-id <id>              Target calendar ID for --calendar-api (default: primary)
  --calendar-auth                 Start OAuth flow to obtain Google Calendar token (needs GOOGLE_CLIENT_ID/SECRET)
  --calendar-auth-port <port>     Port for OAuth callback server (default: 8085)
  --once                          Run once even if --watch is set (default)
  -h, --help                      Show this help

Env:
  CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_OAUTH_TOKEN / CLAUDE_TOKEN  Override keychain token
  GOOGLE_OAUTH_TOKEN / GOOGLE_CALENDAR_TOKEN  OAuth2 token for --calendar-api (scope: calendar.events)
  GOOGLE_CALENDAR_ID              Default calendar ID (default: primary)
  GOOGLE_CLIENT_ID / GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_CLIENT_SECRET / GOOGLE_OAUTH_CLIENT_SECRET  For --calendar-auth
  GOOGLE_CLIENT_ID/SECRET also used for token refresh when stored token expires

Examples:
  bun run index.ts
  bun run index.ts --json
  bun run index.ts --notify --threshold 90
  bun run index.ts --watch 60 --notify
  bun run index.ts --watch --threshold-five 70 --threshold-week 80
  bun run index.ts --calendar
  bun run index.ts --calendar --calendar-open
  bun run index.ts --calendar --calendar-api --calendar-id primary
  GOOGLE_OAUTH_TOKEN=\$(gcloud auth print-access-token) bun run index.ts --calendar --calendar-api
  # First time OAuth:
  GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com GOOGLE_CLIENT_SECRET=GOCSPX-xxx bun run index.ts --calendar-auth
  bun run index.ts --calendar --calendar-api
`);
}

async function runOnce(opts: NotifierOptions): Promise<ClaudeUsage> {
  const token = opts.token ?? (await getClaudeToken());
  const usage = await getClaudeUsage(token);

  if (opts.json) {
    console.log(JSON.stringify(usage, null, 2));
  } else {
    console.log(formatUsage(usage));
    // also show compact json-friendly line for piping
    console.log("");
    console.log(
      JSON.stringify({
        fiveHourUsed: usage.five_hour?.utilization,
        fiveHourReset: usage.five_hour?.resets_at,
        weekUsed: usage.seven_day?.utilization,
        weekReset: usage.seven_day?.resets_at,
      }),
    );
  }

  if (opts.notify) {
    const thFive = opts.thresholdFiveHour ?? 80;
    const thWeek = opts.thresholdSevenDay ?? 80;
    const { notify, reasons } = shouldNotify(usage, thFive, thWeek);
    if (notify) {
      const title = "Claude Code usage alert";
      const body = reasons.join(", ");
      const subtitle = `5h ${usage.five_hour?.utilization ?? "-"}% / 7d ${usage.seven_day?.utilization ?? "-"}%`;
      console.log(`\n[notify] ${title}: ${body} (${subtitle})`);
      await sendMacNotification(title, body, subtitle);
    } else {
      if (!opts.json) console.log(`\n[notify] thresholds not exceeded (5h < ${thFive}%, 7d < ${thWeek}%) - no notification sent`);
    }
  }

  if (opts.calendar) {
    await handleCalendar(usage, opts);
  }

  return usage;
}

// Only run CLI when executed directly (not imported)
const isMain = import.meta.main ?? import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  // also support `bun index.ts` where argv may include `index.ts` handling is already done by Bun
  const opts = parseArgs(argv);

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.calendarAuth) {
    try {
      await runGoogleCalendarAuth({ port: opts.calendarAuthPort });
      process.exit(0);
    } catch (e) {
      console.error(`[calendar-auth] error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  // defaults
  opts.thresholdFiveHour ??= 80;
  opts.thresholdSevenDay ??= 80;

  if (opts.watchIntervalSec && opts.watchIntervalSec > 0) {
    console.log(`[ccusage-notifier] watching every ${opts.watchIntervalSec}s (Ctrl+C to stop) -- thresholds 5h=${opts.thresholdFiveHour}% 7d=${opts.thresholdSevenDay}% ${opts.notify ? "with notify" : ""}`);
    // run immediately
    await runOnce(opts).catch((e) => {
      console.error(`[error] ${e instanceof Error ? e.message : String(e)}`);
    });
    const interval = setInterval(async () => {
      console.log(`\n[${new Date().toISOString()}] checking...`);
      try {
        await runOnce(opts);
      } catch (e) {
        console.error(`[error] ${e instanceof Error ? e.message : String(e)}`);
      }
    }, opts.watchIntervalSec * 1000);
    // graceful shutdown
    process.on("SIGINT", () => {
      clearInterval(interval);
      console.log("\n[ccusage-notifier] stopped");
      process.exit(0);
    });
  } else {
    try {
      await runOnce(opts);
    } catch (e) {
      console.error(`[ccusage-notifier] error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
}
