-- ==============================================
-- Migration: API-First Lステップ Integration
-- ==============================================

-- AI会話セッション管理
CREATE TABLE ai_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  end_user_id UUID NOT NULL REFERENCES end_users(id),
  session_type TEXT NOT NULL, -- hearing, follow_up, nurture
  status TEXT NOT NULL DEFAULT 'active', -- active, completed, expired, escalated
  phase TEXT, -- trust, pain, hope, commit (hearing用)
  turn_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- API使用ログ
CREATE TABLE api_usage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  endpoint TEXT NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tenants にAPIキー追加
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS api_key_prefix TEXT;

-- LINE認証情報をoptionalに（Lステップ連携ではLINE直接連携が不要な場合がある）
ALTER TABLE tenants ALTER COLUMN line_channel_id DROP NOT NULL;
ALTER TABLE tenants ALTER COLUMN line_channel_secret DROP NOT NULL;
ALTER TABLE tenants ALTER COLUMN line_channel_access_token DROP NOT NULL;

-- end_users にセッション状態追加
ALTER TABLE end_users ADD COLUMN IF NOT EXISTS ai_session_state TEXT NOT NULL DEFAULT 'idle';

-- インデックス
CREATE INDEX idx_ai_sessions_end_user ON ai_sessions(end_user_id, status);
CREATE INDEX idx_ai_sessions_tenant ON ai_sessions(tenant_id, session_type);
CREATE INDEX idx_ai_sessions_active ON ai_sessions(status, started_at) WHERE status = 'active';
CREATE INDEX idx_api_usage_log_tenant ON api_usage_log(tenant_id, created_at);
CREATE INDEX idx_tenants_api_key ON tenants(api_key_prefix) WHERE api_key_prefix IS NOT NULL;

-- line_channel_id のユニーク制約を条件付きに変更（NULLを許可するため）
-- 既存のユニーク制約を削除して再作成
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_line_channel_id_key;
CREATE UNIQUE INDEX idx_tenants_line_channel_id ON tenants(line_channel_id) WHERE line_channel_id IS NOT NULL;
