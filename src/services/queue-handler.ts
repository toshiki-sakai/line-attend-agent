import type { Env, QueuePayload, Tenant, EndUser, FlowContext, ScenarioStep } from '../types';
import { getTenant } from '../config/tenant-config';
import { getSupabaseClient } from '../utils/supabase';
import { getProfile } from './line';
import { FlowEngine } from './flow-engine';
import { createBooking } from './booking';
import { sendTextMessage } from './line';
import { logger } from '../utils/logger';

export async function handleQueueMessage(
  batch: MessageBatch<QueuePayload>,
  env: Env
): Promise<void> {
  const flowEngine = new FlowEngine(env);

  for (const message of batch.messages) {
    const { tenantId, events } = message.body;

    let tenant: Tenant;
    try {
      tenant = await getTenant(tenantId, env);
    } catch (error) {
      logger.error('Failed to get tenant', { tenantId, error: String(error) });
      message.ack();
      continue;
    }

    for (const event of events) {
      try {
        switch (event.type) {
          case 'follow':
            await handleFollow(tenant, event, env, flowEngine);
            break;
          case 'message':
            await handleMessage(tenant, event, env, flowEngine);
            break;
          case 'postback':
            await handlePostback(tenant, event, env);
            break;
          default:
            logger.info('Unhandled event type', { type: event.type });
        }
      } catch (error) {
        logger.error('Event processing failed', {
          eventType: event.type,
          error: String(error),
        });
        message.retry();
        return;
      }
    }

    message.ack();
  }
}

async function handleFollow(
  tenant: Tenant,
  event: { source: { userId: string } },
  env: Env,
  flowEngine: FlowEngine
): Promise<void> {
  const supabase = getSupabaseClient(env);
  const lineUserId = event.source.userId;

  // プロフィール取得
  const profile = await getProfile(tenant, lineUserId);
  const displayName = profile?.displayName || null;

  // ユーザー登録（既存ならスキップ）
  const { data: existingUser } = await supabase
    .from('end_users')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('line_user_id', lineUserId)
    .single();

  let endUser: EndUser;

  if (existingUser) {
    // 既存ユーザー: ステップをリセット
    const { data } = await supabase
      .from('end_users')
      .update({
        current_step: 'registered',
        status: 'active',
        display_name: displayName,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingUser.id)
      .select()
      .single();
    endUser = data as EndUser;
  } else {
    // 新規ユーザー
    const { data, error } = await supabase
      .from('end_users')
      .insert({
        tenant_id: tenant.id,
        line_user_id: lineUserId,
        display_name: displayName,
        current_step: 'registered',
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create end user', { error: error.message });
      throw error;
    }
    endUser = data as EndUser;
  }

  logger.info('User followed', { tenantId: tenant.id, lineUserId, displayName });

  // welcomeステップを実行
  const steps = tenant.scenario_config?.steps || [];
  const welcomeStep = steps.find((s) => s.trigger === 'follow');

  if (welcomeStep) {
    await flowEngine.executeStep(tenant, endUser, welcomeStep);
  }
}

async function handleMessage(
  tenant: Tenant,
  event: {
    source: { userId: string };
    message?: { type: string; text?: string };
  },
  env: Env,
  flowEngine: FlowEngine
): Promise<void> {
  if (!event.message || event.message.type !== 'text' || !event.message.text) {
    return;
  }

  const supabase = getSupabaseClient(env);
  const lineUserId = event.source.userId;

  // ユーザー取得
  const { data: endUser } = await supabase
    .from('end_users')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('line_user_id', lineUserId)
    .single();

  if (!endUser) {
    logger.warn('Message from unknown user', { lineUserId });
    return;
  }

  // 現在のステップ取得
  const steps = tenant.scenario_config?.steps || [];
  const currentStep = steps.find((s) => s.id === endUser.current_step);

  if (!currentStep) {
    // ステップが見つからない場合のフォールバック
    logger.warn('Current step not found', { step: endUser.current_step });
    // デフォルトでAI応答
    const fallbackStep: ScenarioStep = {
      id: endUser.current_step,
      type: 'ai',
      trigger: 'auto',
      delay_minutes: 0,
      ai_config: { purpose: 'hearing', max_turns: 6, completion_condition: 'all_items_collected' },
      next_step: '',
    };

    const context: FlowContext = {
      tenant,
      endUser: endUser as EndUser,
      currentStep: fallbackStep,
      hearingData: endUser.hearing_data || {},
    };

    await flowEngine.handleUserMessage(context, event.message.text);
    return;
  }

  const context: FlowContext = {
    tenant,
    endUser: endUser as EndUser,
    currentStep,
    hearingData: endUser.hearing_data || {},
  };

  await flowEngine.handleUserMessage(context, event.message.text);
}

async function handlePostback(
  tenant: Tenant,
  event: {
    source: { userId: string };
    postback?: { data: string };
  },
  env: Env
): Promise<void> {
  if (!event.postback) return;

  const postbackData = event.postback.data;
  const supabase = getSupabaseClient(env);
  const lineUserId = event.source.userId;

  // 予約処理
  if (postbackData.startsWith('book:')) {
    const slotId = postbackData.replace('book:', '');

    const { data: endUser } = await supabase
      .from('end_users')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('line_user_id', lineUserId)
      .single();

    if (!endUser) return;

    const result = await createBooking(tenant.id, endUser.id, slotId, env);

    if (result.success && result.booking) {
      const booking = result.booking;
      const scheduledAt = new Date(booking.scheduled_at as string);
      const dateStr = `${scheduledAt.getMonth() + 1}月${scheduledAt.getDate()}日`;
      const timeStr = `${scheduledAt.getHours().toString().padStart(2, '0')}:${scheduledAt.getMinutes().toString().padStart(2, '0')}`;

      const message = `ご予約ありがとうございます🎉\n${dateStr}の${timeStr}からZoomでお待ちしています！\n\nZoomリンク: ${booking.zoom_url || '（後ほどご案内します）'}`;
      await sendTextMessage(tenant, lineUserId, message);

      // 会話ログ保存
      await supabase.from('conversations').insert({
        end_user_id: endUser.id,
        tenant_id: tenant.id,
        role: 'assistant',
        content: message,
        step_at_time: 'booked',
      });
    } else {
      await sendTextMessage(
        tenant,
        lineUserId,
        result.error || '予約処理中にエラーが発生しました。もう一度お試しください。'
      );
    }
  }
}
