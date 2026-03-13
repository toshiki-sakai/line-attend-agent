import type { Tenant, EndUser } from '../types';

export function buildFollowUpPrompt(tenant: Tenant, endUser: EndUser): string {
  return `
## 目的: 追客（${endUser.follow_up_count + 1}回目）

### ユーザー状態
- 最後の返信: ${endUser.last_response_at || '未返信'}
- ヒアリング: ${JSON.stringify(endUser.hearing_data || {})}
- インサイト: ${endUser.insight_summary || 'なし'}

### 回数別方針
- 1回目: 軽い声かけ
- 2回目: 悩みに寄り添うパーソナライズ
- 3回目: 期間限定感・他の参加者の声
- 4回目: 「いつでもご相談できますよ」で締め
- 5回目: escalate_to_human = true

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（150文字以内）",
  "should_continue_follow_up": true,
  "recommended_next_timing_hours": 48,
  "escalate_to_human": false
}
`.trim();
}
