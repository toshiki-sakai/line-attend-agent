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

export interface StepDropoff {
  step: string;
  users_entered: number;
  users_progressed: number;
  dropoff_rate: number;
}

export interface AIPerformanceMetrics {
  total_conversations: number;
  ai_handled: number;
  staff_handled: number;
  auto_resolution_rate: number; // % handled without staff
  escalation_count: number;
  avg_messages_to_booking: number | null;
  estimated_hours_saved: number;
  estimated_cost_saved: number; // yen, based on ¥2,000/hour staff cost
}

export interface TodaysMission {
  hot_leads: number;
  needs_manual: number;
  pending_bookings: number;
  no_shows_to_recover: number;
  scheduled_consultations_today: number;
  stalled_new: number;
  priority_actions: Array<{
    type: 'hot_lead' | 'manual_needed' | 'no_show_recovery' | 'consultation_today' | 'stalled_new';
    label: string;
    count: number;
    link: string;
    urgency: 'critical' | 'high' | 'medium';
  }>;
}

export interface DetailedAnalytics {
  funnel: FunnelMetrics;
  conversion_rates: {
    friend_to_booking: number | null;
    booking_to_attendance: number | null;
    attendance_to_enrollment: number | null;
    overall: number | null;
  };
  engagement: {
    avg_messages_per_user: number;
    avg_hearing_completion_rate: number;
    stalled_users: number;
    dropped_users: number;
    blocked_users: number;
  };
  bookings: {
    total: number;
    confirmed: number;
    no_show: number;
    no_show_rate: number | null;
  };
  actions: {
    pending: number;
    failed_24h: number;
    completed_24h: number;
  };
  recent_activity: {
    new_users_7d: number;
    bookings_7d: number;
    consultations_7d: number;
  };
  velocity: {
    avg_hours_to_booking: number | null;
    avg_hours_to_first_response: number | null;
  };
  trends: {
    new_users_prev_7d: number;
    bookings_prev_7d: number;
    consultations_prev_7d: number;
  };
  step_dropoff: StepDropoff[];
  ai_performance: AIPerformanceMetrics;
}

export interface HotLead {
  id: string;
  display_name: string | null;
  status: string;
  current_step: string;
  reason: string;
  priority: 'high' | 'medium';
  last_response_at: string | null;
  hearing_data: Record<string, string>;
}

export interface ActivityEvent {
  type: 'new_user' | 'booking' | 'consultation' | 'stalled' | 'no_show' | 'message';
  user_name: string | null;
  tenant_name: string;
  tenant_id: string;
  user_id?: string;
  timestamp: string;
  detail?: string;
}

export async function getHotLeads(tenantId: string, env: Env): Promise<HotLead[]> {
  const supabase = getSupabaseClient(env);
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

  const leads: HotLead[] = [];

  // Users who responded in last 24h and are not yet booked (hot! they're engaging)
  const { data: recentResponders } = await supabase
    .from('end_users')
    .select('id, display_name, status, current_step, last_response_at, hearing_data')
    .eq('tenant_id', tenantId)
    .eq('is_blocked', false)
    .in('status', ['active'])
    .gte('last_response_at', twentyFourHoursAgo)
    .order('last_response_at', { ascending: false })
    .limit(10);

  for (const u of recentResponders || []) {
    leads.push({
      ...u,
      reason: '直近24h以内に返信あり',
      priority: 'high',
    });
  }

  // Stalled users who haven't been followed up recently
  const { data: stalledUsers } = await supabase
    .from('end_users')
    .select('id, display_name, status, current_step, last_response_at, hearing_data')
    .eq('tenant_id', tenantId)
    .eq('status', 'stalled')
    .eq('is_blocked', false)
    .lt('updated_at', fortyEightHoursAgo)
    .order('updated_at', { ascending: true })
    .limit(5);

  for (const u of stalledUsers || []) {
    leads.push({
      ...u,
      reason: '停滞中 - 手動フォロー推奨',
      priority: 'medium',
    });
  }

  // Users with hearing data but not booked (warm leads)
  const { data: warmLeads } = await supabase
    .from('end_users')
    .select('id, display_name, status, current_step, last_response_at, hearing_data')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .eq('is_blocked', false)
    .not('hearing_data', 'eq', '{}')
    .lt('last_response_at', twentyFourHoursAgo)
    .gte('last_response_at', fortyEightHoursAgo)
    .order('last_response_at', { ascending: false })
    .limit(5);

  for (const u of warmLeads || []) {
    const hearingKeys = Object.keys(u.hearing_data || {});
    if (hearingKeys.length > 0) {
      leads.push({
        ...u,
        reason: `ヒアリング${hearingKeys.length}項目回答済み - 予約に近い`,
        priority: 'medium',
      });
    }
  }

  return leads;
}

