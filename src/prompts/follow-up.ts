import type { Tenant, EndUser } from '../types';

export function buildFollowUpPrompt(tenant: Tenant, endUser: EndUser): string {
  const followUpCount = endUser.follow_up_count + 1;
  const hearingData = endUser.hearing_data || {};
  const hasHearingData = Object.keys(hearingData).length > 0;
  const daysSinceLastResponse = endUser.last_response_at
    ? Math.floor((Date.now() - new Date(endUser.last_response_at).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return `
## 目的: 追客メッセージ（${followUpCount}回目）

### 重要: 追客の本質
追客 ≠ 催促。追客 = 「あなたのことを覚えていますよ」という温かい存在感。
ユーザーが返信しない理由は「興味がない」ではなく「忙しい」「タイミングじゃない」がほとんど。
だから、プレッシャーをかけずに「いつでもここにいるよ」感を出す。

### ユーザーの現状
- 名前: ${endUser.display_name || '未取得'}
- 最後の返信: ${endUser.last_response_at || '未返信'}${daysSinceLastResponse !== null ? `（${daysSinceLastResponse}日前）` : ''}
- ヒアリング情報: ${JSON.stringify(hearingData)}
- インサイト: ${endUser.insight_summary || 'なし'}
- これまでのフォローアップ: ${endUser.follow_up_count}回

### ${followUpCount}回目の方針
${getFollowUpStrategy(followUpCount, hasHearingData, daysSinceLastResponse)}

### パーソナライズのポイント
${hasHearingData ? `
ヒアリング情報を必ず活用すること。具体的に触れること。
${Object.entries(hearingData).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

「以前お話しいただいた〇〇のこと、覚えていますよ」感が大事。
インサイト情報も活用: ${endUser.insight_summary || 'なし'}
` : `
まだヒアリング情報がないため、汎用的だが温かいメッセージにする。
「お忙しいところすみません」「ちょっとだけお時間いただけたら嬉しいです」等。
`}

### 過去メッセージとの重複回避
直近の会話ログを参考に、以前送ったメッセージと同じ内容・構成を避けること。
切り口を変える: 前回が声かけなら今回は情報提供、前回が質問なら今回は共感、など。

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（150文字以内。パーソナライズされた温かいメッセージ）",
  "should_continue_follow_up": true,
  "recommended_next_timing_hours": 48,
  "escalate_to_human": false
}

### 禁止事項
- 「お返事まだですか？」「ご確認いただけましたか？」等の催促表現
- 「限定」「今だけ」等の煽り表現（3回目以外）
- 前回と同じ内容のメッセージ
- 長文（LINE追客は短く、刺さる一言が最強）
`.trim();
}

function getFollowUpStrategy(
  count: number,
  hasHearingData: boolean,
  daysSince: number | null
): string {
  switch (count) {
    case 1:
      return `**軽い声かけ**: 「その後いかがですか？」レベル。
- 圧をかけない。ただの挨拶+α
- 「〇〇について気になることがあれば、いつでも聞いてくださいね」
- recommended_next_timing_hours: 48`;

    case 2:
      return `**価値提供型**: ヒアリング情報があれば、それに基づいたお役立ち情報を一言。
- ${hasHearingData ? '「以前〇〇に興味があるとおっしゃっていたので…」' : '「こんな方が多いんですが、〇〇さんはいかがですか？」'}
- 「相談会では、あなたの状況に合わせた具体的なアドバイスがもらえますよ」
- recommended_next_timing_hours: 72`;

    case 3:
      return `**ソーシャルプルーフ+限定感**: 他の参加者の成功体験や、枠の状況。
- 「最近参加された方からも好評で…」
- 「今月の枠が残りわずかになってきたので、お知らせしますね」
- 煽りではなく事実ベースで
- recommended_next_timing_hours: 72`;

    case 4:
      return `**最終アプローチ**: 温かく締める。ドアは開けておく。
- 「いつでもお気軽にメッセージくださいね」
- 「無理にとは言いませんが、少しでも気になったらぜひ」
- should_continue_follow_up: false（これ以上は逆効果）
- recommended_next_timing_hours: 0`;

    default:
      return `**エスカレーション**: 自動追客の限界。人間のフォローが必要。
- escalate_to_human: true
- recommended_next_timing_hours: 0`;
  }
}
