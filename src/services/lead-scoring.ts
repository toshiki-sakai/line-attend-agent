import type { Env, EndUser } from '../types';
import { getSupabaseClient } from '../utils/supabase';

export interface LeadScore {
  score: number; // 0-100
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  conversion_probability: number; // 0-100%
  factors: ScoreFactor[];
  recommended_action: string;
}

export interface ScoreFactor {
  name: string;
  points: number;
  max_points: number;
  description: string;
}

/**
 * Calculate lead score for a user based on behavioral signals.
 * This is the killer feature that Lステップ can't do —
 * AI-powered conversion probability that tells marketers exactly who to focus on.
 */
export function calculateLeadScore(user: EndUser, messageCount: number, hearingItemsTotal: number): LeadScore {
  const factors: ScoreFactor[] = [];
  let totalScore = 0;

  // Factor 1: Response recency (max 25 points)
  // More recent = more engaged = higher score
  const recencyMax = 25;
  if (user.last_response_at) {
    const hoursSince = (Date.now() - new Date(user.last_response_at).getTime()) / (1000 * 60 * 60);
    let recencyPoints: number;
    if (hoursSince < 1) recencyPoints = 25;
    else if (hoursSince < 6) recencyPoints = 22;
    else if (hoursSince < 24) recencyPoints = 18;
    else if (hoursSince < 48) recencyPoints = 14;
    else if (hoursSince < 72) recencyPoints = 10;
    else if (hoursSince < 168) recencyPoints = 5;
    else recencyPoints = 2;
    totalScore += recencyPoints;
    factors.push({ name: '返信鮮度', points: recencyPoints, max_points: recencyMax, description: hoursSince < 24 ? '直近24h以内に返信あり' : `${Math.floor(hoursSince)}時間前に返信` });
  } else {
    factors.push({ name: '返信鮮度', points: 0, max_points: recencyMax, description: '未返信' });
  }

  // Factor 2: Hearing completion (max 25 points)
  const hearingMax = 25;
  const hearingKeys = Object.keys(user.hearing_data || {});
  const hearingRatio = hearingItemsTotal > 0 ? hearingKeys.length / hearingItemsTotal : 0;
  const hearingPoints = Math.round(hearingRatio * hearingMax);
  totalScore += hearingPoints;
  factors.push({
    name: 'ヒアリング進捗',
    points: hearingPoints,
    max_points: hearingMax,
    description: hearingItemsTotal > 0 ? `${hearingKeys.length}/${hearingItemsTotal}項目回答済み` : 'ヒアリング項目なし',
  });

  // Factor 3: Engagement depth (max 20 points)
  const engagementMax = 20;
  let engagementPoints: number;
  if (messageCount >= 10) engagementPoints = 20;
  else if (messageCount >= 6) engagementPoints = 16;
  else if (messageCount >= 3) engagementPoints = 12;
  else if (messageCount >= 1) engagementPoints = 6;
  else engagementPoints = 0;
  totalScore += engagementPoints;
  factors.push({ name: '会話量', points: engagementPoints, max_points: engagementMax, description: `${messageCount}メッセージ` });

  // Factor 4: Funnel position (max 20 points)
  const funnelMax = 20;
  let funnelPoints: number;
  let funnelDesc: string;
  switch (user.status) {
    case 'enrolled': funnelPoints = 20; funnelDesc = '成約済み'; break;
    case 'consulted': funnelPoints = 18; funnelDesc = '相談済み'; break;
    case 'booked': funnelPoints = 15; funnelDesc = '予約済み'; break;
    case 'active': funnelPoints = 8; funnelDesc = 'アクティブ'; break;
    case 'stalled': funnelPoints = 3; funnelDesc = '停滞中'; break;
    default: funnelPoints = 0; funnelDesc = user.status; break;
  }
  totalScore += funnelPoints;
  factors.push({ name: 'ファネル位置', points: funnelPoints, max_points: funnelMax, description: funnelDesc });

  // Factor 5: Follow-up resilience (max 10 points)
  // Users who responded AFTER follow-ups are more committed
  const resilienceMax = 10;
  let resiliencePoints: number;
  if (user.follow_up_count === 0) {
    resiliencePoints = 8; // Never needed follow-up = good
  } else if (user.follow_up_count <= 2 && user.last_response_at) {
    resiliencePoints = 10; // Responded after follow-up = very engaged
  } else if (user.follow_up_count >= 3) {
    resiliencePoints = 2; // Many follow-ups without result = cold
  } else {
    resiliencePoints = 5;
  }
  totalScore += resiliencePoints;
  factors.push({ name: '追客耐性', points: resiliencePoints, max_points: resilienceMax, description: `${user.follow_up_count}回の追客後` });

  // Calculate grade and conversion probability
  const grade = totalScore >= 80 ? 'S' : totalScore >= 60 ? 'A' : totalScore >= 40 ? 'B' : totalScore >= 20 ? 'C' : 'D';

  // Conversion probability: non-linear mapping from score
  // Based on typical LINE marketing conversion patterns
  let conversionProbability: number;
  if (totalScore >= 80) conversionProbability = 75 + Math.round((totalScore - 80) * 1.25);
  else if (totalScore >= 60) conversionProbability = 45 + Math.round((totalScore - 60) * 1.5);
  else if (totalScore >= 40) conversionProbability = 20 + Math.round((totalScore - 40) * 1.25);
  else if (totalScore >= 20) conversionProbability = 5 + Math.round((totalScore - 20) * 0.75);
  else conversionProbability = Math.round(totalScore * 0.25);

  conversionProbability = Math.min(99, Math.max(1, conversionProbability));

  // Recommended action based on score and context
  const recommended_action = getRecommendedAction(user, totalScore, hearingRatio);

  return { score: totalScore, grade, conversion_probability: conversionProbability, factors, recommended_action };
}