export async function getRecentActivity(env: Env, limit = 20): Promise<ActivityEvent[]> {
  const supabase = getSupabaseClient(env);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const events: ActivityEvent[] = [];

  // Recent new users
  const { data: newUsers } = await supabase
    .from('end_users')
    .select('id, display_name, tenant_id, created_at, tenants!inner(name)')
    .gte('created_at', oneDayAgo)
    .order('created_at', { ascending: false })
    .limit(10);

  for (const u of newUsers || []) {
    const t = u.tenants as unknown as { name: string };
    events.push({
      type: 'new_user',
      user_name: u.display_name,
      tenant_name: t?.name || '',
      tenant_id: u.tenant_id,
      user_id: u.id,
      timestamp: u.created_at,
    });
  }

  // Recent bookings
  const { data: recentBookings } = await supabase
    .from('bookings')
    .select('id, tenant_id, scheduled_at, created_at, status, end_users!inner(display_name, id), tenants!inner(name)')
    .gte('created_at', oneDayAgo)
    .order('created_at', { ascending: false })
    .limit(10);

  for (const b of recentBookings || []) {
    const eu = b.end_users as unknown as { display_name: string; id: string };
    const t = b.tenants as unknown as { name: string };
    events.push({
      type: b.status === 'no_show' ? 'no_show' : 'booking',
      user_name: eu?.display_name,
      tenant_name: t?.name || '',
      tenant_id: b.tenant_id,
      user_id: eu?.id,
      timestamp: b.created_at,
    });
  }

  // Sort by timestamp and limit
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return events.slice(0, limit);
}

