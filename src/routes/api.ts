import { Hono } from 'hono';
import type { Env, Tenant, EndUser } from '../types';
import type {
  HearingStartRequest,
  HearingRespondRequest,
  MessageGenerateRequest,
  IntentDetectRequest,
  NoShowRiskRequest,
  LeadScoreRequest,
  SimulateRequest,
} from '../types/api';
import { getSupabaseClient } from '../utils/supabase';
import { apiKeyAuthMiddleware } from '../middleware/api-auth';
import { ConversationEngine } from '../services/conversation-engine';
import { SessionManager } from '../services/session-manager';
import { detectIntent, getIntentGuidance } from '../services/intent-detector';
import { calculateNoShowRisk } from '../services/no-show-predictor';
import { calculateLeadScore } from '../services/lead-scoring';
import { generateHearingResponse } from '../services/ai';
import { getDetailedAnalytics } from '../services/analytics';
import { logger } from '../utils/logger';

type ApiVariables = { tenantId: string };

const api = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

// Apply API key auth to all /api/v1/* routes
api.use('/api/v1/*', apiKeyAuthMiddleware as never);

// === Helper: get tenant and end user ===

async function getTenantAndUser(
  env: Env,
  tenantId: string,
  lineUserId: string
): Promise<{ tenant: Tenant; endUser: EndUser } | null> {
  const supabase = getSupabaseClient(env);

  const { data: tenant } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .eq('is_active', true)
    .single();

  if (!tenant) return null;

  const { data: endUser } = await supabase
    .from('end_users')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('line_user_id', lineUserId)
    .single();

  if (!endUser) return null;

  return { tenant: tenant as Tenant, endUser: endUser as EndUser };
}

/** Ensure end_user exists, create if not */
async function ensureEndUser(
  env: Env,
  tenantId: string,
  lineUserId: string,
  displayName?: string
): Promise<EndUser> {
  const supabase = getSupabaseClient(env);

  const { data: existing } = await supabase
    .from('end_users')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('line_user_id', lineUserId)
    .single();

  if (existing) return existing as EndUser;

  const { data: created, error } = await supabase
    .from('end_users')
    .insert({
      tenant_id: tenantId,
      line_user_id: lineUserId,
      display_name: displayName || null,
      current_step: 'api_managed',
      status: 'active',
      is_blocked: false,
    })
    .select()
    .single();

  if (error || !created) {
    throw new Error(`Failed to create end user: ${error?.message}`);
  }

  return created as EndUser;
}

/** Log API usage */
async function logApiUsage(env: Env, tenantId: string, endpoint: string, startTime: number, statusCode: number): Promise<void> {
  const latencyMs = Date.now() - startTime;
  try {
    const supabase = getSupabaseClient(env);
    await supabase.from('api_usage_log').insert({
      tenant_id: tenantId,
      endpoint,
      latency_ms: latencyMs,
      status_code: statusCode,
    });
  } catch {
    // Non-critical: don't fail the request if logging fails
  }
}

// ========================
// Hearing AI Conversation
// ========================

api.post('/api/v1/hearing/start', async (c) => {
  const startTime = Date.now();
  const tenantId = c.get('tenantId');

  try {
    const body = await c.req.json() as HearingStartRequest;
    if (!body.line_user_id) {
      return c.json({ error: 'line_user_id is required' }, 400);
    }

    const supabase = getSupabaseClient(c.env);
    const { data: tenant } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .eq('is_active', true)
      .single();

    if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

    const endUser = await ensureEndUser(c.env, tenantId, body.line_user_id, body.display_name);

    // Apply initial hearing data if provided
    if (body.initial_hearing_data && Object.keys(body.initial_hearing_data).length > 0) {
      const updatedData = { ...endUser.hearing_data, ...body.initial_hearing_data };
      await supabase
        .from('end_users')
        .update({ hearing_data: updatedData, updated_at: new Date().toISOString() })
        .eq('id', endUser.id);
      endUser.hearing_data = updatedData;
    }

    const engine = new ConversationEngine(c.env);
    const { session, aiResponse } = await engine.startHearing(tenant as Tenant, endUser);

    const response = {
      session_id: session.id,
      message: aiResponse.reply_message,
      phase: session.phase || 'trust',
      turn_count: 1,
    };

    await logApiUsage(c.env, tenantId, 'hearing/start', startTime, 200);
    return c.json(response);
  } catch (error) {
    logger.error('hearing/start failed', { error: String(error) });
    await logApiUsage(c.env, tenantId, 'hearing/start', startTime, 500);
    return c.json({ error: 'Internal server error', detail: String(error) }, 500);
  }
});

