import { describe, it, expect } from 'vitest';
import { toJST, formatDateJST, formatTimeJST, formatDateTimeJST } from '../utils/datetime';

describe('toJST', () => {
  it('should convert UTC string to JST', () => {
    const jst = toJST('2026-03-13T00:00:00Z');
    expect(jst.getHours()).toBe(9);
  });

  it('should convert Date object to JST', () => {
    const utc = new Date('2026-03-13T15:00:00Z');
    const jst = toJST(utc);
    // 15:00 UTC = 00:00 JST next day
    expect(jst.getDate()).toBe(14);
    expect(jst.getHours()).toBe(0);
  });
});

describe('formatDateJST', () => {
  it('should format date with weekday in Japanese', () => {
    // 2026-03-13 is Friday
    const result = formatDateJST('2026-03-13T03:00:00Z');
    // 03:00 UTC = 12:00 JST, still March 13
    expect(result).toBe('3月13日（金）');
  });

  it('should handle date boundary crossing', () => {
    // 2026-03-12T20:00:00Z = 2026-03-13 05:00 JST
    const result = formatDateJST('2026-03-12T20:00:00Z');
    expect(result).toBe('3月13日（金）');
  });
});

describe('formatTimeJST', () => {
  it('should format time in HH:mm', () => {
    const result = formatTimeJST('2026-03-13T01:30:00Z');
    // 01:30 UTC = 10:30 JST
    expect(result).toBe('10:30');
  });

  it('should zero-pad hours and minutes', () => {
    const result = formatTimeJST('2026-03-12T18:05:00Z');
    // 18:05 UTC = 03:05 JST
    expect(result).toBe('03:05');
  });
});

describe('formatDateTimeJST', () => {
  it('should combine date and time', () => {
    const result = formatDateTimeJST('2026-03-13T01:30:00Z');
    expect(result).toBe('3月13日（金） 10:30');
  });
});
