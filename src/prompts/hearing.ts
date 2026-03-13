import type { Tenant, EndUser } from '../types';

export function buildHearingPrompt(tenant: Tenant, endUser: EndUser): string {
  const items = tenant.hearing_config?.items || [];
  const collected = endUser.hearing_data || {};
  const remaining = items.filter((item) => !collected[item.id]);
  const requiredRemaining = remaining.filter((item) => item.required);

  return `
## 目的: ヒアリング
自然な会話で以下の情報を収集。尋問にならないこと。

### 未収集（優先度順）
${remaining.map((item) => `- ${item.question_hint}（ID: ${item.id}, 必須: ${item.required}）`).join('\n')}

### 収集済み
${Object.entries(collected).map(([k, v]) => `- ${k}: ${v}`).join('\n') || 'なし'}

### 完了条件: 必須残り${requiredRemaining.length}件 → 0になったらis_hearing_complete=true

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（150文字以内）",
  "extracted_data": { "項目ID": "抽出内容" },
  "insight": "内部メモ",
  "is_hearing_complete": false,
  "escalate_to_human": false
}

### ルール
- extracted_data: このターンで新規抽出分のみ。なければ {}
- 1ターン1質問。曖昧な回答は深掘り
- ユーザーが話したいことを優先
`.trim();
}
