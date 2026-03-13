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

---

### 要件定義v2対応

要件定義書が修正され、以下の差分に対応:

- `scheduled_actions` テーブル追加（遅延送信/リマインド/追客/フォローの中央管理）
- `processed_events` テーブル + 冪等性チェック（Webhook重複排除）
- `v_funnel_metrics` ビュー（着座率KPI計測）
- `lock_pending_actions` RPC（FOR UPDATE SKIP LOCKEDで排他制御）
- 楽観的ロック（available_slots.version）
- `is_blocked`（unfollow検知）、`ai_metadata`（会話ログ拡張）
- `notification_config`（スタッフ通知設定）
- Claude API: SDK→fetch直接呼び出し + JSONフェンス除去
- reply token廃止 → 全メッセージpush message
- `date-fns-tz` でUTC↔Asia/Tokyo変換
- `escalate_to_human` を全AIレスポンスに追加
- `validateWithRetry`（ガードレール違反時のフィードバック付き再生成）
- unfollow処理: is_blocked=true + pending actions一括cancel
- 非テキストメッセージ対応
- Dead Letter Queue設定

---

### コードレビュー対応

`codereview.doc` の指摘パターンに基づき予防的に修正:

- マジックナンバー → 名前付き定数化（MAX_API_RETRIES, BACKOFF_BASE_MS, KV_CACHE_TTL_SECONDS, MAX_SLOT_RESULTS）
- 不要なダブルキャスト除去（`as unknown as` → `as`）
- 未使用関数削除（getTenantByLineChannelId）
- formatDate/formatTime を datetime.ts に共通化済み

---

### セキュリティレビュー（入力検証 & インジェクション）

- zodによるランタイム検証追加（tenantId UUID, webhook body schema, slotId UUID）
- 署名検証を `timingSafeEqual` に変更（タイミング攻撃対策）
- SQLインジェクション: 問題なし（Supabase JS ClientのORM経由のみ）
- XSS: 該当箇所なし（HTML出力なし、LINE APIにJSON送信のみ）
- パストラバーサル: 該当箇所なし（ファイルシステムアクセスなし）
- コマンドインジェクション: 該当箇所なし（child_process使用なし）

---

### 技術メモ
- Cloudflare Workers の Queue Consumer は `ExportedHandlerQueueHandler<Env>` でキャストが必要
- `node:crypto` の `createHmac` / `timingSafeEqual` を使うために `nodejs_compat` フラグ必須
- TypeScript型チェック通過確認済み

### 次にやること（手動作業）
- [ ] Supabaseプロジェクト作成 → マイグレーション実行（`001_initial_schema.sql`）
- [ ] Cloudflare KV / Queues / DLQ を `wrangler` で作成し、`wrangler.toml` のIDを実際の値に更新
- [ ] `.dev.vars` に実際のAPIキー・トークンを記入
- [ ] `wrangler secret put` で本番シークレット設定
- [ ] `npm run deploy` でCloudflare Workersにデプロイ
- [ ] LINE公式アカウントのWebhook URLを `https://<worker-url>/webhook/<tenantId>` に設定
- [ ] エンドツーエンドの動作テスト
