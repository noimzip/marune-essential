# Discord Bot: 使い捨て会話チャンネル自動生成・削除管理 (`marune-essential`)

Discordサーバー内の指定カテゴリにおいて、日替わりの雑談・使い捨てチャンネル（`使い捨て会話_MM月DD日`）のライフサイクル（毎日の自動生成・過去チャンネルの削除確認・7日経過チャンネルの自動削除）を完全自動化するDiscord Botです。

---

## 🌟 主な機能

1. **毎日 00:00 (JST) の自動生成**
   - 指定カテゴリ（`CATEGORY_ID`）内に `使い捨て会話_MM月DD日`（例: `使い捨て会話_11月12日`）を自動生成。
2. **削除確認メッセージの送信 (作成から1〜6日経過)**
   - 過去の `使い捨て会話_*` チャンネルに対し、削除承認ボタン（赤色 / `disposable_channel_delete_confirm`）と保留ボタン（灰色 / `disposable_channel_delete_cancel`）を送信。
   - ボタン押下時は実行者の「**チャンネルの管理 (Manage Channels)**」権限を検証（権限がない場合はエフェメラル通知で拒否）。
3. **作成から7日経過チャンネルの自動削除**
   - 作成から7日以上経過したチャンネルを毎朝0:00の定期バッチで自動削除。
4. **即時実行スラッシュコマンド (`/daily-batch-run`)**
   - 管理者向けに使い捨て会話の定期バッチを即時テスト・実行できるスラッシュコマンドを提供。
   - 起動時にギルド個別登録（Instant Guild Command Registration）を行うため、起動直後から即時反映。
5. **長期未更新フォーラムトピック削除管理機能 (`/test_forum_cleanup`)**
   - サーバー内のフォーラムチャンネル（`EXCLUDED_FORUM_IDS` で除外設定可能）において、最後の投稿から21日以上経過したトピック（ピン留め除く・アーカイブ済み含む）を毎日 0:00 JST に検出し、削除確認ボタン（承認削除 `forum_thread_delete_confirm` / 残す `forum_thread_delete_keep`）を送信後、スレッドを自動的にクローズ（アーカイブ）します。
   - Botがチャンネル／スレッドへ送信するメッセージはすべてサイレント送信（`MessageFlags.SuppressNotifications`）となり、通知音やプッシュ通知は発生しません。
   - Bot自身が送信した確認/見送りメッセージは最終投稿判定から除外。
   - テスト用スラッシュコマンド `/test_forum_cleanup [days] [dry_run]` で基準日数やドライランを指定して検証可能。
6. **クラウド常時稼働対応 (24/7)**
   - 死活監視エンドポイント `/healthz`（HTTP 200/503 & ステータスJSON返却）を内蔵。
   - Dockerマルチステージビルド・軽量Alpineイメージ。
   - 日本標準時（`TZ=Asia/Tokyo`）完全対応（月跨ぎ・年跨ぎ・うるう年計算対応）。
   - シグナルハンドリング（SIGINT / SIGTERM）によるグレースフルシャットダウン対応。

---

## 🛠️ 必要要件

- **Node.js**: v20以上 (推奨: v22 / v24)
- **Discord Bot Token**: Discord Developer Portalより取得
- **Discord Bot 権限 (Bot Permissions)**:
  - `Manage Channels` (チャンネルの管理)
  - `Manage Threads` (スレッドの管理)
  - `Send Messages` (メッセージを送信)
  - `Send Messages in Threads` (スレッド内でメッセージを送信)
  - `View Channels` (チャンネルを見る)
  - `Read Message History` (メッセージ履歴を読む)

---

## 🚀 ローカル環境でのセットアップ

### 1. リポジトリのクローンと依存パッケージのインストール

```bash
git clone https://github.com/noimzip/marune-essential.git
cd marune-essential
npm install
```

### 2. 環境変数の設定

`.env.example` をコピーして `.env` を作成し、各値を入力します:

```bash
cp .env.example .env
```

