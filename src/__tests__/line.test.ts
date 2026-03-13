import { describe, it, expect } from 'vitest';
import { verifySignature } from '../services/line';
import { createHmac } from 'node:crypto';

describe('verifySignature', () => {
  const channelSecret = 'test-secret';

  function generateValidSignature(body: string): string {
    const hmac = createHmac('SHA256', channelSecret);
    hmac.update(body);
    return hmac.digest('base64');
  }

  it('should return true for valid signature', () => {
    const body = '{"events":[]}';
    const signature = generateValidSignature(body);
    expect(verifySignature(body, signature, channelSecret)).toBe(true);
  });

  it('should return false for invalid signature', () => {
    const body = '{"events":[]}';
    expect(verifySignature(body, 'invalid-base64-signature', channelSecret)).toBe(false);
  });

  it('should return false for tampered body', () => {
    const body = '{"events":[]}';
    const signature = generateValidSignature(body);
    expect(verifySignature('{"events":["tampered"]}', signature, channelSecret)).toBe(false);
  });

  it('should return false for wrong secret', () => {
    const body = '{"events":[]}';
    const signature = generateValidSignature(body);
    expect(verifySignature(body, signature, 'wrong-secret')).toBe(false);
  });

  it('should handle empty body', () => {
    const body = '';
    const signature = generateValidSignature(body);
    expect(verifySignature(body, signature, channelSecret)).toBe(true);
  });

  it('should return false for length mismatch', () => {
    // Short base64 that decodes to fewer bytes than HMAC output
    expect(verifySignature('body', 'dGVzdA==', channelSecret)).toBe(false);
  });
});
