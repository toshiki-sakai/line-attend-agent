import type { Env, Tenant, EndUser, FlowContext, ScenarioStep } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { FlowEngine } from './flow-engine';
import { generateFollowUpResponse, generatePostConsultationResponse } from './ai';
import { sendTextMessage } from './line';
import { validateMessage } from '../guards/ai-guardrails';
import { logger } from '../utils/logger';

export async function handleScheduled(
  controller: ScheduledController,
  env: Env
): Promise<void> {
  const now = new Date(controller.scheduledTime);

  await Promise.all([
    processDelayedSteps(env, now),
    processReminders(env, now),
    processFollowUps(env, now),
    processPostConsultation(env, now),
  ]);
}

async function processDelayedSteps(env: Env, now: Date): Promise<void> {
  const supabase = getSupabaseClient(env);
  const flowEngine = new FlowEngine(env);

  // delay待ちのユーザーを取得（last_message_atが現在時刻以前のもの）
  const { data: users } = await supabase
    .from('end_users')
    .select('*, tenants!inner(*)')
    .lte('last_message_at', now.toISOString())
    .eq('status', 'active')
    .not('last_message_at', 'is', null);

  if (!users || users.length === 0) return;

  for (const userData of users) {
    try {
      const tenant = userData.tenants as unknown as Tenant;
      const endUser = userData as unknown as EndUser;
      const steps = tenant.scenario_config?.steps || [];
      const currentStep = steps.find((s: ScenarioStep) => s.id === endUser.current_step);

      if (!currentStep) continue;

      // auto trigger + delay_minutes > 0 のステップを実行
      if (currentStep.trigger === 'auto' && currentStep.delay_minutes > 0) {
        await flowEngine.executeStep(tenant, endUser, currentStep);

        // last_message_atをクリア
        await supabase
          .from('end_users')
          .update({ last_message_at: null, updated_at: now.toISOString() })
          .eq('id', endUser.id);
      }
    } catch (error) {
      logger.error('Failed to process delayed step', {
        userId: userData.id,
        error: String(error),
      });
    }
  }
}

async function processReminders(env: Env, now: Date): Promise<void> {
  const supabase = getSupabaseClient(env);

  // リマインド対象のbookingを取得
  const { data: bookings } = await supabase
    .from('bookings')
    .select('*, end_users!inner(*), tenants!inner(*)')
    .eq('status', 'confirmed')
    .gt('scheduled_at', now.toISOString());

  if (!bookings || bookings.length === 0) return;

  for (const bookingData of bookings) {
    try {
      const tenant = bookingData.tenants as unknown as Tenant;
      const endUser = bookingData.end_users as unknown as EndUser;
      const scheduledAt = new Date(bookingData.scheduled_at);
      const hoursUntil = (scheduledAt.getTime() - now.getTime()) / (1000 * 60 * 60);

      const reminders = tenant.reminder_config?.pre_consultation || [];

      for (const reminder of reminders) {
        const shouldSend = checkReminderTiming(reminder.timing, hoursUntil, bookingData.reminded_at, now);
        if (!shouldSend) continue;

        let message: string;

        if (reminder.type === 'template' && reminder.content) {
          message = reminder.content
            .replace(/{zoom_url}/g, bookingData.zoom_url || '')
            .replace(/{booking_date}/g, formatDate(bookingData.scheduled_at))
            .replace(/{booking_time}/g, formatTime(bookingData.scheduled_at));
        } else {
          // AI生成リマインド
          const context: FlowContext = {
            tenant,
            endUser,
            currentStep: { id: 'reminder', type: 'ai', trigger: 'auto', delay_minutes: 0, next_step: '' },
            hearingData: endUser.hearing_data || {},
            bookingData: bookingData,
          };
          const response = await generatePostConsultationResponse(context, 'personalized_remind', env);
          message = response.reply_message;
        }

        const guardrailResult = validateMessage(message, tenant);
        if (guardrailResult.passed) {
          await sendTextMessage(tenant, endUser.line_user_id, message);
        }

        // reminded_at更新
        await supabase
          .from('bookings')
          .update({
            reminded_at: now.toISOString(),
            reminder_count: bookingData.reminder_count + 1,
            updated_at: now.toISOString(),
          })
          .eq('id', bookingData.id);
      }

      // ノーショー検知（予約時間を過ぎてstatus=confirmedのまま）
      if (hoursUntil < -1) {
        await supabase
          .from('bookings')
          .update({ status: 'no_show', updated_at: now.toISOString() })
          .eq('id', bookingData.id);

        await sendTextMessage(
          tenant,
          endUser.line_user_id,
          '今日ご都合が悪かったでしょうか？またお気軽に日程をお選びくださいね😊'
        );

        // ユーザーをbooking_invitedに戻す
        await supabase
          .from('end_users')
          .update({
            current_step: 'booking_invited',
            status: 'active',
            updated_at: now.toISOString(),
          })
          .eq('id', endUser.id);
      }
    } catch (error) {
      logger.error('Failed to process reminder', {
        bookingId: bookingData.id,
        error: String(error),
      });
    }
  }
}