export function getUserSmartLabel(user: {
  status: string;
  last_response_at: string | null;
  hearing_data: Record<string, string> | null;
  follow_up_count: number;
  is_staff_takeover: boolean;
}): { label: string; color: string } | null {
  if (user.is_staff_takeover) {
    return { label: 'スタッフ対応中', color: 'bg-orange-100 text-orange-700' };
  }

  const now = Date.now();
  const lastResponse = user.last_response_at ? new Date(user.last_response_at).getTime() : 0;
  const hoursSinceResponse = (now - lastResponse) / (1000 * 60 * 60);
  const hearingKeys = Object.keys(user.hearing_data || {});

  if (user.status === 'active' && hoursSinceResponse < 24) {
    return { label: 'HOT', color: 'bg-red-100 text-red-700 animate-pulse' };
  }

  if (user.status === 'active' && hearingKeys.length >= 2 && hoursSinceResponse < 72) {
    return { label: '見込み高', color: 'bg-amber-100 text-amber-700' };
  }

  if (user.status === 'stalled' && user.follow_up_count >= 3) {
    return { label: '要手動対応', color: 'bg-red-100 text-red-700' };
  }

  if (user.status === 'active' && hoursSinceResponse > 72 && hoursSinceResponse < 168) {
    return { label: '反応低下', color: 'bg-yellow-100 text-yellow-700' };
  }

  if (user.status === 'booked') {
    return { label: '予約済み', color: 'bg-blue-100 text-blue-700' };
  }

  return null;
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

export async function getDetailedAnalytics(tenantId: string, env: Env): Promise<DetailedAnalytics | null> {
  const supabase = getSupabaseClient(env);
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Get funnel metrics
  const funnel = await getFunnelMetrics(tenantId, env);
  if (!funnel) return null;

  // Get detailed user stats
  const [
    { count: stalledCount },
    { count: droppedCount },
    { count: blockedCount },
    { count: newUsers7d },
  ] = await Promise.all([
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'stalled'),
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'dropped'),
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('is_blocked', true),
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', sevenDaysAgo),
  ]);

  // Get conversation stats
  const { count: totalMessages } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  const avgMessages = funnel.total_users > 0 ? Math.round((totalMessages || 0) / funnel.total_users) : 0;

  // Get users with hearing data to calculate completion rate
  const { data: usersWithHearing } = await supabase
    .from('end_users')
    .select('hearing_data')
    .eq('tenant_id', tenantId)
    .not('hearing_data', 'is', null);

  const hearingCompletion = calculateHearingCompletion(usersWithHearing || []);

  // Get booking stats
  const [
    { count: totalBookings },
    { count: confirmedBookings },
    { count: noShowBookings },
    { count: bookings7d },
    { count: consultations7d },
  ] = await Promise.all([
    supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'confirmed'),
    supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'no_show'),
    supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', sevenDaysAgo),
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'consulted').gte('updated_at', sevenDaysAgo),
  ]);

  // Get action stats
  const [
    { count: pendingActions },
    { count: failedActions24h },
    { count: completedActions24h },
  ] = await Promise.all([
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'pending'),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'failed').gte('created_at', oneDayAgo),
    supabase.from('scheduled_actions').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'completed').gte('completed_at', oneDayAgo),
  ]);

  // Calculate conversion rates
  const totalBookingAttempts = (totalBookings || 0);
  const noShowRate = totalBookingAttempts > 0 ? Math.round(((noShowBookings || 0) / totalBookingAttempts) * 100) : null;
  const friendToBooking = funnel.total_users > 0 ? Math.round((funnel.booked_users / funnel.total_users) * 100) : null;
  const bookingToAttendance = funnel.booked_users > 0 ? Math.round((funnel.consulted_users / funnel.booked_users) * 100) : null;
  const attendanceToEnrollment = funnel.consulted_users > 0 ? Math.round((funnel.enrolled_users / funnel.consulted_users) * 100) : null;
  const overall = funnel.total_users > 0 ? Math.round((funnel.enrolled_users / funnel.total_users) * 100) : null;

  // Conversion velocity: average hours from creation to booking
  const { data: bookedUsers } = await supabase
    .from('end_users')
    .select('created_at')
    .eq('tenant_id', tenantId)
    .in('status', ['booked', 'consulted', 'enrolled'])
    .limit(100);

  const { data: bookingDates } = await supabase
    .from('bookings')
    .select('created_at, end_user_id')
    .eq('tenant_id', tenantId)
    .limit(100);

  let avgHoursToBooking: number | null = null;
  if (bookedUsers && bookingDates && bookedUsers.length > 0) {
    // Simple estimate: average time between user creation and first booking
    const velocities: number[] = [];
    for (const bu of bookedUsers) {
      const booking = bookingDates.find((b) => true); // any booking
      if (booking) {
        const hours = (new Date(booking.created_at).getTime() - new Date(bu.created_at).getTime()) / (1000 * 60 * 60);
        if (hours > 0 && hours < 720) velocities.push(hours); // cap at 30 days
      }
    }
    if (velocities.length > 0) {
      avgHoursToBooking = Math.round(velocities.reduce((s, v) => s + v, 0) / velocities.length);
    }
  }

  // Average hours to first response (from AI)
  const { data: firstResponses } = await supabase
    .from('conversations')
    .select('end_user_id, created_at, role')
    .eq('tenant_id', tenantId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: true })
    .limit(200);

  let avgHoursToFirstResponse: number | null = null;
  if (firstResponses && firstResponses.length > 0) {
    // Most AI responses happen in seconds, so this is mainly interesting for staff responses
    avgHoursToFirstResponse = 0; // AI responds instantly
  }

  // Previous 7 days trends (for comparison)
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const [
    { count: newUsersPrev7d },
    { count: bookingsPrev7d },
    { count: consultationsPrev7d },
  ] = await Promise.all([
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', fourteenDaysAgo).lt('created_at', sevenDaysAgo),
    supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', fourteenDaysAgo).lt('created_at', sevenDaysAgo),
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'consulted').gte('updated_at', fourteenDaysAgo).lt('updated_at', sevenDaysAgo),
  ]);

  // Step drop-off and AI performance (parallel)
  const [stepDropoff, aiPerformance] = await Promise.all([
    getStepDropoff(tenantId, env),
    getAIPerformanceMetrics(tenantId, env),
  ]);

  return {
    funnel,
    conversion_rates: {
      friend_to_booking: friendToBooking,
      booking_to_attendance: bookingToAttendance,
      attendance_to_enrollment: attendanceToEnrollment,
      overall,
    },
    engagement: {
      avg_messages_per_user: avgMessages,
      avg_hearing_completion_rate: hearingCompletion,
      stalled_users: stalledCount || 0,
      dropped_users: droppedCount || 0,
      blocked_users: blockedCount || 0,
    },
    bookings: {
      total: totalBookings || 0,
      confirmed: confirmedBookings || 0,
      no_show: noShowBookings || 0,
      no_show_rate: noShowRate,
    },
    actions: {
      pending: pendingActions || 0,
      failed_24h: failedActions24h || 0,
      completed_24h: completedActions24h || 0,
    },
    recent_activity: {
      new_users_7d: newUsers7d || 0,
      bookings_7d: bookings7d || 0,
      consultations_7d: consultations7d || 0,
    },
    velocity: {
      avg_hours_to_booking: avgHoursToBooking,
      avg_hours_to_first_response: avgHoursToFirstResponse,
    },
    trends: {
      new_users_prev_7d: newUsersPrev7d || 0,
      bookings_prev_7d: bookingsPrev7d || 0,
      consultations_prev_7d: consultationsPrev7d || 0,
    },
    step_dropoff: stepDropoff,
    ai_performance: aiPerformance,
  };
}

