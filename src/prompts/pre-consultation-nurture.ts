import type { Tenant, EndUser } from '../types';

/**
 * Pre-consultation nurture prompts.
 *
 * The critical insight: between booking and consultation, the user's motivation
 * decays. Generic reminders ("Don't forget!") do nothing to rebuild it.
 * Instead, each touchpoint must ADD VALUE and DEEPEN INVESTMENT.
 *
 * The psychology:
 * 1. Psychological investment: The more someone invests (time, thought, emotion),
 *    the less likely they are to waste that investment by not showing up.
 * 2. Future pacing: Help them VISUALIZE the consultation going well.
 * 3. Specificity: Generic = ignorable. Specific to their situation = compelling.
 * 4. Identity reinforcement: "You're someone who takes action" framing.
 * 5. Friction removal: Proactively address every reason NOT to show up.
 */
export function buildNurturePrompt(
  tenant: Tenant,
  endUser: EndUser,
  stage: 'value_preview' | 'preparation' | 'excitement' | 'day_of' | 'final_countdown',
  hoursUntilConsultation: number,
  bookingZoomUrl?: string
): string {
  const hearingData = endUser.hearing_data || {};
  const hasHearing = Object.keys(hearingData).length > 0;
  const hearingSummary = Object.entries(hearingData).map(([k, v]) => `${k}: ${v}`).join('\n');

  const baseContext = `
## 背景情報
- テナント: ${tenant.name}
- ユーザー名: ${endUser.display_name || 'ゲスト'}
- 相談会まで: 約${Math.round(hoursUntilConsultation)}時間
- ヒアリング情報: ${hasHearing ? hearingSummary : 'なし'}
- インサイト: ${endUser.insight_summary || 'なし'}
`.trim();

  switch (stage) {
    case 'value_preview':
      return buildValuePreview(tenant, endUser, hearingData, baseContext);
    case 'preparation':
      return buildPreparation(tenant, endUser, hearingData, baseContext);
    case 'excitement':
      return buildExcitement(tenant, endUser, hearingData, baseContext);
    case 'day_of':
      return buildDayOf(tenant, endUser, hearingData, baseContext, bookingZoomUrl);
    case 'final_countdown':
      return buildFinalCountdown(tenant, endUser, hearingData, baseContext, bookingZoomUrl);
  }
}

/**
 * Stage 1: Value Preview (2-3 days after booking)
 * Goal: Reinforce WHY they booked. Connect their hearing data to specific
 * consultation benefits. Create anticipation.
 */
function buildValuePreview(
  _tenant: Tenant,
  endUser: EndUser,
  hearingData: Record<string, string>,
  baseContext: string
): string {
  const hasHearing = Object.keys(hearingData).length > 0;

  return `
## 目的: 予約後の価値プレビュー（着座率向上のための関係維持）

${baseContext}

### このメッセージの狙い
予約直後は「予約できた！」で満足して、当日のモチベーションが下がりやすい。
このメッセージで「相談会では具体的にこんなことがわかる」を伝え、期待値を再燃させる。

### メッセージ設計
${hasHearing ? `
ユーザーのヒアリング情報を必ず活用する。
ポイント: 「以前お話しいただいた〇〇について、相談会では〜がわかりますよ」と
ヒアリング内容 → 相談会での具体的メリットに変換する。

例: ユーザーが「転職したい」と言った場合
→ 「相談会では、${endUser.display_name || 'あなた'}さんの今のスキルセットから、最短でどんなキャリアパスが描けるか、具体的にお話しできますよ」

例: ユーザーが「不安」と言った場合
→ 「同じような不安を持って相談に来られた方の多くが、終わった後に『来てよかった』とおっしゃいます。${endUser.display_name || 'あなた'}さんの場合も、きっとスッキリすると思いますよ」
` : `
ヒアリング情報がないため、汎用的だが具体的なメリットを伝える。
「相談会では、あなたの状況に合わせた具体的なアドバイスがもらえます」
`}

### 絶対ルール
- 押し売り感ゼロ。「楽しみにしていてくださいね」レベルの軽さ
- 「忘れないでくださいね」は禁止（催促感が出る）
- 代わりに「〇〇について話せるの、楽しみにしています」（こちらが楽しみにしている形）

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（100文字以内。期待値を上げる温かいメッセージ）",
  "escalate_to_human": false
}
`.trim();
}

/**
 * Stage 2: Preparation (1-2 days before)
 * Goal: Create psychological investment. When someone PREPARES for something,
 * they've invested effort → sunk cost makes them more likely to attend.
 */