api.post('/api/v1/hearing/respond', async (c) => {
  const startTime = Date.now();
  const tenantId = c.get('tenantId');

  try {
    const body = await c.req.json() as HearingRespondRequest;
    if (!body.line_user_id || !body.session_id || !body.user_message) {
      return c.json({ error: 'line_user_id, session_id, and user_message are required' }, 400);
    }

    const result = await getTenantAndUser(c.env, tenantId, body.line_user_id);
    if (!result) return c.json({ error: 'Tenant or user not found' }, 404);

    const sessionManager = new SessionManager(c.env);
    const session = await sessionManager.getSession(body.session_id);
    if (!session || session.status !== 'active') {
      return c.json({ error: 'Session not found or not active', session_status: session?.status }, 404);
    }

    const engine = new ConversationEngine(c.env);
    const { aiResponse, session: updatedSession } = await engine.processHearingResponse(
      result.tenant,
      result.endUser,
      session,
      body.user_message
    );

    const response = {
      session_id: updatedSession.id,
      message: aiResponse.reply_message,
      is_complete: aiResponse.is_hearing_complete || false,
      phase: updatedSession.phase || 'trust',
      turn_count: updatedSession.turn_count,
      extracted_data: aiResponse.extracted_data || {},
      insight: aiResponse.insight || null,
      detected_intent: aiResponse.detected_intent || null,
      escalate_to_human: aiResponse.escalate_to_human || false,
    };

    await logApiUsage(c.env, tenantId, 'hearing/respond', startTime, 200);
    return c.json(response);
  } catch (error) {
    logger.error('hearing/respond failed', { error: String(error) });
    await logApiUsage(c.env, tenantId, 'hearing/respond', startTime, 500);
    return c.json({ error: 'Internal server error', detail: String(error) }, 500);
  }
});

// ========================
// AI Message Generation
// ========================

api.post('/api/v1/message/generate', async (c) => {
  const startTime = Date.now();
  const tenantId = c.get('tenantId');

  try {
    const body = await c.req.json() as MessageGenerateRequest;
    if (!body.line_user_id || !body.purpose) {
      return c.json({ error: 'line_user_id and purpose are required' }, 400);
    }

    const validPurposes = ['nurture', 'follow_up', 'no_show_recovery', 'post_consultation', 'hearing_recovery'];
    if (!validPurposes.includes(body.purpose)) {
      return c.json({ error: `Invalid purpose. Valid: ${validPurposes.join(', ')}` }, 400);
    }

    const result = await getTenantAndUser(c.env, tenantId, body.line_user_id);
    if (!result) return c.json({ error: 'Tenant or user not found' }, 404);

    const engine = new ConversationEngine(c.env);
    const aiResponse = await engine.generateMessage(
      result.tenant,
      result.endUser,
      body.purpose,
      body.context
    );

    const response = {
      message: aiResponse.reply_message,
      detected_intent: aiResponse.detected_intent || null,
      should_continue_follow_up: aiResponse.should_continue_follow_up || false,
      recommended_next_timing_hours: aiResponse.recommended_next_timing_hours || null,
      escalate_to_human: aiResponse.escalate_to_human || false,
    };

    await logApiUsage(c.env, tenantId, 'message/generate', startTime, 200);
    return c.json(response);
  } catch (error) {
    logger.error('message/generate failed', { error: String(error) });
    await logApiUsage(c.env, tenantId, 'message/generate', startTime, 500);
    return c.json({ error: 'Internal server error', detail: String(error) }, 500);
  }
});

// ========================
// Intelligence
// ========================

api.post('/api/v1/intent/detect', async (c) => {
  const startTime = Date.now();
  const tenantId = c.get('tenantId');

  try {
    const body = await c.req.json() as IntentDetectRequest;
    if (!body.message) {
      return c.json({ error: 'message is required' }, 400);
    }

    const intent = detectIntent(body.message);
    const guidance = getIntentGuidance(intent);

    const response = {
      intent,
      guidance,
      confidence: intent === 'none' ? 'none' as const : 'pattern_match' as const,
    };

    await logApiUsage(c.env, tenantId, 'intent/detect', startTime, 200);
    return c.json(response);
  } catch (error) {
    logger.error('intent/detect failed', { error: String(error) });
    await logApiUsage(c.env, tenantId, 'intent/detect', startTime, 500);
    return c.json({ error: 'Internal server error', detail: String(error) }, 500);
  }
});

