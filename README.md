# ccusage-notifier

Claude Code (`5-hour` / `7-day`, Anthropic OAuth API) と Codex (`5-hour` / `weekly`, `https://chatgpt.com/backend-api/wham/usage`) の利用量を取得して表示・Googleカレンダーへ同期する Bun 製 CLI。

## 検証済み

```
$ bun run index.ts
Claude Code Usage
────────────────────────────────────────
⚪ 5-hour : 1% ░░░░░░░░░░░░░░░░░░░░  reset: 2026-08-29 05:19:59 UTC (2026-08-29 14:19:59 JST, in 4h 50m)
🟢 7-day  : 52% ██████████░░░░░░░░░░  reset: 2026-09-02 19:00:00 UTC (2026-09-03 04:00:00 JST, in 114h 32m)
   extra_usage: disabled 0% (used 0/500)
────────────────────────────────────────
Limits:
  - session (session): 0% [normal] active=false reset=2026-08-29 05:19:59 UTC (2026-08-29 14:19:59 JST, in 4h 50m)
  - weekly_all (weekly): 52% [normal] active=true reset=2026-09-02 19:00:00 UTC (2026-09-03 04:00:00 JST, in 114h 32m)

Codex Usage (plus)
────────────────────────────────────────
⚪ 5-hour : 7% █░░░░░░░░░░░░░░░░░░░  reset: 2026-09-03 10:06:48 UTC (2026-09-03 19:06:48 JST, in 3h 27m)
🟡 weekly : 82% ████████████████░░░░  reset: 2026-09-07 06:54:10 UTC (2026-09-07 15:54:10 JST, in 96h 15m)
   allowed: true  limit_reached: false

{"claude":{"fiveHourUsed":1,"fiveHourReset":"2026-08-29T05:19:59.708436+00:00","weekUsed":52,"weekReset":"2026-09-02T19:00:00.308032+00:00"},"codex":{"fiveHourUsed":7,"fiveHourReset":"2026-09-03T10:06:48.000Z","weekUsed":82,"weekReset":"2026-09-07T06:54:10.000Z","plan":"plus"},"fiveHourUsed":1,"fiveHourReset":"2026-08-29T05:19:59.708436+00:00","weekUsed":52,"weekReset":"2026-09-02T19:00:00.308032+00:00","codexFiveHourUsed":7,"codexFiveHourReset":"2026-09-03T10:06:48.000Z","codexWeekUsed":82,"codexWeekReset":"2026-09-07T06:54:10.000Z"}

$ bun run index.ts --codex
Codex Usage (plus)
────────────────────────────────────────
⚪ 5-hour : 7% █░░░░░░░░░░░░░░░░░░░  reset: 2026-09-03 10:06:48 UTC (2026-09-03 19:06:48 JST, in 3h 27m)
🟡 weekly : 82% ████████████████░░░░  reset: 2026-09-07 06:54:10 UTC (2026-09-07 15:54:10 JST, in 96h 15m)
```

## インストール

```bash
bun install
```

## 使い方

```bash
# 通常表示 (デフォは Claude + Codex 両方。取得できた方を表示)
bun run index.ts
bun run index.ts --json
bun run index.ts --claude --json      # Claude のみ
bun run index.ts --codex --json       # Codex のみ
bun run index.ts --provider all --json

# 5分ごとにポーリング (Ctrl+Cで停止)
bun run index.ts --watch 300
bun run index.ts --codex --watch 300 --calendar --calendar-api

# リセット時刻を Google カレンダーに同期 (refresh_token)
bun run index.ts --calendar --calendar-api
bun run index.ts --codex --calendar --calendar-api
bun run index.ts --calendar --calendar-api --calendar-id primary
# 初回のみ OAuth
GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com" GOOGLE_CLIENT_SECRET="GOCSPX-xxx" bun run index.ts --calendar-auth
bun run index.ts --calendar --calendar-api

# npm scripts
bun run start       # == bun run index.ts
bun run check       # --json
bun run watch       # --watch 300 --calendar --calendar-api
bun run calendar    # --calendar --calendar-api
bun run calendar:auth  # --calendar-auth
```

### オプション

```
--json                          生 JSON 出力
--watch [sec]                   ポーリング間隔秒 (デフォ 300)まで Ctrl+C
--interval <sec>                Alias for --watch
--claude                        Claude のみ表示
--codex                         Codex のみ表示
--all                           Claude + Codex 両方 (デフォ)
--provider <claude|codex|all>   Alias for --claude/--codex/--all
--calendar                      Google カレンダー同期を有効化
--calendar-open                 Google Calendar テンプレート URL をブラウザで開く
--calendar-api                  Google Calendar API で同期 (refresh_token 必須)
--calendar-id <id>              対象カレンダー ID (デフォ: primary)
--calendar-auth                 OAuthフロー開始 (要 GOOGLE_CLIENT_ID/SECRET)
--calendar-auth-port <port>     コールバック用ローカルポート (デフォ: 8085)
--once                          Run once even if --watch is set (default)
-h, --help                      ヘルプ
```

### 環境変数

```bash
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..."  # Keychainの代わりに直接指定
# または ANTHROPIC_OAUTH_TOKEN / CLAUDE_TOKEN

# Codex は ~/.codex/auth.json (codex login) を自動読込。 env で上書きも可:
export CODEX_ACCESS_TOKEN="eyJ..."  # または OPENAI_CODEX_ACCESS_TOKEN / CODEX_BEARER_TOKEN
export CODEX_HOME="$HOME/.codex"    # デフォ ~/.codex
export CHATGPT_ACCOUNT_ID="ef45e621-..."  # 必要なら明示
# トークンは期限切れ時に refresh_token で自動更新され auth.json に保存 (600)
# 失敗時は 401 時に1回リトライ
```

