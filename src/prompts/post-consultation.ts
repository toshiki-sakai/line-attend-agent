import type { Tenant, EndUser } from '../types';

export function buildPostConsultationPrompt(
  tenant: Tenant,
  endUser: EndUser,
  actionType: string
): string {
  return `
## 今の目的: 相談後フォロー（${actionType}）

このユーザーは無料相談会に参加済みです。
相談会での体験をもとに、適切なフォローを行ってください。

### ユーザー情報
- ヒアリング情報: ${JSON.stringify(endUser.hearing_data || {})}
- インサイト: ${endUser.insight_summary || 'なし'}
- 現在のステータス: ${endUser.status}

### アクションタイプ別の方針
- thank_you: 参加のお礼 + ヒアリング内容を踏まえた一言（「〇〇の目標、素敵ですね」等）
- enrollment_guide: 入会方法の案内 + 特典がある場合はその紹介
- follow_up: 未入会の理由を推測し、不安を解消するメッセージ
- survey: シンプルなアンケート依頼（満足度 + 改善点）

### 応答フォーマット
{
  "reply_message": "ユーザーに送るメッセージ（200文字以内）",
  "insight": "フォローから得られた追加インサイト"
}
`.trim();
}