api.post('/api/v1/risk/no-show', async (c) => {
  const startTime = Date.now();
  const tenantId = c.get('tenantId');

  try {
    const body = await c.req.json() as NoShowRiskRequest;
    if (!body.line_user_id || !body.booking) {
      return c.json({ error: 'line_user_id and booking are required' }, 400);
    }

    const result = await getTenantAndUser(c.env, tenantId, body.line_user_id);
    if (!result) return c.json({ error: 'Tenant or user not found' }, 404);

    // Build a booking-like object from the request
    const bookingProxy = {
      id: 'api-request',
      end_user_id: result.endUser.id,
      tenant_id: tenantId,
      scheduled_at: body.booking.scheduled_at,
      zoom_url: null,
      status: 'confirmed',
      reminded_at: null,
      reminder_count: body.booking.reminder_count || 0,
      created_at: body.booking.created_at,
      updated_at: new Date().toISOString(),
    };

    // Get message counts from DB if not provided
    let messagesSinceBooking = body.messages_since_booking;
    let userResponseRate = body.user_response_rate;

    if (messagesSinceBooking === undefined || userResponseRate === undefined) {
      const supabase = getSupabaseClient(c.env);
      const { count: msgCount } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('end_user_id', result.endUser.id)
        .eq('tenant_id', tenantId)
        .gte('created_at', body.booking.created_at);

      const { count: userMsgCount } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('end_user_id', result.endUser.id)
        .eq('tenant_id', tenantId)
        .eq('role', 'user')
        .gte('created_at', body.booking.created_at);

      const total = msgCount || 0;
      messagesSinceBooking = messagesSinceBooking ?? (userMsgCount || 0);
      userResponseRate = userResponseRate ?? (total > 0 ? (userMsgCount || 0) / total : 0);
    }

    const risk = calculateNoShowRisk(
      result.endUser,
      bookingProxy,
      messagesSinceBooking,
      userResponseRate
    );

    await logApiUsage(c.env, tenantId, 'risk/no-show', startTime, 200);
    return c.json(risk);
  } catch (error) {
    logger.error('risk/no-show failed', { error: String(error) });
    await logApiUsage(c.env, tenantId, 'risk/no-show', startTime, 500);
    return c.json({ error: 'Internal server error', detail: String(error) }, 500);
  }
});

api.post('/api/v1/score/lead', async (c) => {
  const startTime = Date.now();
  const tenantId = c.get('tenantId');

  try {
    const body = await c.req.json() as LeadScoreRequest;
    if (!body.line_user_id) {
      return c.json({ error: 'line_user_id is required' }, 400);
    }

    const result = await getTenantAndUser(c.env, tenantId, body.line_user_id);
    if (!result) return c.json({ error: 'Tenant or user not found' }, 404);

    let messageCount = body.message_count;
    if (messageCount === undefined) {
      const supabase = getSupabaseClient(c.env);
      const { count } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('end_user_id', result.endUser.id)
        .eq('tenant_id', tenantId)
        .eq('role', 'user');
      messageCount = count || 0;
    }

    const hearingItemsTotal = result.tenant.hearing_config?.items?.length || 6;
    const score = calculateLeadScore(result.endUser, messageCount, hearingItemsTotal);

    await logApiUsage(c.env, tenantId, 'score/lead', startTime, 200);
    return c.json(score);
  } catch (error) {
    logger.error('score/lead failed', { error: String(error) });
    await logApiUsage(c.env, tenantId, 'score/lead', startTime, 500);
    return c.json({ error: 'Internal server error', detail: String(error) }, 500);
  }
});

// ========================
// User Profile
// ========================

api.get('/api/v1/user/:lineUserId/profile', async (c) => {
  const startTime = Date.now();
  const tenantId = c.get('tenantId');

  try {
    const lineUserId = c.req.param('lineUserId');
    const supabase = getSupabaseClient(c.env);

    const { data: endUser } = await supabase
      .from('end_users')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('line_user_id', lineUserId)
      .single();

    if (!endUser) return c.json({ error: 'User not found' }, 404);

    const response = {
      line_user_id: endUser.line_user_id,
      display_name: endUser.display_name,
      status: endUser.status,
      hearing_data: endUser.hearing_data || {},
      insight_summary: endUser.insight_summary,
      follow_up_count: endUser.follow_up_count,
      last_message_at: endUser.last_message_at,
      last_response_at: endUser.last_response_at,
      ai_session_state: endUser.ai_session_state || 'idle',
      created_at: endUser.created_at,
    };

    await logApiUsage(c.env, tenantId, 'user/profile', startTime, 200);
    return c.json(response);
  } catch (error) {
    logger.error('user/profile failed', { error: String(error) });
    await logApiUsage(c.env, tenantId, 'user/profile', startTime, 500);
    return c.json({ error: 'Internal server error', detail: String(error) }, 500);
  }
});

// ========================
// Admin: Analytics
// ========================

