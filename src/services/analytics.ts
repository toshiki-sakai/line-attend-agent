import type { Env } from '../types';
import { getSupabaseClient } from '../utils/supabase';

export interface FunnelMetrics {
  tenant_id: string;
  tenant_name: string;
  total_users: number;
  booked_users: number;
  consulted_users: number;
  enrolled_users: number;
  attendance_rate: number | null;
}

export async function getFunnelMetrics(tenantId: string, env: Env): Promise<FunnelMetrics | null> {
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from('v_funnel_metrics')
    .select('*')
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) return null;
  return data as FunnelMetrics;
}

export async function getAllFunnelMetrics(env: Env): Promise<FunnelMetrics[]> {
  const supabase = getSupabaseClient(env);
  const { data } = await supabase.from('v_funnel_metrics').select('*');
  return (data || []) as FunnelMetrics[];
}
