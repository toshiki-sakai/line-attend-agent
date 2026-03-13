import type { Tenant, EndUser } from '../types';

export function buildFollowUpPrompt(tenant: Tenant, endUser: EndUser): string {
  return `
## 今の目的: 追客（フォローアップ）

このユーザーはしばらく返信がありません。
自然な形で会話を再開し、無料相談会への参加意欲を高めてください。

### ユーザーの状態
- 最後のメッセージ: ${endUser.last_response_at || '未返信'}
- これまでの追客回数: ${endUser.follow_up_count}回
- ヒアリング情報: ${JSON.stringify(endUser.hearing_data || {})}
- インサイト: ${endUser.insight_summary || 'なし'}

### 追客の方針
- 1回目: 軽い声かけ（「その後いかがですか？」的な）
- 2回目: ヒアリングで聞いた悩みに寄り添うメッセージ
- 3回目: 期間限定感や他の参加者の声を活用
- 4回目: 最後の案内として「いつでも相談できます」と伝える
- 5回目: 人間スタッフへの引き継ぎを案内

### 応答フォーマット
{
  "reply_message": "ユーザーに送るメッセージ（150文字以内）",
  "should_continue_follow_up": true,
  "recommended_next_timing_hours": 48,
  "escalate_to_human": false
}
`.trim();
}
