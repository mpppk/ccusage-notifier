# ccusage-notifier

Claude Code の利用量 (`5-hour` / `7-day`) を Anthropic OAuth API (`https://api.anthropic.com/api/oauth/usage`) から取得して表示・通知する Bun 製 CLI。

いただいたスニペットをベースに、以下の機能を追加しています:

- macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`) からトークン自動取得 (`index.ts:54`)
- `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_OAUTH_TOKEN` / `CLAUDE_TOKEN` 環境変数での上書き
- 見やすい整形表示 + バー表示 + JST/UTC リセット時刻 (`index.ts:103`)
- 閾値超過時の macOS 通知 (`osascript display notification`) (`index.ts:280`)
- `--watch` ポーリング + `--json` 生出力
- Google Calendar 連携: リセット時刻を ICS / Google Calendar URL / Calendar API で登録 (`index.ts:230`)

## 検証済み

```
$ bun run index.ts
Claude Code Usage
────────────────────────────────────────
🔴 5-hour : 100% ████████████████████  reset: 2026-08-28 14:40:00 UTC (2026-08-28 23:40:00 JST, in 2h 42m)
⚪ 7-day  : 44% █████████░░░░░░░░░░░  reset: 2026-09-02 19:00:00 UTC (2026-09-03 04:00:00 JST, in 127h 2m)
   extra_usage: disabled 0% (used 0/500)
────────────────────────────────────────
Limits:
  - session (session): 100% [critical] active=true reset=2026-08-28 14:40:00 UTC (2026-08-28 23:40:00 JST, in 2h 42m)
  - weekly_all (weekly): 44% [normal] active=false reset=2026-09-02 19:00:00 UTC (2026-09-03 04:00:00 JST, in 127h 2m)

{"fiveHourUsed":100,"fiveHourReset":"2026-08-28T14:40:00.777618+00:00","weekUsed":44,"weekReset":"2026-09-02T19:00:00.777641+00:00"}
```

`five_hour.utilization` / `seven_day.utilization` が正しく取得できています。

## インストール

```bash
bun install
```

## 使い方

```bash
# 通常表示 (Keychainからトークン取得)
bun run index.ts
bun run index.ts --json

# 閾値 90% 超えで macOS 通知
bun run index.ts --notify --threshold 90

# 5h と 7day を別閾値に
bun run index.ts --notify --threshold-five 70 --threshold-week 80

# 5分ごとにポーリング (Ctrl+Cで停止)
bun run index.ts --watch 300 --notify
bun run index.ts --watch --threshold 80   # デフォルト 300秒

# リセット時刻を Google カレンダーに登録 (ICS + URL 生成)
bun run index.ts --calendar
bun run index.ts --calendar --calendar-open        # ブラウザでテンプレートを開く
bun run index.ts --calendar --calendar-out ./my.ics
# API で直接登録 (一時トークン)
GOOGLE_OAUTH_TOKEN="$(gcloud auth print-access-token)" bun run index.ts --calendar --calendar-api
GOOGLE_OAUTH_TOKEN="ya29..." bun run index.ts --calendar --calendar-api --calendar-id primary
# API で永続登録 (refresh_token 保存、推奨)
GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com" GOOGLE_CLIENT_SECRET="GOCSPX-xxx" bun run index.ts --calendar-auth
bun run index.ts --calendar --calendar-api         # 以降トークン指定なしで自動リフレッシュ

