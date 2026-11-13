# AGENTS.md

Discordサーバー内の指定カテゴリ（`CATEGORY_ID`）配下で日替わりチャンネル（`使い捨て会話_MM月DD日`）のライフサイクル管理を行い、あわせてサーバー内のフォーラムチャンネルで長期間（21日以上）更新のないトピックの削除確認・承認削除を行う 24/7 常時稼働 Discord Bot（TypeScript / discord.js v14）。

## Verification

変更後は毎回以下を実行し、全パスを確認する（Live Discord API トークン不要で動作する）。

```bash
npm test       # Vitest による単体テスト (tests/*.test.ts)
npm run build  # tsc による型チェックと dist/ ビルド (src/**/* のみ対象)
```

- `tsconfig.json` は `tests/**/*` を `exclude` しているため、`npm run build` だけではテストファイルの型崩れを検知できない。テストとビルドをセットで実行すること。

## Where to Look

- **起動・Intent・コマンド登録・グレースフルシャットダウン**: `src/index.ts`
- **環境変数スキーマ (Zod)**: `src/config.ts`
- **毎日 00:00 JST 定期バッチ**: `src/scheduler.ts`（`croner` で `0 0 0 * * *` / `Asia/Tokyo`）
- **チャンネル生成・経過判定・削除のコア**: `src/services/channelManager.ts`
- **フォーラム長期未更新トピック検出・確認送信**: `src/services/forumManager.ts`
- **スラッシュコマンド・ボタン押下処理**: `src/handlers/interactionHandler.ts`, `src/commands/dailyBatchRun.ts`, `src/commands/testForumCleanup.ts`
- **JST日付変換・チャンネル名パース・差分日数計算**: `src/utils/dateUtils.ts`
- **クラウド死活監視 HTTP サーバー**: `src/server.ts`
- **デプロイ・インフラ連動設定**: `Dockerfile`, `docker-compose.yml`, `railway.json`, `render.yaml`, `.env.example`

## Invariants & Gotchas

### 1. モジュール解決と相対インポート
- `tsconfig.json` は `"module": "NodeNext"` / `"moduleResolution": "NodeNext"` を採用している。
- `src/` および `tests/` 内の相対インポートは**必ず `.js` 拡張子を付与する**（例: `import { getConfig } from '../config.js'`）。拡張子なしや `.ts` 指定にすると `tsc` ビルドが失敗する。

### 2. 日付計算とチャンネル命名 (`src/utils/dateUtils.ts`)
- **タイムゾーン非依存の JST 計算**: コンテナやホストのシステム時刻に依存せず、`Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo' })`（`getJSTParts`）経由で年月日を取得する。`Date#getMonth()` 等のローカル時刻メソッドを直接使用しないこと。
- **生成フォーマットとパース許容幅の非対称性**:
  - 生成（`formatChannelName`）は `使い捨て会話_MM月DD日`（2桁ゼロ埋め）。
  - 解析（`parseChannelName`）は Discord の自動変換や手動作成を考慮し、区切り `_` / `-` の両方および 1〜2 桁の月日（`^使い捨て会話[_-](\d{1,2})月(\d{1,2})日$`）を受け入れる。
- **年跨ぎ・うるう年判定（`calculateDiffDays`）**:
  - Discord の `channel.createdAt` がある場合は作成年（12月作成の1月チャンネル等の境界補正含む）を優先する。
  - `channelCreatedAt` 省略時は「基準日から14日以上未来になる日付は前年とみなす」ヒューリスティックを用いる（2/29 のうるう年補正あり）。安易に特定の月（例: `<= 2`）で分岐を切らないこと。

### 3. ライフサイクルと権限境界 (`src/services/channelManager.ts`, `src/services/forumManager.ts`, `src/handlers/interactionHandler.ts`)
- **テスト分離構造**: `runDailyLifecycle(client)` / `runForumCleanup(client)` は `getConfig()` を解決する薄いラッパーであり、コアロジックは config 非依存の `runLifecycleForGuild` / `runForumCleanupForGuild` に置く。テストや新機能追加時はこの分離を維持する。
- **Bot 自身の権限チェック**:
  - 日替わりチャンネル（`runLifecycleForGuild`）: ギルド全体の `ManageChannels` に加え、`category.permissionsFor(botMember)` でカテゴリ固有の上書き権限を事前検証する。
  - フォーラム（`runForumCleanupForGuild`）: フォーラムごとに `ViewChannel`, `ManageThreads`, `SendMessagesInThreads`, `ReadMessageHistory` を検証し、権限不足のフォーラムのみ `errors` に記録して他フォーラムを続行する。