`.env` 設定例:
```env
# Discord Bot Token
DISCORD_TOKEN=your_bot_token_here

# 対象Discordサーバー (ギルド) ID
GUILD_ID=123456789012345678

# 対象カテゴリID (「テキストチャンネル」カテゴリ)
CATEGORY_ID=123456789012345678

# 削除確認対象から除外するフォーラムチャンネルID (カンマ区切り・任意)
EXCLUDED_FORUM_IDS=

# フォーラムトピックの未更新判定日数 (デフォルト: 21)
FORUM_INACTIVE_DAYS=21

# ヘルスチェックHTTPポート (デフォルト: 8080)
PORT=8080

# タイムゾーン (デフォルト: Asia/Tokyo)
TZ=Asia/Tokyo
```

### 3. テストの実行

```bash
npm test
```

### 4. ビルドと起動

開発起動 (watchモード):
```bash
npm run dev
```

本番ビルド & 実行:
```bash
npm run build
npm start
```

### 5. Docker Compose でのローカル起動

```bash
docker compose up -d
```

---

## ☁️ クラウドプラットフォームへのデプロイ

### 1. Railway でのデプロイ (推奨: 最短設定)

1. [Railway](https://railway.app/) にログインし、**「New Project」** -> **「Deploy from GitHub repo」** を選択。
2. `noimzip/marune-essential` リポジトリを選択。
3. リポジトリ内の `railway.json` と `Dockerfile` が自動認識されます。
4. **「Variables」** タブで以下の環境変数を設定:
   - `DISCORD_TOKEN`: Discord Botトークン
   - `GUILD_ID`: 対象サーバーID
   - `CATEGORY_ID`: 対象カテゴリID
   - `TZ`: `Asia/Tokyo`
5. デプロイ完了後、`/healthz` によるヘルスチェックが有効化され、24/7常時稼働します。

### 2. Render でのデプロイ

1. [Render](https://render.com/) にログインし、**「Blueprints」** -> **「New Blueprint Instance」** を選択。
2. `noimzip/marune-essential` リポジトリを連携。
3. `render.yaml` が自動検出され、Web Serviceの設定が読み込まれます。
4. 画面上のプロンプトに従い、シークレット環境変数を入力:
   - `DISCORD_TOKEN`
   - `GUILD_ID`
   - `CATEGORY_ID`
5. **「Apply」** をクリックするとビルドおよびデプロイが開始されます。

---

## 📋 ディレクトリ構成

```
marune-essential/
├── Dockerfile                  # 軽量Node.js 24 Alpine マルチステージビルド (TZ=Asia/Tokyo)
├── docker-compose.yml          # ローカル・VPS動作用Compose定義
├── render.yaml                 # Render Blueprint設定
├── railway.json                # Railway デプロイ構成
├── .dockerignore               # Docker除外設定
├── package.json                # プロジェクト定義・依存関係
├── tsconfig.json               # TypeScriptコンパイル設定
├── .env.example                # 環境変数テンプレート
├── README.md                   # 本ドキュメント
├── src/
│   ├── index.ts                # エントリーポイント・イベント購読・グレースフルシャットダウン
│   ├── config.ts               # 環境変数バリデーション (Zod)
│   ├── scheduler.ts            # 毎日 00:00 JST 定期タスク (croner)
│   ├── server.ts               # 死活監視エンドポイント (/healthz)
│   ├── services/
│   │   ├── channelManager.ts   # チャンネルライフサイクル管理（生成・確認・7日削除）
│   │   └── forumManager.ts     # フォーラムトピック長期未更新検出・確認送信
│   ├── handlers/
│   │   └── interactionHandler.ts # スラッシュコマンド・ボタンインタラクション処理
│   ├── commands/
│   │   ├── dailyBatchRun.ts    # /daily-batch-run コマンド定義
│   │   └── testForumCleanup.ts # /test_forum_cleanup コマンド定義
│   └── utils/
│       └── dateUtils.ts        # JST日付処理・差分日数判定・年跨ぎ/うるう年対応
└── tests/
    ├── dateUtils.test.ts       # 日付ユーティリティのユニットテスト
    ├── channelManager.test.ts  # チャンネルライフサイクルのテスト
    ├── forumManager.test.ts    # フォーラムトピック管理のテスト
    ├── interactionHandler.test.ts # インタラクション＆権限検証テスト
    └── server.test.ts          # /healthz サーバーのテスト
```

---

## 📄 ライセンス

MIT License
