import type { Env, Tenant, EndUser, FlowContext, ScenarioStep, AIResponse } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { pushMessage, pushFlexMessage } from './line';
import { generateHearingResponse, handleUnexpectedInput, getConversationHistory } from './ai';
import { validateMessage, validateWithRetry } from '../guards/ai-guardrails';
import { getAvailableSlots, buildBookingFlexMessage } from './booking';
import { notifyStaff } from './notification';
import { cancelPendingActions } from '../utils/scheduled-actions';
import { logger } from '../utils/logger';

const NON_TEXT_REPLY = 'ありがとうございます！テキストでお返事いただけると嬉しいです😊';

export class FlowEngine {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async handleUserMessage(context: FlowContext, userMessage: string, messageType: string): Promise<void> {
    if (context.endUser.is_blocked) return;

    // 非テキストメッセージ対応
    if (messageType !== 'text') {
      if (context.currentStep.type === 'ai') {
        await pushMessage(context.tenant, context.endUser.line_user_id, NON_TEXT_REPLY);
      }
      return;
    }

    await this.saveConversation(context, 'user', userMessage);
    await this.updateLastResponseAt(context.endUser.id);

    if (context.currentStep.type === 'ai') {
      await this.handleAIStep(context, userMessage);
    } else {
      await this.handleTemplateStepInput(context, userMessage);
    }
  }

  private async handleAIStep(context: FlowContext, userMessage: string): Promise<void> {
    const purpose = context.currentStep.ai_config?.purpose;

    if (purpose === 'hearing') {
      const aiResponse = await generateHearingResponse(context, userMessage);
      await this.processAIResponse(context, aiResponse);

      if (aiResponse.extracted_data && Object.keys(aiResponse.extracted_data).length > 0) {
        await this.updateHearingData(context, aiResponse);
      }

      if (aiResponse.is_hearing_complete) {
        await this.advanceStep(context);
      }
    } else {
      const aiResponse = await handleUnexpectedInput(context, userMessage);
      await this.processAIResponse(context, aiResponse);
    }
  }

  private async handleTemplateStepInput(context: FlowContext, userMessage: string): Promise<void> {
    const aiResponse = await handleUnexpectedInput(context, userMessage);
    await this.processAIResponse(context, aiResponse);
  }

  private async processAIResponse(context: FlowContext, aiResponse: AIResponse): Promise<void> {
    if (aiResponse.escalate_to_human) {
      await this.escalateToHuman(context, 'AI判断によるエスカレーション');
      return;
    }

    const validated = await validateWithRetry(
      aiResponse.reply_message,
      context.tenant,
      context,
      async () => handleUnexpectedInput(context, '（再生成してください）')
    );

    if (!validated.passed) {
      await this.escalateToHuman(context, 'ガードレール違反が解消されない');
      return;
    }

    await pushMessage(context.tenant, context.endUser.line_user_id, validated.message);
    await this.saveConversation(context, 'assistant', validated.message, aiResponse);
  }

  async advanceStep(context: FlowContext): Promise<void> {
    const nextStepId = context.currentStep.next_step;
    if (!nextStepId) return;

    const nextStep = this.getStepById(context.tenant, nextStepId);
    if (!nextStep) {
      logger.warn('Next step not found', { nextStepId });
      return;
    }

    await this.updateCurrentStep(context.endUser.id, nextStepId);

    if (nextStep.trigger === 'auto' && nextStep.delay_minutes === 0) {
      await this.executeStep(context.tenant, context.endUser, nextStep, context.env);
    } else if (nextStep.trigger === 'auto' && nextStep.delay_minutes > 0) {
      await this.scheduleAction({
        tenant_id: context.tenant.id,
        end_user_id: context.endUser.id,
        action_type: 'scenario_step',
        action_payload: { step_id: nextStep.id },
        execute_at: new Date(Date.now() + nextStep.delay_minutes * 60 * 1000).toISOString(),
      });
    }
  }

  async executeStep(tenant: Tenant, endUser: EndUser, step: ScenarioStep, env: Env): Promise<void> {
    if (step.type === 'template') {
      await this.executeTemplateStep(tenant, endUser, step, env);
    } else if (step.type === 'ai') {
      await this.executeAIStep(tenant, endUser, step, env);
    }
  }

  private async executeAIStep(tenant: Tenant, endUser: EndUser, step: ScenarioStep, env: Env): Promise<void> {
    if (step.ai_config?.purpose !== 'hearing') return;

    const history = await getConversationHistory(endUser.id, tenant.id, env);
    const context: FlowContext = {
      tenant,
      endUser,
      currentStep: step,
      hearingData: endUser.hearing_data,
      conversationHistory: history,
      env,
    };

    const aiResponse = await generateHearingResponse(context, '（システム: ヒアリングを開始してください）');
    const guardrailResult = validateMessage(aiResponse.reply_message, tenant);
    const message = guardrailResult.passed
      ? aiResponse.reply_message
      : 'こんにちは！少しお話を聞かせていただけますか？😊';

    await pushMessage(tenant, endUser.line_user_id, message);
    await this.saveConversation(context, 'assistant', message, aiResponse);
  }