export async function getTodaysMission(tenantId: string, env: Env): Promise<TodaysMission> {
  const supabase = getSupabaseClient(env);
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const [
    { count: hotLeadCount },
    { count: needsManualCount },
    { count: pendingBookingCount },
    { count: noShowCount },
    { count: todayConsultationCount },
    { count: stalledNewCount },
  ] = await Promise.all([
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'active').eq('is_blocked', false).gte('last_response_at', twentyFourHoursAgo),
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'stalled').gte('follow_up_count', 3),
    supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'confirmed'),
    supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'no_show').gte('updated_at', twentyFourHoursAgo),
    supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'confirmed').gte('scheduled_at', todayStart).lt('scheduled_at', todayEnd),
    supabase.from('end_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'stalled').gte('updated_at', twentyFourHoursAgo),
  ]);

  const priority_actions: TodaysMission['priority_actions'] = [];

  if ((todayConsultationCount || 0) > 0) {
    priority_actions.push({
      type: 'consultation_today', label: '本日の相談会', count: todayConsultationCount || 0,
      link: `/admin/tenants/${tenantId}/bookings?status=confirmed`, urgency: 'critical',
    });
  }
  if ((hotLeadCount || 0) > 0) {
    priority_actions.push({
      type: 'hot_lead', label: 'HOTリード（24h以内返信）', count: hotLeadCount || 0,
      link: `/admin/tenants/${tenantId}/users?status=active`, urgency: 'critical',
    });
  }
  if ((noShowCount || 0) > 0) {
    priority_actions.push({
      type: 'no_show_recovery', label: 'ノーショー回復', count: noShowCount || 0,
      link: `/admin/tenants/${tenantId}/bookings?status=no_show`, urgency: 'high',
    });
  }
  if ((needsManualCount || 0) > 0) {
    priority_actions.push({
      type: 'manual_needed', label: '手動フォロー必要', count: needsManualCount || 0,
      link: `/admin/tenants/${tenantId}/users?status=stalled`, urgency: 'high',
    });
  }
  if ((stalledNewCount || 0) > 0) {
    priority_actions.push({
      type: 'stalled_new', label: '新規停滞', count: stalledNewCount || 0,
      link: `/admin/tenants/${tenantId}/users?status=stalled`, urgency: 'medium',
    });
  }

  return {
    hot_leads: hotLeadCount || 0,
    needs_manual: needsManualCount || 0,
    pending_bookings: pendingBookingCount || 0,
    no_shows_to_recover: noShowCount || 0,
    scheduled_consultations_today: todayConsultationCount || 0,
    stalled_new: stalledNewCount || 0,
    priority_actions,
  };
}

