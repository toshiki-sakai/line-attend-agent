import type { Env, Tenant, EndUser, FlowContext, ScenarioStep } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { sendTextMessage, sendPushMessage } from './line';
import {
  generateHearingResponse,
  generateFollowUpResponse,
  generatePostConsultationResponse,
  handleUnexpectedInput,
} from './ai';
import { validateMessage } from '../guards/ai-guardrails';
import { getAvailableSlots, buildBookingFlexMessage } from './booking';
import { logger } from '../utils/logger';

export class FlowEngine {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async handleUserMessage(context: FlowContext, userMessage: string): Promise<void> {
    const step = context.currentStep;

    // 会話ログ保存（ユーザーメッセージ）
    await this.saveConversation(context, 'user', userMessage);

    // last_response_at更新
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({
        last_response_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', context.endUser.id);

    if (step.type === 'ai') {
      await this.handleAIStep(context, userMessage);
    } else {
      // テンプレートステップでの想定外入力
      const response = await handleUnexpectedInput(context, userMessage, this.env);
      const guardrailResult = validateMessage(response, context.tenant);

      if (guardrailResult.passed) {
        await sendTextMessage(context.tenant, context.endUser.line_user_id, response);
        await this.saveConversation(context, 'assistant', response);
      } else {
        const fallback = 'ご質問ありがとうございます！詳しくは相談会でお話しさせていただきますね😊';
        await sendTextMessage(context.tenant, context.endUser.line_user_id, fallback);
        await this.saveConversation(context, 'assistant', fallback);
        logger.warn('Guardrail violation on unexpected input', {
          violations: guardrailResult.violations,
        });
      }
    }
  }

  private async handleAIStep(context: FlowContext, userMessage: string): Promise<void> {
    const step = context.currentStep;
    const purpose = step.ai_config?.purpose;

    if (purpose === 'hearing') {
      const hearingResponse = await generateHearingResponse(context, userMessage, this.env);

      // ガードレールチェック
      const guardrailResult = validateMessage(hearingResponse.reply_message, context.tenant);
      let messageToSend = hearingResponse.reply_message;

      if (!guardrailResult.passed) {
        messageToSend = 'もう少し詳しく教えていただけますか？😊';
        logger.warn('Guardrail violation in hearing response', {
          violations: guardrailResult.violations,
        });
      }

      await sendTextMessage(context.tenant, context.endUser.line_user_id, messageToSend);
      await this.saveConversation(context, 'assistant', messageToSend);

      // ヒアリングデータ更新
      if (Object.keys(hearingResponse.extracted_data).length > 0) {
        const updatedHearingData = {
          ...context.endUser.hearing_data,
          ...hearingResponse.extracted_data,
        };
        const supabase = getSupabaseClient(this.env);
        await supabase
          .from('end_users')
          .update({
            hearing_data: updatedHearingData,
            insight_summary: hearingResponse.insight || context.endUser.insight_summary,
            updated_at: new Date().toISOString(),
          })
          .eq('id', context.endUser.id);

        context.endUser.hearing_data = updatedHearingData;
      }

      // ヒアリング完了判定
      if (hearingResponse.is_hearing_complete) {
        await this.advanceStep(context);
      }
    } else {
      // follow_up / post_consultation 等
      const response = await handleUnexpectedInput(context, userMessage, this.env);
      const guardrailResult = validateMessage(response, context.tenant);

      if (guardrailResult.passed) {
        await sendTextMessage(context.tenant, context.endUser.line_user_id, response);
        await this.saveConversation(context, 'assistant', response);
      } else {
        const fallback = 'ご質問ありがとうございます！詳しくは相談会でお話しさせていただきますね😊';
        await sendTextMessage(context.tenant, context.endUser.line_user_id, fallback);
        await this.saveConversation(context, 'assistant', fallback);
      }
    }
  }

  async advanceStep(context: FlowContext): Promise<void> {
    const nextStepId = context.currentStep.next_step;
    if (!nextStepId) return;

    const steps = context.tenant.scenario_config?.steps || [];
    const nextStep = steps.find((s) => s.id === nextStepId);
    if (!nextStep) {
      logger.warn('Next step not found', { nextStepId });
      return;
    }

    // DBのcurrent_stepを更新
    const supabase = getSupabaseClient(this.env);
    await supabase
      .from('end_users')
      .update({ current_step: nextStepId, updated_at: new Date().toISOString() })
      .eq('id', context.endUser.id);

    // 次のステップがautoトリガーでdelay_minutes=0なら即実行
    if (nextStep.trigger === 'auto' && nextStep.delay_minutes === 0) {
      await this.executeStep(context.tenant, context.endUser, nextStep);
    } else if (nextStep.trigger === 'auto' && nextStep.delay_minutes > 0) {
      // delay_minutes > 0 の場合はスケジュール登録
      const scheduledAt = new Date(Date.now() + nextStep.delay_minutes * 60 * 1000);
      await supabase.from('end_users').update({
        last_message_at: scheduledAt.toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', context.endUser.id);
    }
  }

  async executeStep(tenant: Tenant, endUser: EndUser, step: ScenarioStep): Promise<void> {
    if (step.type === 'template') {
      await this.executeTemplateStep(tenant, endUser, step);
    } else if (step.type === 'ai') {
      // AIステップの開始メッセージ（最初のターン）
      const context: FlowContext = {
        tenant,
        endUser,
        currentStep: step,
        hearingData: endUser.hearing_data,
      };

      if (step.ai_config?.purpose === 'hearing') {
        const hearingResponse = await generateHearingResponse(
          context,
          '（システム: ヒアリングを開始してください）',
          this.env
        );
        const guardrailResult = validateMessage(hearingResponse.reply_message, tenant);
        const message = guardrailResult.passed
          ? hearingResponse.reply_message
          : 'こんにちは！少しお話を聞かせていただけますか？😊';

        await sendTextMessage(tenant, endUser.line_user_id, message);
        await this.saveConversation(context, 'assistant', message);
      }
    }
  }

  private async executeTemplateStep(
    tenant: Tenant,
    endUser: EndUser,
    step: ScenarioStep
  ): Promise<void> {
    if (!step.message) return;

    const content = step.message.content;

    // 特殊キーワード処理
    if (content === 'BOOKING_SELECTOR') {
      const slots = await getAvailableSlots(tenant.id, this.env);
      if (slots.length > 0) {
        const flexMessage = buildBookingFlexMessage(slots);
        await sendPushMessage(tenant, endUser.line_user_id, [flexMessage]);
      } else {
        await sendTextMessage(
          tenant,
          endUser.line_user_id,
          '現在予約可能な日程を準備中です。もう少しお待ちください😊'
        );
      }
      return;
    }

    // テンプレート変数の置換
    const processedContent = this.replaceTemplateVariables(content, endUser);

    if (step.message.type === 'text') {
      await sendTextMessage(tenant, endUser.line_user_id, processedContent);
    } else if (step.message.type === 'flex') {
      try {
        const flexContent = JSON.parse(processedContent);
        await sendPushMessage(tenant, endUser.line_user_id, [
          { type: 'flex', altText: 'お知らせ', contents: flexContent },
        ]);
      } catch {
        // Flex Messageのパースに失敗した場合はテキストで送信
        await sendTextMessage(tenant, endUser.line_user_id, processedContent);
      }
    }

    // 会話ログ保存
    const context: FlowContext = {
      tenant,
      endUser,
      currentStep: step,
      hearingData: endUser.hearing_data,
    };
    await this.saveConversation(context, 'assistant', processedContent);

    // 次のステップに自動進行
    if (step.next_step) {
      const nextStep = tenant.scenario_config?.steps?.find((s) => s.id === step.next_step);
      if (nextStep && nextStep.trigger === 'auto' && nextStep.delay_minutes === 0) {
        const supabase = getSupabaseClient(this.env);
        await supabase
          .from('end_users')
          .update({ current_step: step.next_step, updated_at: new Date().toISOString() })
          .eq('id', endUser.id);
        await this.executeStep(tenant, endUser, nextStep);
      } else if (nextStep) {
        const supabase = getSupabaseClient(this.env);
        await supabase
          .from('end_users')
          .update({ current_step: step.next_step, updated_at: new Date().toISOString() })
          .eq('id', endUser.id);
      }
    }
  }

  private replaceTemplateVariables(content: string, endUser: EndUser): string {
    let result = content;
    result = result.replace(/{display_name}/g, endUser.display_name || 'ゲスト');
    return result;
  }

  private async saveConversation(
    context: FlowContext,
    role: 'user' | 'assistant' | 'system',
    content: string
  ): Promise<void> {
    const supabase = getSupabaseClient(this.env);
    await supabase.from('conversations').insert({
      end_user_id: context.endUser.id,
      tenant_id: context.tenant.id,
      role,
      content,
      step_at_time: context.currentStep.id,
    });
  }
}
