import type { Env, Tenant, EndUser, FlowContext, ScheduledAction } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { FlowEngine } from './flow-engine';
import { generateFollowUpResponse, generatePostConsultationResponse, getConversationHistory } from './ai';
import { pushMessage } from './line';
import { validateMessage } from '../guards/ai-guardrails';
import { notifyStaff } from './notification';
import { formatDateJST, formatTimeJST } from '../utils/datetime';
import { logger } from '../utils/logger';

const NO_SHOW_THRESHOLD_MINUTES = 30;

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  await Promise.allSettled([
    processScheduledActions(env),
    detectNoShows(env),
  ]);
}

async function processScheduledActions(env: Env): Promise<void> {
  const supabase = getSupabaseClient(env);

  // 排他ロック付きで pending アクションを取得
  const { data: actions, error } = await supabase.rpc('lock_pending_actions', {
    batch_size: 20,
    lock_duration: '5 minutes',
  });

  if (error || !actions || actions.length === 0) return;

  const flowEngine = new FlowEngine(env);

  for (const action of actions as ScheduledAction[]) {
    try {
      await executeAction(action, env, flowEngine);
      await supabase
        .from('scheduled_actions')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', action.id);
    } catch (error) {
      const attempts = action.attempts + 1;
      const status = attempts >= action.max_attempts ? 'failed' : 'pending';

      await supabase
        .from('scheduled_actions')
        .update({
          status,
          attempts,
          last_error: String(error),
          locked_until: null,
        })
        .eq('id', action.id);

      if (status === 'failed') {
        await handleActionFailure(action, env);
      }

      logger.error('Scheduled action failed', {
        actionId: action.id,
        actionType: action.action_type,
        attempts,
        error: String(error),
      });
    }
  }
}

async function executeAction(
  action: ScheduledAction,
  env: Env,
  flowEngine: FlowEngine
): Promise<void> {
  const supabase = getSupabaseClient(env);

  const { data: endUser } = await supabase
    .from('end_users')
    .select('*')
    .eq('id', action.end_user_id)
    .single();

  if (!endUser || endUser.is_blocked) return;

  const { data: tenant } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', action.tenant_id)
    .eq('is_active', true)
    .single();

  if (!tenant) return;

  switch (action.action_type) {
    case 'scenario_step':
      await executeScenarioStep(action, tenant as Tenant, endUser as EndUser, env, flowEngine);
      break;
    case 'reminder':
      await executeReminder(action, tenant as Tenant, endUser as EndUser, env);
      break;
    case 'follow_up':
      await executeFollowUp(action, tenant as Tenant, endUser as EndUser, env);
      break;
    case 'post_consultation':
      await executePostConsultation(action, tenant as Tenant, endUser as EndUser, env);
      break;
  }
}

async function executeScenarioStep(
  action: ScheduledAction,
  tenant: Tenant,
  endUser: EndUser,
  env: Env,
  flowEngine: FlowEngine
): Promise<void> {
  const stepId = action.action_payload.step_id as string;
  const step = tenant.scenario_config?.steps?.find((s) => s.id === stepId);
  if (!step) return;

  await flowEngine.executeStep(tenant, endUser, step, env);
}