Google Calendar (refresh_token のみ):

```bash
export GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="GOCSPX-xxx"
export GOOGLE_REFRESH_TOKEN="1//0g..."        # ある場合、即座にリフレッシュして保存
export GOOGLE_CALENDAR_ID="primary"           # 省略時は primary
# 初回: GOOGLE_CLIENT_ID/SECRET で認証
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." bun run index.ts --calendar-auth
# -> ~/.config/ccusage-notifier/google-calendar-token.json (600) に保存
# 以降は env なしで自動リフレッシュ
```

必要スコープ: `https://www.googleapis.com/auth/calendar.events`

## Google カレンダー連携

`access_token` は1時間で失効するため、`refresh_token` を保存して自動更新します。`getGoogleAccessToken` が `expires_at` を見て自動リフレッシュします。

```bash
# 1. GCPで OAuthクライアント作成
#    https://console.cloud.google.com/auth/clients
#    - 種類: デスクトップアプリ (またはウェブで http://localhost:8085/callback を登録)
#    - 同意画面でスコープ https://www.googleapis.com/auth/calendar.events とテストユーザーを追加

# 2. 認証フロー開始 (ブラウザが開く)
GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com" GOOGLE_CLIENT_SECRET="GOCSPX-xxx" bun run index.ts --calendar-auth
# -> 許可後に ~/.config/ccusage-notifier/google-calendar-token.json (600) に保存

# 3. 以降はトークン指定なしで同期 (期限切れは自動リフレッシュ)
bun run index.ts --calendar --calendar-api
bun run calendar:api

# 手動で refresh_token から直接保存したい場合
GOOGLE_REFRESH_TOKEN="1//0g..." GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." bun run index.ts --calendar --calendar-api

# 定期実行例
bun run index.ts --watch 3600 --calendar --calendar-api
```

保存先と優先順位:
1. `GOOGLE_REFRESH_TOKEN` + `GOOGLE_CLIENT_ID/SECRET` があればその場でリフレッシュして保存
2. `~/.config/ccusage-notifier/google-calendar-token.json` / `~/.ccusage-notifier-google-token.json` / `./.google-calendar-token.json` の順で読み込み、期限切れなら `refresh_token` で自動更新

**既存予定の扱い:** `upsertGoogleCalendarEvent` が `q=Claude Code` (Claude) / `q=Codex` (Codex) で検索し、`extendedProperties.private.source=ccusage-notifier` + `product=claude|codex` + `kind` で判別して `PATCH` で移動。重複は先頭1件を残して `DELETE`。Claude の `five_hour` が `0%` / `null` の場合は `claude -p "ping"` で新セッションを自動開始して新 `resets_at` で移動します。Codex は `5-hour` / `weekly` それぞれ `Codex 5-hour limit reset` / `Codex weekly limit reset` として別イベントで管理されます。

**注意:** テストモードの `refresh_token` は7日で失効 (`refresh_token_expires_in: 604799`)。本番公開するか7日ごとに再認証してください。

## ライブラリとして使う

```ts
import { getClaudeToken, getClaudeUsage, formatUsage, buildCalendarEvents, buildGoogleCalendarUrl } from "./index.ts";
import { getCodexToken, getCodexUsage, formatCodexUsage, buildCodexCalendarEvents, buildCombinedCalendarEvents } from "./index.ts";

const claudeToken = await getClaudeToken();
const claudeUsage = await getClaudeUsage(claudeToken);
console.log(formatUsage(claudeUsage));

const codexToken = await getCodexToken();
const codexUsage = await getCodexUsage(codexToken);
console.log(formatCodexUsage(codexUsage));

const events = buildCalendarEvents(claudeUsage);
console.log(buildGoogleCalendarUrl(events[0]!));

const combinedEvents = buildCombinedCalendarEvents({ claude: claudeUsage, codex: codexUsage });
```

## 注意

- ポーリング間隔を 60秒未満にすると `429 Rate limited` になることがあります。推奨は 300秒以上。`--codex` と `--claude` は別エンドポイントなので Codex は Claude の 429 影響を受けませんが、どちらも頻繁なポーリングは避けてください。
- `security` コマンドは macOS 専用です。Linux では環境変数でトークンを渡してください。
- Codex の `~/.codex/auth.json` は `codex login` で作成されます。トークンは短命 (約10日) で `refresh_token` により自動更新。`CODEX_ACCESS_TOKEN` で上書き時は refresh なし。
- Google Calendar のリセット時刻は取得時点のスナップショットです。定期的に再実行してください。既存予定は自動で移動され、重複は削除されます。
- Claude の 5-hour が `0%` かつ `null` の場合は `claude -p "ping"` で自動的に新セッションを開始します。`claude` コマンドが無い場合はスキップされます。
- Codex の API は `https://chatgpt.com/backend-api/wham/usage` を使用。`primary_window` (5h, 18000s) と `secondary_window` (weekly, 604800s) の `used_percent` / `reset_at` (epoch秒) を `UsageBucket` に正規化して表示・カレンダー同期します。

## 開発

```bash
bun tsc --noEmit
bun test
```

## 元スニペット

```ts
async function getClaudeToken() {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-a", process.env.USER!, "-w"], { stdout: "pipe", stderr: "pipe" });
  const raw = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("Could not read Claude Code credentials");
  return JSON.parse(raw).claudeAiOauth.accessToken as string;
}
async function getClaudeUsage(token: string) {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
  });
  if (!res.ok) throw new Error(`usage fetch failed: ${res.status} ${await res.text()}`);
  return await res.json();
}
```
