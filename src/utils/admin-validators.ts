import { z } from 'zod';

const jsonObject = z.record(z.string(), z.unknown());

export const createTenantSchema = z.object({
  name: z.string().min(1).max(100),
  line_channel_id: z.string().min(1),
  line_channel_secret: z.string().min(1),
  line_channel_access_token: z.string().min(1),
  school_context: z.string().optional().default(''),
  scenario_config: jsonObject.optional().default({}),
  hearing_config: jsonObject.optional().default({}),
  reminder_config: jsonObject.optional().default({}),
  tone_config: jsonObject.optional().default({}),
  guardrail_config: jsonObject.optional().default({}),
  notification_config: jsonObject.optional().default({}),
});

export const updateTenantSchema = createTenantSchema.partial();

export const createSlotSchema = z.object({
  start_at: z.string().min(1),
  end_at: z.string().min(1),
  max_bookings: z.number().int().min(1).optional().default(1),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
