import type { Env } from '../types';
import { getSupabaseClient } from './supabase';

export async function cancelPendingActions(
  endUserId: string,
  env: Env,
  filters?: { action_type?: string }
): Promise<void> {
  const supabase = getSupabaseClient(env);
  let query = supabase
    .from('scheduled_actions')
    .update({ status: 'cancelled' })
    .eq('end_user_id', endUserId)
    .eq('status', 'pending');

  if (filters?.action_type) {
    query = query.eq('action_type', filters.action_type);
  }

  await query;
}
