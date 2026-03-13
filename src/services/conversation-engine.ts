import type { Env, Tenant, EndUser, ConversationMessage, AIResponse } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { generateHearingResponse, generateFollowUpResponse, generatePostConsultationResponse, generateHearingRecoveryResponse, generateNurtureResponse, getConversationHistory, handleUnexpectedInput } from './ai';
import { validateMessage } from '../guards/ai-guardrails';
import { detectIntent } from './intent-detector';
import { SessionManager } from './session-manager';
import type { AISession } from './session-manager';
import { logger } from '../utils/logger';

/**
 * ConversationContext is the API-friendly replacement for FlowContext.
 * It doesn't depend on ScenarioStep or LINE-specific details.
 */
export interface ConversationContext {
  tenant: Tenant;
  endUser: EndUser;
  conversationHistory: ConversationMessage[];
  env: Env;
}

/**
 * ConversationEngine handles AI conversation logic separated from
 * FlowEngine's orchestration (template sending, step transitions, scheduling).
 *
 * This is the core intelligence layer that Lステップ calls via API.
 */
export class ConversationEngine {
  private env: Env;
  private sessionManager: SessionManager;

  constructor(env: Env) {
    this.env = env;
    this.sessionManager = new SessionManager(env);
  }

  /**
   * Start a new hearing session for a user.
   * Returns the first AI message.
   */
  async startHearing(
    tenant: Tenant,
    endUser: EndUser
  ): Promise<{ session: AISession; aiResponse: AIResponse }> {
    const session = await this.sessionManager.createSession(
      tenant.id,
      endUser.id,
      'hearing',
      'trust'
    );

    const history = await getConversationHistory(endUser.id, tenant.id, this.env);
    const context = this.buildFlowContext(tenant, endUser, 'hearing', history);

    const aiResponse = await generateHearingResponse(context, '（システム: ヒアリングを開始してください）');
    const guardrailResult = validateMessage(aiResponse.reply_message, tenant);
    if (!guardrailResult.passed) {
      aiResponse.reply_message = 'こんにちは！少しお話を聞かせていただけますか？😊';
    }

    await this.sessionManager.updateSession(session.id, { turn_count: 1 });
    await this.saveConversation(tenant.id, endUser.id, 'assistant', aiResponse.reply_message, aiResponse);

    return { session, aiResponse };
  }

  /**
   * Process a user response in an active hearing session.
   */
  async processHearingResponse(
    tenant: Tenant,
    endUser: EndUser,
    session: AISession,
    userMessage: string
  ): Promise<{ aiResponse: AIResponse; session: AISession }> {
    // Save user message
    await this.saveConversation(tenant.id, endUser.id, 'user', userMessage);
    await this.updateLastResponseAt(endUser.id);

    // Detect intent
    const intent = detectIntent(userMessage);

    // Handle human request immediately
    if (intent === 'human_request') {
      await this.sessionManager.escalateSession(session.id, endUser.id);
      const aiResponse: AIResponse = {
        reply_message: '担当スタッフにおつなぎしますね。少々お待ちください😊',
        escalate_to_human: true,
      };
      await this.saveConversation(tenant.id, endUser.id, 'assistant', aiResponse.reply_message, aiResponse);
      return { aiResponse, session: { ...session, status: 'escalated' } };
    }

    const history = await getConversationHistory(endUser.id, tenant.id, this.env);
    const context = this.buildFlowContext(tenant, endUser, 'hearing', history);

    const aiResponse = await generateHearingResponse(context, userMessage);
    if (intent) aiResponse.detected_intent = intent;

    // Guardrail check
    const guardrailResult = validateMessage(aiResponse.reply_message, tenant);
    if (!guardrailResult.passed) {
      aiResponse.reply_message = 'もう少し詳しく教えていただけますか？😊';
    }

    // Update hearing data if extracted
    if (aiResponse.extracted_data && Object.keys(aiResponse.extracted_data).length > 0) {
      const updatedData = { ...endUser.hearing_data, ...aiResponse.extracted_data };
      const supabase = getSupabaseClient(this.env);
      await supabase
        .from('end_users')
        .update({
          hearing_data: updatedData,
          insight_summary: aiResponse.insight || endUser.insight_summary,
          updated_at: new Date().toISOString(),
        })
        .eq('id', endUser.id);
    }

    // Update session
    const newTurnCount = session.turn_count + 1;
    const updates: Partial<AISession> = { turn_count: newTurnCount };

    if (aiResponse.is_hearing_complete) {
      await this.sessionManager.completeSession(session.id, endUser.id);
      if (aiResponse.insight) {
        await this.updateInsightSummary(endUser.id, aiResponse.insight);
      }
      updates.status = 'completed';
    } else {
      await this.sessionManager.updateSession(session.id, updates);
    }

    await this.saveConversation(tenant.id, endUser.id, 'assistant', aiResponse.reply_message, aiResponse);
    await this.updateLastMessageAt(endUser.id);

    return {
      aiResponse,
      session: { ...session, turn_count: newTurnCount, status: updates.status || session.status },
    };
  }