# npm scripts エイリアス
bun run start       # == bun run index.ts
bun run check       # --json
bun run notify      # --notify --threshold 80
bun run watch       # --watch 300 --notify
```

### オプション

```
--json                          生 JSON 出力
--notify                        閾値超過時に macOS 通知
--threshold <n>                 両方の閾値を <n>% に設定 (デフォ 80)
--threshold-five <n>            5時間閾値
--threshold-week <n>            7日閾値
--watch [sec]                   ポーリング間隔秒 (デフォ 300)
--interval <sec>                --watch のエイリアス
--calendar                      リセット時刻を Google Calendar 用に ICS + URL 生成
--calendar-out <path>           ICS 出力先 (デフォ: ccusage-reset.ics)
--calendar-open                 Google Calendar テンプレート URL をブラウザで開く
--calendar-api                  Google Calendar API で直接登録 (要 GOOGLE_OAUTH_TOKEN または保存済み refresh_token)
--calendar-id <id>              対象カレンダー ID (デフォ: primary)
--calendar-auth                 Google Calendar OAuthフロー開始 (要 GOOGLE_CLIENT_ID/SECRET)
--calendar-auth-port <port>     コールバック用ローカルポート (デフォ: 8085)
-h, --help                      ヘルプ
```

### 環境変数

```bash
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..."
# または
export ANTHROPIC_OAUTH_TOKEN="sk-ant-oat01-..."
export CLAUDE_TOKEN="sk-ant-oat01-..."
```

設定時は Keychain 読み取りをスキップします。Linux / CI 向け。

Google Calendar API を使う場合（一時トークン）:

```bash
export GOOGLE_OAUTH_TOKEN="ya29...."  # もしくは GOOGLE_CALENDAR_TOKEN / GOOGLE_ACCESS_TOKEN
export GOOGLE_CALENDAR_ID="primary"   # 省略時は primary
# gcloud が入っている場合:
export GOOGLE_OAUTH_TOKEN="$(gcloud auth print-access-token)"
```

永続化する場合（推奨、refresh_token 保存）:

```bash
export GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="GOCSPX-xxx"
# 既に refresh_token を持つ場合
export GOOGLE_REFRESH_TOKEN="1//0g..."
# 初回はブラウザで認証して保存 (access + refresh を ~/.config/ccusage-notifier/google-calendar-token.json に 600 で保存)
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." bun run index.ts --calendar-auth
# 以降は env なしで自動リフレッシュ
bun run index.ts --calendar --calendar-api
# 保存先: ~/.config/ccusage-notifier/google-calendar-token.json (XDG_CONFIG_HOME/ccusage-notifier/)
# 代替: ~/.ccusage-notifier-google-token.json / ./.google-calendar-token.json も参照
```

必要スコープ: `https://www.googleapis.com/auth/calendar.events`

## Google カレンダー連携の詳細

### 方法1: ワンクリック登録 (推奨・認証不要)

```bash
bun run index.ts --calendar
# 出力される Google Calendar URL をブラウザで開く
# 例: https://calendar.google.com/calendar/render?action=TEMPLATE&text=Claude+Code+5-hour+limit+reset&dates=20260828T143959Z/20260828T145459Z&...

# 自動でブラウザを開く
bun run index.ts --calendar --calendar-open
```

`--calendar` は `five_hour.resets_at` / `seven_day.resets_at` それぞれについて:
- Google Calendar テンプレート URL を表示
- `ccusage-reset.ics` (ICS) を生成

ICS は `Google Calendar > 設定 > インポート/エクスポート > インポート` から取り込むか、ICS ファイルを Google Calendar の Web UI にドラッグ&ドロップで登録できます。

### 方法2: ICS ファイルを直接インポート

```bash
bun run index.ts --calendar --calendar-out ./reset.ics
# -> ./reset.ics を Google Calendar にインポート
```

ICS 中身例:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ccusage-notifier//EN
BEGIN:VEVENT
UID:20260828T143959Z-Claude-Code-5-hour-limit-reset@ccusage-notifier
DTSTART:20260828T143959Z
DTEND:20260828T145459Z
SUMMARY:Claude Code 5-hour limit reset
...
END:VEVENT
END:VCALENDAR
```

### 方法3: Google Calendar API で自動登録 (一時トークン、要 OAuth)

GCP で OAuth 同意画面とカレンダー API を有効化し、トークンを取得してください:

```bash
# gcloud 経由が最短 (Calendar scope が必要)
gcloud auth login --scopes=https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/cloud-platform
GOOGLE_OAUTH_TOKEN="$(gcloud auth print-access-token)" bun run index.ts --calendar --calendar-api

# または自前の OAuth トークン (1時間で失効)
GOOGLE_OAUTH_TOKEN="ya29...." bun run index.ts --calendar --calendar-api --calendar-id primary
```

成功すると `htmlLink` が出力されます（既存イベントがある場合は移動/更新、重複は自動削除）:

```
[calendar] Upserting 2 event(s) via API to calendar: primary (existing events will be moved)
  ✓ Claude Code 5-hour limit reset [moved] -> https://www.google.com/calendar/event?eid=...
  ✓ Claude Code weekly limit reset [updated (already at correct time)] -> https://www.google.com/calendar/event?eid=...
```

### 方法4: Google Calendar API で永続登録 (推奨、refresh_token)

`access_token` は1時間で失効するため、継続利用には `refresh_token` を保存します。`index.ts:411` の `getGoogleAccessToken` が `expires_at` を見て自動リフレッシュします。

```bash
# 1. GCPで OAuthクライアント作成
#    https://console.cloud.google.com/auth/clients
#    - 種類: デスクトップアプリ (またはウェブで http://localhost:8085/callback を登録)
#    - 同意画面でスコープ https://www.googleapis.com/auth/calendar.events とテストユーザーを追加

