-- テナント
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  line_channel_id TEXT NOT NULL UNIQUE,
  line_channel_secret TEXT NOT NULL,
  line_channel_access_token TEXT NOT NULL,
  scenario_config JSONB NOT NULL DEFAULT '{}',
  hearing_config JSONB NOT NULL DEFAULT '[]',
  reminder_config JSONB NOT NULL DEFAULT '{}',
  tone_config JSONB NOT NULL DEFAULT '{}',
  guardrail_config JSONB NOT NULL DEFAULT '{}',
  notification_config JSONB NOT NULL DEFAULT '{}',
  school_context TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- エンドユーザー
CREATE TABLE end_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  line_user_id TEXT NOT NULL,
  display_name TEXT,
  current_step TEXT NOT NULL DEFAULT 'registered',
  status TEXT NOT NULL DEFAULT 'active',
  -- active / booked / consulted / enrolled / dropped / stalled
  hearing_data JSONB NOT NULL DEFAULT '{}',
  insight_summary TEXT,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_response_at TIMESTAMPTZ,
  source TEXT,
  is_blocked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, line_user_id)
);

-- 会話ログ
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  end_user_id UUID NOT NULL REFERENCES end_users(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  step_at_time TEXT,
  ai_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 予約
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  end_user_id UUID NOT NULL REFERENCES end_users(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  scheduled_at TIMESTAMPTZ NOT NULL,
  zoom_url TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  reminded_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 予約枠
CREATE TABLE available_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  max_bookings INTEGER NOT NULL DEFAULT 1,
  current_bookings INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- スケジュール済みアクション（遅延送信の中央管理テーブル）
CREATE TABLE scheduled_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  end_user_id UUID NOT NULL REFERENCES end_users(id),
  action_type TEXT NOT NULL,
  -- scenario_step / reminder / follow_up / post_consultation
  action_payload JSONB NOT NULL DEFAULT '{}',
  execute_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending / processing / completed / failed / cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- 相談後フォロー
CREATE TABLE post_consultation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  action_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TIMESTAMPTZ NOT NULL,
  content JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook冪等性キー
CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ファネル分析ビュー
CREATE VIEW v_funnel_metrics AS
SELECT
  t.id AS tenant_id, t.name AS tenant_name,
  COUNT(DISTINCT eu.id) AS total_users,
  COUNT(DISTINCT eu.id) FILTER (WHERE eu.status IN ('booked','consulted','enrolled')) AS booked_users,
  COUNT(DISTINCT eu.id) FILTER (WHERE eu.status IN ('consulted','enrolled')) AS consulted_users,
  COUNT(DISTINCT eu.id) FILTER (WHERE eu.status = 'enrolled') AS enrolled_users,
  ROUND(COUNT(DISTINCT eu.id) FILTER (WHERE eu.status IN ('consulted','enrolled'))::DECIMAL
    / NULLIF(COUNT(DISTINCT eu.id) FILTER (WHERE eu.status IN ('booked','consulted','enrolled')),0)*100,1
  ) AS attendance_rate
FROM tenants t LEFT JOIN end_users eu ON eu.tenant_id = t.id
GROUP BY t.id, t.name;

-- 排他ロック付きでpendingアクションを取得するRPC
CREATE OR REPLACE FUNCTION lock_pending_actions(batch_size INT, lock_duration INTERVAL DEFAULT '5 minutes')
RETURNS SETOF scheduled_actions AS $$
  UPDATE scheduled_actions
  SET status = 'processing', locked_until = now() + lock_duration
  WHERE id IN (
    SELECT id FROM scheduled_actions
    WHERE status = 'pending' AND execute_at <= now()
      AND (locked_until IS NULL OR locked_until < now())
    ORDER BY execute_at ASC
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$ LANGUAGE sql;

-- インデックス
CREATE INDEX idx_end_users_tenant ON end_users(tenant_id);
CREATE INDEX idx_end_users_status ON end_users(tenant_id, status);
CREATE INDEX idx_conversations_end_user ON conversations(end_user_id, created_at);
CREATE INDEX idx_bookings_scheduled ON bookings(scheduled_at);
CREATE INDEX idx_bookings_status ON bookings(status, scheduled_at);
CREATE INDEX idx_scheduled_actions_pending ON scheduled_actions(execute_at) WHERE status = 'pending';
CREATE INDEX idx_available_slots_active ON available_slots(tenant_id, start_at) WHERE is_active = true;
CREATE INDEX idx_processed_events_cleanup ON processed_events(processed_at);
