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
