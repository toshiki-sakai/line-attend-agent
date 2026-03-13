import type { Env } from '../types';
import { getSupabaseClient } from './supabase';

export async function isAlreadyProcessed(eventId: string, env: Env): Promise<boolean> {
  const supabase = getSupabaseClient(env);
  const { data } = await supabase
    .from('processed_events')
    .select('event_id')
    .eq('event_id', eventId)
    .single();
  return data !== null;
}

export async function markProcessed(eventId: string, tenantId: string, env: Env): Promise<void> {
  const supabase = getSupabaseClient(env);
  await supabase.from('processed_events').insert({
    event_id: eventId,
    tenant_id: tenantId,
  });
}
