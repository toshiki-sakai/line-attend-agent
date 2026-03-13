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

  for (const staffUserId of config.staff_line_user_ids) {
    try {
      await pushMessage(tenant, staffUserId, message);
    } catch (error) {
      logger.error('Failed to notify staff', {
        staffUserId,
        error: String(error),
      });
    }
  }
}

function buildNotificationMessage(tenant: Tenant, notification: StaffNotification): string {
  const userLabel = notification.endUser.display_name || notification.endUser.line_user_id;

  switch (notification.type) {
    case 'human_handoff':
      return `【対応依頼】${userLabel}さんへの対応が必要です。\n理由: ${notification.reason}\nステップ: ${notification.endUser.current_step}`;
    case 'no_show':
      return `【ノーショー】${userLabel}さんが相談会に参加しませんでした。\nフォローをお願いします。`;
    case 'stalled':
      return `【追客上限】${userLabel}さんへの自動追客が上限に達しました。\n手動でのフォローをお願いします。`;
    case 'error':
      return `【エラー】${userLabel}さんへの処理でエラーが発生しました。\n詳細: ${notification.reason}`;
    default:
      return `【通知】${userLabel}さんに関する通知です。\n${notification.reason}`;
  }
}
