import { createHmac } from 'node:crypto';
import type { Tenant } from '../types';
import { logger } from '../utils/logger';

const LINE_API_BASE = 'https://api.line.me/v2/bot';

export function verifySignature(body: string, signature: string, channelSecret: string): boolean {
  const hmac = createHmac('SHA256', channelSecret);
  hmac.update(body);
  const digest = hmac.digest('base64');
  return digest === signature;
}

export async function sendTextMessage(
  tenant: Tenant,
  userId: string,
  text: string
): Promise<void> {
  await sendPushMessage(tenant, userId, [{ type: 'text', text }]);
}

export async function sendPushMessage(
  tenant: Tenant,
  userId: string,
  messages: unknown[]
): Promise<void> {
  const response = await fetch(`${LINE_API_BASE}/message/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tenant.line_channel_access_token}`,
    },
    body: JSON.stringify({ to: userId, messages }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error('LINE push message failed', {
      status: response.status,
      body: errorBody,
      userId,
    });
    throw new Error(`LINE API error: ${response.status} ${errorBody}`);
  }
}

export async function sendReplyMessage(
  tenant: Tenant,
  replyToken: string,
  messages: unknown[]
): Promise<void> {
  const response = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tenant.line_channel_access_token}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error('LINE reply message failed', {
      status: response.status,
      body: errorBody,
    });
    throw new Error(`LINE API error: ${response.status} ${errorBody}`);
  }
}

export async function getProfile(
  tenant: Tenant,
  userId: string
): Promise<{ displayName: string; userId: string } | null> {
  try {
    const response = await fetch(`${LINE_API_BASE}/profile/${userId}`, {
      headers: {
        Authorization: `Bearer ${tenant.line_channel_access_token}`,
      },
    });

    if (!response.ok) return null;
    return (await response.json()) as { displayName: string; userId: string };
  } catch {
    return null;
  }
}

export function buildFlexMessage(altText: string, contents: unknown): unknown {
  return {
    type: 'flex',
    altText,
    contents,
  };
}
