import type { Env, EndUser, Booking } from '../types';
import { getSupabaseClient } from '../utils/supabase';

export interface NoShowRisk {
  score: number; // 0-100 (higher = more likely to no-show)
  level: 'low' | 'medium' | 'high' | 'critical';
  factors: Array<{ name: string; impact: number; detail: string }>;
  recommended_intervention: string;
  hours_until_consultation: number;
}

/**
 * Predict no-show probability for a booked user.
 *
 * The insight: no-show risk is a function of:
 * 1. Engagement decay since booking (are they going cold?)
 * 2. Booking intent quality (did they book enthusiastically or passively?)
 * 3. Information investment (more hearing data = more committed)
 * 4. Proximity to consultation (risk changes as date approaches)
 * 5. Communication pattern (responsive users show up)
 */
export function calculateNoShowRisk(
  user: EndUser,
  booking: Booking,
  messagesSinceBooking: number,
  userResponseRate: number // 0-1, ratio of user messages to total
): NoShowRisk {
  const factors: NoShowRisk['factors'] = [];
  let riskScore = 0;

  const now = Date.now();
  const consultationTime = new Date(booking.scheduled_at).getTime();
  const hoursUntil = Math.max(0, (consultationTime - now) / (1000 * 60 * 60));
  const bookingAge = (now - new Date(booking.created_at).getTime()) / (1000 * 60 * 60);

  // Factor 1: Engagement since booking (max 30 risk points)
  // Silent after booking = very bad sign
  if (messagesSinceBooking === 0 && bookingAge > 24) {
    riskScore += 25;
    factors.push({ name: '予約後の沈黙', impact: 25, detail: `予約後${Math.floor(bookingAge)}時間メッセージなし` });
  } else if (messagesSinceBooking <= 1 && bookingAge > 48) {
    riskScore += 15;
    factors.push({ name: '低エンゲージメント', impact: 15, detail: '予約後のやり取りが少ない' });
  } else if (messagesSinceBooking >= 3) {
    riskScore -= 5; // Negative = good
    factors.push({ name: '高エンゲージメント', impact: -5, detail: `予約後${messagesSinceBooking}回のやり取り` });
  }

  // Factor 2: Response recency (max 25 risk points)
  const lastResponseHoursAgo = user.last_response_at
    ? (now - new Date(user.last_response_at).getTime()) / (1000 * 60 * 60)
    : 999;

  if (lastResponseHoursAgo > 72) {
    riskScore += 25;
    factors.push({ name: '長期未返信', impact: 25, detail: `${Math.floor(lastResponseHoursAgo)}時間前が最後の返信` });
  } else if (lastResponseHoursAgo > 48) {
    riskScore += 15;
    factors.push({ name: '返信間隔が空いている', impact: 15, detail: `${Math.floor(lastResponseHoursAgo)}時間前の返信` });
  } else if (lastResponseHoursAgo < 24) {
    riskScore -= 5;
    factors.push({ name: '最近返信あり', impact: -5, detail: '直近24時間以内に返信' });
  }

  // Factor 3: Hearing data depth (max 15 risk points)
  // More data = more invested = less likely to no-show
  const hearingKeys = Object.keys(user.hearing_data || {});
  if (hearingKeys.length === 0) {
    riskScore += 15;
    factors.push({ name: 'ヒアリング未実施', impact: 15, detail: '個人情報を共有していない = 心理的投資が低い' });
  } else if (hearingKeys.length <= 2) {
    riskScore += 8;
    factors.push({ name: 'ヒアリング不十分', impact: 8, detail: `${hearingKeys.length}項目のみ回答` });
  } else if (hearingKeys.length >= 4) {
    riskScore -= 10;
    factors.push({ name: 'ヒアリング充実', impact: -10, detail: `${hearingKeys.length}項目回答済み = 高い心理的投資` });
  }

  // Factor 4: Reminder response (max 15 risk points)
  if (booking.reminder_count > 0 && lastResponseHoursAgo > 48) {
    riskScore += 15;
    factors.push({ name: 'リマインド無応答', impact: 15, detail: `${booking.reminder_count}回のリマインドに返答なし` });
  }

  // Factor 5: Consultation proximity pressure (max 15 risk points)
  // As the date approaches, an unresponsive user becomes higher risk
  if (hoursUntil < 6 && lastResponseHoursAgo > 24) {
    riskScore += 15;
    factors.push({ name: '直前リスク', impact: 15, detail: '相談会まで6時間以内だが反応なし' });
  } else if (hoursUntil < 24 && lastResponseHoursAgo > 48) {
    riskScore += 10;
    factors.push({ name: '前日リスク', impact: 10, detail: '明日の相談会だが2日以上未返信' });
  }

  // Factor 6: User response rate (max 10 risk points)
  if (userResponseRate < 0.2) {
    riskScore += 10;
    factors.push({ name: '低応答率', impact: 10, detail: 'メッセージの大半に未返信' });
  } else if (userResponseRate > 0.4) {
    riskScore -= 5;
    factors.push({ name: '高応答率', impact: -5, detail: 'メッセージに積極的に返信' });
  }

  // Clamp to 0-100
  riskScore = Math.max(0, Math.min(100, riskScore));

  const level: NoShowRisk['level'] =
    riskScore >= 70 ? 'critical' :
    riskScore >= 45 ? 'high' :
    riskScore >= 25 ? 'medium' : 'low';

  const recommended_intervention = getIntervention(level, hoursUntil, user);

  return { score: riskScore, level, factors, recommended_intervention, hours_until_consultation: Math.round(hoursUntil) };
}

