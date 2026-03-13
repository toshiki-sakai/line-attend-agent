import type { ConversationMessage, DetectedIntent } from '../types';

// === Hearing API ===

export interface HearingStartRequest {
  tenant_id: string;
  line_user_id: string;
  /** Optional: pre-populated hearing data from Lステップ */
  initial_hearing_data?: Record<string, string>;
  /** Optional: display name from Lステップ */
  display_name?: string;
}

export interface HearingStartResponse {
  session_id: string;
  message: string;
  phase: string;
  turn_count: number;
}

export interface HearingRespondRequest {
  tenant_id: string;
  line_user_id: string;
  session_id: string;
  user_message: string;
}

export interface HearingRespondResponse {
  session_id: string;
  message: string;
  is_complete: boolean;
  phase: string;
  turn_count: number;
  extracted_data: Record<string, string>;
  insight: string | null;
  detected_intent: DetectedIntent | null;
  escalate_to_human: boolean;
}

// === Message Generation API ===

export type MessagePurpose =
  | 'nurture'
  | 'follow_up'
  | 'no_show_recovery'
  | 'post_consultation'
  | 'hearing_recovery';

export interface MessageGenerateRequest {
  tenant_id: string;
  line_user_id: string;
  purpose: MessagePurpose;
  /** Extra context depending on purpose */
  context?: {
    /** For nurture: stage of nurture sequence */
    nurture_stage?: 'value_preview' | 'preparation' | 'excitement' | 'day_of' | 'final_countdown';
    /** For nurture/no_show_recovery: hours until consultation */
    hours_until_consultation?: number;
    /** For nurture: zoom URL */
    zoom_url?: string;
    /** For post_consultation: action type */
    action_type?: string;
  };
}

export interface MessageGenerateResponse {
  message: string;
  detected_intent: DetectedIntent | null;
  should_continue_follow_up: boolean;
  recommended_next_timing_hours: number | null;
  escalate_to_human: boolean;
}

// === Intent Detection API ===

export interface IntentDetectRequest {
  message: string;
}

export interface IntentDetectResponse {
  intent: DetectedIntent;
  guidance: string;
  confidence: 'pattern_match' | 'none';
}

// === No-Show Risk API ===

export interface NoShowRiskRequest {
  tenant_id: string;
  line_user_id: string;
  /** Booking info from Lステップ */
  booking: {
    scheduled_at: string;
    created_at: string;
    reminder_count: number;
  };
  /** Messages since booking from Lステップ */
  messages_since_booking?: number;
  /** User response rate from Lステップ */
  user_response_rate?: number;
}

export interface NoShowRiskResponse {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  factors: Array<{ name: string; impact: number; detail: string }>;
  recommended_intervention: string;
  hours_until_consultation: number;
}

// === Lead Score API ===

export interface LeadScoreRequest {
  tenant_id: string;
  line_user_id: string;
  /** Optional message count override (otherwise calculated from DB) */
  message_count?: number;
}

export interface LeadScoreResponse {
  score: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  conversion_probability: number;
  factors: Array<{ name: string; points: number; max_points: number; description: string }>;
  recommended_action: string;
}

// === User Profile API ===

export interface UserProfileResponse {
  line_user_id: string;
  display_name: string | null;
  status: string;
  hearing_data: Record<string, string>;
  insight_summary: string | null;
  follow_up_count: number;
  last_message_at: string | null;
  last_response_at: string | null;
  ai_session_state: string;
  created_at: string;
}

// === Admin Analytics API ===

export interface AdminAnalyticsResponse {
  ai_performance: {
    total_conversations: number;
    ai_handled: number;
    auto_resolution_rate: number;
    escalation_count: number;
    avg_messages_to_booking: number | null;
    estimated_hours_saved: number;
  };
  hearing_analytics: {
    total_sessions: number;
    completed_sessions: number;
    completion_rate: number;
    avg_turns: number;
  };
  intent_distribution: Record<string, number>;
  api_usage: {
    total_calls: number;
    avg_latency_ms: number;
    error_rate: number;
  };
}

// === Simulate API ===

export interface SimulateRequest {
  tenant_id: string;
  message: string;
  history?: ConversationMessage[];
  config?: {
    user_name?: string;
    hearing_data?: Record<string, string>;
  };
}

export interface SimulateResponse {
  reply: string;
  extracted_data: Record<string, string>;
  insight: string | null;
  is_hearing_complete: boolean;
  escalate_to_human: boolean;
  detected_intent: DetectedIntent | null;
  updated_hearing_data: Record<string, string>;
}

// === API Error Response ===

export interface APIErrorResponse {
  error: string;
  detail?: string;
}
