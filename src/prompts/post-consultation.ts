import type { Tenant, EndUser } from '../types';

export function buildPostConsultationPrompt(
  tenant: Tenant,
  endUser: EndUser,
  actionType: string
): string {
  const hearingData = endUser.hearing_data || {};

  return `
## 目的: 相談後フォロー（${actionType}）

### 重要な考え方
相談会が終わった後が、実は一番大事なタイミング。
ユーザーは「良い話だったな」と思っていても、日常に戻ると忘れる。
このフォローで「思い出させる」＋「次のアクションを明確にする」。

### ユーザー情報（必ず活用すること）
- 名前: ${endUser.display_name || '未取得'}
- ヒアリング情報: ${JSON.stringify(hearingData)}
- インサイト: ${endUser.insight_summary || 'なし'}
- 現在のステータス: ${endUser.status}

### アクション別方針: ${actionType}

${getPostConsultationGuidance(actionType, endUser)}

### 応答フォーマット（JSON以外出力禁止）
{
  "reply_message": "（200文字以内。パーソナライズされたフォローメッセージ）",
  "insight": "（追加インサイト：ユーザーの入会見込み、懸念点の推測など）",
  "escalate_to_human": false
}

### 禁止事項
- 「お金」「費用」「料金」に関する具体的な言及
- 押し売り感のある表現
- 相談会の内容を勝手に推測する（「きっと良い話が聞けたと思います」はOK）
`.trim();
}

function getPostConsultationGuidance(actionType: string, endUser: EndUser): string {
  const name = endUser.display_name || 'ゲスト';
  const hearingKeys = Object.keys(endUser.hearing_data || {});

  switch (actionType) {
    case 'thank_you':
      return `**お礼メッセージ**（相談会直後〜数時間後）
- 「${name}さん、今日はお時間いただきありがとうございました！」から始める
- ヒアリング情報に触れる: ${hearingKeys.length > 0 ? `「${hearingKeys[0]}について話されていた件、ぜひ…」` : '汎用的なお礼'}
- 「何か気になることがあれば、いつでもメッセージくださいね」で締める
- 温かく、短く、印象に残る一言を`;

    case 'enrollment_guide':
      return `**入会案内**（相談会翌日〜2日後）
- 押し売りは絶対NG。「次のステップとして」「もしご興味があれば」のトーン
- ヒアリング情報を踏まえた価値提案をする
- 「${name}さんの場合は〇〇から始めるのが良さそうですね」と具体的に
- 質問があれば答えられることを伝える`;

    case 'follow_up':
      return `**不安解消フォロー**（入会案内後、未入会の場合）
- ユーザーが決断できない理由を推測し、先回りして解消する
- 「よくある質問」的なアプローチ: 「こういう不安をお持ちの方も多いんですが…」
- 一方的に話さない。「何か気になっていることはありますか？」で対話を促す`;

    case 'survey':
      return `**アンケート・感想依頼**
- 軽いトーンで: 「一つだけ聞いてもいいですか？」
- 相談会の満足度 or 「一番印象に残ったこと」を聞く
- 返答ハードルを下げる: 「一言でOKです！」`;

    case 'personalized_remind':
      return `**パーソナライズドリマインド**（予約済みユーザーへの相談会前リマインド）
- 相談会への期待感を高める
- ヒアリング情報を踏まえて「${name}さんの〇〇について、しっかりお話できる準備をしていますよ」
- 場所・時間の再確認
- 「楽しみにしていますね！」で締める`;

    default:
      return `汎用フォローメッセージ。温かさ＋パーソナライズを心がける。`;
  }
}