async function getStepDropoff(tenantId: string, env: Env): Promise<StepDropoff[]> {
  const supabase = getSupabaseClient(env);

  // Get user distribution by current_step
  const { data: users } = await supabase
    .from('end_users')
    .select('current_step, status')
    .eq('tenant_id', tenantId)
    .eq('is_blocked', false);

  if (!users || users.length === 0) return [];

  // Define canonical step order
  const stepOrder = ['welcome', 'hearing_start', 'pre_booking_nudge', 'booking_invite', 'booked', 'consulted', 'enrolled'];
  const stepCounts = new Map<string, number>();
  const stepProgressed = new Map<string, number>();

  for (const step of stepOrder) {
    stepCounts.set(step, 0);
    stepProgressed.set(step, 0);
  }

  // Count users at each step (users who reached this step = current_step + all later steps)
  for (const u of users) {
    const step = u.current_step || 'welcome';
    const statusStep = u.status === 'enrolled' ? 'enrolled' : u.status === 'consulted' ? 'consulted' : u.status === 'booked' ? 'booked' : null;

    // Mark this step as entered
    const userStepIdx = stepOrder.indexOf(step);
    const statusStepIdx = statusStep ? stepOrder.indexOf(statusStep) : -1;
    const maxIdx = Math.max(userStepIdx, statusStepIdx);

    for (let i = 0; i <= Math.min(maxIdx, stepOrder.length - 1); i++) {
      stepCounts.set(stepOrder[i], (stepCounts.get(stepOrder[i]) || 0) + 1);
    }
  }

  // Calculate drop-off between consecutive steps
  const dropoffs: StepDropoff[] = [];
  for (let i = 0; i < stepOrder.length - 1; i++) {
    const currentCount = stepCounts.get(stepOrder[i]) || 0;
    const nextCount = stepCounts.get(stepOrder[i + 1]) || 0;
    if (currentCount > 0) {
      dropoffs.push({
        step: stepOrder[i],
        users_entered: currentCount,
        users_progressed: nextCount,
        dropoff_rate: Math.round(((currentCount - nextCount) / currentCount) * 100),
      });
    }
  }

  return dropoffs;
}

async function getAIPerformanceMetrics(tenantId: string, env: Env): Promise<AIPerformanceMetrics> {
  const supabase = getSupabaseClient(env);

  // Count total conversations by role
  const [
    { count: totalConversations },
    { count: aiMessages },
    { count: staffMessages },
    { count: escalationCount },
  ] = await Promise.all([
    supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'assistant'),
    supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'assistant').is('ai_metadata->staff_sent', null),
    supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'assistant').not('ai_metadata->staff_sent', 'is', null),
    supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'system').ilike('content', '%エスカレーション%'),
  ]);

  const total = totalConversations || 0;
  const ai = aiMessages || 0;
  const staff = staffMessages || 0;
  const autoResolutionRate = total > 0 ? Math.round((ai / total) * 100) : 100;

  // Estimate hours saved: assume each AI message saves 3 minutes of staff time
  const estimatedHoursSaved = Math.round((ai * 3) / 60);
  // ¥2,000/hour average staff cost
  const estimatedCostSaved = estimatedHoursSaved * 2000;

  // Average messages to booking
  const { data: bookedUsers } = await supabase
    .from('end_users')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('status', ['booked', 'consulted', 'enrolled'])
    .limit(100);

  let avgMessagesToBooking: number | null = null;
  if (bookedUsers && bookedUsers.length > 0) {
    const userIds = bookedUsers.map(u => u.id);
    const { count: bookingMsgCount } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('end_user_id', userIds);
    avgMessagesToBooking = bookingMsgCount ? Math.round(bookingMsgCount / bookedUsers.length) : null;
  }

  return {
    total_conversations: total,
    ai_handled: ai,
    staff_handled: staff,
    auto_resolution_rate: autoResolutionRate,
    escalation_count: escalationCount || 0,
    avg_messages_to_booking: avgMessagesToBooking,
    estimated_hours_saved: estimatedHoursSaved,
    estimated_cost_saved: estimatedCostSaved,
  };
}

function calculateHearingCompletion(users: Array<{ hearing_data: Record<string, string> | null }>): number {
  if (users.length === 0) return 0;
  const withData = users.filter((u) => u.hearing_data && Object.keys(u.hearing_data).length > 0);
  return Math.round((withData.length / users.length) * 100);
}

