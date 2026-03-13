import type { Tenant } from '../types';

interface GuardrailResult {
  passed: boolean;
  violations: string[];
}

// 全テナント共通の禁止パターン
const UNIVERSAL_FORBIDDEN: RegExp[] = [
  /\d{1,3}[,，]\d{3}円/,
  /\d+万円/,
  /月額\d+/,
  /絶対[にう]/,
  /保証(し|する|します)/,
  /確実[にな]/,
  /必ず[a-zA-Zぁ-ん]/,
  /100\s*[%％]/,
];

export function validateMessage(message: string, tenant: Tenant): GuardrailResult {
  const violations: string[] = [];

  // 1. 全テナント共通チェック
  for (const pattern of UNIVERSAL_FORBIDDEN) {
    if (pattern.test(message)) {
      violations.push(`禁止パターン検出: ${pattern.source}`);
    }
  }

  // 2. テナント固有の禁止表現チェック
  const forbiddenExpressions = tenant.guardrail_config?.forbidden_expressions || [];
  for (const expr of forbiddenExpressions) {
    if (message.includes(expr)) {
      violations.push(`テナント禁止表現: ${expr}`);
    }
  }

  // 3. テナント固有の禁止トピックチェック
  const forbiddenTopics = tenant.guardrail_config?.forbidden_topics || [];
  for (const topic of forbiddenTopics) {
    if (message.includes(topic)) {
      violations.push(`禁止トピック: ${topic}`);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
