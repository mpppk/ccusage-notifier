# ccusage-notifier

Claude Code の利用量 (`5-hour` / `7-day`) を Anthropic OAuth API (`https://api.anthropic.com/api/oauth/usage`) から取得して表示・通知する Bun 製 CLI。

いただいたスニペットをベースに、以下の機能を追加しています:

- macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`) からトークン自動取得 (`index.ts:54`)
- `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_OAUTH_TOKEN` / `CLAUDE_TOKEN` 環境変数での上書き
- 見やすい整形表示 + バー表示 + JST/UTC リセット時刻 (`index.ts:103`)
- 閾値超過時の macOS 通知 (`osascript display notification`) (`index.ts:168`)
- `--watch` ポーリング + `--json` 生出力

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

## ライブラリとして使う

```ts
import { getClaudeToken, getClaudeUsage, formatUsage, shouldNotify } from "./index.ts";

const token = await getClaudeToken();
const usage = await getClaudeUsage(token);
console.log(formatUsage(usage));

const { notify, reasons } = shouldNotify(usage, 80, 80);
if (notify) console.log("alert:", reasons);
```

## 注意

- ポーリング間隔を 60秒未満にすると `429 Rate limited` になることがあります。推奨は 300秒以上。
- `security` コマンドは macOS 専用です。Linux では環境変数でトークンを渡してください。
- Keychain アクセスで `Could not read Claude Code credentials` が出る場合は、Claude Code にログイン済みか確認してください。

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
