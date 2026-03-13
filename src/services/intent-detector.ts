export type UserIntent =
  | 'defer'
  | 'hesitant'
  | 'price_question'
  | 'cancel'
  | 'human_request'
  | 'schedule_change'
  | 'none';

interface IntentPattern {
  intent: UserIntent;
  patterns: RegExp[];
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: 'human_request',
    patterns: [
      /人と(話|相談)/,
      /担当者/,
      /スタッフ/,
      /直接(話|聞)/,
      /電話(で|した)/,
      /オペレーター/,
      /人間/,
    ],
  },
  {
    intent: 'cancel',
    patterns: [
      /やめ(たい|ます|る|とく)/,
      /キャンセル/,
      /もういい/,
      /いらない/,
      /不要/,
      /退会/,
      /ブロック/,
      /うざい/,
      /迷惑/,
      /配信(停止|止め)/,
      /結構です/,
    ],
  },
  {
    intent: 'price_question',
    patterns: [
      /いくら/,
      /料金/,
      /費用/,
      /値段/,
      /価格/,
      /月額/,
      /金額/,
      /コスト/,
      /お金/,
      /高い/,
      /安い/,
      /予算/,
      /分割/,
      /支払い?方法/,
    ],
  },
  {
    intent: 'schedule_change',
    patterns: [
      /日程(変更|変え)/,
      /時間(変え|変更|ず[らら])/,
      /予約(変更|取り消|キャンセル)/,
      /別の日/,
      /リスケ/,
      /都合(が|悪)/,
      /行けなく/,
      /参加できな/,
    ],
  },
  {
    intent: 'defer',
    patterns: [
      /また(今度|後で|あとで|にし)/,
      /忙し[いく]/,
      /時間(が|ない|な[いく])/,
      /今(は|じゃ)ちょっと/,
      /余裕(が|ない)/,
      /落ち着いたら/,
      /今度/,
      /そのうち/,
      /いつか/,
    ],
  },
  {
    intent: 'hesitant',
    patterns: [
      /迷[いっう]て/,
      /どうしよう/,
      /考え(中|てる|ている|てます)/,
      /悩[んみ]/,
      /ちょっと(不安|心配)/,
      /自分に(合う|できる)/,
      /大丈夫(か|かな|でしょう)/,
      /ついていけ/,
      /向いて(る|い)/,
    ],
  },
];

export function detectIntent(message: string): UserIntent {
  const normalized = message.trim();
  if (!normalized) return 'none';

  for (const { intent, patterns } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        return intent;
      }
    }
  }

  return 'none';
}

export function getIntentGuidance(intent: UserIntent): string {
  switch (intent) {
    case 'defer':
      return `【意図: 先延ばし】
ユーザーは「今はタイミングじゃない」と感じている。
- 絶対に催促しない。「お忙しいですよね」と共感
- 「落ち着いた頃にまたご連絡しますね」と軽く締める
- 1-2週間後のフォローアップを推奨`;

    case 'hesitant':
      return `【意図: 迷い・不安】
ユーザーは興味はあるが不安を抱えている。ここが最大のチャンス。
- 不安の具体的な内容を聞き出す（「どんなところが気になりますか？」）
- 社会的証明を使う（「同じように不安だった方も、相談会後にスッキリされてます」）
- 無理に決断を迫らず、相談会で解消できることを伝える`;

    case 'price_question':
      return `【意図: 料金への関心】
ユーザーは投資対効果を知りたい。具体的な金額は言わず、価値を伝える。
- 「料金体系は状況によって異なるので、相談会で詳しくご案内しますね」
- 「投資に見合うかどうか、具体的な数字をお見せしながらお話しできますよ」
- 金額を聞かれても、絶対に具体額を答えない（嫌味なく）`;

    case 'cancel':
      return `【意図: キャンセル・拒否】
ユーザーは離脱したい。無理な引き止めは逆効果。
- 「承知しました。ご連絡ありがとうございました」と受容
- 「もし今後気が変わったら、いつでもメッセージくださいね」とドアを開けておく
- should_continue_follow_up: false を推奨`;

    case 'human_request':
      return `【意図: 人間対応の要求】
ユーザーはAIではなく人間と話したい。即座に対応する。
- 「担当スタッフにおつなぎしますね。少々お待ちください」
- escalate_to_human: true を設定`;

    case 'schedule_change':
      return `【意図: 日程変更】
ユーザーは参加意欲はあるが日程が合わない。柔軟に対応。
- 「もちろん、日程の変更は可能です」と安心感
- 新しい日程の候補を提示
- 予約変更の案内を含める`;

    default:
      return '';
  }
}
