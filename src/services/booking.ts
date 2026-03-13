import type { Env, AvailableSlot } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { formatDateJST, formatTimeJST } from '../utils/datetime';
import { logger } from '../utils/logger';

const MAX_SLOT_RESULTS = 10;

export async function getAvailableSlots(tenantId: string, env: Env): Promise<AvailableSlot[]> {
  const supabase = getSupabaseClient(env);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('available_slots')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .gt('start_at', now)
    .order('start_at', { ascending: true })
    .limit(MAX_SLOT_RESULTS);

  if (error) {
    logger.error('Failed to get available slots', { tenantId, error: error.message });
    return [];
  }

  return (data || []).filter(
    (slot: AvailableSlot) => slot.current_bookings < slot.max_bookings
  );
}

export async function createBooking(
  tenantId: string,
  endUserId: string,
  slotId: string,
  env: Env
): Promise<{ success: boolean; booking?: Record<string, unknown>; error?: string }> {
  const supabase = getSupabaseClient(env);

  const { data: slot, error: slotError } = await supabase
    .from('available_slots')
    .select('*')
    .eq('id', slotId)
    .eq('tenant_id', tenantId)
    .single();

  if (slotError || !slot) {
    return { success: false, error: 'スロットが見つかりません' };
  }

  if (slot.current_bookings >= slot.max_bookings) {
    return { success: false, error: 'この枠は満席です' };
  }

  // 楽観的ロック: version で同時予約の競合防止
  const { data: updatedSlot, error: lockError } = await supabase
    .from('available_slots')
    .update({
      current_bookings: slot.current_bookings + 1,
      version: slot.version + 1,
    })
    .eq('id', slotId)
    .eq('version', slot.version)
    .select()
    .single();

  if (lockError || !updatedSlot) {
    return { success: false, error: 'ご指定の枠は他の方に先に予約されました。別の日程をお選びください。' };
  }

  const { data: tenant } = await supabase
    .from('tenants')
    .select('scenario_config')
    .eq('id', tenantId)
    .single();

  const bookingConfig = (tenant?.scenario_config as Record<string, unknown>)?.booking as Record<string, string> | undefined;
  const zoomUrl = bookingConfig?.zoom_base_url || '';

  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .insert({
      end_user_id: endUserId,
      tenant_id: tenantId,
      scheduled_at: slot.start_at,
      zoom_url: zoomUrl,
      status: 'confirmed',
    })
    .select()
    .single();

  if (bookingError) {
    logger.error('Failed to create booking', { error: bookingError.message });
    return { success: false, error: '予約の作成に失敗しました' };
  }

  await supabase
    .from('end_users')
    .update({ status: 'booked', current_step: 'booked', updated_at: new Date().toISOString() })
    .eq('id', endUserId);

  return { success: true, booking };
}

export function buildBookingFlexMessage(slots: AvailableSlot[]): unknown {
  return {
    type: 'carousel',
    contents: slots.map((slot) => ({
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: formatDateJST(slot.start_at), weight: 'bold', size: 'lg' },
          {
            type: 'text',
            text: `${formatTimeJST(slot.start_at)} 〜 ${formatTimeJST(slot.end_at)}`,
            size: 'md',
            color: '#666666',
          },
          {
            type: 'text',
            text: `残り${slot.max_bookings - slot.current_bookings}枠`,
            size: 'sm',
            color: '#FF6B6B',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'postback',
              label: 'この日程で予約する',
              data: `book:${slot.id}`,
            },
            style: 'primary',
            color: '#4CAF50',
          },
        ],
      },
    })),
  };
}
