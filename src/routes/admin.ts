import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { invalidateTenantCache } from '../config/tenant-config';
import { createTenantSchema, updateTenantSchema, createSlotSchema, paginationSchema } from '../utils/admin-validators';
import { uuidSchema } from '../utils/validation';
import { getFunnelMetrics, getAllFunnelMetrics, getDetailedAnalytics } from '../services/analytics';
import { verifySessionToken } from '../middleware/security';
import { getDefaultConfigs } from '../config/default-scenarios';
import { schedulePostConsultationActions } from '../services/action-executors';
import type { Tenant, EndUser } from '../types';

const admin = new Hono<{ Bindings: Env }>();

// --- Auth middleware ---
admin.use('/admin/api/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    if (authHeader.slice(7) === c.env.ADMIN_API_KEY) return next();
  }
  const cookie = getCookie(c, 'admin_session');
  if (cookie && verifySessionToken(cookie, c.env.ADMIN_API_KEY)) return next();
  return c.json({ error: 'Unauthorized' }, 401);
});

// --- Helper: mask secrets in list responses ---
function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return '****' + value.slice(-4);
}

function maskTenant(tenant: Record<string, unknown>): Record<string, unknown> {
  return {
    ...tenant,
    line_channel_secret: maskSecret(String(tenant.line_channel_secret || '')),
    line_channel_access_token: maskSecret(String(tenant.line_channel_access_token || '')),
  };
}

// ========================
// Tenants CRUD
// ========================

// List tenants
admin.get('/admin/api/tenants', async (c) => {
  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data: (data || []).map(maskTenant) });
});

// Get single tenant (full detail, no masking)
admin.get('/admin/api/tenants/:id', async (c) => {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return c.json({ error: 'Invalid ID' }, 400);

  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase.from('tenants').select('*').eq('id', id).single();

  if (error || !data) return c.json({ error: 'Tenant not found' }, 404);
  return c.json({ data });
});

// Create tenant
admin.post('/admin/api/tenants', async (c) => {
  const body = await c.req.json();
  const parsed = createTenantSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.issues }, 400);

  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase.from('tenants').insert(parsed.data).select().single();

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data }, 201);
});

// Update tenant
admin.put('/admin/api/tenants/:id', async (c) => {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return c.json({ error: 'Invalid ID' }, 400);

  const body = await c.req.json();
  const parsed = updateTenantSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.issues }, 400);

  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase
    .from('tenants')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);
  await invalidateTenantCache(id, c.env);
  return c.json({ data });
});

// Delete (soft-delete) tenant
admin.delete('/admin/api/tenants/:id', async (c) => {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return c.json({ error: 'Invalid ID' }, 400);

  const supabase = getSupabaseClient(c.env);
  const { error } = await supabase
    .from('tenants')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return c.json({ error: error.message }, 500);
  await invalidateTenantCache(id, c.env);
  return c.json({ message: 'Tenant deactivated' });
});

// ========================
// End Users
// ========================

// List users for a tenant
admin.get('/admin/api/tenants/:id/users', async (c) => {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return c.json({ error: 'Invalid ID' }, 400);

  const query = paginationSchema.safeParse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
  });
  const { page, limit } = query.success ? query.data : { page: 1, limit: 20 };
  const offset = (page - 1) * limit;

  const status = c.req.query('status');
  const search = c.req.query('search');

  const supabase = getSupabaseClient(c.env);
  let q = supabase
    .from('end_users')
    .select('*', { count: 'exact' })
    .eq('tenant_id', id)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq('status', status);
  if (search) q = q.ilike('display_name', `%${search}%`);

  const { data, error, count } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data: data || [], total: count || 0, page, limit });
});

// Get single user detail
admin.get('/admin/api/tenants/:id/users/:userId', async (c) => {
  const userId = c.req.param('userId');
  if (!uuidSchema.safeParse(userId).success) return c.json({ error: 'Invalid user ID' }, 400);

  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase
    .from('end_users')
    .select('*')
    .eq('id', userId)
    .eq('tenant_id', c.req.param('id'))
    .single();

  if (error || !data) return c.json({ error: 'User not found' }, 404);
  return c.json({ data });
});

// ========================
// Conversations
// ========================