function buildPreparation(
  _tenant: Tenant,
  endUser: EndUser,
  hearingData: Record<string, string>,
  baseContext: string
): string {
  const hasHearing = Object.keys(hearingData).length > 0;

  return `
## 目的: 相談会の準備（心理的投資を作る）

${baseContext}

### このメッセージの最重要ポイント
「準備してもらう」= 心理的投資を作る。
人は投資したものを無駄にしたくない。だから準備した人は来る。

ただし「準備してください」とは言わない。
代わりに「1つだけ考えておいてもらえると、もっと有意義な時間になりますよ」と
ユーザーのメリットとして提案する。

### 具体的な「準備」のお願い例
${hasHearing ? `
ヒアリング情報に基づいた個別質問:
${Object.entries(hearingData).map(([k, v]) => `- 「${v}」について → 「${k}について、一番聞きたいことを1つ考えておいてくださいね」`).join('\n')}
` : `
- 「相談会で一番聞きたいことを1つだけ考えておくと、もっと充実した時間になりますよ」
- 「最近気になっていることがあれば、メモしておいてくださいね」
`}

### トーン
- 軽い。義務感を感じさせない
- 「準備しなきゃ」ではなく「こうするともっと良くなるよ」
- 「〇〇さんの場合は特に、△△について聞くと良いと思いますよ」

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（120文字以内。軽い準備提案）",
  "escalate_to_human": false
}
`.trim();
}

/**
 * Stage 3: Excitement Building (evening before or morning of - far enough out)
 * Goal: Build anticipation and social proof. Make them WANT to come.
 */
function buildExcitement(
  _tenant: Tenant,
  endUser: EndUser,
  hearingData: Record<string, string>,
  baseContext: string
): string {
  const hasHearing = Object.keys(hearingData).length > 0;

  return `
## 目的: 期待感の醸成（前日〜当日朝）

${baseContext}

### このメッセージの心理学
フューチャーペーシング（未来の自分を想像させる）が最強。
「相談会が終わったら、〇〇さんは△△についてスッキリしていると思いますよ」
→ ユーザーの脳内に「行った後の自分」がリアルに描ける → 行動のハードルが下がる。

### メッセージ設計
${hasHearing ? `
「${endUser.display_name || '○○'}さんが以前お話しされていた${Object.keys(hearingData)[0]}のこと、
相談会で具体的にお話しできるの、楽しみにしています！」

→ 「あなたのことを覚えていて、あなたのために準備している」感を出す。
これが最強の来場動機。
` : `
「明日（今日）はよろしくお願いします！
リラックスして来てくださいね。難しい話はしないので、気軽な感じで大丈夫ですよ😊」
`}

### ソーシャルプルーフ（控えめに）
- 「最近参加された方からも『もっと早く来ればよかった』というお声をいただいています」
- 煽りではない。事実ベースで。

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（100文字以内。温かく、楽しみにしている気持ち）",
  "escalate_to_human": false
}
`.trim();
}

/**
 * Stage 4: Day-of (morning of consultation day)
 * Goal: Logistics + final motivation. Remove every possible friction.
 */
function buildDayOf(
  _tenant: Tenant,
  endUser: EndUser,
  hearingData: Record<string, string>,
  baseContext: string,
  zoomUrl?: string
): string {
  return `
## 目的: 当日朝のメッセージ（最終確認 + 応援）

${baseContext}

### このメッセージの設計
当日朝は3つのことを同時にやる:
1. 実務情報（時間、Zoom URL）を簡潔に伝える
2. 不安を取り除く（「リラックスしてきてくださいね」）
3. 最後の一押し（「楽しみにしています！」）

### 必須要素
${zoomUrl ? `- Zoom URL: ${zoomUrl}` : '- Zoom URLは別途送信済み'}
- 開始時間のリマインド
- 「何か分からないことがあればいつでもメッセージください」

### トーン
- 事務的にならない。温かさを保つ
- 「忘れてませんか？」は絶対禁止
- 「今日はよろしくお願いします！」= 対等なパートナー感

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（150文字以内。当日の実務情報 + 温かいメッセージ）",
  "escalate_to_human": false
}
`.trim();
}

/**
 * Stage 5: Final Countdown (30-60 min before)
 * Goal: Last touch. Simple, warm, zero friction.
 */
function buildFinalCountdown(
  _tenant: Tenant,
  endUser: EndUser,
  _hearingData: Record<string, string>,
  baseContext: string,
  zoomUrl?: string
): string {
  return `
## 目的: 直前メッセージ（30分〜1時間前）

${baseContext}

### このメッセージの設計
最短・最シンプル。ワンタップでZoomに入れる状態を作る。

### 必須要素
${zoomUrl ? `- Zoom URL: ${zoomUrl}（タップするだけで参加できるように）` : ''}
- 「もうすぐですね！」的な軽い声かけ
- 「お会いできるのを楽しみにしています」

### 絶対ルール
- 長文禁止。3行以内
- 新しい情報を入れない（混乱させない）
- 質問しない（返信の必要がない形で）

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（80文字以内。シンプルに。Zoom URLがあれば含める）",
  "escalate_to_human": false
}
`.trim();
}
