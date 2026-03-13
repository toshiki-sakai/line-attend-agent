import type { Env, FlowContext, AIResponse, ConversationMessage } from '../types';
import { buildSystemPrompt } from '../prompts/system-base';
import { buildHearingPrompt } from '../prompts/hearing';
import { buildFollowUpPrompt } from '../prompts/follow-up';
import { buildPostConsultationPrompt } from '../prompts/post-consultation';
import { buildHearingRecoveryPrompt } from '../prompts/hearing-recovery';
import { buildNurturePrompt } from '../prompts/pre-consultation-nurture';
import { getSupabaseClient } from '../utils/supabase';
import { logger } from '../utils/logger';
import { detectIntent, getIntentGuidance } from './intent-detector';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 400;
const CONVERSATION_HISTORY_LIMIT = 20;
const MAX_API_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
// Why: Cloudflare Workers has a 30s wall-clock limit; timeout before that to allow graceful error handling
const API_TIMEOUT_MS = 25000;

export async function getConversationHistory(
  endUserId: string,
  tenantId: string,
  env: Env
): Promise<ConversationMessage[]> {
  const supabase = getSupabaseClient(env);
  const { data } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('end_user_id', endUserId)
    .eq('tenant_id', tenantId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true })
    .limit(CONVERSATION_HISTORY_LIMIT);

  return (data || []) as ConversationMessage[];
}

