import type { Env, Tenant, AvailableSlot } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { logger } from '../utils/logger';

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
    .limit(10);

  if (error) {
    logger.error('Failed to get available slots', { tenantId, error: error.message });
    return [];
  }

  // 満席の枠を除外
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

  // スロット取得
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

  // テナント情報を取得してZoom URL取得
  const { data: tenant } = await supabase
    .from('tenants')
    .select('scenario_config')
    .eq('id', tenantId)
    .single();

  const bookingConfig = (tenant?.scenario_config as Record<string, unknown>)?.booking as Record<string, string> | undefined;
  const zoomUrl = bookingConfig?.zoom_base_url || '';

  // 予約作成
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

  // スロットのcurrent_bookingsをインクリメント
  await supabase
    .from('available_slots')
    .update({ current_bookings: slot.current_bookings + 1 })
    .eq('id', slotId);

  // ユーザーステータス更新
  await supabase
    .from('end_users')
    .update({ status: 'booked', current_step: 'booked', updated_at: new Date().toISOString() })
    .eq('id', endUserId);

  return { success: true, booking };
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const weekday = weekdays[d.getDay()];
  return `${month}月${day}日（${weekday}）`;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function buildBookingFlexMessage(slots: AvailableSlot[]): unknown {
  return {
    type: 'flex',
    altText: '日程を選択してください',
    contents: {
      type: 'carousel',
      contents: slots.map((slot) => ({
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: formatDate(slot.start_at), weight: 'bold', size: 'lg' },
            {
              type: 'text',
              text: `${formatTime(slot.start_at)} 〜 ${formatTime(slot.end_at)}`,
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
    },
  };
}
