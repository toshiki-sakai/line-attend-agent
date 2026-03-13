import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Tenant } from '../types';
import { logger } from '../utils/logger';

const LINE_API_BASE = 'https://api.line.me/v2/bot';
const LINE_API_TIMEOUT_MS = 10000;

export function verifySignature(body: string, signature: string, channelSecret: string | null): boolean {
  if (!channelSecret) return false;
  const hmac = createHmac('SHA256', channelSecret);
  hmac.update(body);
  const expected = hmac.digest();
  const actual = Buffer.from(signature, 'base64');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function pushMessage(
  tenant: Tenant,
  userId: string,
  text: string
): Promise<void> {
  if (!tenant.line_channel_access_token) {
    logger.warn('Cannot push message: no LINE access token configured (API-only tenant)', { tenantId: tenant.id });
    return;
  }
  await pushMessages(tenant, userId, [{ type: 'text', text }]);
}

export async function pushFlexMessage(
  tenant: Tenant,
  userId: string,
  flex: unknown,
  altText: string
): Promise<void> {
  if (!tenant.line_channel_access_token) {
    logger.warn('Cannot push flex message: no LINE access token configured (API-only tenant)', { tenantId: tenant.id });
    return;
  }
  await pushMessages(tenant, userId, [{ type: 'flex', altText, contents: flex }]);
}

async function pushMessages(
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
    signal: AbortSignal.timeout(LINE_API_TIMEOUT_MS),
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

export async function getProfile(
  tenant: Tenant,
  userId: string
): Promise<{ displayName: string; userId: string } | null> {
  if (!tenant.line_channel_access_token) return null;

  try {
    const response = await fetch(`${LINE_API_BASE}/profile/${userId}`, {
      headers: {
        Authorization: `Bearer ${tenant.line_channel_access_token}`,
      },
      signal: AbortSignal.timeout(LINE_API_TIMEOUT_MS),
    });

    if (!response.ok) return null;
    return (await response.json()) as { displayName: string; userId: string };
  } catch {
    return null;
  }
}