  private async executeTemplateStep(
    tenant: Tenant,
    endUser: EndUser,
    step: ScenarioStep,
    env: Env
  ): Promise<void> {
    if (!step.message) return;

    const content = step.message.content;

    if (content === 'BOOKING_SELECTOR') {
      await this.sendBookingSelector(tenant, endUser);
      return;
    }

    const processedContent = this.replaceTemplateVariables(content, endUser);

    if (step.message.type === 'flex') {
      try {
        const flexContent = JSON.parse(processedContent);
        await pushFlexMessage(tenant, endUser.line_user_id, flexContent, 'お知らせ');
      } catch {
        await pushMessage(tenant, endUser.line_user_id, processedContent);
      }
    } else {
      await pushMessage(tenant, endUser.line_user_id, processedContent);
    }

    const dummyContext: FlowContext = {
      tenant,
      endUser,
      currentStep: step,
      hearingData: endUser.hearing_data,
      conversationHistory: [],
      env,
    };
    await this.saveConversation(dummyContext, 'assistant', processedContent);

    if (step.next_step) {
      const nextStep = this.getStepById(tenant, step.next_step);
      if (!nextStep) return;

      await this.updateCurrentStep(endUser.id, step.next_step);

      if (nextStep.trigger === 'auto' && nextStep.delay_minutes === 0) {
        await this.executeStep(tenant, endUser, nextStep, env);
      } else if (nextStep.trigger === 'auto' && nextStep.delay_minutes > 0) {
        await this.scheduleAction({
          tenant_id: tenant.id,
          end_user_id: endUser.id,
          action_type: 'scenario_step',
          action_payload: { step_id: nextStep.id },
          execute_at: new Date(Date.now() + nextStep.delay_minutes * 60 * 1000).toISOString(),
        });
      }
    }
  }

  private async sendBookingSelector(tenant: Tenant, endUser: EndUser): Promise<void> {
    const slots = await getAvailableSlots(tenant.id, this.env);
    if (slots.length > 0) {
      const flexContent = buildBookingFlexMessage(slots);
      await pushFlexMessage(tenant, endUser.line_user_id, flexContent, '日程を選択してください');
    } else {
      await pushMessage(
        tenant,
        endUser.line_user_id,
        '現在予約可能な日程を準備中です。もう少しお待ちください😊'
      );
    }
  }

  async escalateToHuman(context: FlowContext, reason: string): Promise<void> {
    await pushMessage(
      context.tenant,
      context.endUser.line_user_id,
      '担当スタッフにおつなぎしますね。少々お待ちください😊'
    );
    await this.updateStatus(context.endUser.id, 'stalled');
    await notifyStaff(context.tenant, {
      type: 'human_handoff',
      endUser: context.endUser,
      reason,
    });
    await cancelPendingActions(context.endUser.id, this.env);
  }

  // --- Helper methods ---

  private getStepById(tenant: Tenant, stepId: string): ScenarioStep | undefined {
    return tenant.scenario_config?.steps?.find((s) => s.id === stepId);
  }

  private replaceTemplateVariables(content: string, endUser: EndUser): string {
    return content.replace(/{display_name}/g, endUser.display_name || 'ゲスト');
  }

  private async updateCurrentStep(endUserId: string, stepId: string): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({ current_step: stepId, updated_at: new Date().toISOString() })
      .eq('id', endUserId);
  }

  private async updateStatus(endUserId: string, status: string): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', endUserId);
  }

  private async updateLastResponseAt(endUserId: string): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({ last_response_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', endUserId);
  }

  private async updateHearingData(context: FlowContext, aiResponse: AIResponse): Promise<void> {
    const updatedData = { ...context.endUser.hearing_data, ...aiResponse.extracted_data };
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({
        hearing_data: updatedData,
        insight_summary: aiResponse.insight || context.endUser.insight_summary,
        updated_at: new Date().toISOString(),
      })
      .eq('id', context.endUser.id);
    context.endUser.hearing_data = updatedData;
  }

  async scheduleAction(action: {
    tenant_id: string;
    end_user_id: string;
    action_type: string;
    action_payload: Record<string, unknown>;
    execute_at: string;
  }): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase.from('scheduled_actions').insert({
      ...action,
      status: 'pending',
    });
  }

  private async saveConversation(
    context: FlowContext,
    role: 'user' | 'assistant' | 'system',
    content: string,
    aiMetadata?: AIResponse
  ): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase.from('conversations').insert({
      end_user_id: context.endUser.id,
      tenant_id: context.tenant.id,
      role,
      content,
      step_at_time: context.currentStep.id,
      ai_metadata: aiMetadata ? { extracted_data: aiMetadata.extracted_data, insight: aiMetadata.insight } : null,
    });
  }
}
