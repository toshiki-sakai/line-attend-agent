# 開発ログ

## 2026-03-13（木）— プロジェクト立ち上げ & 全フェーズ実装完了

### やったこと

- 要件定義書（`requirements-definition.doc`）を読み込み、設計方針を確認
- プロジェクト初期化（npm + TypeScript + Hono + Cloudflare Workers）
- 以下を一気通貫で実装：

#### フェーズ1: 基盤構築
- `wrangler.toml` 設定（KV / Queues / Cron Triggers / nodejs_compat）
- Supabase DBスキーマ作成（`supabase/migrations/001_initial_schema.sql`）
  - tenants / end_users / conversations / bookings / available_slots / post_consultation_actions
- LINE Webhook受信（署名検証 → 即200返却 → Queue送信）
- Queue Consumer実装（follow / message / postback イベント振り分け）
- テナント設定ローダー（DB取得 + KVキャッシュ TTL 5分）

#### フェーズ2: シナリオエンジン + AI会話
- FlowEngine（状態遷移マシン）：template / ai ステップの処理分岐
- Claude API連携（claude-sonnet-4-20250514）
  - ヒアリング用（temperature 0.3）・追客用（0.7）・相談後フォロー用（0.5）
  - JSON応答パース + 最大3回リトライ + フォールバック
- AIガードレール（金額パターン・断定表現・テナント固有禁止語チェック）
- 会話ログ保存

#### フェーズ3: 予約 + リマインド
- 予約枠管理（available_slots から空き枠取得）
- Flex Messageカルーセルで日程選択UI
- Postback → 予約確定 → ステータス更新
- Cron Trigger（毎分）でリマインド送信（3日前 / 前日 / 1時間前）
- ノーショー検知 → 再予約誘導

#### フェーズ4: 追客 + 相談後フォロー
- 未返信ユーザー検出 + AI判断追客（最大5回 → エスカレーション）
- 相談後フォローアクション（お礼 / 入会案内 / 追客 / アンケート）

#### フェーズ5: デプロイ準備
- テスト用テナント設定JSON（`tenant-configs/example-school.json`）
- GitHubリポジトリ作成 & プッシュ: https://github.com/toshiki-sakai/line-attend-agent

### 技術メモ
- Cloudflare Workers の Queue Consumer は `ExportedHandlerQueueHandler<Env>` でキャストが必要だった
- `node:crypto` の `createHmac` を使うために `nodejs_compat` フラグ必須
- TypeScript型チェック通過確認済み

### 次にやること
- [ ] Supabaseプロジェクト作成 → マイグレーション実行
- [ ] Cloudflare KV / Queues を `wrangler` で作成し、`wrangler.toml` のIDを実際の値に更新
- [ ] `.dev.vars` に実際のAPIキー・トークンを記入
- [ ] `wrangler secret put` で本番シークレット設定
- [ ] `npm run deploy` でCloudflare Workersにデプロイ
- [ ] LINE公式アカウントのWebhook URLを設定
- [ ] エンドツーエンドの動作テスト