  /**
   * Generate a single AI message for a specific purpose.
   * Used for nurture, follow-up, no-show recovery, etc.
   */
  async generateMessage(
    tenant: Tenant,
    endUser: EndUser,
    purpose: string,
    extraContext?: {
      nurture_stage?: 'value_preview' | 'preparation' | 'excitement' | 'day_of' | 'final_countdown';
      hours_until_consultation?: number;
      zoom_url?: string;
      action_type?: string;
    }
  ): Promise<AIResponse> {
    const history = await getConversationHistory(endUser.id, tenant.id, this.env);
    const context = this.buildFlowContext(tenant, endUser, purpose, history);

    let aiResponse: AIResponse;

    switch (purpose) {
      case 'nurture': {
        const stage = extraContext?.nurture_stage || 'value_preview';
        const hours = extraContext?.hours_until_consultation || 48;
        aiResponse = await generateNurtureResponse(context, stage, hours, extraContext?.zoom_url);
        break;
      }
      case 'follow_up':
        aiResponse = await generateFollowUpResponse(context);
        break;
      case 'no_show_recovery':
        aiResponse = await generatePostConsultationResponse(context, 'no_show_recovery');
        break;
      case 'post_consultation':
        aiResponse = await generatePostConsultationResponse(context, extraContext?.action_type || 'thank_you');
        break;
      case 'hearing_recovery':
        aiResponse = await generateHearingRecoveryResponse(context);
        break;
      default:
        aiResponse = await handleUnexpectedInput(context, `（システム: ${purpose}メッセージを生成してください）`);
    }

    // Guardrail check
    const guardrailResult = validateMessage(aiResponse.reply_message, tenant);
    if (!guardrailResult.passed) {
      logger.warn('Generated message failed guardrail', { purpose, violations: guardrailResult.violations });
    }

    return aiResponse;
  }

  /**
   * Build a FlowContext-compatible object from API parameters.
   * This bridges the new ConversationContext to the existing AI functions
   * which still expect FlowContext.
   */
  private buildFlowContext(
    tenant: Tenant,
    endUser: EndUser,
    stepId: string,
    conversationHistory: ConversationMessage[]
  ) {
    return {
      tenant,
      endUser,
      currentStep: {
        id: stepId,
        type: 'ai' as const,
        trigger: 'auto' as const,
        delay_minutes: 0,
        ai_config: { purpose: 'hearing' as const, max_turns: 8, completion_condition: 'all_required' },
        next_step: '',
      },
      hearingData: endUser.hearing_data || {},
      conversationHistory,
      env: this.env,
    };
  }

  private async saveConversation(
    tenantId: string,
    endUserId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    aiMetadata?: AIResponse
  ): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase.from('conversations').insert({
      end_user_id: endUserId,
      tenant_id: tenantId,
      role,
      content,
      ai_metadata: aiMetadata ? { extracted_data: aiMetadata.extracted_data, insight: aiMetadata.insight } : null,
    });
  }

  private async updateLastMessageAt(endUserId: string): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', endUserId);
  }

  private async updateLastResponseAt(endUserId: string): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({ last_response_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', endUserId);
  }

  private async updateInsightSummary(endUserId: string, insight: string): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({ insight_summary: insight, updated_at: new Date().toISOString() })
      .eq('id', endUserId);
  }
}