function getRecommendedAction(user: EndUser, score: number, hearingRatio: number): string {
  if (user.status === 'enrolled') return '成約済み。リファーラル促進を検討';
  if (user.status === 'consulted') return 'クロージングフォロー送信';
  if (user.status === 'booked') return '着座率向上のためリマインド強化';

  if (score >= 70) return '即座に予約案内を送信。成約確率が高い';
  if (score >= 50 && hearingRatio < 0.5) return 'ヒアリング項目を追加取得。あと少しで予約に近い';
  if (score >= 50) return '予約案内タイミング。パーソナライズされた案内を';
  if (score >= 30) return '価値提供型フォローで関係構築を継続';
  if (score >= 15) return '軽い声かけで存在感を維持';
  if (user.follow_up_count >= 3) return 'スタッフの手動フォローを検討';
  return 'しばらく様子見。次の自動追客を待つ';
}

export function getScoreColor(grade: string): string {
  switch (grade) {
    case 'S': return 'from-red-500 to-orange-500';
    case 'A': return 'from-orange-500 to-amber-500';
    case 'B': return 'from-amber-500 to-yellow-500';
    case 'C': return 'from-blue-400 to-cyan-400';
    case 'D': return 'from-slate-400 to-slate-500';
    default: return 'from-slate-400 to-slate-500';
  }
}

export function getScoreBadgeColor(grade: string): string {
  switch (grade) {
    case 'S': return 'bg-red-100 text-red-700 border-red-200';
    case 'A': return 'bg-orange-100 text-orange-700 border-orange-200';
    case 'B': return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'C': return 'bg-blue-100 text-blue-700 border-blue-200';
    case 'D': return 'bg-slate-100 text-slate-500 border-slate-200';
    default: return 'bg-slate-100 text-slate-500 border-slate-200';
  }
}

/**
 * Batch calculate lead scores for all active users in a tenant.
 */
export async function getLeadScores(tenantId: string, env: Env): Promise<Map<string, LeadScore>> {
  const supabase = getSupabaseClient(env);

  const { data: users } = await supabase
    .from('end_users')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_blocked', false)
    .limit(200);

  const { data: tenant } = await supabase
    .from('tenants')
    .select('hearing_config')
    .eq('id', tenantId)
    .single();

  const hearingItemsTotal = tenant?.hearing_config?.items?.length || 6;

  // Get message counts per user
  const { data: messageCounts } = await supabase
    .from('conversations')
    .select('end_user_id')
    .eq('tenant_id', tenantId)
    .eq('role', 'user');

  const countMap = new Map<string, number>();
  for (const msg of messageCounts || []) {
    countMap.set(msg.end_user_id, (countMap.get(msg.end_user_id) || 0) + 1);
  }

  const scores = new Map<string, LeadScore>();
  for (const user of users || []) {
    const msgCount = countMap.get(user.id) || 0;
    scores.set(user.id, calculateLeadScore(user as EndUser, msgCount, hearingItemsTotal));
  }

  return scores;
}

/**
 * Generate AI-powered staff response suggestions based on user context.
 * This is THE feature that makes this tool irreplaceable.
 */
export function generateStaffSuggestions(
  user: EndUser,
  leadScore: LeadScore,
  recentMessages: Array<{ role: string; content: string }>
): string[] {
  const suggestions: string[] = [];
  const hearingData = user.hearing_data || {};
  const hasHearing = Object.keys(hearingData).length > 0;
  const lastUserMsg = recentMessages.filter(m => m.role === 'user').pop();

  // Context-aware suggestions based on lead score and status
  if (leadScore.grade === 'S' || leadScore.grade === 'A') {
    // High score - push for conversion
    if (user.status === 'active') {
      suggestions.push('成約確率が高いです！具体的な相談会の日程を提案してみましょう');
      if (hasHearing) {
        const firstKey = Object.keys(hearingData)[0];
        suggestions.push(`「${hearingData[firstKey]}」について、相談会で詳しくアドバイスできますよ、と伝えてみましょう`);
      }
    } else if (user.status === 'booked') {
      suggestions.push('期待値を高めるメッセージを。「当日は○○についてもお話しできますよ」');
    }
  } else if (leadScore.grade === 'B') {
    // Medium score - nurture
    suggestions.push('もう少し関係構築が必要。共感ベースのメッセージを');
    if (!hasHearing) {
      suggestions.push('まだヒアリングが不十分。「差し支えなければ教えてほしいのですが...」と切り出す');
    }
  } else {
    // Low score - gentle re-engagement
    suggestions.push('押しすぎ注意。「お忙しいところすみません」から入る');
    suggestions.push('無理に予約を促さず、存在感を維持する程度に');
  }

  // Last message context
  if (lastUserMsg) {
    const content = lastUserMsg.content;
    if (content.includes('忙し') || content.includes('時間')) {
      suggestions.push('「お忙しいんですね。落ち着かれた頃にまたご連絡しますね」と共感を');
    }
    if (content.includes('迷') || content.includes('不安') || content.includes('どうしよう')) {
      suggestions.push('不安を受け止めてから具体的なメリットを1つだけ伝える');
    }
    if (content.includes('料金') || content.includes('いくら') || content.includes('費用')) {
      suggestions.push('「詳しい料金は相談会でご説明しますね。30分だけなのでお気軽に！」');
    }
  }

  return suggestions.slice(0, 4);
}
