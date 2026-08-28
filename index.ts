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
  --once                          Run once even if --watch is set (default)
  -h, --help                      Show this help

Env:
  CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_OAUTH_TOKEN / CLAUDE_TOKEN  Override keychain token

Examples:
  bun run index.ts
  bun run index.ts --json
  bun run index.ts --notify --threshold 90
  bun run index.ts --watch 60 --notify
  bun run index.ts --watch --threshold-five 70 --threshold-week 80
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
