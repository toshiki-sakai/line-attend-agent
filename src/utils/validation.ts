import { z } from 'zod';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuidSchema = z.string().regex(UUID_REGEX, 'Invalid UUID format');

export const lineWebhookEventSchema = z.object({
  type: z.enum(['follow', 'unfollow', 'message', 'postback']),
  timestamp: z.number(),
  source: z.object({
    userId: z.string().min(1),
    type: z.string(),
  }),
  replyToken: z.string().optional(),
  message: z.object({
    type: z.string(),
    text: z.string().optional(),
    id: z.string(),
  }).optional(),
  postback: z.object({
    data: z.string(),
  }).optional(),
});

export const lineWebhookBodySchema = z.object({
  events: z.array(lineWebhookEventSchema).default([]),
});

export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}
