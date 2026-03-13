import type { ScenarioConfig, HearingConfig, ReminderConfig, ToneConfig, GuardrailConfig, NotificationConfig, PostConsultationConfig } from '../types';

/**
 * Default scenario template for online school attendance optimization.
 * Designed by LINE marketing experts for maximum consultation attendance rate.
 *
 * Flow: Follow → Welcome → Hearing (AI) → Booking Invitation → Booked →
 *       Reminders → Consultation → Post-consultation Follow-up
 */
export const DEFAULT_SCENARIO_CONFIG: ScenarioConfig = {
  steps: [
    {
      id: 'welcome',
      type: 'template',
      trigger: 'follow',
      delay_minutes: 0,
      message: {
        type: 'text',
        content: '{display_name}さん、友だち追加ありがとうございます！\n\nあなたの目標や今のお悩みに合わせて、最適なアドバイスをお届けしますね。\n\nまずは少しお話を聞かせてください😊',
      },
      next_step: 'hearing_start',
    },
    {
      id: 'hearing_start',
      type: 'ai',
      trigger: 'auto',
      delay_minutes: 0,
      ai_config: {
        purpose: 'hearing',
        max_turns: 8,
        completion_condition: 'all_required_items_collected',
      },
      next_step: 'pre_booking_nudge',
    },
    {
      id: 'pre_booking_nudge',
      type: 'template',
      trigger: 'auto',
      delay_minutes: 0,
      message: {
        type: 'text',
        content: 'ありがとうございます！{display_name}さんのお話、とても参考になりました✨\n\n{display_name}さんの状況に合わせて、より具体的なアドバイスができる無料相談会をご用意しています。\n\nオンラインで30分ほどなので、お気軽にどうぞ！',
      },
      next_step: 'booking_invite',
    },
    {
      id: 'booking_invite',
      type: 'template',
      trigger: 'auto',
      delay_minutes: 1,
      message: {
        type: 'text',
        content: 'BOOKING_SELECTOR',
      },
      next_step: '',
    },
    {
      id: 'booked',
      type: 'template',
      trigger: 'booking_confirmed',
      delay_minutes: 0,
      message: {
        type: 'text',
        content: '相談会までに何か気になることがあれば、いつでもメッセージくださいね！楽しみにしています😊',
      },
      next_step: '',
    },
  ],
};

export const DEFAULT_HEARING_CONFIG: HearingConfig = {
  items: [
    {
      id: 'current_situation',
      question_hint: '今の状況（仕事、学習状況など）',
      required: true,
      priority: 1,
    },
    {
      id: 'goal',
      question_hint: '目標・なりたい姿',
      required: true,
      priority: 2,
    },
    {
      id: 'challenge',
      question_hint: '今一番困っていること・悩み',
      required: true,
      priority: 3,
    },
    {
      id: 'timeline',
      question_hint: 'いつまでに達成したいか',
      required: false,
      priority: 4,
    },
    {
      id: 'past_experience',
      question_hint: '過去に試したこと・学習経験',
      required: false,
      priority: 5,
    },
    {
      id: 'motivation',
      question_hint: 'きっかけ・モチベーション',
      required: false,
      priority: 6,
    },
  ],
};

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = {
  pre_consultation: [
    {
      timing: '3_days_before',
      type: 'ai',
      purpose: '相談会3日前のリマインド。期待感を高めるパーソナライズドメッセージ。',
    },
    {
      timing: '1_day_before',
      type: 'template',
      content: '{display_name}さん、明日は相談会ですね！\n\n{booking_date} {booking_time}〜\nZoom: {zoom_url}\n\nお会いできるのを楽しみにしています😊',
    },
    {
      timing: '1_hour_before',
      type: 'template',
      content: 'まもなく相談会の時間です！\n\nZoomリンク: {zoom_url}\n\nお待ちしていますね😊',
    },
  ],
  no_response_follow_up: {
    enabled: true,
    strategy: 'ai_decided',
    max_attempts: 4,
    min_interval_hours: 24,
    max_interval_hours: 72,
    escalation_message: 'いつでもお気軽にメッセージくださいね。ご都合の良いタイミングでお話できればと思います😊',
  },
};

export const DEFAULT_TONE_CONFIG: ToneConfig = {
  personality: 'friendly_professional',
  emoji_usage: 'moderate（文末に1つ程度。多すぎない）',
  language_style: 'です・ます調（だけどカジュアルめ）',
  custom_instructions: '親しみやすい先輩のように。売り込まない。相手の話を聞くことを最優先に。',
};

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  forbidden_topics: ['他社スクール名', '競合比較', '政治', '宗教'],
  forbidden_expressions: ['絶対', '保証', '確実', '必ず', '100%'],
  answer_scope: 'スクールに関する一般的な質問のみ。具体的な料金・カリキュラム詳細は相談会で案内。',
  human_handoff_trigger: 'ユーザーが不満・怒りを表明した場合、または3回連続で意図不明な場合',
};

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  method: 'line',
  staff_line_user_ids: [],
  notify_on: ['human_handoff', 'no_show', 'stalled', 'error'],
};

export const DEFAULT_POST_CONSULTATION_CONFIG: PostConsultationConfig = {
  actions: [
    { type: 'thank_you', delay_hours: 1, method: 'ai' },
    { type: 'enrollment_guide', delay_hours: 24, method: 'ai', condition: 'status != enrolled' },
    { type: 'follow_up', delay_hours: 72, method: 'ai', condition: 'status != enrolled' },
  ],
};

export function getDefaultConfigs(): {
  scenario_config: ScenarioConfig;
  hearing_config: HearingConfig;
  reminder_config: ReminderConfig;
  tone_config: ToneConfig;
  guardrail_config: GuardrailConfig;
  notification_config: NotificationConfig;
  post_consultation_config: PostConsultationConfig;
} {
  return {
    scenario_config: DEFAULT_SCENARIO_CONFIG,
    hearing_config: DEFAULT_HEARING_CONFIG,
    reminder_config: DEFAULT_REMINDER_CONFIG,
    tone_config: DEFAULT_TONE_CONFIG,
    guardrail_config: DEFAULT_GUARDRAIL_CONFIG,
    notification_config: DEFAULT_NOTIFICATION_CONFIG,
    post_consultation_config: DEFAULT_POST_CONSULTATION_CONFIG,
  };
}
