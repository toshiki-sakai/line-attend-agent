import type { Env, Tenant, EndUser, Booking, FlowContext, ScheduledAction, PostConsultationConfig } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { FlowEngine } from './flow-engine';
import { generateFollowUpResponse, generatePostConsultationResponse, generateHearingRecoveryResponse, generateNurtureResponse, getConversationHistory } from './ai';
import { pushMessage } from './line';
import { validateMessage } from '../guards/ai-guardrails';
import { notifyStaff } from './notification';
import { cancelPendingActions } from '../utils/scheduled-actions';
import { formatDateJST, formatTimeJST } from '../utils/datetime';
import { calculateNoShowRisk } from './no-show-predictor';

export async function executeAction(
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

  // Skip action execution when staff has taken over
  if (endUser.is_staff_takeover) return;

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
    case 'nurture':
      await executeNurture(action, tenant as Tenant, endUser as EndUser, env);
      break;
  }
}

export async function schedulePostConsultationActions(
  tenant: Tenant,
  endUser: EndUser,
  bookingId: string,
  env: Env
): Promise<void> {
  const actions = tenant.post_consultation_config?.actions || [];
  if (actions.length === 0) return;

  const supabase = getSupabaseClient(env);
  const now = Date.now();

  const rows = actions.map((action) => ({
    tenant_id: tenant.id,
    end_user_id: endUser.id,
    action_type: 'post_consultation' as const,
    action_payload: {
      action_type: action.type,
      booking_id: bookingId,
      method: action.method,
      content: action.content,
      condition: action.condition,
    },
    execute_at: new Date(now + action.delay_hours * 60 * 60 * 1000).toISOString(),
    status: 'pending' as const,
  }));

  if (rows.length > 0) {
    await supabase.from('scheduled_actions').insert(rows);
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

  // Calculate no-show risk to decide reminder strategy
  const { count: msgCount } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('end_user_id', endUser.id)
    .eq('tenant_id', tenant.id)
    .gte('created_at', booking.created_at);

  const { count: userMsgCount } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('end_user_id', endUser.id)
    .eq('tenant_id', tenant.id)
    .eq('role', 'user')
    .gte('created_at', booking.created_at);

  const totalMsgs = msgCount || 0;
  const responseRate = totalMsgs > 0 ? (userMsgCount || 0) / totalMsgs : 0;
  const risk = calculateNoShowRisk(endUser, booking as unknown as Booking, userMsgCount || 0, responseRate);

  let message: string;

  // High/critical risk: escalate to staff for direct intervention
  if (risk.level === 'critical') {
    await notifyStaff(tenant, {
      type: 'no_show',
      endUser,
      reason: `着座リスク: ${risk.score}点（${risk.level}）。${risk.recommended_intervention}`,
    });
  }

  if (reminderType === 'template' && reminderContent && risk.level === 'low') {
    // Low risk: standard template reminder is fine
    message = reminderContent
      .replace(/{zoom_url}/g, booking.zoom_url || '')
      .replace(/{booking_date}/g, formatDateJST(booking.scheduled_at))
      .replace(/{booking_time}/g, formatTimeJST(booking.scheduled_at));
  } else {
    // Medium+ risk or AI reminder: use nurture-style personalized message
    const hoursUntil = Math.max(0, (new Date(booking.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60));
    const stage = hoursUntil < 2 ? 'final_countdown' : hoursUntil < 8 ? 'day_of' : hoursUntil < 30 ? 'excitement' : 'preparation';

    const context = await buildFlowContext(tenant, endUser, 'reminder', env);
    const response = await generateNurtureResponse(context, stage, hoursUntil, booking.zoom_url || undefined);
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
  _action: ScheduledAction,
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

  const context = await buildFlowContext(tenant, endUser, 'follow_up', env);

  // Check if this user has incomplete hearing data - use recovery prompt
  const hearingItems = tenant.hearing_config?.items || [];
  const answeredKeys = Object.keys(endUser.hearing_data || {});
  const isHearingIncomplete = hearingItems.length > 0 && answeredKeys.length > 0 && answeredKeys.length < hearingItems.length;
  const isInHearingStep = endUser.current_step?.includes('hearing');

  const response = isHearingIncomplete || isInHearingStep
    ? await generateHearingRecoveryResponse(context)
    : await generateFollowUpResponse(context);

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
    const context = await buildFlowContext(tenant, endUser, 'post_consultation', env);
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

async function executeNurture(
  action: ScheduledAction,
  tenant: Tenant,
  endUser: EndUser,
  env: Env
): Promise<void> {
  const payload = action.action_payload;
  const stage = payload.stage as 'value_preview' | 'preparation' | 'excitement' | 'day_of' | 'final_countdown';
  const bookingId = payload.booking_id as string;
  const zoomUrl = payload.zoom_url as string | undefined;

  const supabase = getSupabaseClient(env);

  // Verify booking is still confirmed
  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .eq('status', 'confirmed')
    .single();

  if (!booking) return;

  const consultationTime = new Date(booking.scheduled_at).getTime();
  const hoursUntil = Math.max(0, (consultationTime - Date.now()) / (1000 * 60 * 60));

  // Check no-show risk for this user
  const { count: msgCount } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('end_user_id', endUser.id)
    .eq('tenant_id', tenant.id)
    .gte('created_at', booking.created_at);

  const { count: userMsgCount } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('end_user_id', endUser.id)
    .eq('tenant_id', tenant.id)
    .eq('role', 'user')
    .gte('created_at', booking.created_at);

  const totalMsgs = msgCount || 0;
  const responseRate = totalMsgs > 0 ? (userMsgCount || 0) / totalMsgs : 0;
  const risk = calculateNoShowRisk(endUser, booking as unknown as Booking, userMsgCount || 0, responseRate);

  // Critical risk on day-of stages: alert staff for direct intervention
  if (risk.level === 'critical' && (stage === 'day_of' || stage === 'final_countdown')) {
    await notifyStaff(tenant, {
      type: 'no_show',
      endUser,
      reason: `【緊急】相談会まで${Math.round(hoursUntil)}時間。着座リスク: ${risk.score}点。${risk.recommended_intervention}`,
    });
  }

  const context = await buildFlowContext(tenant, endUser, 'nurture', env);
  const response = await generateNurtureResponse(
    context,
    stage,
    hoursUntil,
    zoomUrl || booking.zoom_url || undefined
  );

  const guardrailResult = validateMessage(response.reply_message, tenant);
  if (guardrailResult.passed) {
    await pushMessage(tenant, endUser.line_user_id, response.reply_message);
  }

  await supabase.from('conversations').insert({
    end_user_id: endUser.id,
    tenant_id: tenant.id,
    role: 'assistant',
    content: response.reply_message,
    step_at_time: `nurture_${stage}`,
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

  await cancelPendingActions(endUser.id, env);

  await notifyStaff(tenant, {
    type: 'stalled',
    endUser,
    reason: '追客上限到達',
  });
}

// FlowContext生成の共通化
async function buildFlowContext(
  tenant: Tenant,
  endUser: EndUser,
  stepId: string,
  env: Env
): Promise<FlowContext> {
  const history = await getConversationHistory(endUser.id, tenant.id, env);
  return {
    tenant,
    endUser,
    currentStep: { id: stepId, type: 'ai', trigger: 'auto', delay_minutes: 0, next_step: '' },
    hearingData: endUser.hearing_data || {},
    conversationHistory: history,
    env,
  };
}
