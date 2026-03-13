import type { Env, Tenant, EndUser, ScheduledAction } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { FlowEngine } from './flow-engine';
import { executeAction } from './action-executors';
import { pushMessage } from './line';
import { notifyStaff } from './notification';
import { cancelPendingActions } from '../utils/scheduled-actions';
import { logger } from '../utils/logger';

const NO_SHOW_THRESHOLD_MINUTES = 30;

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  await Promise.allSettled([
    processScheduledActions(env),
    detectNoShows(env),
    detectStaleConversations(env),
  ]);
}

async function processScheduledActions(env: Env): Promise<void> {
  const supabase = getSupabaseClient(env);

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

/**
 * Detect users who haven't responded and schedule follow-up actions.
 * Only for active users (not booked/consulted/enrolled/stalled/dropped).
 * Checks: user has received a message (last_message_at) but hasn't responded within the configured interval.
 */
async function detectStaleConversations(env: Env): Promise<void> {
  const supabase = getSupabaseClient(env);

  // Find active users who received a message but haven't responded
  // Only process users who don't already have pending follow-up actions
  const minStaleHours = 24; // At least 24 hours since last bot message
  const staleThreshold = new Date(Date.now() - minStaleHours * 60 * 60 * 1000).toISOString();

  const { data: staleUsers } = await supabase
    .from('end_users')
    .select('id, tenant_id, follow_up_count, last_message_at, last_response_at')
    .eq('status', 'active')
    .eq('is_blocked', false)
    .not('last_message_at', 'is', null)
    .lt('last_message_at', staleThreshold);

  if (!staleUsers || staleUsers.length === 0) return;

  for (const user of staleUsers) {
    // Skip if user responded after the last bot message
    if (user.last_response_at && user.last_message_at &&
        new Date(user.last_response_at) >= new Date(user.last_message_at)) {
      continue;
    }

    // Check if there's already a pending follow-up for this user
    const { count: pendingFollowUps } = await supabase
      .from('scheduled_actions')
      .select('*', { count: 'exact', head: true })
      .eq('end_user_id', user.id)
      .eq('action_type', 'follow_up')
      .eq('status', 'pending');

    if ((pendingFollowUps || 0) > 0) continue;

    // Get tenant config to check if follow-up is enabled
    const { data: tenant } = await supabase
      .from('tenants')
      .select('reminder_config')
      .eq('id', user.tenant_id)
      .eq('is_active', true)
      .single();

    if (!tenant) continue;

    const reminderConfig = tenant.reminder_config as Record<string, unknown> | null;
    const followUpConfig = reminderConfig?.no_response_follow_up as Record<string, unknown> | null;
    if (!followUpConfig?.enabled) continue;

    const maxAttempts = (followUpConfig.max_attempts as number) || 4;
    if (user.follow_up_count >= maxAttempts) continue;

    // Schedule follow-up based on configured interval
    const minInterval = (followUpConfig.min_interval_hours as number) || 24;
    const maxInterval = (followUpConfig.max_interval_hours as number) || 72;
    // Increase interval with each follow-up attempt
    const intervalHours = Math.min(minInterval + user.follow_up_count * 24, maxInterval);
    const executeAt = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();

    await supabase.from('scheduled_actions').insert({
      tenant_id: user.tenant_id,
      end_user_id: user.id,
      action_type: 'follow_up',
      action_payload: { attempt: user.follow_up_count + 1 },
      execute_at: executeAt,
      status: 'pending',
    });

    logger.info('Follow-up scheduled for stale user', {
      userId: user.id,
      attempt: user.follow_up_count + 1,
      executeAt,
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
      const tenant = bookingData.tenants as Tenant;
      const endUser = bookingData.end_users as EndUser;

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

      await cancelPendingActions(endUser.id, env, { action_type: 'reminder' });

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