- **ボタンの永続化と固定 `customId`**: 再起動後のメッセージからも操作できるよう、日替わり用は `BUTTON_IDS`（`disposable_channel_delete_confirm`, `disposable_channel_delete_cancel`）、フォーラム用は `FORUM_BUTTON_IDS`（`forum_thread_delete_confirm`, `forum_thread_delete_keep`）の固定文字列でステートレスに処理する。これらの ID を変更すると既存メッセージのボタンが動作不能になる。
- **フォーラムのピン留め・Botメッセージ除外・アーカイブ取得 (`src/services/forumManager.ts`)**:
  - `thread.flags?.has(ChannelFlags.Pinned)` は誤削除防止のため必ずスキップする。
  - 最終投稿日時は `classifyForumBotMessage` で Bot 自身の削除確認・見送りメッセージを除外した上で算出する（メッセージ0件時は `thread.createdAt` フォールバック）。確認送信済み、または見送り編集から猶予期間（`Math.max(1, thresholdDays)` 日）未満の場合は再送信をスキップする。
  - 21日以上前のスレッドは多くがアーカイブ済みのため、アクティブスレッド一括取得に加え `fetchArchived` を `hasMore` ループでページネーションして全件取得する。送信時 `thread.archived === true` の場合は `setArchived(false)` 後に送信し、送信完了後はアクティブだったものも含め `setArchived(true)` で必ずスレッドをクローズする。
- **通知抑制 (`MessageFlags.SuppressNotifications`)**: Bot がチャンネル・スレッドへ送る自動メッセージ（ウェルカム・削除確認）はすべて `flags: [MessageFlags.SuppressNotifications]` を付与し、ボタン見送り・保留のメッセージ更新では `allowedMentions: { parse: [] }` を指定して通知を発生させない。
- **未キャッシュチャンネルと実行者権限・アーカイブ済み操作**: ボタン押下時は `memberPermissions?.has(PermissionFlagsBits.ManageChannels)` を検証し、`interaction.channel` が `null`（再起動直後など）の場合は `guild.channels.fetch(channelId)` → `client.channels.fetch(channelId)` へフォールバックする。フォーラム用ボタンでは対象がフォーラム配下のスレッドであることも検証し、`archived === true` のスレッドで見送り操作を行う場合は一時解除・更新・再クローズを行う。
- **既知のエラーコード分岐**: 削除失敗時は Discord API エラーコード `50013`（権限不足）・`10003`（削除済みチャンネル/スレッド）を判別し、フォーラム削除で `50083`（Thread is archived）が発生した場合は `setArchived(false)` 後にリトライする。

### 4. 設定とコマンド登録 (`src/config.ts`, `src/index.ts`)
- **遅延設定パース**: `src/config.ts` は `getConfig()` 初回呼び出し時に `process.env` を Zod 検証してキャッシュする。テストでモジュールをインポートしただけでクラッシュしないよう、トップレベルで `getConfig()` を呼ばないこと（注入には `setConfig()` を使う）。
- **ギルドコマンドの一括置換**: `ClientReady` 時に `guild.commands.set([dailyBatchRunCommand.toJSON(), testForumCleanupCommand.toJSON()])` でコマンドを上書き登録している。スラッシュコマンドを増やす場合はこの配列に追加する。

### 5. 24/7 クラウド稼働契約 (`src/server.ts`, インフラ設定)
- **ヘルスチェック仕様**: `railway.json` と `render.yaml` は `/healthz`（`PORT` デフォルト `8080`、`0.0.0.0` リッスン）を監視する。`client.isReady()` が `true` のとき HTTP `200`、起動中・未接続時は `503` を返す契約を維持する。
- **設定ファイルの同期**: 環境変数の追加・変更・ポートやタイムゾーンの変更を行った場合は、`.env.example`、`Dockerfile`、`docker-compose.yml`、`render.yaml`、`railway.json`、`README.md` の該当箇所も同時に更新する。

## Testing Conventions

- 外部 Discord Gateway / REST API には接続せず、`tests/channelManager.test.ts`・`tests/interactionHandler.test.ts` のように `Guild` / `Interaction` / `TextChannel` の最小モックオブジェクトを組み立てて `vi.fn()` / `vi.spyOn()` で検証する。
- サーバーテスト（`tests/server.test.ts`）は並列・連続実行時のポート競合を避けるため、テストケースごとに異なるポート番号を割り当て、`afterEach` で必ず `server.close()` する。
