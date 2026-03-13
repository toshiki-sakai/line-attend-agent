import { describe, it, expect } from 'vitest';
import { buildBookingFlexMessage } from '../services/booking';
import type { AvailableSlot } from '../types';

function makeSlot(overrides: Partial<AvailableSlot> = {}): AvailableSlot {
  return {
    id: 'slot-1',
    tenant_id: 'tenant-1',
    start_at: '2026-03-15T01:00:00Z', // 10:00 JST
    end_at: '2026-03-15T02:00:00Z',   // 11:00 JST
    max_bookings: 3,
    current_bookings: 1,
    version: 1,
    is_active: true,
    created_at: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildBookingFlexMessage', () => {
  it('should create carousel with correct structure', () => {
    const slots = [makeSlot()];
    const result = buildBookingFlexMessage(slots) as Record<string, unknown>;

    expect(result.type).toBe('carousel');
    expect(Array.isArray(result.contents)).toBe(true);
    expect((result.contents as unknown[]).length).toBe(1);
  });

  it('should include remaining slots count', () => {
    const slots = [makeSlot({ max_bookings: 5, current_bookings: 2 })];
    const result = buildBookingFlexMessage(slots) as { contents: Array<{ body: { contents: Array<{ text: string }> } }> };

    const remainingText = result.contents[0].body.contents[2].text;
    expect(remainingText).toBe('残り3枠');
  });

  it('should include postback data with slot id', () => {
    const slots = [makeSlot({ id: 'my-slot-id' })];
    const result = buildBookingFlexMessage(slots) as { contents: Array<{ footer: { contents: Array<{ action: { data: string } }> } }> };

    const postbackData = result.contents[0].footer.contents[0].action.data;
    expect(postbackData).toBe('book:my-slot-id');
  });

  it('should handle multiple slots', () => {
    const slots = [
      makeSlot({ id: 'slot-1' }),
      makeSlot({ id: 'slot-2', start_at: '2026-03-16T01:00:00Z', end_at: '2026-03-16T02:00:00Z' }),
    ];
    const result = buildBookingFlexMessage(slots) as { contents: unknown[] };
    expect(result.contents.length).toBe(2);
  });

  it('should handle empty slots array', () => {
    const result = buildBookingFlexMessage([]) as Record<string, unknown>;
    expect(result.type).toBe('carousel');
    expect(result.contents).toHaveLength(0);
  });
});