async function processFollowUps(env: Env, now: Date): Promise<void> {
  const supabase = getSupabaseClient(env);

  // 追客対象ユーザーを取得
  const { data: users } = await supabase
    .from('end_users')
    .select('*, tenants!inner(*)')
    .eq('status', 'active')
    .not('last_response_at', 'is', null);

  if (!users || users.length === 0) return;

  for (const userData of users) {
    try {
      const tenant = userData.tenants as unknown as Tenant;
      const endUser = userData as unknown as EndUser;
      const followUpConfig = tenant.reminder_config?.no_response_follow_up;

      if (!followUpConfig?.enabled) continue;
      if (endUser.follow_up_count >= followUpConfig.max_attempts) {
        // 最大回数到達 → エスカレーション
        if (endUser.status !== 'stalled') {
          await sendTextMessage(
            tenant,
            endUser.line_user_id,
            followUpConfig.escalation_message
          );
          await supabase
            .from('end_users')
            .update({ status: 'stalled', updated_at: now.toISOString() })
            .eq('id', endUser.id);
        }
        continue;
      }

      // 最後の返信からの経過時間チェック
      const lastResponse = new Date(endUser.last_response_at!);
      const hoursSinceResponse = (now.getTime() - lastResponse.getTime()) / (1000 * 60 * 60);

      if (hoursSinceResponse < followUpConfig.min_interval_hours) continue;

      const context: FlowContext = {
        tenant,
        endUser,
        currentStep: { id: 'follow_up', type: 'ai', trigger: 'auto', delay_minutes: 0, next_step: '' },
        hearingData: endUser.hearing_data || {},
      };

      const response = await generateFollowUpResponse(context, env);

      if (response.escalate_to_human) {
        await sendTextMessage(tenant, endUser.line_user_id, followUpConfig.escalation_message);
        await supabase
          .from('end_users')
          .update({ status: 'stalled', updated_at: now.toISOString() })
          .eq('id', endUser.id);
        continue;
      }

      const guardrailResult = validateMessage(response.reply_message, tenant);
      if (guardrailResult.passed) {
        await sendTextMessage(tenant, endUser.line_user_id, response.reply_message);
      }

      await supabase
        .from('end_users')
        .update({
          follow_up_count: endUser.follow_up_count + 1,
          last_message_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq('id', endUser.id);

      // 会話ログ保存
      await supabase.from('conversations').insert({
        end_user_id: endUser.id,
        tenant_id: tenant.id,
        role: 'assistant',
        content: response.reply_message,
        step_at_time: 'follow_up',
      });
    } catch (error) {
      logger.error('Failed to process follow-up', {
        userId: userData.id,
        error: String(error),
      });
    }
  }
}

async function processPostConsultation(env: Env, now: Date): Promise<void> {
  const supabase = getSupabaseClient(env);

  // 送信待ちの相談後フォローアクションを取得
  const { data: actions } = await supabase
    .from('post_consultation_actions')
    .select('*, bookings!inner(*, end_users!inner(*), tenants!inner(*))')
    .eq('status', 'pending')
    .lte('scheduled_at', now.toISOString());

  if (!actions || actions.length === 0) return;

  for (const action of actions) {
    try {
      const booking = action.bookings;
      const tenant = booking.tenants as unknown as Tenant;
      const endUser = booking.end_users as unknown as EndUser;

      // condition チェック
      if (action.content?.condition) {
        const condition = action.content.condition as string;
        if (condition === 'status != enrolled' && endUser.status === 'enrolled') {
          await supabase
            .from('post_consultation_actions')
            .update({ status: 'completed' })
            .eq('id', action.id);
          continue;
        }
      }

      let message: string;

      if (action.action_type === 'template' && action.content?.text) {
        message = action.content.text as string;
      } else {
        const context: FlowContext = {
          tenant,
          endUser,
          currentStep: { id: 'post_consultation', type: 'ai', trigger: 'auto', delay_minutes: 0, next_step: '' },
          hearingData: endUser.hearing_data || {},
          bookingData: booking,
        };
        const response = await generatePostConsultationResponse(context, action.action_type, env);
        message = response.reply_message;

        // インサイト更新
        if (response.insight) {
          await supabase
            .from('end_users')
            .update({ insight_summary: response.insight, updated_at: now.toISOString() })
            .eq('id', endUser.id);
        }
      }

      const guardrailResult = validateMessage(message, tenant);
      if (guardrailResult.passed) {
        await sendTextMessage(tenant, endUser.line_user_id, message);
      }

      await supabase
        .from('post_consultation_actions')
        .update({ status: 'sent' })
        .eq('id', action.id);

      // 会話ログ保存
      await supabase.from('conversations').insert({
        end_user_id: endUser.id,
        tenant_id: tenant.id,
        role: 'assistant',
        content: message,
        step_at_time: 'post_consultation',
      });
    } catch (error) {
      logger.error('Failed to process post-consultation action', {
        actionId: action.id,
        error: String(error),
      });
    }
  }
}

function checkReminderTiming(
  timing: string,
  hoursUntil: number,
  lastRemindedAt: string | null,
  now: Date
): boolean {
  // 既に最近リマインドした場合はスキップ（1時間以内）
  if (lastRemindedAt) {
    const lastReminded = new Date(lastRemindedAt);
    if (now.getTime() - lastReminded.getTime() < 60 * 60 * 1000) return false;
  }

  switch (timing) {
    case '3_days_before':
      return hoursUntil <= 72 && hoursUntil > 48;
    case '1_day_before':
      return hoursUntil <= 24 && hoursUntil > 12;
    case '1_hour_before':
      return hoursUntil <= 1 && hoursUntil > 0;
    default:
      return false;
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
