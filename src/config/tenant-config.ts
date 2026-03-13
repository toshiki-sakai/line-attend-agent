import type { Env, Tenant } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { logger } from '../utils/logger';

const KV_CACHE_TTL_SECONDS = 300; // 5分

export async function getTenant(tenantId: string, env: Env): Promise<Tenant> {
  // 1. KVキャッシュを確認
  const cached = await env.TENANT_CACHE.get(`tenant:${tenantId}`, 'json');
  if (cached) {
    return cached as Tenant;
  }

  // 2. DBから取得
  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    logger.error('Tenant not found', { tenantId, error: error?.message });
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  const tenant = data as Tenant;

  // 3. KVにキャッシュ
  await env.TENANT_CACHE.put(`tenant:${tenantId}`, JSON.stringify(tenant), {
    expirationTtl: KV_CACHE_TTL_SECONDS,
  });

  return tenant;
}

export async function invalidateTenantCache(tenantId: string, env: Env): Promise<void> {
  await env.TENANT_CACHE.delete(`tenant:${tenantId}`);
}
