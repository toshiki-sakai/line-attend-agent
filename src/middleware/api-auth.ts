import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { createHmac } from 'node:crypto';
import { logger } from '../utils/logger';

/**
 * API key authentication middleware for tenant-scoped API access.
 *
 * Expects header: Authorization: Bearer <api_key>
 * The API key is hashed and matched against tenant's api_key_hash.
 * Sets c.set('tenantId', ...) on successful auth.
 */
export async function apiKeyAuthMiddleware(
  c: Context<{ Bindings: Env; Variables: { tenantId: string } }>,
  next: Next
): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header. Expected: Bearer <api_key>' }, 401);
  }

  const apiKey = authHeader.slice(7);
  if (!apiKey || apiKey.length < 16) {
    return c.json({ error: 'Invalid API key format' }, 401);
  }

  const prefix = apiKey.slice(0, 8);
  const keyHash = hashApiKey(apiKey);

  const supabase = getSupabaseClient(c.env);
  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('id, is_active')
    .eq('api_key_prefix', prefix)
    .eq('api_key_hash', keyHash)
    .single();

  if (error || !tenant) {
    logger.warn('API auth failed', { prefix, error: error?.message });
    return c.json({ error: 'Invalid API key' }, 401);
  }

  if (!tenant.is_active) {
    return c.json({ error: 'Tenant is deactivated' }, 403);
  }

  // Store tenant ID for downstream handlers
  c.set('tenantId', tenant.id);

  return next();
}

/**
 * Hash an API key for storage/comparison.
 */
export function hashApiKey(apiKey: string): string {
  return createHmac('sha256', 'line-attend-api-key')
    .update(apiKey)
    .digest('hex');
}

/**
 * Generate a new API key and its hash.
 */
export function generateApiKey(): { apiKey: string; hash: string; prefix: string } {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let apiKey = 'la_';
  for (let i = 0; i < 40; i++) {
    apiKey += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return {
    apiKey,
    hash: hashApiKey(apiKey),
    prefix: apiKey.slice(0, 8),
  };
}
