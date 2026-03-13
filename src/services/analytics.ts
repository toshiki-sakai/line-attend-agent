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
  };
}

function calculateHearingCompletion(users: Array<{ hearing_data: Record<string, string> | null }>): number {
  if (users.length === 0) return 0;
  const withData = users.filter((u) => u.hearing_data && Object.keys(u.hearing_data).length > 0);
  return Math.round((withData.length / users.length) * 100);
}
