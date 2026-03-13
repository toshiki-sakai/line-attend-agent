import type { Env, QueuePayload, Tenant, EndUser, FlowContext, LineWebhookEvent } from '../types';
import { getTenant } from '../config/tenant-config';
import { getSupabaseClient } from '../utils/supabase';
import { getProfile, pushMessage } from './line';
import { FlowEngine } from './flow-engine';
import { createBooking } from './booking';
import { getConversationHistory } from './ai';
import { isAlreadyProcessed, markProcessed } from '../utils/idempotency';
import { cancelPendingActions } from '../utils/scheduled-actions';
import { isValidUUID } from '../utils/validation';
import { formatDateJST, formatTimeJST } from '../utils/datetime';
import { logger } from '../utils/logger';

export async function handleQueueMessage(
  batch: MessageBatch<QueuePayload>,
  env: Env
): Promise<void> {
  const flowEngine = new FlowEngine(env);

  for (const message of batch.messages) {
    const { tenantId, events } = message.body;

    let tenant: Tenant;
    try {
      tenant = await getTenant(tenantId, env);
    } catch (error) {
      logger.error('Failed to get tenant', { tenantId, error: String(error) });
      message.ack();
      continue;
    }

    try {
      for (const event of events) {
        const eventId = `${event.source.userId}-${event.timestamp}`;

        if (await isAlreadyProcessed(eventId, env)) continue;

        switch (event.type) {
          case 'follow':
            await handleFollow(tenant, event, env, flowEngine);
            break;
          case 'unfollow':
            await handleUnfollow(tenant, event, env);
            break;
          case 'message':
            await handleMessage(tenant, event, env, flowEngine);
            break;
          case 'postback':
            await handlePostback(tenant, event, env);
            break;
        }

        await markProcessed(eventId, tenant.id, env);
      }
      message.ack();
    } catch (error) {
      logger.error('Event processing failed', { tenantId, error: String(error) });
      message.retry();
    }
  }
}