// Get conversations for a user
admin.get('/admin/api/tenants/:id/conversations/:userId', async (c) => {
  const tenantId = c.req.param('id');
  const userId = c.req.param('userId');

  const query = paginationSchema.safeParse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
  });
  const { page, limit } = query.success ? query.data : { page: 1, limit: 50 };
  const offset = (page - 1) * limit;

  const supabase = getSupabaseClient(c.env);
  const { data, error, count } = await supabase
    .from('conversations')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('end_user_id', userId)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data: data || [], total: count || 0, page, limit });
});

// ========================
// Analytics
// ========================

admin.get('/admin/api/tenants/:id/analytics', async (c) => {
  const id = c.req.param('id');
  const data = await getFunnelMetrics(id, c.env);
  if (!data) return c.json({ error: 'No data' }, 404);
  return c.json({ data });
});

admin.get('/admin/api/analytics', async (c) => {
  const data = await getAllFunnelMetrics(c.env);
  return c.json({ data });
});

// Detailed analytics for a tenant
admin.get('/admin/api/tenants/:id/analytics/detailed', async (c) => {
  const id = c.req.param('id');
  const data = await getDetailedAnalytics(id, c.env);
  if (!data) return c.json({ error: 'No data' }, 404);
  return c.json({ data });
});

// ========================
// Bookings
// ========================

// List bookings for a tenant
admin.get('/admin/api/tenants/:id/bookings', async (c) => {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return c.json({ error: 'Invalid ID' }, 400);

  const query = paginationSchema.safeParse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
  });
  const { page, limit } = query.success ? query.data : { page: 1, limit: 20 };
  const offset = (page - 1) * limit;
  const status = c.req.query('status');

  const supabase = getSupabaseClient(c.env);
  let q = supabase
    .from('bookings')
    .select('*, end_users!inner(display_name, line_user_id)', { count: 'exact' })
    .eq('tenant_id', id)
    .order('scheduled_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq('status', status);

  const { data, error, count } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data: data || [], total: count || 0, page, limit });
});

// Update booking status
admin.put('/admin/api/tenants/:id/bookings/:bookingId', async (c) => {
  const bookingId = c.req.param('bookingId');
  if (!uuidSchema.safeParse(bookingId).success) return c.json({ error: 'Invalid booking ID' }, 400);

  const body = await c.req.json();
  const validStatuses = ['confirmed', 'no_show', 'consulted', 'cancelled'];
  if (!validStatuses.includes(body.status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }

  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase
    .from('bookings')
    .update({ status: body.status, updated_at: new Date().toISOString() })
    .eq('id', bookingId)
    .eq('tenant_id', c.req.param('id'))
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);

  // If marked as consulted, update end_user status and schedule post-consultation actions
  if (body.status === 'consulted' && data) {
    const { data: endUserData } = await supabase
      .from('end_users')
      .update({ status: 'consulted', updated_at: new Date().toISOString() })
      .eq('id', data.end_user_id)
      .select()
      .single();

    if (endUserData) {
      const { data: tenantData } = await supabase
        .from('tenants')
        .select('*')
        .eq('id', c.req.param('id'))
        .single();

      if (tenantData) {
        await schedulePostConsultationActions(
          tenantData as unknown as Tenant,
          endUserData as unknown as EndUser,
          bookingId,
          c.env
        );
      }
    }
  }

  return c.json({ data });
});

// ========================
// User status management
// ========================

// Update user status manually
admin.put('/admin/api/tenants/:id/users/:userId/status', async (c) => {
  const userId = c.req.param('userId');
  if (!uuidSchema.safeParse(userId).success) return c.json({ error: 'Invalid user ID' }, 400);

  const body = await c.req.json();
  const validStatuses = ['active', 'booked', 'consulted', 'enrolled', 'dropped', 'stalled'];
  if (!validStatuses.includes(body.status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }

  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase
    .from('end_users')
    .update({ status: body.status, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .eq('tenant_id', c.req.param('id'))
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data });
});

// ========================
// Scheduled Actions
// ========================

// List scheduled actions for a tenant
admin.get('/admin/api/tenants/:id/actions', async (c) => {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return c.json({ error: 'Invalid ID' }, 400);

  const query = paginationSchema.safeParse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
  });
  const { page, limit } = query.success ? query.data : { page: 1, limit: 20 };
  const offset = (page - 1) * limit;
  const status = c.req.query('status');

  const supabase = getSupabaseClient(c.env);
  let q = supabase
    .from('scheduled_actions')
    .select('*, end_users!inner(display_name)', { count: 'exact' })
    .eq('tenant_id', id)
    .order('execute_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq('status', status);

  const { data, error, count } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data: data || [], total: count || 0, page, limit });
});