async function callClaudeAPI(
  systemPrompt: string,
  messages: ConversationMessage[],
  env: Env,
  options: { temperature?: number } = {}
): Promise<AIResponse> {
  const { temperature = 0.5 } = options;

  for (let attempt = 0; attempt < MAX_API_RETRIES; attempt++) {
    try {
      const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: MAX_TOKENS,
          temperature,
          system: systemPrompt,
          messages,
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Claude API: ${response.status}`);
      }

      const data = (await response.json()) as { content: Array<{ type: string; text?: string }> };
      const text = data.content[0]?.text || '';
      // Why: Claude sometimes wraps JSON in markdown fences despite instructions
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned) as AIResponse;
    } catch (error) {
      if (attempt === MAX_API_RETRIES - 1) throw error;
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * BACKOFF_BASE_MS));
    }
  }

  throw new Error('Claude API: all retries exhausted');
}

export async function generateHearingResponse(
  context: FlowContext,
  userMessage: string
): Promise<AIResponse> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'hearing') +
    '\n\n' +
    buildHearingPrompt(context.tenant, context.endUser);

  const messages: ConversationMessage[] = [
    ...context.conversationHistory,
    { role: 'user', content: userMessage },
  ];

  try {
    return await callClaudeAPI(systemPrompt, messages, context.env, { temperature: 0.3 });
  } catch (error) {
    logger.error('Hearing response failed', { error: String(error) });
    return {
      reply_message: 'もう少し詳しく教えていただけますか？😊',
      extracted_data: {},
      insight: '',
      is_hearing_complete: false,
      escalate_to_human: false,
    };
  }
}

export async function generateFollowUpResponse(
  context: FlowContext
): Promise<AIResponse> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'follow_up') +
    '\n\n' +
    buildFollowUpPrompt(context.tenant, context.endUser);

  const messages: ConversationMessage[] = [
    ...context.conversationHistory,
    { role: 'user', content: '（システム: フォローアップメッセージを生成してください）' },
  ];

  try {
    return await callClaudeAPI(systemPrompt, messages, context.env, { temperature: 0.7 });
  } catch (error) {
    logger.error('Follow-up response failed', { error: String(error) });
    return {
      reply_message: 'その後いかがですか？何か気になることがあれば、いつでもメッセージくださいね😊',
      should_continue_follow_up: true,
      recommended_next_timing_hours: 48,
      escalate_to_human: false,
    };
  }
}

export async function generatePostConsultationResponse(
  context: FlowContext,
  actionType: string
): Promise<AIResponse> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'post_consultation') +
    '\n\n' +
    buildPostConsultationPrompt(context.tenant, context.endUser, actionType);

  const messages: ConversationMessage[] = [
    ...context.conversationHistory,
    { role: 'user', content: `（システム: ${actionType}メッセージを生成してください）` },
  ];

  try {
    return await callClaudeAPI(systemPrompt, messages, context.env, { temperature: 0.5 });
  } catch (error) {
    logger.error('Post-consultation response failed', { error: String(error) });
    return {
      reply_message: 'ご参加ありがとうございました！何かご不明な点があれば、いつでもメッセージくださいね😊',
      insight: '',
      escalate_to_human: false,
    };
  }
}

export async function handleUnexpectedInput(
  context: FlowContext,
  userMessage: string,
  detectedIntentOverride?: string
): Promise<AIResponse> {
  const stepId = context.currentStep.id;
  const status = context.endUser.status;
  const hearingData = context.endUser.hearing_data || {};
  const hasHearingData = Object.keys(hearingData).length > 0;

  // Detect user intent for smarter responses
  const intent = (detectedIntentOverride as ReturnType<typeof detectIntent>) || detectIntent(userMessage);
  const intentGuidance = getIntentGuidance(intent);

  // Context-aware guidance based on where the user is in the funnel
  let situationGuidance: string;
  if (status === 'booked') {
    situationGuidance = `ユーザーは予約済みです。相談会に向けた期待感を高め、不安を解消してください。
日程の変更希望があれば柔軟に対応を。キャンセルしたい場合も否定せず、理由を聞いて再提案を。`;
  } else if (stepId === 'booking_invite' || stepId === 'pre_booking_nudge') {
    situationGuidance = `ユーザーは予約案内の段階です。
${hasHearingData ? `ヒアリング情報: ${JSON.stringify(hearingData)} を踏まえて、「あなたの場合は相談会で〇〇について具体的に聞けますよ」と価値を伝えてください。` : ''}
予約を迷っている場合: 「30分だけなのでお気軽に」「他の方からも好評ですよ」等の安心感を。
断りの場合: 無理に勧めない。「またいつでもメッセージくださいね」で締める。`;
  } else {
    situationGuidance = `ユーザーは「${stepId}」ステップにいます。
ユーザーからの返信に対して、共感を示しつつ、最終的には無料相談会への参加を自然に後押しする方向で対応してください。`;
  }

  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'general') +
    `\n\n## 今の状況
${situationGuidance}
${intentGuidance ? `\n${intentGuidance}` : ''}

### 応答ルール
- まず共感・受け止めから
- 質問には丁寧に答える
- 答えられない質問→「相談会で詳しくお話できますよ！」
- 常にゴール（相談会参加）を意識するが、押し売りはしない

### 応答フォーマット（JSON以外出力禁止）
{ "reply_message": "（150文字以内）", "escalate_to_human": false, "should_continue_follow_up": ${intent === 'cancel' ? 'false' : 'true'} }`;

  const messages: ConversationMessage[] = [
    ...context.conversationHistory,
    { role: 'user', content: userMessage },
  ];

  try {
    const response = await callClaudeAPI(systemPrompt, messages, context.env, { temperature: 0.5 });
    response.detected_intent = intent;
    return response;
  } catch (error) {
    logger.error('Unexpected input handling failed', { error: String(error) });
    return {
      reply_message: 'すみません、もう少し詳しく教えていただけますか？😊',
      escalate_to_human: false,
      detected_intent: intent,
    };
  }
}

export async function generateNurtureResponse(
  context: FlowContext,
  stage: 'value_preview' | 'preparation' | 'excitement' | 'day_of' | 'final_countdown',
  hoursUntilConsultation: number,
  zoomUrl?: string
): Promise<AIResponse> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'nurture') +
    '\n\n' +
    buildNurturePrompt(context.tenant, context.endUser, stage, hoursUntilConsultation, zoomUrl);

  const messages: ConversationMessage[] = [
    ...context.conversationHistory,
    { role: 'user', content: `（システム: ${stage}ナーチャリングメッセージを生成してください）` },
  ];

  try {
    return await callClaudeAPI(systemPrompt, messages, context.env, { temperature: 0.5 });
  } catch (error) {
    logger.error('Nurture response failed', { error: String(error), stage });
    // Stage-specific fallback messages
    const fallbacks: Record<string, string> = {
      value_preview: '相談会で具体的なアドバイスをお伝えできるの、楽しみにしています😊',
      preparation: '相談会で一番聞きたいことを1つ考えておいてくださいね😊',
      excitement: '明日はよろしくお願いします！リラックスして来てくださいね😊',
      day_of: `今日はよろしくお願いします！${zoomUrl ? `\nこちらからご参加ください: ${zoomUrl}` : ''}`,
      final_countdown: `もうすぐですね！楽しみにしています😊${zoomUrl ? `\n${zoomUrl}` : ''}`,
    };
    return {
      reply_message: fallbacks[stage] || '相談会、楽しみにしていますね😊',
      escalate_to_human: false,
    };
  }
}

export async function generateHearingRecoveryResponse(
  context: FlowContext
): Promise<AIResponse> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'follow_up') +
    '\n\n' +
    buildHearingRecoveryPrompt(context.tenant, context.endUser);

  const messages: ConversationMessage[] = [
    ...context.conversationHistory,
    { role: 'user', content: '（システム: ヒアリング中断ユーザーへの再開メッセージを生成してください）' },
  ];

  try {
    return await callClaudeAPI(systemPrompt, messages, context.env, { temperature: 0.6 });
  } catch (error) {
    logger.error('Hearing recovery response failed', { error: String(error) });
    return {
      reply_message: 'その後いかがですか？何か気になることがあれば、いつでもメッセージくださいね😊',
      should_continue_follow_up: true,
      recommended_next_timing_hours: 72,
      escalate_to_human: false,
    };
  }
}