async function handleFollow(
  tenant: Tenant,
  event: LineWebhookEvent,
  env: Env,
  flowEngine: FlowEngine
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const lineUserId = event.source.userId;

  const profile = await getProfile(tenant, lineUserId);
  const displayName = profile?.displayName || null;

  const { data: existingUser } = await supabase
    .from('end_users')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('line_user_id', lineUserId)
    .single();

  let endUser: EndUser;

  if (existingUser) {
    const { data } = await supabase
      .from('end_users')
      .update({
        current_step: 'registered',
        status: 'active',
        is_blocked: false,
        display_name: displayName,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingUser.id)
      .select()
      .single();
    endUser = data as EndUser;
  } else {
    const { data, error } = await supabase
      .from('end_users')
      .insert({
        tenant_id: tenant.id,
        line_user_id: lineUserId,
        display_name: displayName,
        current_step: 'registered',
        status: 'active',
        is_blocked: false,
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create end user', { error: error.message });
      throw error;
    }
    endUser = data as EndUser;
  }

  logger.info('User followed', { tenantId: tenant.id, lineUserId, displayName });

  const welcomeStep = tenant.scenario_config?.steps?.find((s) => s.trigger === 'follow');
  if (welcomeStep) {
    await flowEngine.executeStep(tenant, endUser, welcomeStep, env);
  }
}

async function handleUnfollow(
  tenant: Tenant,
  event: LineWebhookEvent,
  env: Env
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const lineUserId = event.source.userId;

  const { data: endUser } = await supabase
    .from('end_users')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('line_user_id', lineUserId)
    .single();

  if (!endUser) return;

  await supabase
    .from('end_users')
    .update({ is_blocked: true, updated_at: new Date().toISOString() })
    .eq('id', endUser.id);

  await cancelPendingActions(endUser.id, env);

  logger.info('User unfollowed', { tenantId: tenant.id, lineUserId });
}

async function handleMessage(
  tenant: Tenant,
  event: LineWebhookEvent,
  env: Env,
  flowEngine: FlowEngine
): Promise<void> {
  const messageType = event.message?.type || 'unknown';
  const messageText = event.message?.text || '';

  const supabase = getSupabaseClient(env);
  const lineUserId = event.source.userId;

  const { data: endUser } = await supabase
    .from('end_users')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('line_user_id', lineUserId)
    .single();

  if (!endUser) {
    logger.warn('Message from unknown user', { lineUserId });
    return;
  }

  const steps = tenant.scenario_config?.steps || [];
  const currentStep = steps.find((s) => s.id === endUser.current_step);

  const effectiveStep = currentStep || {
    id: endUser.current_step,
    type: 'ai' as const,
    trigger: 'auto' as const,
    delay_minutes: 0,
    ai_config: { purpose: 'hearing' as const, max_turns: 6, completion_condition: 'all_items_collected' },
    next_step: '',
  };

  const conversationHistory = await getConversationHistory(endUser.id, tenant.id, env);

  const context: FlowContext = {
    tenant,
    endUser: endUser as EndUser,
    currentStep: effectiveStep,
    hearingData: endUser.hearing_data || {},
    conversationHistory,
    env,
  };

  await flowEngine.handleUserMessage(context, messageText, messageType);
}

async function handlePostback(
  tenant: Tenant,
  event: LineWebhookEvent,
  env: Env
): Promise<void> {
  if (!event.postback) return;

  const postbackData = event.postback.data;
  const supabase = getSupabaseClient(env);
  const lineUserId = event.source.userId;

  if (!postbackData.startsWith('book:')) return;

  const slotId = postbackData.replace('book:', '');

  // slotIdのUUID形式チェック
  if (!isValidUUID(slotId)) {
    logger.warn('Invalid slot ID in postback', { slotId });
    return;
  }

  const { data: endUser } = await supabase
    .from('end_users')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('line_user_id', lineUserId)
    .single();

  if (!endUser) return;

  const result = await createBooking(tenant.id, endUser.id, slotId, env);

  if (result.success && result.booking) {
    const booking = result.booking;
    const scheduledAt = booking.scheduled_at as string;
    const dateStr = formatDateJST(scheduledAt);
    const timeStr = formatTimeJST(scheduledAt);

    const message = `ご予約ありがとうございます🎉\n${dateStr}の${timeStr}からZoomでお待ちしています！\n\nZoomリンク: ${booking.zoom_url || '（後ほどご案内します）'}`;
    await pushMessage(tenant, lineUserId, message);

    await supabase.from('conversations').insert({
      end_user_id: endUser.id,
      tenant_id: tenant.id,
      role: 'assistant',
      content: message,
      step_at_time: 'booked',
    });

    // Schedule reminders for the booking
    await scheduleBookingReminders(tenant, endUser as EndUser, booking, env);
  } else {
    await pushMessage(
      tenant,
      lineUserId,
      result.error || '予約処理中にエラーが発生しました。もう一度お試しください。'
    );
  }
}

// --- Booking reminder helpers ---

async function scheduleBookingReminders(
  tenant: Tenant,
  endUser: EndUser,
  booking: Record<string, unknown>,
  env: Env
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const scheduledAt = new Date(booking.scheduled_at as string);
  const reminders = tenant.reminder_config?.pre_consultation || [];

  const now = new Date();
  const rows = reminders
    .map((reminder) => {
      const executeAt = calculateReminderTime(reminder.timing, scheduledAt);
      if (!executeAt || executeAt <= now) return null;
      return {
        tenant_id: tenant.id,
        end_user_id: endUser.id,
        action_type: 'reminder' as const,
        action_payload: {
          booking_id: booking.id,
          reminder_timing: reminder.timing,
          reminder_type: reminder.type,
          reminder_content: reminder.content,
        },
        execute_at: executeAt.toISOString(),
        status: 'pending' as const,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length > 0) {
    await supabase.from('scheduled_actions').insert(rows);
  }
}

function calculateReminderTime(timing: string, scheduledAt: Date): Date | null {
  switch (timing) {
    case '3_days_before':
      return new Date(scheduledAt.getTime() - 3 * 24 * 60 * 60 * 1000);
    case '1_day_before':
      return new Date(scheduledAt.getTime() - 24 * 60 * 60 * 1000);
    case '1_hour_before':
      return new Date(scheduledAt.getTime() - 60 * 60 * 1000);
    default:
      return null;
  }
}
