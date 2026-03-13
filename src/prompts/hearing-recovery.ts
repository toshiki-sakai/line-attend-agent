import type { Tenant, EndUser } from '../types';

export function buildHearingRecoveryPrompt(tenant: Tenant, endUser: EndUser): string {
  const hearingData = endUser.hearing_data || {};
  const answeredKeys = Object.keys(hearingData);
  const hearingItems = tenant.hearing_config?.items || [];
  const answeredCount = answeredKeys.length;
  const totalCount = hearingItems.length;

  const unansweredItems = hearingItems.filter(
    (item) => !answeredKeys.includes(item.id)
  );

  const daysSinceLastResponse = endUser.last_response_at
    ? Math.floor((Date.now() - new Date(endUser.last_response_at).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return `
## 目的: ヒアリング中断ユーザーへの再開メッセージ

### 状況
ユーザーはヒアリングの途中で会話が止まっています。
- 回答済み: ${answeredCount}/${totalCount} 項目
- 回答済みデータ: ${JSON.stringify(hearingData)}
- 最後の返信: ${endUser.last_response_at || '不明'}${daysSinceLastResponse !== null ? `（${daysSinceLastResponse}日前）` : ''}
- インサイト: ${endUser.insight_summary || 'なし'}

### 未回答の項目
${unansweredItems.map((item) => `- ${item.question_hint}${item.required ? '（必須）' : ''}`).join('\n')}

### 方針
${getRecoveryStrategy(answeredCount, totalCount, daysSinceLastResponse)}

### 重要なルール
- 「途中でしたね」「まだ終わっていませんよ」等の催促禁止
- 回答済みの内容に触れて「覚えていますよ」感を出す
- 残りの質問数が少ないなら「あと少しだけ聞かせてください」
- 会話の自然な再開を心がける

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（150文字以内。温かく自然な再開メッセージ）",
  "escalate_to_human": false,
  "should_continue_follow_up": true,
  "recommended_next_timing_hours": 48
}
`.trim();
}

function getRecoveryStrategy(
  answered: number,
  total: number,
  daysSince: number | null
): string {
  const progress = total > 0 ? answered / total : 0;

  if (progress === 0) {
    return `**まだ何も回答していない**
- 最初のヒアリングに入る前に離脱した可能性
- 軽い声かけから始める（「その後いかがですか？」）
- ヒアリングを再開する形ではなく、新しい会話を始める感覚で`;
  }

  if (progress < 0.5) {
    return `**序盤で止まっている（${answered}/${total}）**
- 回答済みの内容に軽く触れつつ、続きを促す
- 「前回お話しいただいた内容、しっかり覚えてますよ」
- 残りの質問を1つだけ聞く（一気に聞かない）`;
  }

  if (progress < 1) {
    return `**あと少し（${answered}/${total}）**
- 「あと少しで完了です！」と前向きに
- 残りの最も重要な質問だけに絞る
- 完了後のメリット（相談会でパーソナライズされたアドバイス）を伝える`;
  }

  return `**ヒアリング完了済み**
- ヒアリング自体は完了しているので、次のステップ（予約）へ誘導
- 「お話しいただいた内容を踏まえて、ぴったりのご提案ができますよ」`;
}
