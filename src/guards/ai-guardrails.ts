import type { Tenant, FlowContext, AIResponse } from '../types';
import { logger } from '../utils/logger';

interface GuardrailResult {
  passed: boolean;
  violations: string[];
}

interface ValidateWithRetryResult {
  passed: boolean;
  message: string;
}

const UNIVERSAL_PATTERNS: Array<{ pattern: RegExp; desc: string }> = [
  { pattern: /\d{1,3}[,，]\d{3}円/, desc: '金額（300,000円等）' },
  { pattern: /\d+万円/, desc: '金額（30万円等）' },
  { pattern: /月額\d+/, desc: '月額表記' },
  { pattern: /\d+円/, desc: '円表記' },
  { pattern: /絶対/, desc: '「絶対」' },
  { pattern: /保証/, desc: '「保証」' },
  { pattern: /確実/, desc: '「確実」' },
  { pattern: /必ず/, desc: '「必ず」' },
  { pattern: /100\s*[%％]/, desc: '「100%」' },
];

const MAX_MESSAGE_LENGTH = 300;

export function validateMessage(message: string, tenant: Tenant): GuardrailResult {
  const violations: string[] = [];

  // Length check - LINE messages should be concise
  if (message.length > MAX_MESSAGE_LENGTH) {
    violations.push(`メッセージが長すぎます（${message.length}文字 > ${MAX_MESSAGE_LENGTH}文字）`);
  }

  for (const { pattern, desc } of UNIVERSAL_PATTERNS) {
    if (pattern.test(message)) {
      violations.push(desc);
    }
  }

  for (const expr of tenant.guardrail_config?.forbidden_expressions || []) {
    if (expr && message.includes(expr)) {
      violations.push(`禁止: ${expr}`);
    }
  }

  for (const topic of tenant.guardrail_config?.forbidden_topics || []) {
    if (topic && message.includes(topic)) {
      violations.push(`禁止トピック: ${topic}`);
    }
  }

  return { passed: violations.length === 0, violations };
}

export async function validateWithRetry(
  message: string,
  tenant: Tenant,
  context: FlowContext,
  regenerateFn: () => Promise<AIResponse>,
  maxRetries: number = 3
): Promise<ValidateWithRetryResult> {
  let currentMessage = message;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = validateMessage(currentMessage, tenant);
    if (result.passed) {
      return { passed: true, message: currentMessage };
    }

    logger.warn('Guardrail violation, regenerating', {
      attempt,
      violations: result.violations,
    });

    if (attempt < maxRetries - 1) {
      try {
        const regenerated = await regenerateFn();
        currentMessage = regenerated.reply_message;
      } catch (error) {
        logger.error('Regeneration failed', { error: String(error) });
        break;
      }
    }
  }

  return { passed: false, message: currentMessage };
}
