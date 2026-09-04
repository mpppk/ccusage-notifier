#!/usr/bin/env bun

/**
 * ccusage-notifier - Claude Code & Codex usage fetcher & Google Calendar sync
 *
 * Fetches Claude via Anthropic OAuth API and Codex via ChatGPT backend wham/usage.
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

// ---------------------------------------------------------------------------
// Codex types
// ---------------------------------------------------------------------------

export type CodexRateLimitWindow = {
  used_percent: number | null;
  limit_window_seconds: number | null;
  reset_at: number | null; // epoch seconds
  reset_after_seconds: number | null;
};

export type CodexRawUsage = {
  plan_type?: string | null;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: CodexRateLimitWindow | null;
    secondary_window?: CodexRateLimitWindow | null;
  } | null;
  credits?: unknown;
  rate_limit_reset_credits?: unknown;
  [k: string]: unknown;
};

export type CodexUsage = {
  plan_type: string | null;
  five_hour: UsageBucket | null;
  seven_day: UsageBucket | null;
  primary_window: CodexRateLimitWindow | null;
  secondary_window: CodexRateLimitWindow | null;
  raw: CodexRawUsage;
};

export type CombinedUsage = {
  claude: ClaudeUsage | null;
  codex: CodexUsage | null;
};

export type NotifierOptions = {
  json?: boolean;
  watchIntervalSec?: number;
  token?: string; // claude token override
  codexToken?: string;
  calendar?: boolean;
  calendarApi?: boolean;
  calendarId?: string;
  calendarAuth?: boolean;
  calendarAuthPort?: number;
  calendarOpen?: boolean;
  claude?: boolean;
  codex?: boolean;
  all?: boolean;
};

// ---------------------------------------------------------------------------
// Token retrieval - Claude
// ---------------------------------------------------------------------------

export async function getClaudeToken(): Promise<string> {
  const envToken =
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??
    process.env.ANTHROPIC_OAUTH_TOKEN ??
    process.env.CLAUDE_TOKEN;
  if (envToken) return envToken.trim();

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
    if (typeof parsed === "string" && parsed.startsWith("sk-ant-")) return parsed;
    throw new Error("claudeAiOauth.accessToken not found in keychain JSON");
  } catch (e) {
    if (trimmed.startsWith("sk-ant-")) return trimmed;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Token retrieval - Codex
// ---------------------------------------------------------------------------

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? "https://auth.openai.com/oauth/token";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type CodexAuthFile = {
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string | null;
  };
  OPENAI_API_KEY?: string | null;
  auth_mode?: string;
  last_refresh?: string | null;
};

function getCodexAuthFilePath(): string {
  const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME ?? "."}/.codex`;
  return `${codexHome}/auth.json`;
}

async function readCodexAuthFile(): Promise<CodexAuthFile | null> {
  const candidates = [
    getCodexAuthFilePath(),
    `${process.env.HOME ?? "."}/.codex/auth.json`,
  ];
  // dedup
  const seen = new Set<string>();
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const file = Bun.file(p);
      if (await file.exists()) {
        const json = (await file.json()) as CodexAuthFile;
        if (json?.tokens?.access_token || json?.OPENAI_API_KEY) return json;
      }
    } catch {}
  }
  return null;
}

async function writeCodexAuthFile(updated: CodexAuthFile): Promise<void> {
  const path = getCodexAuthFilePath();
  const dir = path.substring(0, path.lastIndexOf("/"));
  const proc = Bun.spawn(["mkdir", "-p", dir], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  // Preserve formatting similar to Codex (pretty JSON)
  await Bun.write(path, JSON.stringify(updated, null, 2));
  const chmod = Bun.spawn(["chmod", "600", path], { stdout: "pipe", stderr: "pipe" });
  await chmod.exited;
}

function parseJwtExp(jwt: string): number | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1]!;
    const pad = payload.length % 4 === 0 ? "" : "=".repeat(4 - (payload.length % 4));
    const decoded = Buffer.from(payload + pad, "base64url").toString("utf-8");
    const obj = JSON.parse(decoded);
    if (typeof obj.exp === "number") return obj.exp;
    return null;
  } catch {
    return null;
  }
}

function isJwtExpiringSoon(jwt: string, skewSec = 600): boolean {
  const exp = parseJwtExp(jwt);
  if (exp == null) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return exp - nowSec < skewSec;
}

async function refreshCodexAccessToken(refreshToken: string): Promise<{ access_token: string; id_token?: string; refresh_token?: string }> {
  const clientId = process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID ?? process.env.CLIENT_ID_OVERRIDE ?? CODEX_CLIENT_ID;
  const endpoint = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? CODEX_TOKEN_URL;
  const body = JSON.stringify({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Codex token refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { access_token?: string; id_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error("Codex refresh response missing access_token");
  return data as { access_token: string; id_token?: string; refresh_token?: string };
}

export async function getCodexToken(): Promise<string> {
  const envToken =
    process.env.CODEX_ACCESS_TOKEN ??
    process.env.OPENAI_CODEX_ACCESS_TOKEN ??
    process.env.CODEX_BEARER_TOKEN ??
    process.env.OPENAI_API_KEY; // fallback if user stores codex api key (will fail for wham but try)
  if (envToken) {
    const trimmed = envToken.trim();
    if (trimmed) return trimmed;
  }

  const authFile = await readCodexAuthFile();
  if (!authFile) {
    throw new Error(
      `Codex auth not found at ${getCodexAuthFilePath()}. Run "codex login" or set CODEX_ACCESS_TOKEN env var.`,
    );
  }
  // If API key mode, just return it (though wham may not work)
  if (authFile.OPENAI_API_KEY && !authFile.tokens?.access_token) {
    return authFile.OPENAI_API_KEY;
  }
  const tokens = authFile.tokens;
  if (!tokens?.access_token) {
    throw new Error(`Codex auth file ${getCodexAuthFilePath()} missing tokens.access_token`);
  }
  // Proactive refresh if expiring soon and refresh_token available
  if (tokens.refresh_token && isJwtExpiringSoon(tokens.access_token, 600)) {
    try {
      console.log("[codex] Access token expiring soon, refreshing...");
      const refreshed = await refreshCodexAccessToken(tokens.refresh_token);
      const updated: CodexAuthFile = {
        ...authFile,
        tokens: {
          ...tokens,
          access_token: refreshed.access_token,
          ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
          ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
        },
        last_refresh: new Date().toISOString(),
      };
      await writeCodexAuthFile(updated);
      console.log("[codex] Token refreshed and saved");
      return refreshed.access_token;
    } catch (e) {
      console.warn(`[codex] Proactive refresh failed: ${e instanceof Error ? e.message : String(e)}, using existing token`);
    }
  }
  return tokens.access_token;
}

export async function getCodexAccountId(): Promise<string | null> {
  const envId = process.env.CHATGPT_ACCOUNT_ID ?? process.env.OPENAI_ACCOUNT_ID;
  if (envId) return envId;
  const authFile = await readCodexAuthFile();
  return authFile?.tokens?.account_id ?? null;
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

function codexEpochToIso(epoch: number | null | undefined): string | null {
  if (epoch == null) return null;
  // epoch is seconds since unix epoch
  const ms = epoch * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeCodexUsage(raw: CodexRawUsage): CodexUsage {
  const primary = raw.rate_limit?.primary_window ?? null;
  const secondary = raw.rate_limit?.secondary_window ?? null;

  const toBucket = (w: CodexRateLimitWindow | null | undefined): UsageBucket | null => {
    if (!w) return null;
    // used_percent present, reset_at is epoch seconds
    const utilization = w.used_percent ?? null;
    const resets_at = codexEpochToIso(w.reset_at ?? null);
    return { utilization, resets_at };
  };

  // Heuristic: primary is 5h (18000s), secondary is weekly (604800s)
  // But if backend flips, we can detect via window_seconds
  let fiveHourRaw = primary;
  let weeklyRaw = secondary;
  // If window sizes hint differently, swap
  if (primary && secondary) {
    const pSec = primary.limit_window_seconds;
    const sSec = secondary.limit_window_seconds;
    if (pSec === 604800 && sSec === 18000) {
      fiveHourRaw = secondary;
      weeklyRaw = primary;
    }
  }

  return {
    plan_type: (raw.plan_type as string) ?? null,
    five_hour: toBucket(fiveHourRaw),
    seven_day: toBucket(weeklyRaw),
    primary_window: primary ?? null,
    secondary_window: secondary ?? null,
    raw,
  };
}

export async function getCodexUsage(token: string, accountId?: string | null): Promise<CodexUsage> {
  const attemptFetch = async (tok: string): Promise<CodexRawUsage> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "OpenAI-Beta": "codex-1",
      originator: "codex_cli_rs",
    };
    const resolvedAccountId = accountId ?? (await getCodexAccountId());
    if (resolvedAccountId) headers["ChatGPT-Account-ID"] = resolvedAccountId;
    const res = await fetch(CODEX_USAGE_URL, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`codex usage fetch failed: ${res.status} ${body}`);
    }
    return (await res.json()) as CodexRawUsage;
  };

  try {
    const raw = await attemptFetch(token);
    return normalizeCodexUsage(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAuthError = msg.includes("401") || msg.toLowerCase().includes("unauthorized") || msg.includes("403");
    if (!isAuthError) throw e;
    // Try refresh flow if we have a refresh_token
    const authFile = await readCodexAuthFile();
    const refreshToken = authFile?.tokens?.refresh_token;
    if (!refreshToken) throw e;
    // Avoid infinite loop: only try once
    console.log("[codex] Usage fetch auth failed, attempting token refresh...");
    try {
      const refreshed = await refreshCodexAccessToken(refreshToken);
      const updated: CodexAuthFile = {
        ...(authFile as CodexAuthFile),
        tokens: {
          ...(authFile!.tokens as NonNullable<CodexAuthFile["tokens"]>),
          access_token: refreshed.access_token,
          ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
          ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
        },
        last_refresh: new Date().toISOString(),
      };
      await writeCodexAuthFile(updated);
      console.log("[codex] Token refreshed after 401, retrying usage fetch...");
      const raw2 = await attemptFetch(refreshed.access_token);
      return normalizeCodexUsage(raw2);
    } catch (refreshErr) {
      console.warn(`[codex] Refresh after 401 failed: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`);
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatResetsAt(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (date: Date) =>
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
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

export function formatCodexUsage(usage: CodexUsage): string {
  const five = usage.five_hour;
  const seven = usage.seven_day;
  const lines: string[] = [];
  const planLabel = usage.plan_type ? ` (${usage.plan_type})` : "";
  lines.push(`Codex Usage${planLabel}`);
  lines.push("────────────────────────────────────────");
  // Codex primary = 5h session
  lines.push(
    `${severityEmoji(five?.utilization)} 5-hour : ${five?.utilization ?? "-"}% ${bar(five?.utilization)}  reset: ${formatResetsAt(five?.resets_at)}`,
  );
  lines.push(
    `${severityEmoji(seven?.utilization)} weekly : ${seven?.utilization ?? "-"}% ${bar(seven?.utilization)}  reset: ${formatResetsAt(seven?.resets_at)}`,
  );
  if (usage.raw.rate_limit) {
    const rl = usage.raw.rate_limit as { allowed?: boolean; limit_reached?: boolean };
    if (rl.allowed != null || rl.limit_reached != null) {
      lines.push(`   allowed: ${rl.allowed ?? "-"}  limit_reached: ${rl.limit_reached ?? "-"}`);
    }
  }
  // Show raw windows if present for debugging
  if (usage.primary_window || usage.secondary_window) {
    const pw = usage.primary_window;
    const sw = usage.secondary_window;
    if (pw) lines.push(`   primary_window: ${pw.used_percent ?? "-"}% window=${pw.limit_window_seconds ?? "-"}s reset=${formatResetsAt(codexEpochToIso(pw.reset_at))}`);
    if (sw) lines.push(`   secondary_window: ${sw.used_percent ?? "-"}% window=${sw.limit_window_seconds ?? "-"}s reset=${formatResetsAt(codexEpochToIso(sw.reset_at))}`);
  }
  return lines.join("\n");
}

export function formatCombinedUsage(combined: CombinedUsage): string {
  const parts: string[] = [];
  if (combined.claude) {
    parts.push(formatUsage(combined.claude));
  } else {
    parts.push("Claude Code Usage\n────────────────────────────────────────\n(unavailable - no auth or fetch failed)");
  }
  if (combined.codex) {
    if (parts.length > 0) parts.push("");
    parts.push(formatCodexUsage(combined.codex));
  } else {
    if (combined.claude) {
      // when default both, show placeholder if codex missing but claude succeeded? Only if codex was requested
      // handled by caller printing warnings
    }
  }
  // If both null, caller would have errored
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Google Calendar integration
// ---------------------------------------------------------------------------

export type CalendarEventInput = {
  summary: string;
  description: string;
  startIso: string;
  durationMinutes?: number;
  kind?: "five_hour" | "weekly" | "codex_five_hour" | "codex_weekly";
  product?: "claude" | "codex";
};

function toGoogleCalendarDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
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
      description: `Claude Code 5-hour usage ${util ?? "-"}% resets. Weekly: ${usage.seven_day?.utilization ?? "-"}%.`,
      startIso: usage.five_hour.resets_at,
      durationMinutes: 15,
      kind: "five_hour",
      product: "claude",
    });
  }
  if (usage.seven_day?.resets_at) {
    const util = usage.seven_day.utilization;
    events.push({
      summary: "Claude Code weekly limit reset",
      description: `Claude Code 7-day usage ${util ?? "-"}% resets. 5-hour: ${usage.five_hour?.utilization ?? "-"}%.`,
      startIso: usage.seven_day.resets_at,
      durationMinutes: 15,
      kind: "weekly",
      product: "claude",
    });
  }
  return events;
}

export function buildCodexCalendarEvents(usage: CodexUsage): CalendarEventInput[] {
  const events: CalendarEventInput[] = [];
  if (usage.five_hour?.resets_at) {
    const util = usage.five_hour.utilization;
    events.push({
      summary: "Codex 5-hour limit reset",
      description: `Codex 5-hour usage ${util ?? "-"}% resets. Weekly: ${usage.seven_day?.utilization ?? "-"}%. Plan: ${usage.plan_type ?? "-"}`,
      startIso: usage.five_hour.resets_at,
      durationMinutes: 15,
      kind: "codex_five_hour",
      product: "codex",
    });
  }
  if (usage.seven_day?.resets_at) {
    const util = usage.seven_day.utilization;
    events.push({
      summary: "Codex weekly limit reset",
      description: `Codex weekly usage ${util ?? "-"}% resets. 5-hour: ${usage.five_hour?.utilization ?? "-"}%. Plan: ${usage.plan_type ?? "-"}`,
      startIso: usage.seven_day.resets_at,
      durationMinutes: 15,
      kind: "codex_weekly",
      product: "codex",
    });
  }
  return events;
}

export function buildCombinedCalendarEvents(combined: CombinedUsage): CalendarEventInput[] {
  const events: CalendarEventInput[] = [];
  if (combined.claude) events.push(...buildCalendarEvents(combined.claude));
  if (combined.codex) events.push(...buildCodexCalendarEvents(combined.codex));
  return events;
}

export async function insertGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<unknown> {
  const start = new Date(event.startIso);
  const end = new Date(start.getTime() + (event.durationMinutes ?? 15) * 60 * 1000);
  const kind = event.kind ?? (event.summary.includes("weekly") ? "weekly" : "five_hour");
  const product = event.product ?? (event.summary.includes("Codex") ? "codex" : "claude");
  const body: Record<string, unknown> = {
    summary: event.summary,
    description: event.description,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        source: "ccusage-notifier",
        kind,
        product,
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
  const kind = event.kind ?? (event.summary.includes("weekly") ? "weekly" : "five_hour");
  const product = event.product ?? (event.summary.includes("Codex") ? "codex" : "claude");
  const body: Record<string, unknown> = {
    summary: event.summary,
    description: event.description,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        source: "ccusage-notifier",
        kind,
        product,
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
): Promise<Array<{ id: string; summary?: string; description?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string }; extendedProperties?: { private?: Record<string, string> } }>> {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.timeMin) params.set("timeMin", opts.timeMin);
  if (opts.timeMax) params.set("timeMax", opts.timeMax);
  params.set("singleEvents", "true");
  params.set("orderBy", "startTime");
  params.set("maxResults", String(opts.maxResults ?? 50));
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google Calendar LIST failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: Array<{ id: string; summary?: string; description?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string }; extendedProperties?: { private?: Record<string, string> } }> };
  return data.items ?? [];
}

export async function upsertGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<{ action: "created" | "updated" | "moved" | "skipped"; id: string; htmlLink?: string }> {
  const kind = event.kind ?? (event.summary.includes("weekly") ? "weekly" : "five_hour");
  const product = event.product ?? (event.summary.includes("Codex") ? "codex" : "claude");
  const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  // Choose query based on product
  const query = product === "codex" ? "Codex" : "Claude Code";
  const items = await listGoogleCalendarEvents(accessToken, calendarId, {
    q: query,
    timeMin,
    timeMax,
    maxResults: 50,
  });

  const normalizeKind = (k: string) => k.replace(/^codex_/, "");
  const expectedNorm = normalizeKind(kind);

  const candidates = items.filter((it) => {
    if (!it.summary) return false;
    const priv = it.extendedProperties?.private;
    const marker = priv?.source;
    const p = priv?.product;
    const k = priv?.kind;
    // If event has explicit product/kind in extendedProperties, match strictly
    if (p) {
      if (p !== product) return false;
      if (k && normalizeKind(k) !== expectedNorm) return false;
      // summary should match expected product prefix
      if (product === "codex" && !it.summary.includes("Codex")) return false;
      if (product === "claude" && !it.summary.includes("Claude Code")) return false;
      // kind vs summary
      const isKindMatch = (expectedNorm === "five_hour" && it.summary.includes("5-hour")) || (expectedNorm === "weekly" && it.summary.includes("weekly"));
      if (!isKindMatch) return false;
      if (marker) return marker === "ccusage-notifier";
      return true;
    }
    // Legacy fallback: no product marker
    if (marker && marker !== "ccusage-notifier") return false;
    // Must match product by summary
    if (product === "codex") {
      if (!it.summary.includes("Codex")) return false;
    } else {
      if (!it.summary.includes("Claude Code")) return false;
    }
    const isSameKind =
      (expectedNorm === "five_hour" && it.summary.includes("5-hour")) || (expectedNorm === "weekly" && it.summary.includes("weekly"));
    if (!isSameKind) return false;
    if (marker) return marker === "ccusage-notifier";
    return true;
  });

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

  const primary = candidates[0]!;
  const primarySec = primary.start?.dateTime ? toSec(primary.start.dateTime) : null;
  const isSameTime = primarySec === wantedSec;
  const isSameDescription = (primary.description ?? "") === event.description;
  const isSameSummary = (primary.summary ?? "") === event.summary;

  // If nothing changed, skip PATCH entirely to avoid unnecessary API calls
  if (isSameTime && isSameDescription && isSameSummary) {
    // Still clean up duplicates if any
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
    return { action: "skipped", id: primary.id, htmlLink: (primary as { htmlLink?: string }).htmlLink };
  }

  const patched = (await patchGoogleCalendarEvent(accessToken, calendarId, primary.id, event)) as {
    id: string;
    htmlLink?: string;
  };

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
  expires_at?: number;
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
  const proc = Bun.spawn(["mkdir", "-p", dir], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  await Bun.write(path, JSON.stringify(token, null, 2));
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

  const openProc = Bun.spawn(["open", authUrl.toString()], { stdout: "pipe", stderr: "pipe" });
  await openProc.exited;

  console.log("[calendar-auth] Waiting for OAuth callback... (Ctrl+C to cancel)");

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
  const isZero = (usage.five_hour?.utilization ?? 0) === 0;
  if (!isZero) return usage;
  const ping = await triggerClaudePing("ping");
  if (!ping.success) {
    console.warn("[calendar] Skipping 5h reset refresh due to ping failure");
    return usage;
  }
  for (let i = 0; i < maxRetries; i++) {
    await Bun.sleep(2000);
    try {
      const refreshed = await getClaudeUsage(claudeToken);
      if (refreshed.five_hour?.resets_at) {
        console.log(`[calendar] New 5-hour reset obtained: ${refreshed.five_hour.resets_at} (after ${i + 1} poll(s))`);
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

export async function handleCalendar(combinedOrClaude: CombinedUsage | ClaudeUsage, opts: NotifierOptions): Promise<void> {
  // Back-compat: allow passing ClaudeUsage directly
  let combined: CombinedUsage;
  if (
    combinedOrClaude &&
    typeof combinedOrClaude === "object" &&
    "claude" in (combinedOrClaude as Record<string, unknown>) &&
    "codex" in (combinedOrClaude as Record<string, unknown>)
  ) {
    combined = combinedOrClaude as CombinedUsage;
  } else {
    combined = { claude: combinedOrClaude as ClaudeUsage, codex: null };
  }
  // Handle Claude 5h null auto-ping
  let effectiveCombined = { ...combined };
  if (combined.claude && !combined.claude.five_hour?.resets_at && opts.calendar) {
    const isZero = (combined.claude.five_hour?.utilization ?? 0) === 0;
    if (isZero) {
      try {
        const claudeToken = opts.token ?? (await getClaudeToken());
        effectiveCombined.claude = await ensureFiveHourReset(combined.claude, claudeToken);
      } catch (e) {
        console.warn(`[calendar] ensureFiveHourReset failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const events = buildCombinedCalendarEvents(effectiveCombined);
  // Determine missing kinds per product
  type KindWithProduct = { kind: "five_hour" | "weekly" | "codex_five_hour" | "codex_weekly"; product: "claude" | "codex" };
  const missing: KindWithProduct[] = [];
  if (effectiveCombined.claude) {
    if (!effectiveCombined.claude.seven_day?.resets_at) missing.push({ kind: "weekly", product: "claude" });
    if (!effectiveCombined.claude.five_hour?.resets_at) missing.push({ kind: "five_hour", product: "claude" });
  }
  // For Codex, if we requested codex but have null resets, we also consider missing
  if (effectiveCombined.codex) {
    if (!effectiveCombined.codex.five_hour?.resets_at) missing.push({ kind: "codex_five_hour", product: "codex" });
    if (!effectiveCombined.codex.seven_day?.resets_at) missing.push({ kind: "codex_weekly", product: "codex" });
  } else if (opts.codex && events.length === 0) {
    // If codex requested but no usage, no events; but we still want to note
  }

  // If effective has no events at all but some product had usage null, we still need to report
  const hasEvents = events.length > 0;
  if (!hasEvents) {
    console.log("[calendar] No reset times available in usage data (all resets_at are null)");
    if (missing.length > 0 && opts.calendarApi) {
      const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      const token = await getGoogleAccessToken(clientId, clientSecret);
      if (!token) {
        console.error("[calendar] No auth for deletion");
        return;
      }
      const calendarId = opts.calendarId ?? process.env.GOOGLE_CALENDAR_ID ?? "primary";
      for (const m of missing) {
        const count = await deleteCalendarEventsByKind(token, calendarId, m.kind, m.product);
        console.log(`[calendar] Deleted ${count} stale event(s) for ${m.product}/${m.kind} (reset is null)`);
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
  if (missing.length > 0) {
    for (const k of missing) {
      // Only print missing if that product had some events? Actually we printed events; missing ones are those with null reset
      // To avoid noise when codex not requested, only print if that product was in combined
      const hasProductEvents = events.some((e) => e.product === k.product);
      if (!hasProductEvents && k.product === "codex" && !effectiveCombined.codex) continue;
      if (!hasProductEvents && k.product === "claude" && !effectiveCombined.claude) continue;
      // But we already have filtered: if product's both resets null, hasProductEvents false, we still want to note deletion
      // So we print regardless if that product had any usage object
      const label = k.kind.includes("five_hour") ? "5-hour" : "weekly";
      console.log(`  - ${k.product} ${label}: reset is null -> existing events for ${k.product}/${k.kind} will be deleted`);
    }
  }

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
        "[calendar] --calendar-api requires auth. Run: bun run index.ts --calendar-auth (then --calendar --calendar-api)\n" +
          "  See README for OAuth setup. Scope required: https://www.googleapis.com/auth/calendar.events",
      );
      return;
    }
    const calendarId = opts.calendarId ?? process.env.GOOGLE_CALENDAR_ID ?? "primary";

    for (const m of missing) {
      try {
        const count = await deleteCalendarEventsByKind(token, calendarId, m.kind, m.product);
        if (count > 0) console.log(`[calendar] Deleted ${count} stale event(s) for ${m.product}/${m.kind} (reset is null)`);
        else console.log(`[calendar] No stale events to delete for ${m.product}/${m.kind}`);
      } catch (e) {
        console.error(`[calendar] Failed to delete ${m.product}/${m.kind} events: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(`[calendar] Upserting ${events.length} event(s) via API to calendar: ${calendarId} (existing events will be moved)`);
    for (const ev of events) {
      try {
        const result = await upsertGoogleCalendarEvent(token, calendarId, ev);
        const label =
          result.action === "moved"
            ? "moved"
            : result.action === "updated"
              ? "updated"
              : result.action === "skipped"
                ? "skipped (no change)"
                : "created";
        console.log(`  ${result.action === "skipped" ? "○" : "✓"} ${ev.summary} [${label}] -> ${result.htmlLink ?? result.id}`);
      } catch (e) {
        console.error(`  ✗ ${ev.summary} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

// Backwards compat: allow old signature handleCalendar(usage, opts) where usage is ClaudeUsage
export async function handleCalendarLegacy(usage: ClaudeUsage, opts: NotifierOptions): Promise<void> {
  return handleCalendar({ claude: usage, codex: null }, opts);
}

export async function deleteCalendarEventsByKind(
  accessToken: string,
  calendarId: string,
  kind: "five_hour" | "weekly" | "codex_five_hour" | "codex_weekly",
  product: "claude" | "codex" = "claude",
): Promise<number> {
  const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const q = product === "codex" ? "Codex" : "Claude Code";
  const items = await listGoogleCalendarEvents(accessToken, calendarId, {
    q,
    timeMin,
    timeMax,
    maxResults: 50,
  });
  const norm = (k: string) => k.replace(/^codex_/, "");
  const expectedNorm = norm(kind);
  const targets = items.filter((it) => {
    if (!it.summary) return false;
    const priv = it.extendedProperties?.private;
    const p = priv?.product;
    const k = priv?.kind;
    const marker = priv?.source;
    // If product present, require match
    if (p) {
      if (p !== product) return false;
      if (k && norm(k) !== expectedNorm) return false;
      const isSameKind = (expectedNorm === "five_hour" && it.summary.includes("5-hour")) || (expectedNorm === "weekly" && it.summary.includes("weekly"));
      if (!isSameKind) return false;
      if (product === "codex" && !it.summary.includes("Codex")) return false;
      if (product === "claude" && !it.summary.includes("Claude Code")) return false;
      if (marker) return marker === "ccusage-notifier";
      return true;
    }
    // legacy
    if (product === "codex") {
      if (!it.summary.includes("Codex")) return false;
    } else {
      if (!it.summary.includes("Claude Code")) return false;
    }
    const isSameKind =
      (expectedNorm === "five_hour" && it.summary.includes("5-hour")) || (expectedNorm === "weekly" && it.summary.includes("weekly"));
    if (!isSameKind) return false;
    if (marker) return marker === "ccusage-notifier";
    return true;
  });
  for (const it of targets) {
    await deleteGoogleCalendarEvent(accessToken, calendarId, it.id);
  }
  return targets.length;
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
    else if (a === "--once") opts.once = true;
    else if (a === "--calendar") opts.calendar = true;
    else if (a === "--calendar-open") opts.calendarOpen = true;
    else if (a === "--calendar-api") opts.calendarApi = true;
    else if (a === "--calendar-auth") opts.calendarAuth = true;
    else if (a === "--calendar-id") opts.calendarId = argv[++i];
    else if (a.startsWith("--calendar-id=")) opts.calendarId = a.split("=").slice(1).join("=");
    else if (a.startsWith("--calendar-auth-port=")) opts.calendarAuthPort = Number(a.split("=").slice(1).join("="));
    else if (a === "--calendar-auth-port") opts.calendarAuthPort = Number(argv[++i]);
    else if (a === "--claude") opts.claude = true;
    else if (a === "--codex") opts.codex = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--provider" || a === "--service") {
      const v = argv[++i]?.toLowerCase();
      if (v === "claude") opts.claude = true;
      else if (v === "codex") opts.codex = true;
      else if (v === "all" || v === "both") opts.all = true;
    } else if (a.startsWith("--provider=") || a.startsWith("--service=")) {
      const v = a.split("=").slice(1).join("=").toLowerCase();
      if (v === "claude") opts.claude = true;
      else if (v === "codex") opts.codex = true;
      else if (v === "all" || v === "both") opts.all = true;
    } else if (a === "--watch" || a === "-w") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && !isNaN(Number(next))) {
        opts.watchIntervalSec = Number(argv[++i]);
      } else {
        opts.watchIntervalSec = 300;
      }
    } else if (a === "--interval") {
      opts.watchIntervalSec = Number(argv[++i]);
    } else if (a.startsWith("--watch=")) {
      opts.watchIntervalSec = Number(a.split("=")[1]);
    }
  }
  if (opts.calendarOpen) opts.calendar = true;
  if (opts.calendarApi) opts.calendar = true;
  // Resolve provider selection
  const hasClaudeFlag = opts.claude === true;
  const hasCodexFlag = opts.codex === true;
  const hasAllFlag = opts.all === true;
  if (!hasClaudeFlag && !hasCodexFlag && !hasAllFlag) {
    // default: both
    opts.claude = true;
    opts.codex = true;
  } else if (hasAllFlag) {
    opts.claude = true;
    opts.codex = true;
  } else {
    // explicit flags only
    opts.claude = hasClaudeFlag;
    opts.codex = hasCodexFlag;
    // if both flags were passed, both true already
    if (hasClaudeFlag && hasCodexFlag) {
      opts.claude = true;
      opts.codex = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
ccusage-notifier - Claude Code & Codex usage fetcher & Google Calendar sync

Usage:
  bun run index.ts [options]

Options:
  --json                          Output raw JSON instead of pretty table
  --watch [sec]                   Poll every <sec> seconds (default 300) until Ctrl+C
  --interval <sec>                Alias for --watch
  --claude                        Show only Claude Code usage
  --codex                         Show only Codex usage
  --all                           Show both Claude and Codex (default)
  --provider <claude|codex|all>   Alias for --claude/--codex/--all
  --calendar                      Generate Google Calendar events for reset times
  --calendar-open                 Also open Google Calendar template URL in browser
  --calendar-api                  Sync events via Google Calendar API (refresh_token only)
                                  When 5h is 0% with no reset, auto-runs 'claude -p ping' to start new session
  --calendar-id <id>              Target calendar ID for --calendar-api (default: primary)
  --calendar-auth                 Start OAuth flow to obtain Google Calendar token (needs GOOGLE_CLIENT_ID/SECRET)
  --calendar-auth-port <port>     Port for OAuth callback server (default: 8085)
  --once                          Run once even if --watch is set (default)
  -h, --help                      Show this help

Env:
  CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_OAUTH_TOKEN / CLAUDE_TOKEN  Override claude keychain token
  CODEX_ACCESS_TOKEN / OPENAI_CODEX_ACCESS_TOKEN / CODEX_BEARER_TOKEN  Override Codex token (else ~/.codex/auth.json)
  CODEX_HOME                      Path to Codex home (default ~/.codex)
  CHATGPT_ACCOUNT_ID              Override Codex account ID
  CODEX_REFRESH_TOKEN_URL_OVERRIDE  Override Codex refresh endpoint
  GOOGLE_REFRESH_TOKEN            Refresh token for --calendar-api (with GOOGLE_CLIENT_ID/SECRET)
  GOOGLE_CALENDAR_ID              Default calendar ID (default: primary)
  GOOGLE_CLIENT_ID / GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_CLIENT_SECRET / GOOGLE_OAUTH_CLIENT_SECRET  For --calendar-auth and token refresh

Examples:
  bun run index.ts
  bun run index.ts --codex --json
  bun run index.ts --claude --json
  bun run index.ts --json                 # both
  bun run index.ts --watch 300 --calendar --calendar-api
  bun run index.ts --calendar
  bun run index.ts --calendar --calendar-open
  bun run index.ts --calendar --calendar-api --calendar-id primary
  bun run index.ts --codex --calendar --calendar-api
  # First time OAuth (refresh_token):
  GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com GOOGLE_CLIENT_SECRET=GOCSPX-xxx bun run index.ts --calendar-auth
  bun run index.ts --calendar --calendar-api
`);
}

async function runOnce(opts: NotifierOptions): Promise<CombinedUsage> {
  let claudeUsage: ClaudeUsage | null = null;
  let codexUsage: CodexUsage | null = null;
  let claudeError: string | null = null;
  let codexError: string | null = null;

  const shouldFetchClaude = opts.claude === true;
  const shouldFetchCodex = opts.codex === true;

  if (shouldFetchClaude) {
    try {
      const token = opts.token ?? (await getClaudeToken());
      claudeUsage = await getClaudeUsage(token);
    } catch (e) {
      claudeError = e instanceof Error ? e.message : String(e);
      // If only claude requested, we will handle error after both fetches
      console.warn(`[claude] fetch failed: ${claudeError}`);
    }
  }

  if (shouldFetchCodex) {
    try {
      const token = opts.codexToken ?? (await getCodexToken());
      const accountId = await getCodexAccountId();
      codexUsage = await getCodexUsage(token, accountId);
    } catch (e) {
      codexError = e instanceof Error ? e.message : String(e);
      console.warn(`[codex] fetch failed: ${codexError}`);
    }
  }

  if (!claudeUsage && !codexUsage) {
    // Both failed or nothing requested
    if (shouldFetchClaude && shouldFetchCodex) {
      throw new Error(`Both Claude and Codex fetch failed:\n  claude: ${claudeError ?? "unknown"}\n  codex: ${codexError ?? "unknown"}`);
    } else if (shouldFetchClaude) {
      throw new Error(`Claude fetch failed: ${claudeError ?? "unknown"}`);
    } else if (shouldFetchCodex) {
      throw new Error(`Codex fetch failed: ${codexError ?? "unknown"}`);
    } else {
      throw new Error("No provider selected");
    }
  }

  const combined: CombinedUsage = { claude: claudeUsage, codex: codexUsage };

  if (opts.json) {
    // Output combined JSON: preserve raw shapes plus normalized summary
    const out: Record<string, unknown> = {};
    if (claudeUsage) out.claude = claudeUsage;
    if (codexUsage) out.codex = codexUsage.raw ?? codexUsage;
    // Also include normalized convenience fields
    out.combined = {
      claude: claudeUsage
        ? {
            fiveHourUsed: claudeUsage.five_hour?.utilization,
            fiveHourReset: claudeUsage.five_hour?.resets_at,
            weekUsed: claudeUsage.seven_day?.utilization,
            weekReset: claudeUsage.seven_day?.resets_at,
          }
        : null,
      codex: codexUsage
        ? {
            fiveHourUsed: codexUsage.five_hour?.utilization,
            fiveHourReset: codexUsage.five_hour?.resets_at,
            weekUsed: codexUsage.seven_day?.utilization,
            weekReset: codexUsage.seven_day?.resets_at,
            plan: codexUsage.plan_type,
          }
        : null,
    };
    // Backward compat: if only claude, also output top-level raw for existing scripts
    if (claudeUsage && !codexUsage) {
      // keep original top-level as claude raw for compatibility
      console.log(JSON.stringify(claudeUsage, null, 2));
    } else if (!claudeUsage && codexUsage) {
      console.log(JSON.stringify(out.codex, null, 2));
    } else {
      // Both providers: include legacy flat fields for Claude for backward compat,
      // plus codex-prefixed fields
      if (claudeUsage) {
        out.fiveHourUsed = claudeUsage.five_hour?.utilization;
        out.fiveHourReset = claudeUsage.five_hour?.resets_at;
        out.weekUsed = claudeUsage.seven_day?.utilization;
        out.weekReset = claudeUsage.seven_day?.resets_at;
      }
      if (codexUsage) {
        out.codexFiveHourUsed = codexUsage.five_hour?.utilization;
        out.codexFiveHourReset = codexUsage.five_hour?.resets_at;
        out.codexWeekUsed = codexUsage.seven_day?.utilization;
        out.codexWeekReset = codexUsage.seven_day?.resets_at;
        out.codexPlan = codexUsage.plan_type;
      }
      console.log(JSON.stringify(out, null, 2));
    }
  } else {
    // Pretty table
    if (claudeUsage && codexUsage) {
      console.log(formatCombinedUsage(combined));
    } else if (claudeUsage) {
      console.log(formatUsage(claudeUsage));
    } else if (codexUsage) {
      console.log(formatCodexUsage(codexUsage));
    }
    console.log("");
    // Also print minimal JSON line for scripting (combined)
    const summary: Record<string, unknown> = {};
    if (claudeUsage) {
      summary.claude = {
        fiveHourUsed: claudeUsage.five_hour?.utilization,
        fiveHourReset: claudeUsage.five_hour?.resets_at,
        weekUsed: claudeUsage.seven_day?.utilization,
        weekReset: claudeUsage.seven_day?.resets_at,
      };
    }
    if (codexUsage) {
      summary.codex = {
        fiveHourUsed: codexUsage.five_hour?.utilization,
        fiveHourReset: codexUsage.five_hour?.resets_at,
        weekUsed: codexUsage.seven_day?.utilization,
        weekReset: codexUsage.seven_day?.resets_at,
        plan: codexUsage.plan_type,
      };
    }
    // If single provider, keep legacy flat shape as well for backward compat
    if (claudeUsage && !codexUsage) {
      console.log(
        JSON.stringify({
          fiveHourUsed: claudeUsage.five_hour?.utilization,
          fiveHourReset: claudeUsage.five_hour?.resets_at,
          weekUsed: claudeUsage.seven_day?.utilization,
          weekReset: claudeUsage.seven_day?.resets_at,
        }),
      );
    } else if (!claudeUsage && codexUsage) {
      console.log(
        JSON.stringify({
          fiveHourUsed: codexUsage.five_hour?.utilization,
          fiveHourReset: codexUsage.five_hour?.resets_at,
          weekUsed: codexUsage.seven_day?.utilization,
          weekReset: codexUsage.seven_day?.resets_at,
          plan: codexUsage.plan_type,
        }),
      );
    } else {
      // Both providers: keep nested plus legacy flat for Claude for backward compat
      const legacySummary: Record<string, unknown> = {
        ...summary,
        fiveHourUsed: claudeUsage?.five_hour?.utilization,
        fiveHourReset: claudeUsage?.five_hour?.resets_at,
        weekUsed: claudeUsage?.seven_day?.utilization,
        weekReset: claudeUsage?.seven_day?.resets_at,
        codexFiveHourUsed: codexUsage?.five_hour?.utilization,
        codexFiveHourReset: codexUsage?.five_hour?.resets_at,
        codexWeekUsed: codexUsage?.seven_day?.utilization,
        codexWeekReset: codexUsage?.seven_day?.resets_at,
      };
      console.log(JSON.stringify(legacySummary));
    }
    // Warnings for partial failures
    if (claudeError && shouldFetchClaude && !claudeUsage) console.warn(`[claude] ${claudeError}`);
    if (codexError && shouldFetchCodex && !codexUsage) console.warn(`[codex] ${codexError}`);
  }

  if (opts.calendar) {
    await handleCalendar(combined, opts);
  }

  return combined;
}

// Only run CLI when executed directly (not imported)
const isMain = import.meta.main ?? import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
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

  if (opts.watchIntervalSec && opts.watchIntervalSec > 0) {
    console.log(`[ccusage-notifier] watching every ${opts.watchIntervalSec}s (Ctrl+C to stop)`);
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
