-- ============================================
-- テナント（オンラインスクール顧客）
-- ============================================
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
  school_context TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- エンドユーザー（LINE友だち）
-- ============================================
CREATE TABLE end_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  line_user_id TEXT NOT NULL,
  display_name TEXT,
  current_step TEXT NOT NULL DEFAULT 'registered',
  status TEXT NOT NULL DEFAULT 'active',
  hearing_data JSONB NOT NULL DEFAULT '{}',
  insight_summary TEXT,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_response_at TIMESTAMPTZ,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, line_user_id)
);

-- ============================================
-- 会話ログ
-- ============================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  end_user_id UUID NOT NULL REFERENCES end_users(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  step_at_time TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 予約
-- ============================================
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

-- ============================================
-- スケジュール枠（顧客が設定する空き枠）
-- ============================================
CREATE TABLE available_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  max_bookings INTEGER NOT NULL DEFAULT 1,
  current_bookings INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 相談後フォロー
-- ============================================
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

-- インデックス
CREATE INDEX idx_end_users_tenant ON end_users(tenant_id);
CREATE INDEX idx_end_users_status ON end_users(tenant_id, status);
CREATE INDEX idx_end_users_step ON end_users(tenant_id, current_step);
CREATE INDEX idx_conversations_end_user ON conversations(end_user_id);
CREATE INDEX idx_bookings_tenant_status ON bookings(tenant_id, status);
CREATE INDEX idx_bookings_scheduled ON bookings(scheduled_at);
CREATE INDEX idx_available_slots_tenant ON available_slots(tenant_id, start_at);
CREATE INDEX idx_post_consultation_booking ON post_consultation_actions(booking_id);
