import { describe, it, expect } from 'vitest';
import { isValidUUID } from '../utils/validation';
import { uuidSchema, lineWebhookBodySchema } from '../utils/validation';

describe('isValidUUID', () => {
  it('should accept valid UUID', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('should accept uppercase UUID', () => {
    expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('should reject empty string', () => {
    expect(isValidUUID('')).toBe(false);
  });

  it('should reject random string', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
  });

  it('should reject UUID without dashes', () => {
    expect(isValidUUID('550e8400e29b41d4a716446655440000')).toBe(false);
  });

  it('should reject short UUID', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716')).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('should parse valid UUID', () => {
    const result = uuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
    expect(result.success).toBe(true);
  });

  it('should reject invalid UUID', () => {
    const result = uuidSchema.safeParse('invalid');
    expect(result.success).toBe(false);
  });

  it('should reject non-string', () => {
    const result = uuidSchema.safeParse(123);
    expect(result.success).toBe(false);
  });
});

describe('lineWebhookBodySchema', () => {
  it('should parse valid webhook body with events', () => {
    const body = {
      events: [{
        type: 'message',
        timestamp: 1234567890,
        source: { userId: 'U123', type: 'user' },
        message: { type: 'text', text: 'hello', id: 'msg1' },
      }],
    };
    const result = lineWebhookBodySchema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it('should default to empty events array', () => {
    const result = lineWebhookBodySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toEqual([]);
    }
  });

  it('should reject invalid event type', () => {
    const body = {
      events: [{
        type: 'invalid_type',
        timestamp: 1234567890,
        source: { userId: 'U123', type: 'user' },
      }],
    };
    const result = lineWebhookBodySchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('should reject event without source.userId', () => {
    const body = {
      events: [{
        type: 'message',
        timestamp: 1234567890,
        source: { userId: '', type: 'user' },
        message: { type: 'text', text: 'hi', id: 'msg1' },
      }],
    };
    const result = lineWebhookBodySchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('should accept follow event', () => {
    const body = {
      events: [{
        type: 'follow',
        timestamp: 1234567890,
        source: { userId: 'U123', type: 'user' },
      }],
    };
    const result = lineWebhookBodySchema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it('should accept postback event', () => {
    const body = {
      events: [{
        type: 'postback',
        timestamp: 1234567890,
        source: { userId: 'U123', type: 'user' },
        postback: { data: 'book:some-id' },
      }],
    };
    const result = lineWebhookBodySchema.safeParse(body);
    expect(result.success).toBe(true);
  });
});