// Cancel a scheduled action
admin.delete('/admin/api/tenants/:id/actions/:actionId', async (c) => {
  const actionId = c.req.param('actionId');
  if (!uuidSchema.safeParse(actionId).success) return c.json({ error: 'Invalid action ID' }, 400);

  const supabase = getSupabaseClient(c.env);
  const { error } = await supabase
    .from('scheduled_actions')
    .update({ status: 'cancelled' })
    .eq('id', actionId)
    .eq('tenant_id', c.req.param('id'))
    .in('status', ['pending', 'processing']);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ message: 'Action cancelled' });
});

// ========================
// Tenant activation toggle
// ========================

admin.post('/admin/api/tenants/:id/toggle', async (c) => {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return c.json({ error: 'Invalid ID' }, 400);

  const supabase = getSupabaseClient(c.env);
  const { data: tenant } = await supabase.from('tenants').select('is_active').eq('id', id).single();
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

  const { data, error } = await supabase
    .from('tenants')
    .update({ is_active: !tenant.is_active, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);
  await invalidateTenantCache(id, c.env);
  return c.json({ data });
});

// ========================
// System health / monitoring
// ========================

admin.get('/admin/api/system/health', async (c) => {
  const supabase = getSupabaseClient(c.env);
  const now = new Date();

  // Check pending actions (backlog)
  const { count: pendingCount } = await supabase
    .from('scheduled_actions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');

  // Check failed actions in last 24h
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { count: failedCount } = await supabase
    .from('scheduled_actions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'failed')
    .gte('created_at', oneDayAgo);

  // Check processing (possibly stuck) actions
  const { count: processingCount } = await supabase
    .from('scheduled_actions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'processing');

  // Overdue actions (should have been executed but still pending)
  const { count: overdueCount } = await supabase
    .from('scheduled_actions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending')
    .lt('execute_at', now.toISOString());

  // Active tenant count
  const { count: activeTenants } = await supabase
    .from('tenants')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  // Total active users
  const { count: activeUsers } = await supabase
    .from('end_users')
    .select('*', { count: 'exact', head: true })
    .eq('is_blocked', false);

  // Bookings today
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const { count: bookingsToday } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .gte('scheduled_at', todayStart)
    .lt('scheduled_at', todayEnd);

  return c.json({
    status: (failedCount || 0) > 10 || (overdueCount || 0) > 50 ? 'warning' : 'healthy',
    timestamp: now.toISOString(),
    actions: {
      pending: pendingCount || 0,
      processing: processingCount || 0,
      failed_24h: failedCount || 0,
      overdue: overdueCount || 0,
    },
    tenants: {
      active: activeTenants || 0,
    },
    users: {
      active: activeUsers || 0,
    },
    bookings: {
      today: bookingsToday || 0,
    },
  });
});

// ========================
// Default configs
// ========================

admin.get('/admin/api/defaults', (c) => {
  return c.json({ data: getDefaultConfigs() });
});

// ========================
// Available Slots
// ========================

// List slots
admin.get('/admin/api/tenants/:id/slots', async (c) => {
  const id = c.req.param('id');
  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase
    .from('available_slots')
    .select('*')
    .eq('tenant_id', id)
    .order('start_at', { ascending: true });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data: data || [] });
});

// Create slot
admin.post('/admin/api/tenants/:id/slots', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = createSlotSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.issues }, 400);

  const supabase = getSupabaseClient(c.env);
  const { data, error } = await supabase
    .from('available_slots')
    .insert({ tenant_id: id, ...parsed.data })
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data }, 201);
});

// Deactivate slot
admin.delete('/admin/api/tenants/:id/slots/:slotId', async (c) => {
  const slotId = c.req.param('slotId');
  if (!uuidSchema.safeParse(slotId).success) return c.json({ error: 'Invalid slot ID' }, 400);

  const supabase = getSupabaseClient(c.env);
  const { error } = await supabase
    .from('available_slots')
    .update({ is_active: false })
    .eq('id', slotId)
    .eq('tenant_id', c.req.param('id'));

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ message: 'Slot deactivated' });
});

export default admin;