api.get('/api/v1/admin/analytics', async (c) => {
  const startTime = Date.now();
  const tenantId = c.get('tenantId');

  try {
    const analytics = await getDetailedAnalytics(tenantId, c.env);
    if (!analytics) return c.json({ error: 'No analytics data' }, 404);

    // Get API usage stats
    const supabase = getSupabaseClient(c.env);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { count: totalCalls } = await supabase
      .from('api_usage_log')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('created_at', oneDayAgo);

    const { data: latencyData } = await supabase
      .from('api_usage_log')
      .select('latency_ms')
      .eq('tenant_id', tenantId)
      .gte('created_at', oneDayAgo);

    const avgLatency = latencyData && latencyData.length > 0
      ? Math.round(latencyData.reduce((sum: number, r: { latency_ms: number }) => sum + r.latency_ms, 0) / latencyData.length)
      : 0;

    const { count: errorCalls } = await supabase
      .from('api_usage_log')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('created_at', oneDayAgo)
      .gte('status_code', 400);

    // Get hearing session analytics
    const { count: totalSessions } = await supabase
      .from('ai_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    const { count: completedSessions } = await supabase
      .from('ai_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'completed');

    const { data: turnData } = await supabase
      .from('ai_sessions')
      .select('turn_count')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed');

    const avgTurns = turnData && turnData.length > 0
      ? Math.round(turnData.reduce((sum: number, s: { turn_count: number }) => sum + s.turn_count, 0) / turnData.length)
      : 0;

    const response = {
      ai_performance: analytics.ai_performance,
      hearing_analytics: {
        total_sessions: totalSessions || 0,
        completed_sessions: completedSessions || 0,
        completion_rate: totalSessions ? Math.round(((completedSessions || 0) / totalSessions) * 100) : 0,
        avg_turns: avgTurns,
      },
      intent_distribution: {}, // Could be populated from conversation analysis
      api_usage: {
        total_calls: totalCalls || 0,
        avg_latency_ms: avgLatency,
        error_rate: totalCalls ? Math.round(((errorCalls || 0) / totalCalls) * 100) : 0,
      },
    };

    await logApiUsage(c.env, tenantId, 'admin/analytics', startTime, 200);
    return c.json(response);
  } catch (error) {
    logger.error('admin/analytics failed', { error: String(error) });
    await logApiUsage(c.env, tenantId, 'admin/analytics', startTime, 500);
    return c.json({ error: 'Internal server error', detail: String(error) }, 500);
  }
});

// ========================
// Admin: Simulate
// ========================

api.post('/api/v1/admin/simulate', async (c) => {
  const startTime = Date.now();
  const tenantId = c.get('tenantId');

  try {
    const body = await c.req.json() as SimulateRequest;
    if (!body.message) {
      return c.json({ error: 'message is required' }, 400);
    }

    const supabase = getSupabaseClient(c.env);
    const { data: tenant } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .single();

    if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

    const mockEndUser: EndUser = {
      id: 'simulator',
      tenant_id: tenantId,
      line_user_id: 'simulator',
      display_name: body.config?.user_name || 'テストユーザー',
      current_step: 'hearing_start',
      status: 'active',
      hearing_data: body.config?.hearing_data || {},
      insight_summary: null,
      follow_up_count: 0,
      last_message_at: new Date().toISOString(),
      last_response_at: new Date().toISOString(),
      source: null,
      is_blocked: false,
      is_staff_takeover: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const t = tenant as unknown as Tenant;
    const context = {
      tenant: t,
      endUser: mockEndUser,
      currentStep: {
        id: 'hearing_start',
        type: 'ai' as const,
        trigger: 'auto' as const,
        delay_minutes: 0,
        ai_config: { purpose: 'hearing' as const, max_turns: 8, completion_condition: 'all_required' },
        next_step: '',
      },
      hearingData: mockEndUser.hearing_data,
      conversationHistory: body.history || [],
      env: c.env,
    };

    const response = await generateHearingResponse(context, body.message);
    const updatedHearingData = { ...mockEndUser.hearing_data, ...(response.extracted_data || {}) };

    const result = {
      reply: response.reply_message,
      extracted_data: response.extracted_data || {},
      insight: response.insight || null,
      is_hearing_complete: response.is_hearing_complete || false,
      escalate_to_human: response.escalate_to_human || false,
      detected_intent: response.detected_intent || null,
      updated_hearing_data: updatedHearingData,
    };

    await logApiUsage(c.env, tenantId, 'admin/simulate', startTime, 200);
    return c.json(result);
  } catch (error) {
    logger.error('admin/simulate failed', { error: String(error) });
    await logApiUsage(c.env, tenantId, 'admin/simulate', startTime, 500);
    return c.json({ error: 'Internal server error', detail: String(error) }, 500);
  }
});

export default api;
