import { Hono } from 'hono';
import type { Env } from '../types';
import { verifySignature } from '../services/line';
import { getTenant } from '../config/tenant-config';
import { logger } from '../utils/logger';

const webhook = new Hono<{ Bindings: Env }>();

webhook.post('/webhook/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId');

  let tenant;
  try {
    tenant = await getTenant(tenantId, c.env);
  } catch {
    logger.error('Tenant not found for webhook', { tenantId });
    return c.text('Tenant not found', 404);
  }

  // 署名検証
  const body = await c.req.text();
  const signature = c.req.header('x-line-signature') || '';
  if (!verifySignature(body, signature, tenant.line_channel_secret)) {
    logger.warn('Invalid LINE signature', { tenantId });
    return c.text('Invalid signature', 401);
  }

  // 即200を返し、重い処理はQueueに投げる
  const events = JSON.parse(body).events;
  if (events && events.length > 0) {
    await c.env.MESSAGE_QUEUE.send({
      tenantId,
      events,
    });
  }

  return c.text('OK', 200);
});

export default webhook;
