import type { Env, Tenant, EndUser, Booking, FlowContext, ScenarioStep, AIResponse } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { pushMessage, pushFlexMessage } from './line';
import { generateHearingResponse, handleUnexpectedInput, getConversationHistory } from './ai';
import { validateMessage, validateWithRetry } from '../guards/ai-guardrails';
import { getAvailableSlots, buildBookingFlexMessage } from './booking';
import { notifyStaff } from './notification';
import { cancelPendingActions } from '../utils/scheduled-actions';
import { logger } from '../utils/logger';
import { detectIntent } from './intent-detector';

const NON_TEXT_REPLY = 'ありがとうございます！テキストでお返事いただけると嬉しいです😊';

export class FlowEngine {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async handleUserMessage(context: FlowContext, userMessage: string, messageType: string): Promise<void> {
    if (context.endUser.is_blocked) return;

    // Staff takeover mode: skip all AI processing
    if (context.endUser.is_staff_takeover) return;

    // 非テキストメッセージ対応
    if (messageType !== 'text') {
      if (context.currentStep.type === 'ai') {
        await pushMessage(context.tenant, context.endUser.line_user_id, NON_TEXT_REPLY);
      }
      return;
    }

    await this.saveConversation(context, 'user', userMessage);
    await this.updateLastResponseAt(context.endUser.id);

    // Detect user intent before AI processing
    const intent = detectIntent(userMessage);

    // Immediate escalation for human_request intent
    if (intent === 'human_request') {
      await this.escalateToHuman(context, 'ユーザーが人間対応を要求');
      return;
    }

    if (context.currentStep.type === 'ai') {
      await this.handleAIStep(context, userMessage, intent);
    } else {
      await this.handleTemplateStepInput(context, userMessage, intent);
    }
  }

  private async handleAIStep(context: FlowContext, userMessage: string, intent?: string): Promise<void> {
    const purpose = context.currentStep.ai_config?.purpose;

    if (purpose === 'hearing') {
      const aiResponse = await generateHearingResponse(context, userMessage);
      if (intent) aiResponse.detected_intent = intent as AIResponse['detected_intent'];
      await this.processAIResponse(context, aiResponse);

      if (aiResponse.extracted_data && Object.keys(aiResponse.extracted_data).length > 0) {
        await this.updateHearingData(context, aiResponse);
      }

      if (aiResponse.is_hearing_complete) {
        if (aiResponse.insight) {
          await this.updateInsightSummary(context.endUser.id, aiResponse.insight);
        }
        await this.advanceStep(context);
      }
    } else if (purpose === 'follow_up') {
      const supabase = getSupabaseClient(this.env);
      await cancelPendingActions(context.endUser.id, this.env, { action_type: 'follow_up' });

      await supabase
        .from('end_users')
        .update({ follow_up_count: 0, last_response_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', context.endUser.id);

      const aiResponse = await handleUnexpectedInput(context, userMessage, intent);
      await this.processAIResponse(context, aiResponse);

      // Schedule defer follow-up if user said "later"
      if (intent === 'defer') {
        await this.scheduleDeferFollowUp(context);
      }
    } else {
      const aiResponse = await handleUnexpectedInput(context, userMessage, intent);
      await this.processAIResponse(context, aiResponse);

      if (intent === 'defer') {
        await this.scheduleDeferFollowUp(context);
      }
    }
  }

  private async handleTemplateStepInput(context: FlowContext, userMessage: string, intent?: string): Promise<void> {
    const aiResponse = await handleUnexpectedInput(context, userMessage, intent);
    await this.processAIResponse(context, aiResponse);

    if (intent === 'defer') {
      await this.scheduleDeferFollowUp(context);
    }
  }

  private async scheduleDeferFollowUp(context: FlowContext): Promise<void> {
    // Schedule a gentle follow-up in 1-2 weeks for users who said "later"
    const delayHours = 168; // 1 week
    await this.scheduleAction({
      tenant_id: context.tenant.id,
      end_user_id: context.endUser.id,
      action_type: 'follow_up',
      action_payload: { trigger: 'defer_intent' },
      execute_at: new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString(),
    });
  }

  /**
   * Schedule the full pre-consultation nurture sequence after a booking is confirmed.
   * This is THE key to near-100% attendance: don't just remind, BUILD DESIRE over time.
   *
   * Timeline:
   * - value_preview: 2 days after booking (reconnect hearing data → consultation value)
   * - preparation: 2 days before consultation (create psychological investment)
   * - excitement: evening before (future pacing, anticipation)
   * - day_of: morning of consultation (logistics + warmth)
   * - final_countdown: 1 hour before (Zoom link, "see you soon")
   */
  async scheduleNurtureSequence(tenant: Tenant, endUser: EndUser, booking: Booking): Promise<void> {
    const consultationTime = new Date(booking.scheduled_at).getTime();
    const now = Date.now();
    const hoursUntil = (consultationTime - now) / (1000 * 60 * 60);

    // Cancel any existing nurture actions for this user
    await cancelPendingActions(endUser.id, this.env, { action_type: 'nurture' });

    const stages: Array<{
      stage: string;
      executeAt: number; // timestamp
    }> = [];

    // Value preview: 48h after booking (but only if consultation is 4+ days away)
    if (hoursUntil > 96) {
      stages.push({ stage: 'value_preview', executeAt: now + 48 * 60 * 60 * 1000 });
    }

    // Preparation: 48h before consultation
    if (hoursUntil > 54) {
      stages.push({ stage: 'preparation', executeAt: consultationTime - 48 * 60 * 60 * 1000 });
    }

    // Excitement: evening before (18:00 JST the day before)
    if (hoursUntil > 30) {
      const dayBefore = new Date(consultationTime - 24 * 60 * 60 * 1000);
      dayBefore.setUTCHours(9, 0, 0, 0); // 18:00 JST = 09:00 UTC
      if (dayBefore.getTime() > now) {
        stages.push({ stage: 'excitement', executeAt: dayBefore.getTime() });
      }
    }

    // Day of: morning (08:00 JST)
    if (hoursUntil > 6) {
      const dayOf = new Date(booking.scheduled_at);
      dayOf.setUTCHours(23, 0, 0, 0); // 08:00 JST = 23:00 UTC previous day
      if (dayOf.getTime() < consultationTime && dayOf.getTime() > now) {
        stages.push({ stage: 'day_of', executeAt: dayOf.getTime() });
      }
    }

    // Final countdown: 1 hour before
    if (hoursUntil > 1.5) {
      stages.push({ stage: 'final_countdown', executeAt: consultationTime - 60 * 60 * 1000 });
    }

    for (const { stage, executeAt } of stages) {
      await this.scheduleAction({
        tenant_id: tenant.id,
        end_user_id: endUser.id,
        action_type: 'nurture',
        action_payload: {
          stage,
          booking_id: booking.id,
          zoom_url: booking.zoom_url || undefined,
        },
        execute_at: new Date(executeAt).toISOString(),
      });
    }

    logger.info('Nurture sequence scheduled', {
      userId: endUser.id,
      bookingId: booking.id,
      stages: stages.map(s => s.stage),
      hoursUntilConsultation: Math.round(hoursUntil),
    });
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
    await this.updateLastMessageAt(context.endUser.id);
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
    await this.updateLastMessageAt(endUser.id);

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
