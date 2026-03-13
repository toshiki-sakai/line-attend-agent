import type { Tenant, StaffNotification } from '../types';
import { pushMessage } from './line';
import { logger } from '../utils/logger';

export async function notifyStaff(tenant: Tenant, notification: StaffNotification): Promise<void> {
  const config = tenant.notification_config;
  if (!config?.staff_line_user_ids?.length) {
    logger.warn('No staff notification config', { tenantId: tenant.id });
    return;
  }

  if (!config.notify_on.includes(notification.type)) {
    return;
  }

  const message = buildNotificationMessage(tenant, notification);

  const results = await Promise.allSettled(
    config.staff_line_user_ids.map((staffUserId) => pushMessage(tenant, staffUserId, message))
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      logger.error('Failed to notify staff', {
        staffUserId: config.staff_line_user_ids[i],
        error: String((results[i] as PromiseRejectedResult).reason),
      });
    }
  }
}

function buildNotificationMessage(tenant: Tenant, notification: StaffNotification): string {
  const userLabel = notification.endUser.display_name || notification.endUser.line_user_id;
  const hearingData = notification.endUser.hearing_data || {};
  const hearingSummary = Object.entries(hearingData)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  switch (notification.type) {
    case 'human_handoff':
      return [
        `【対応依頼】${userLabel}さん`,
        `理由: ${notification.reason}`,
        `ステップ: ${notification.endUser.current_step}`,
        hearingSummary ? `\nヒアリング情報:\n${hearingSummary}` : '',
        notification.endUser.insight_summary ? `\nインサイト: ${notification.endUser.insight_summary}` : '',
      ].filter(Boolean).join('\n');

    case 'no_show':
      return [
        `【ノーショー】${userLabel}さんが相談会に参加しませんでした。`,
        `自動で再予約案内を送信済みです。`,
        hearingSummary ? `\nヒアリング情報:\n${hearingSummary}` : '',
        `\n手動フォローが必要な場合は管理画面からご確認ください。`,
      ].filter(Boolean).join('\n');

    case 'stalled':
      return [
        `【追客上限】${userLabel}さんへの自動追客が上限に達しました。`,
        `追客回数: ${notification.endUser.follow_up_count}回`,
        hearingSummary ? `\nヒアリング情報:\n${hearingSummary}` : '',
        `\n手動でのフォローをお願いします。`,
      ].filter(Boolean).join('\n');

    case 'error':
      return `【エラー】${userLabel}さんへの処理でエラーが発生しました。\n詳細: ${notification.reason}\n\n管理画面のシステム状態をご確認ください。`;

    default:
      return `【通知】${userLabel}さんに関する通知です。\n${notification.reason}`;
  }
}
