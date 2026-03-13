export interface Env {
  TENANT_CACHE: KVNamespace;
  MESSAGE_QUEUE: Queue<QueuePayload>;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ANTHROPIC_API_KEY: string;
  DEFAULT_LINE_CHANNEL_SECRET: string;
  DEFAULT_LINE_CHANNEL_ACCESS_TOKEN: string;
}

export interface QueuePayload {
  tenantId: string;
  events: LineWebhookEvent[];
}

export interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source: {
    type: string;
    userId: string;
  };
  message?: {
    type: string;
    id: string;
    text?: string;
  };
  postback?: {
    data: string;
  };
  timestamp: number;
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
  is_active: boolean;
  created_at: string;
}

export interface Conversation {
  id: string;
  end_user_id: string;
  tenant_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  message_type: string;
  step_at_time: string | null;
  created_at: string;
}

export interface FlowContext {
  tenant: Tenant;
  endUser: EndUser;
  currentStep: ScenarioStep;
  hearingData: Record<string, string>;
  bookingData?: Booking;
}
