import { Hono } from 'hono';
import type { Env } from '../types';
import { getSupabaseClient } from '../utils/supabase';

const health = new Hono<{ Bindings: Env }>();

// Basic health check (no auth required, for uptime monitoring)
health.get('/health', async (c) => {
  const checks: Record<string, string> = {};
  let healthy = true;

  // Check Supabase connectivity
  try {
    const supabase = getSupabaseClient(c.env);
    const { error } = await supabase.from('tenants').select('id').limit(1);
    checks.database = error ? 'error' : 'ok';
    if (error) healthy = false;
  } catch {
    checks.database = 'unreachable';
    healthy = false;
  }

  // Check KV connectivity
  try {
    await c.env.TENANT_CACHE.get('health-check');
    checks.kv = 'ok';
  } catch {
    checks.kv = 'unreachable';
    healthy = false;
  }

  return c.json({
    status: healthy ? 'ok' : 'degraded',
    service: 'line-attend-agent',
    timestamp: new Date().toISOString(),
    checks,
  }, healthy ? 200 : 503);
});

// Detailed status (requires monitoring, no auth for external monitors with secret path)
health.get('/health/detailed', async (c) => {
  const supabase = getSupabaseClient(c.env);
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const [
    { count: activeTenants },
    { count: totalUsers },
    { count: pendingActions },
    { count: failedActions24h },
    { count: completedActions1h },
    { count: overdueActions },
  ] = await Promise.all([
    supabase.from('tenants').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('is_blocked', false),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', oneDayAgo),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('status', 'completed').gte('completed_at', oneHourAgo),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('status', 'pending').lt('execute_at', now.toISOString()),
  ]);

  const alertLevel =
    (failedActions24h || 0) > 20 || (overdueActions || 0) > 100 ? 'critical' :
    (failedActions24h || 0) > 5 || (overdueActions || 0) > 20 ? 'warning' :
    'normal';

  return c.json({
    status: alertLevel === 'critical' ? 'unhealthy' : alertLevel === 'warning' ? 'degraded' : 'ok',
    alert_level: alertLevel,
    timestamp: now.toISOString(),
    metrics: {
      active_tenants: activeTenants || 0,
      active_users: totalUsers || 0,
      actions: {
        pending: pendingActions || 0,
        failed_24h: failedActions24h || 0,
        completed_1h: completedActions1h || 0,
        overdue: overdueActions || 0,
      },
    },
  });
});

export default health;
