import type { Env } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { logger } from '../utils/logger';

export interface AISession {
  id: string;
  tenant_id: string;
  end_user_id: string;
  session_type: 'hearing' | 'follow_up' | 'nurture';
  status: 'active' | 'completed' | 'expired' | 'escalated';
  phase: string | null;
  turn_count: number;
  started_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
}

const SESSION_EXPIRY_HOURS = 24;

export class SessionManager {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async createSession(
    tenantId: string,
    endUserId: string,
    sessionType: AISession['session_type'],
    initialPhase?: string
  ): Promise<AISession> {
    const supabase = getSupabaseClient(this.env);

    // Expire any existing active sessions for this user
    await supabase
      .from('ai_sessions')
      .update({ status: 'expired', completed_at: new Date().toISOString() })
      .eq('end_user_id', endUserId)
      .eq('status', 'active');

    const { data, error } = await supabase
      .from('ai_sessions')
      .insert({
        tenant_id: tenantId,
        end_user_id: endUserId,
        session_type: sessionType,
        status: 'active',
        phase: initialPhase || (sessionType === 'hearing' ? 'trust' : null),
        turn_count: 0,
        metadata: {},
      })
      .select()
      .single();

    if (error || !data) {
      logger.error('Failed to create AI session', { error: error?.message });
      throw new Error('Failed to create session');
    }

    // Update end_user session state
    await supabase
      .from('end_users')
      .update({ ai_session_state: sessionType, updated_at: new Date().toISOString() })
      .eq('id', endUserId);

    return data as AISession;
  }

  async getSession(sessionId: string): Promise<AISession | null> {
    const supabase = getSupabaseClient(this.env);
    const { data } = await supabase
      .from('ai_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (!data) return null;

    // Check expiry
    const session = data as AISession;
    if (session.status === 'active') {
      const startedAt = new Date(session.started_at).getTime();
      const expiryTime = startedAt + SESSION_EXPIRY_HOURS * 60 * 60 * 1000;
      if (Date.now() > expiryTime) {
        await this.expireSession(sessionId);
        return { ...session, status: 'expired' };
      }
    }

    return session;
  }

  async getActiveSession(endUserId: string): Promise<AISession | null> {
    const supabase = getSupabaseClient(this.env);
    const { data } = await supabase
      .from('ai_sessions')
      .select('*')
      .eq('end_user_id', endUserId)
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(1)
      .single();

    return data as AISession | null;
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Pick<AISession, 'phase' | 'turn_count' | 'status' | 'metadata'>>
  ): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    const updateData: Record<string, unknown> = { ...updates };
    if (updates.status === 'completed' || updates.status === 'escalated') {
      updateData.completed_at = new Date().toISOString();
    }

    await supabase
      .from('ai_sessions')
      .update(updateData)
      .eq('id', sessionId);
  }

  async completeSession(sessionId: string, endUserId: string): Promise<void> {
    await this.updateSession(sessionId, { status: 'completed' });

    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({ ai_session_state: 'idle', updated_at: new Date().toISOString() })
      .eq('id', endUserId);
  }

  async escalateSession(sessionId: string, endUserId: string): Promise<void> {
    await this.updateSession(sessionId, { status: 'escalated' });

    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({ ai_session_state: 'escalated', updated_at: new Date().toISOString() })
      .eq('id', endUserId);
  }

  private async expireSession(sessionId: string): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('ai_sessions')
      .update({ status: 'expired', completed_at: new Date().toISOString() })
      .eq('id', sessionId);
  }

  /**
   * Cleanup expired sessions (called from scheduler)
   */
  async cleanupExpiredSessions(): Promise<number> {
    const supabase = getSupabaseClient(this.env);
    const expiryThreshold = new Date(Date.now() - SESSION_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

    const { data } = await supabase
      .from('ai_sessions')
      .update({ status: 'expired', completed_at: new Date().toISOString() })
      .eq('status', 'active')
      .lt('started_at', expiryThreshold)
      .select('end_user_id');

    if (data && data.length > 0) {
      const endUserIds = data.map((d: { end_user_id: string }) => d.end_user_id);
      await supabase
        .from('end_users')
        .update({ ai_session_state: 'idle', updated_at: new Date().toISOString() })
        .in('id', endUserIds);
    }

    return data?.length || 0;
  }
}