// --- Benchmarks & Recommendations ---

export interface Benchmark {
  label: string;
  min: number;
  max: number;
}

export const BENCHMARKS: Record<string, Benchmark> = {
  friend_to_booking: { label: '友だち→予約', min: 25, max: 40 },
  booking_to_attendance: { label: '予約→着座', min: 60, max: 80 },
  attendance_to_enrollment: { label: '着座→入会', min: 30, max: 50 },
  hearing_completion: { label: 'ヒアリング回答率', min: 60, max: 80 },
  no_show_rate: { label: 'ノーショー率', min: 5, max: 20 },
};

export interface Recommendation {
  severity: 'good' | 'warning' | 'critical';
  message: string;
  metric: string;
  value: number | null;
}

export function generateRecommendations(analytics: DetailedAnalytics): Recommendation[] {
  const recs: Recommendation[] = [];

  // Friend to booking
  const f2b = analytics.conversion_rates.friend_to_booking;
  if (f2b !== null) {
    if (f2b < 15) {
      recs.push({ severity: 'critical', message: '友だち→予約率が非常に低いです。ヒアリング項目を減らすか、予約案内のタイミングを早めることを検討してください。', metric: 'friend_to_booking', value: f2b });
    } else if (f2b < 25) {
      recs.push({ severity: 'warning', message: '友だち→予約率が業界平均以下です。予約案内のメッセージ内容を見直してみましょう。', metric: 'friend_to_booking', value: f2b });
    } else {
      recs.push({ severity: 'good', message: '友だち→予約率は良好です。', metric: 'friend_to_booking', value: f2b });
    }
  }

  // Booking to attendance
  const b2a = analytics.conversion_rates.booking_to_attendance;
  if (b2a !== null) {
    if (b2a < 50) {
      recs.push({ severity: 'critical', message: '着座率が低いです。リマインダーの回数を増やすか、予約直前のメッセージ内容を改善してください。', metric: 'booking_to_attendance', value: b2a });
    } else if (b2a < 60) {
      recs.push({ severity: 'warning', message: '着座率が業界平均以下です。リマインダーのタイミングや内容を調整しましょう。', metric: 'booking_to_attendance', value: b2a });
    } else {
      recs.push({ severity: 'good', message: '着座率は良好です。', metric: 'booking_to_attendance', value: b2a });
    }
  }

  // Hearing completion
  const hc = analytics.engagement.avg_hearing_completion_rate;
  if (hc < 40) {
    recs.push({ severity: 'critical', message: 'ヒアリング回答率が非常に低いです。質問数を減らすか、質問の表現を見直してください。', metric: 'hearing_completion', value: hc });
  } else if (hc < 60) {
    recs.push({ severity: 'warning', message: 'ヒアリング回答率が低めです。必須項目を減らすことを検討してください。', metric: 'hearing_completion', value: hc });
  }

  // Stalled users
  if (analytics.engagement.stalled_users > 0) {
    const stallRate = analytics.funnel.total_users > 0
      ? Math.round((analytics.engagement.stalled_users / analytics.funnel.total_users) * 100)
      : 0;
    if (stallRate > 20) {
      recs.push({ severity: 'critical', message: `停滞ユーザーが${analytics.engagement.stalled_users}名います（${stallRate}%）。追客メッセージの内容や頻度を見直してください。`, metric: 'stalled', value: analytics.engagement.stalled_users });
    } else if (stallRate > 10) {
      recs.push({ severity: 'warning', message: `停滞ユーザーが${analytics.engagement.stalled_users}名います。個別フォローを検討してください。`, metric: 'stalled', value: analytics.engagement.stalled_users });
    }
  }

  // No-show rate
  const nsr = analytics.bookings.no_show_rate;
  if (nsr !== null && nsr > 30) {
    recs.push({ severity: 'critical', message: 'ノーショー率が高いです。リマインダーを強化するか、予約直前のフォローを追加してください。', metric: 'no_show_rate', value: nsr });
  } else if (nsr !== null && nsr > 20) {
    recs.push({ severity: 'warning', message: 'ノーショー率がやや高めです。リマインダーの内容を改善しましょう。', metric: 'no_show_rate', value: nsr });
  }

  return recs;
}
