import Anthropic from '@anthropic-ai/sdk';
import type { Env, Tenant, EndUser, FlowContext } from '../types';
import { buildSystemPrompt } from '../prompts/system-base';
import { buildHearingPrompt } from '../prompts/hearing';
import { buildFollowUpPrompt } from '../prompts/follow-up';
import { buildPostConsultationPrompt } from '../prompts/post-consultation';
import { getSupabaseClient } from '../utils/supabase';
import { logger } from '../utils/logger';

interface HearingResponse {
  reply_message: string;
  extracted_data: Record<string, string>;
  insight: string;
  is_hearing_complete: boolean;
}

interface FollowUpResponse {
  reply_message: string;
  should_continue_follow_up: boolean;
  recommended_next_timing_hours: number;
  escalate_to_human: boolean;
}

interface PostConsultationResponse {
  reply_message: string;
  insight: string;
}

function getClient(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

async function getConversationHistory(
  endUserId: string,
  tenantId: string,
  env: Env,
  limit = 20
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const supabase = getSupabaseClient(env);
  const { data } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('end_user_id', endUserId)
    .eq('tenant_id', tenantId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true })
    .limit(limit);

  return (data || []) as Array<{ role: 'user' | 'assistant'; content: string }>;
}

async function callClaude(
  env: Env,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  temperature: number = 0.3,
  maxTokens: number = 300
): Promise<string> {
  const client = getClient(env);
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages,
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : '';
}

function parseJsonResponse<T>(text: string): T | null {
  try {
    // JSON部分を抽出（前後にテキストがある場合に対応）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as T;
    }
    return null;
  } catch {
    return null;
  }
}

export async function generateHearingResponse(
  context: FlowContext,
  userMessage: string,
  env: Env
): Promise<HearingResponse> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'hearing') +
    '\n\n' +
    buildHearingPrompt(context.tenant, context.endUser);

  const history = await getConversationHistory(
    context.endUser.id,
    context.tenant.id,
    env
  );
  const messages = [...history, { role: 'user' as const, content: userMessage }];

  // 最大3回リトライ
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await callClaude(env, systemPrompt, messages, 0.3, 400);
    const parsed = parseJsonResponse<HearingResponse>(response);
    if (parsed && parsed.reply_message) {
      return parsed;
    }
    logger.warn('Failed to parse hearing response, retrying', { attempt, response });
  }

  // フォールバック
  return {
    reply_message: 'もう少し詳しく教えていただけますか？😊',
    extracted_data: {},
    insight: '',
    is_hearing_complete: false,
  };
}

export async function generateFollowUpResponse(
  context: FlowContext,
  env: Env
): Promise<FollowUpResponse> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'follow_up') +
    '\n\n' +
    buildFollowUpPrompt(context.tenant, context.endUser);

  const history = await getConversationHistory(
    context.endUser.id,
    context.tenant.id,
    env
  );
  // 追客はシステムからの発信なので、userメッセージとして「フォローアップ実行」を送る
  const messages = [
    ...history,
    { role: 'user' as const, content: '（システム: フォローアップメッセージを生成してください）' },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await callClaude(env, systemPrompt, messages, 0.7, 400);
    const parsed = parseJsonResponse<FollowUpResponse>(response);
    if (parsed && parsed.reply_message) {
      return parsed;
    }
    logger.warn('Failed to parse follow-up response, retrying', { attempt });
  }

  return {
    reply_message: 'その後いかがですか？何か気になることがあれば、いつでもメッセージくださいね😊',
    should_continue_follow_up: true,
    recommended_next_timing_hours: 48,
    escalate_to_human: false,
  };
}

export async function generatePostConsultationResponse(
  context: FlowContext,
  actionType: string,
  env: Env
): Promise<PostConsultationResponse> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'post_consultation') +
    '\n\n' +
    buildPostConsultationPrompt(context.tenant, context.endUser, actionType);

  const history = await getConversationHistory(
    context.endUser.id,
    context.tenant.id,
    env
  );
  const messages = [
    ...history,
    { role: 'user' as const, content: `（システム: ${actionType}メッセージを生成してください）` },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await callClaude(env, systemPrompt, messages, 0.5, 400);
    const parsed = parseJsonResponse<PostConsultationResponse>(response);
    if (parsed && parsed.reply_message) {
      return parsed;
    }
    logger.warn('Failed to parse post-consultation response, retrying', { attempt });
  }

  return {
    reply_message: 'ご参加ありがとうございました！何かご不明な点があれば、いつでもメッセージくださいね😊',
    insight: '',
  };
}

export async function handleUnexpectedInput(
  context: FlowContext,
  userMessage: string,
  env: Env
): Promise<string> {
  const systemPrompt =
    buildSystemPrompt(context.tenant, context.endUser, 'general') +
    `\n\n## 今の状況
ユーザーは「${context.currentStep.id}」ステップにいます。
このステップでは定型メッセージを送信した直後です。
ユーザーからの返信に対して、適切に対応してください。
予約や相談会に関する質問には丁寧に答え、次のステップへの誘導を心がけてください。
150文字以内で応答してください。`;

  const history = await getConversationHistory(
    context.endUser.id,
    context.tenant.id,
    env
  );
  const messages = [...history, { role: 'user' as const, content: userMessage }];

  const response = await callClaude(env, systemPrompt, messages, 0.5, 300);
  return response || 'すみません、もう少し詳しく教えていただけますか？😊';
}
