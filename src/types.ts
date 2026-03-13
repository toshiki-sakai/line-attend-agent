export interface Env {
  TENANT_CACHE: KVNamespace;
  MESSAGE_QUEUE: Queue<QueuePayload>;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ANTHROPIC_API_KEY: string;
  ADMIN_API_KEY: string;
}

export interface QueuePayload {
  tenantId: string;
  events: LineWebhookEvent[];
  receivedAt: string;
}

export interface LineWebhookEvent {
  type: 'follow' | 'unfollow' | 'message' | 'postback';
  timestamp: number;
  source: { userId: string; type: string };
  replyToken?: string;
  message?: { type: string; text?: string; id: string };
  postback?: { data: string };
}

export interface Tenant {
  id: string;
  name: string;
  line_channel_id: string;
  line_channel_secret: string;
  line_channel_access_token: string;
  scenario_config: ScenarioConfig;
  hearing_config: HearingConfig;
  reminder_config: ReminderConfig;
  tone_config: ToneConfig;
  guardrail_config: GuardrailConfig;
  notification_config: NotificationConfig;
  school_context: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScenarioConfig {
  steps: ScenarioStep[];
}

export interface ScenarioStep {
  id: string;
  type: 'template' | 'ai';
  trigger: 'follow' | 'auto' | 'booking_confirmed';
  delay_minutes: number;
  message?: {
    type: 'text' | 'flex' | 'quick_reply';
    content: string;
  };
  ai_config?: {
    purpose: 'hearing' | 'follow_up' | 'post_consultation';
    max_turns: number;
    completion_condition: string;
  };
  next_step: string;
}

export interface HearingConfig {
  items: HearingItem[];
}

export interface HearingItem {
  id: string;
  question_hint: string;
  required: boolean;
  priority: number;
}

export interface ReminderConfig {
  pre_consultation: PreConsultationReminder[];
  no_response_follow_up: {
    enabled: boolean;
    strategy: 'fixed' | 'ai_decided';
    max_attempts: number;
    min_interval_hours: number;
    max_interval_hours: number;
    escalation_message: string;
  };
}

export interface PreConsultationReminder {
  timing: string;
  type: 'template' | 'ai';
  content?: string;
  purpose?: string;
}

export interface ToneConfig {
  personality: string;
  emoji_usage: string;
  language_style: string;
  custom_instructions: string;
}

export interface GuardrailConfig {
  forbidden_topics: string[];
  forbidden_expressions: string[];
  answer_scope: string;
  human_handoff_trigger: string;
}

export interface NotificationConfig {
  method: 'line' | 'email';
  staff_line_user_ids: string[];
  notify_on: string[];
}

export interface PostConsultationConfig {
  actions: PostConsultationAction[];
}

export interface PostConsultationAction {
  type: string;
  delay_hours: number;
  method: 'template' | 'ai';
  content?: string;
  condition?: string;
}

export interface BookingConfig {
  zoom_base_url: string;
  duration_minutes: number;
  buffer_minutes: number;
  max_daily_bookings: number;
}

export interface EndUser {
  id: string;
  tenant_id: string;
  line_user_id: string;
  display_name: string | null;
  current_step: string;
  status: string;
  hearing_data: Record<string, string>;
  insight_summary: string | null;
  follow_up_count: number;
  last_message_at: string | null;
  last_response_at: string | null;
  source: string | null;
  is_blocked: boolean;
  created_at: string;
  updated_at: string;
}

export interface Booking {
  id: string;
  end_user_id: string;
  tenant_id: string;
  scheduled_at: string;
  zoom_url: string | null;
  status: string;
  reminded_at: string | null;
  reminder_count: number;
  created_at: string;
  updated_at: string;
}

export interface AvailableSlot {
  id: string;
  tenant_id: string;
  start_at: string;
  end_at: string;
  max_bookings: number;
  current_bookings: number;
  version: number;
  is_active: boolean;
  created_at: string;
}

export interface ScheduledAction {
  id: string;
  tenant_id: string;
  end_user_id: string;
  action_type: 'scenario_step' | 'reminder' | 'follow_up' | 'post_consultation';
  action_payload: Record<string, unknown>;
  execute_at: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  locked_until: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Conversation {
  id: string;
  end_user_id: string;
  tenant_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  message_type: string;
  step_at_time: string | null;
  ai_metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface FlowContext {
  tenant: Tenant;
  endUser: EndUser;
  currentStep: ScenarioStep;
  hearingData: Record<string, string>;
  bookingData?: Booking;
  conversationHistory: ConversationMessage[];
  env: Env;
}

export interface AIResponse {
  reply_message: string;
  escalate_to_human: boolean;
  extracted_data?: Record<string, string>;
  insight?: string;
  is_hearing_complete?: boolean;
  should_continue_follow_up?: boolean;
  recommended_next_timing_hours?: number;
}

export interface StaffNotification {
  type: 'human_handoff' | 'no_show' | 'stalled' | 'error';
  endUser: EndUser;
  reason: string;
}
