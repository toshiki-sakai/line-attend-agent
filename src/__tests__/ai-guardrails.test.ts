import { describe, it, expect } from 'vitest';
import { validateMessage } from '../guards/ai-guardrails';
import type { Tenant } from '../types';

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'test-tenant',
    name: 'Test School',
    line_channel_id: 'ch',
    line_channel_secret: 'secret',
    line_channel_access_token: 'token',
    scenario_config: { steps: [] },
    hearing_config: { items: [] },
    reminder_config: { pre_consultation: [], no_response_follow_up: { enabled: false, strategy: 'fixed', max_attempts: 5, min_interval_hours: 24, max_interval_hours: 72, escalation_message: '' } },
    tone_config: { personality: '', emoji_usage: '', language_style: '', custom_instructions: '' },
    guardrail_config: { forbidden_topics: [], forbidden_expressions: [], answer_scope: '', human_handoff_trigger: '' },
    notification_config: { method: 'line', staff_line_user_ids: [], notify_on: [] },
    school_context: '',
    is_active: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('validateMessage', () => {
  const tenant = makeTenant();

  it('should pass a clean message', () => {
    const result = validateMessage('プログラミングを学ぶことで目標に近づけますよ！', tenant);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should detect yen amounts (円)', () => {
    const result = validateMessage('受講料は3000円です', tenant);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('should detect ten-thousand yen amounts (万円)', () => {
    const result = validateMessage('月々5万円で学べます', tenant);
    expect(result.passed).toBe(false);
  });

  it('should detect comma-formatted amounts', () => {
    const result = validateMessage('300,000円のコースです', tenant);
    expect(result.passed).toBe(false);
  });

  it('should detect "絶対"', () => {
    const result = validateMessage('絶対に成功します', tenant);
    expect(result.passed).toBe(false);
  });

  it('should detect "保証"', () => {
    const result = validateMessage('成果を保証します', tenant);
    expect(result.passed).toBe(false);
  });

  it('should detect "確実"', () => {
    const result = validateMessage('確実にスキルアップできます', tenant);
    expect(result.passed).toBe(false);
  });

  it('should detect "必ず"', () => {
    const result = validateMessage('必ず転職できます', tenant);
    expect(result.passed).toBe(false);
  });

  it('should detect "100%"', () => {
    const result = validateMessage('100%満足いただけます', tenant);
    expect(result.passed).toBe(false);
  });

  it('should detect "月額" pattern', () => {
    const result = validateMessage('月額5000からスタート', tenant);
    expect(result.passed).toBe(false);
  });

  it('should detect tenant-specific forbidden expressions', () => {
    const customTenant = makeTenant({
      guardrail_config: { forbidden_topics: [], forbidden_expressions: ['激安'], answer_scope: '', human_handoff_trigger: '' },
    });
    const result = validateMessage('激安キャンペーン中です', customTenant);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('禁止: 激安');
  });

  it('should detect tenant-specific forbidden topics', () => {
    const customTenant = makeTenant({
      guardrail_config: { forbidden_topics: ['政治'], forbidden_expressions: [], answer_scope: '', human_handoff_trigger: '' },
    });
    const result = validateMessage('政治についてどう思いますか', customTenant);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('禁止トピック: 政治');
  });

  it('should collect multiple violations', () => {
    const result = validateMessage('絶対に100%成功を保証します', tenant);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('should handle empty message', () => {
    const result = validateMessage('', tenant);
    expect(result.passed).toBe(true);
  });

  it('should handle missing guardrail_config', () => {
    const noGuardrailTenant = makeTenant({
      guardrail_config: undefined as unknown as Tenant['guardrail_config'],
    });
    const result = validateMessage('普通のメッセージ', noGuardrailTenant);
    expect(result.passed).toBe(true);
  });
});