async function executeReminder(
  action: ScheduledAction,
  tenant: Tenant,
  endUser: EndUser,
  env: Env
): Promise<void> {
  const payload = action.action_payload;
  const reminderType = payload.reminder_type as string;
  const reminderContent = payload.reminder_content as string | undefined;
  const bookingId = payload.booking_id as string;

  const supabase = getSupabaseClient(env);
  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .eq('status', 'confirmed')
    .single();

  if (!booking) return;

  let message: string;

  if (reminderType === 'template' && reminderContent) {
    message = reminderContent
      .replace(/{zoom_url}/g, booking.zoom_url || '')
      .replace(/{booking_date}/g, formatDateJST(booking.scheduled_at))
      .replace(/{booking_time}/g, formatTimeJST(booking.scheduled_at));
  } else {
    const history = await getConversationHistory(endUser.id, tenant.id, env);
    const context: FlowContext = {
      tenant,
      endUser,
      currentStep: { id: 'reminder', type: 'ai', trigger: 'auto', delay_minutes: 0, next_step: '' },
      hearingData: endUser.hearing_data || {},
      conversationHistory: history,
      env,
    };
    const response = await generatePostConsultationResponse(context, 'personalized_remind');
    message = response.reply_message;
  }

  const guardrailResult = validateMessage(message, tenant);
  if (guardrailResult.passed) {
    await pushMessage(tenant, endUser.line_user_id, message);
  }

  await supabase
    .from('bookings')
    .update({
      reminded_at: new Date().toISOString(),
      reminder_count: booking.reminder_count + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId);
}

async function executeFollowUp(
  action: ScheduledAction,
  tenant: Tenant,
  endUser: EndUser,
  env: Env
): Promise<void> {
  const followUpConfig = tenant.reminder_config?.no_response_follow_up;
  if (!followUpConfig?.enabled) return;

  if (endUser.follow_up_count >= followUpConfig.max_attempts) {
    await handleMaxFollowUpReached(tenant, endUser, followUpConfig.escalation_message, env);
    return;
  }

  const history = await getConversationHistory(endUser.id, tenant.id, env);
  const context: FlowContext = {
    tenant,
    endUser,
    currentStep: { id: 'follow_up', type: 'ai', trigger: 'auto', delay_minutes: 0, next_step: '' },
    hearingData: endUser.hearing_data || {},
    conversationHistory: history,
    env,
  };

  const response = await generateFollowUpResponse(context);

  if (response.escalate_to_human) {
    await handleMaxFollowUpReached(tenant, endUser, followUpConfig.escalation_message, env);
    return;
  }

  const guardrailResult = validateMessage(response.reply_message, tenant);
  if (guardrailResult.passed) {
    await pushMessage(tenant, endUser.line_user_id, response.reply_message);
  }

  const supabase = getSupabaseClient(env);
  await supabase
    .from('end_users')
    .update({
      follow_up_count: endUser.follow_up_count + 1,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', endUser.id);

  await supabase.from('conversations').insert({
    end_user_id: endUser.id,
    tenant_id: tenant.id,
    role: 'assistant',
    content: response.reply_message,
    step_at_time: 'follow_up',
  });

  // Schedule next follow-up if needed
  if (response.should_continue_follow_up) {
    const nextTiming = response.recommended_next_timing_hours || 48;
    const flowEngine = new FlowEngine(env);
    await flowEngine.scheduleAction({
      tenant_id: tenant.id,
      end_user_id: endUser.id,
      action_type: 'follow_up',
      action_payload: {},
      execute_at: new Date(Date.now() + nextTiming * 60 * 60 * 1000).toISOString(),
    });
  }
}

async function executePostConsultation(
  action: ScheduledAction,
  tenant: Tenant,
  endUser: EndUser,
  env: Env
): Promise<void> {
  const actionType = action.action_payload.action_type as string;
  const condition = action.action_payload.condition as string | undefined;

  if (condition === 'status != enrolled' && endUser.status === 'enrolled') return;

  const templateContent = action.action_payload.content as string | undefined;
  let message: string;

  if (templateContent) {
    message = templateContent;
  } else {
    const history = await getConversationHistory(endUser.id, tenant.id, env);
    const context: FlowContext = {
      tenant,
      endUser,
      currentStep: { id: 'post_consultation', type: 'ai', trigger: 'auto', delay_minutes: 0, next_step: '' },
      hearingData: endUser.hearing_data || {},
      conversationHistory: history,
      env,
    };
    const response = await generatePostConsultationResponse(context, actionType);
    message = response.reply_message;

    if (response.insight) {
      const supabase = getSupabaseClient(env);
      await supabase
        .from('end_users')
        .update({ insight_summary: response.insight, updated_at: new Date().toISOString() })
        .eq('id', endUser.id);
    }
  }

  const guardrailResult = validateMessage(message, tenant);
  if (guardrailResult.passed) {
    await pushMessage(tenant, endUser.line_user_id, message);
  }

  const supabase = getSupabaseClient(env);
  await supabase.from('conversations').insert({
    end_user_id: endUser.id,
    tenant_id: tenant.id,
    role: 'assistant',
    content: message,
    step_at_time: 'post_consultation',
  });
}

async function handleMaxFollowUpReached(
  tenant: Tenant,
  endUser: EndUser,
  escalationMessage: string,
  env: Env
): Promise<void> {
  if (endUser.status === 'stalled') return;

  await pushMessage(tenant, endUser.line_user_id, escalationMessage);

  const supabase = getSupabaseClient(env);
  await supabase
    .from('end_users')
    .update({ status: 'stalled', updated_at: new Date().toISOString() })
    .eq('id', endUser.id);

  // Cancel pending actions
  await supabase
    .from('scheduled_actions')
    .update({ status: 'cancelled' })
    .eq('end_user_id', endUser.id)
    .eq('status', 'pending');

  await notifyStaff(tenant, {
    type: 'stalled',
    endUser,
    reason: '追客上限到達',
  });
}

async function handleActionFailure(action: ScheduledAction, env: Env): Promise<void> {
  const supabase = getSupabaseClient(env);

  const { data: tenant } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', action.tenant_id)
    .single();

  const { data: endUser } = await supabase
    .from('end_users')
    .select('*')
    .eq('id', action.end_user_id)
    .single();

  if (tenant && endUser) {
    await notifyStaff(tenant as Tenant, {
      type: 'error',
      endUser: endUser as EndUser,
      reason: `Scheduled action failed after max attempts: ${action.action_type}. Error: ${action.last_error}`,
    });
  }
}

async function detectNoShows(env: Env): Promise<void> {
  const supabase = getSupabaseClient(env);
  const threshold = new Date(Date.now() - NO_SHOW_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data: noShowBookings } = await supabase
    .from('bookings')
    .select('*, end_users!inner(*), tenants!inner(*)')
    .eq('status', 'confirmed')
    .lt('scheduled_at', threshold);

  if (!noShowBookings || noShowBookings.length === 0) return;

  for (const bookingData of noShowBookings) {
    try {
      const tenant = bookingData.tenants as unknown as Tenant;
      const endUser = bookingData.end_users as unknown as EndUser;

      await supabase
        .from('bookings')
        .update({ status: 'no_show', updated_at: new Date().toISOString() })
        .eq('id', bookingData.id);

      await pushMessage(
        tenant,
        endUser.line_user_id,
        '今日ご都合が悪かったでしょうか？またお気軽に日程をお選びくださいね😊'
      );

      await supabase
        .from('end_users')
        .update({
          current_step: 'booking_invited',
          status: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('id', endUser.id);

      // Cancel remaining reminders for this booking
      await supabase
        .from('scheduled_actions')
        .update({ status: 'cancelled' })
        .eq('end_user_id', endUser.id)
        .eq('action_type', 'reminder')
        .eq('status', 'pending');

      await notifyStaff(tenant, {
        type: 'no_show',
        endUser,
        reason: 'ノーショー検知',
      });

      logger.info('No-show detected', { bookingId: bookingData.id, userId: endUser.id });
    } catch (error) {
      logger.error('Failed to process no-show', {
        bookingId: bookingData.id,
        error: String(error),
      });
    }
  }
}