function getIntervention(level: NoShowRisk['level'], hoursUntil: number, user: EndUser): string {
  const hasHearing = Object.keys(user.hearing_data || {}).length > 0;

  if (level === 'critical') {
    if (hoursUntil < 12) return 'スタッフが直接LINEまたは電話でフォロー。日程変更の提案を';
    return 'スタッフから個別メッセージ送信。ヒアリング内容に触れて「あなたのために準備しています」と伝える';
  }

  if (level === 'high') {
    if (hasHearing) return 'ヒアリング内容に基づいた個別価値提案メッセージを送信';
    return '「もし都合が合わなければ日程変更もできますよ」と選択肢を提示';
  }

  if (level === 'medium') {
    return '通常のリマインドに加え、相談会で得られる具体的なメリットを1つ伝える';
  }

  return '通常のリマインドスケジュールで十分';
}

/**
 * Get no-show risk for all confirmed bookings of a tenant.
 */
export async function getBookingRisks(tenantId: string, env: Env): Promise<Map<string, NoShowRisk>> {
  const supabase = getSupabaseClient(env);

  const { data: bookings } = await supabase
    .from('bookings')
    .select('*, end_users!inner(*)')
    .eq('tenant_id', tenantId)
    .eq('status', 'confirmed')
    .gt('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true });

  if (!bookings) return new Map();

  const risks = new Map<string, NoShowRisk>();

  for (const b of bookings) {
    const user = b.end_users as unknown as EndUser;
    const bookingCreatedAt = new Date(b.created_at).toISOString();

    // Count messages since booking
    const { count: msgCount } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('end_user_id', user.id)
      .eq('tenant_id', tenantId)
      .gte('created_at', bookingCreatedAt);

    const { count: userMsgCount } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('end_user_id', user.id)
      .eq('tenant_id', tenantId)
      .eq('role', 'user')
      .gte('created_at', bookingCreatedAt);

    const totalMsgs = msgCount || 0;
    const responseRate = totalMsgs > 0 ? (userMsgCount || 0) / totalMsgs : 0;

    risks.set(b.id, calculateNoShowRisk(
      user,
      b as unknown as Booking,
      userMsgCount || 0,
      responseRate
    ));
  }

  return risks;
}