# 2. 認証フロー開始 (ブラウザが開く)
GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com" GOOGLE_CLIENT_SECRET="GOCSPX-xxx" bun run index.ts --calendar-auth
# または npm script
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." bun run calendar:auth
# -> 許可後に ~/.config/ccusage-notifier/google-calendar-token.json (600) に保存

# 3. 以降はトークン指定なしで登録 (期限切れは自動リフレッシュ)
bun run index.ts --calendar --calendar-api
bun run calendar:api

# 手動で refresh_token から直接保存したい場合
GOOGLE_REFRESH_TOKEN="1//0g..." GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." bun run index.ts --calendar --calendar-api
# -> その場で refresh してファイルに保存

# 定期実行例
bun run index.ts --watch 3600 --calendar --calendar-api
```

保存先と優先順位:

1. `GOOGLE_REFRESH_TOKEN` + `GOOGLE_CLIENT_ID/SECRET` があればその場でリフレッシュして保存（`client_id/secret` も保存）
2. `GOOGLE_OAUTH_TOKEN` env があればそれを使用（一時的、Playground等、1時間で失効）
3. `~/.config/ccusage-notifier/google-calendar-token.json` / `~/.ccusage-notifier-google-token.json` / `./.google-calendar-token.json` の順で読み込み、ファイル内の `client_id` / `client_secret` を使って期限切れなら `refresh_token` で自動更新（`--calendar-auth` 時に自動保存されるため env 不要）

**既存予定の扱い (5h limit 更新時):** `index.ts:408` の `upsertGoogleCalendarEvent` が `q=Claude Code` で既存イベントを検索し、`extendedProperties.private.source=ccusage-notifier` + `summary` で `five_hour` / `weekly` を判別して `PATCH` で新時刻へ移動します。重複があれば先頭1件を残して他を `DELETE` で自動クリーンアップします。初回以降は毎回同じイベントが移動されるため、重複は増えません。ICSは毎回上書きされます。

`resets_at` が `null` の場合（例: 5-hour が `0%` でリセット不要）は、該当 `kind` の既存予定を `DELETE` で自動削除します。`five_hour` が `0%` / `null` になった今回のケースでは、古い5-hour予定が削除され weekly のみが残ります。

**注意:** OAuth同意画面が `テスト` モードの場合、`refresh_token` は7日で失効します（`refresh_token_expires_in: 604799`）。`本番環境` に公開するか、7日ごとに `bun run calendar:auth` で再認証してください。`access_token` は1時間で失効しますが、`--calendar-auth` 時に `client_id` / `client_secret` も一緒に `~/.config/ccusage-notifier/google-calendar-token.json` に保存されるため、以降は `GOOGLE_CLIENT_ID/SECRET` 環境変数なしでも自動リフレッシュされます。`--calendar` の `resets_at` は取得時点のスナップショットなので、時間経過で変わる場合は再実行してください。

他の方法で手動登録したい場合は方法1/2を使ってください。

## ライブラリとして使う

```ts
import { getClaudeToken, getClaudeUsage, formatUsage, shouldNotify, buildCalendarEvents, buildGoogleCalendarUrl, generateIcs } from "./index.ts";

const token = await getClaudeToken();
const usage = await getClaudeUsage(token);
console.log(formatUsage(usage));

const { notify, reasons } = shouldNotify(usage, 80, 80);
if (notify) console.log("alert:", reasons);

// Calendar
const events = buildCalendarEvents(usage);
console.log(buildGoogleCalendarUrl(events[0]!)); // URL
console.log(generateIcs(events)); // ICS 文字列
```

## 注意

- ポーリング間隔を 60秒未満にすると `429 Rate limited` になることがあります。推奨は 300秒以上。
- `security` コマンドは macOS 専用です。Linux では環境変数でトークンを渡してください。
- Keychain アクセスで `Could not read Claude Code credentials` が出る場合は、Claude Code にログイン済みか確認してください。
- Google Calendar のリセット時刻は取得時点の `resets_at` のスナップショットです。時間経過で変わるため、定期的に `bun run index.ts --calendar --calendar-api` を再実行してください。既存予定は自動で新時刻へ移動（`PATCH`）され、重複は削除されます。`--watch` と組み合わせると毎回チェックされ、時刻変更時のみ移動します。

## 開発

```bash
bun tsc --noEmit   # 型チェック
bun test           # テスト (index.test.ts)
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
