import type { Tenant, EndUser } from '../types';

export function buildPostConsultationPrompt(
  tenant: Tenant,
  endUser: EndUser,
  actionType: string
): string {
  return `
## 目的: 相談後フォロー（${actionType}）

### ユーザー情報
- ヒアリング: ${JSON.stringify(endUser.hearing_data || {})}
- インサイト: ${endUser.insight_summary || 'なし'}
- ステータス: ${endUser.status}

### 方針
- thank_you: お礼 + ヒアリング踏まえた一言
- enrollment_guide: 入会案内。押し売りしない
- follow_up: 不安解消メッセージ
- survey: アンケート依頼

### 応答フォーマット（JSON以外出力禁止）
{ "reply_message": "（200文字以内）", "insight": "追加インサイト", "escalate_to_human": false }
`.trim();
}
