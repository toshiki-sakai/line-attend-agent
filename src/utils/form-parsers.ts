import type {
  HearingConfig,
  ToneConfig,
  GuardrailConfig,
  NotificationConfig,
  ReminderConfig,
  PreConsultationReminder,
} from '../types';

/**
 * Parse structured form data into config JSON objects.
 * Replaces JSON textarea editing with structured form inputs.
 */

export function parseHearingForm(body: Record<string, string | string[]>): HearingConfig {
  const ids = toArray(body['hearing_id']);
  const hints = toArray(body['hearing_hint']);
  const requireds = toArray(body['hearing_required']);
  const priorities = toArray(body['hearing_priority']);

  const items = ids.map((id, i) => ({
    id: id || `item_${i + 1}`,
    question_hint: hints[i] || '',
    required: requireds[i] === 'on' || requireds[i] === 'true',
    priority: parseInt(priorities[i]) || (i + 1),
  })).filter((item) => item.question_hint.trim() !== '');

  return { items };
}

export function parseToneForm(body: Record<string, string | string[]>): ToneConfig {
  return {
    personality: (body['tone_personality'] as string) || 'friendly',
    emoji_usage: (body['tone_emoji'] as string) || 'moderate',
    language_style: (body['tone_style'] as string) || 'polite',
    custom_instructions: (body['tone_custom'] as string) || '',
  };
}

export function parseGuardrailForm(body: Record<string, string | string[]>): GuardrailConfig {
  const forbiddenTopics = splitTags(body['guardrail_topics'] as string);
  const forbiddenExpressions = splitTags(body['guardrail_expressions'] as string);

  return {
    forbidden_topics: forbiddenTopics,
    forbidden_expressions: forbiddenExpressions,
    answer_scope: (body['guardrail_scope'] as string) || '',
    human_handoff_trigger: (body['guardrail_handoff'] as string) || '',
  };
}

export function parseNotificationForm(body: Record<string, string | string[]>): NotificationConfig {
  const method = (body['notification_method'] as string) === 'email' ? 'email' as const : 'line' as const;
  const staffIds = splitTags(body['notification_staff_ids'] as string);
  const notifyOn = toArray(body['notification_on']);

  return {
    method,
    staff_line_user_ids: staffIds,
    notify_on: notifyOn.filter(Boolean),
  };
}

export function parseReminderForm(body: Record<string, string | string[]>): ReminderConfig {
  // Pre-consultation reminders
  const timings = toArray(body['reminder_timing']);
  const types = toArray(body['reminder_type']);
  const contents = toArray(body['reminder_content']);
  const purposes = toArray(body['reminder_purpose']);

  const preConsultation: PreConsultationReminder[] = timings.map((timing, i) => ({
    timing: timing || '',
    type: (types[i] === 'ai' ? 'ai' : 'template') as 'template' | 'ai',
    ...(types[i] === 'template' && contents[i] ? { content: contents[i] } : {}),
    ...(types[i] === 'ai' && purposes[i] ? { purpose: purposes[i] } : {}),
  })).filter((r) => r.timing.trim() !== '');

  // No-response follow-up
  const enabled = body['followup_enabled'] === 'on' || body['followup_enabled'] === 'true';
  const strategy = (body['followup_strategy'] as string) === 'ai_decided' ? 'ai_decided' as const : 'fixed' as const;

  return {
    pre_consultation: preConsultation,
    no_response_follow_up: {
      enabled,
      strategy,
      max_attempts: parseInt(body['followup_max_attempts'] as string) || 4,
      min_interval_hours: parseInt(body['followup_min_interval'] as string) || 24,
      max_interval_hours: parseInt(body['followup_max_interval'] as string) || 72,
      escalation_message: (body['followup_escalation_message'] as string) || '',
    },
  };
}

// --- Helpers ---

function toArray(val: string | string[] | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

function splitTags(val: string | undefined): string[] {
  if (!val) return [];
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}
