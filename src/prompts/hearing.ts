import type { Tenant, EndUser } from '../types';

export function buildHearingPrompt(tenant: Tenant, endUser: EndUser): string {
  const items = tenant.hearing_config?.items || [];
  const collected = endUser.hearing_data || {};
  const remaining = items.filter((item) => !collected[item.id]);

  return `
## 今の目的: ヒアリング

以下の項目をユーザーとの自然な会話の中で収集してください。
尋問のように聞くのではなく、相手の話に共感しながら自然に引き出してください。

### 未収集の項目（優先度順）
${remaining.map((item) => `- ${item.question_hint}（ID: ${item.id}, 必須: ${item.required}）`).join('\n')}

### 収集済みの項目
${Object.entries(collected).map(([key, value]) => `- ${key}: ${value}`).join('\n') || 'なし'}

### 応答フォーマット
以下のJSON形式で応答してください:
{
  "reply_message": "ユーザーに送るメッセージ（150文字以内）",
  "extracted_data": {
    "項目ID": "抽出した内容"
  },
  "insight": "この会話から読み取れるユーザーのインサイト（内部メモ）",
  "is_hearing_complete": false
}

### 重要
- extracted_dataにはこの会話ターンで新しく抽出できた情報のみ入れる
- 無理に全項目を1回で聞かない。1ターン1質問
- ユーザーが話したいことがあれば、それを優先して聞く
- 必須項目がすべて収集できたらis_hearing_completeをtrueにする
`.trim();
}
