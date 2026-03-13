import type { Env, FlowContext, AIResponse, ConversationMessage } from '../types';
import { buildSystemPrompt } from '../prompts/system-base';
import { buildHearingPrompt } from '../prompts/hearing';
import { buildFollowUpPrompt } from '../prompts/follow-up';
import { buildPostConsultationPrompt } from '../prompts/post-consultation';
import { getSupabaseClient } from '../utils/supabase';
import { logger } from '../utils/logger';

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
  userMessage: string
): Promise<AIResponse> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'general') +
    `\n\n## 今の状況
ユーザーは「${context.currentStep.id}」ステップにいます。
このステップでは定型メッセージを送信した直後です。
ユーザーからの返信に対して、適切に対応してください。
予約や相談会に関する質問には丁寧に答え、次のステップへの誘導を心がけてください。

### 応答フォーマット（JSON以外出力禁止）
{ "reply_message": "（150文字以内）", "escalate_to_human": false }`;

  const messages: ConversationMessage[] = [
    ...context.conversationHistory,
    { role: 'user', content: userMessage },
  ];

  try {
    return await callClaudeAPI(systemPrompt, messages, context.env, { temperature: 0.5 });
  } catch (error) {
    logger.error('Unexpected input handling failed', { error: String(error) });
    return {
      reply_message: 'すみません、もう少し詳しく教えていただけますか？😊',
      escalate_to_human: false,
    };
  }
}
