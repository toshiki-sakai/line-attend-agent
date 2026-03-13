import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { createHmac } from 'node:crypto';

// --- Rate Limiting ---
// Simple in-memory rate limiter using KV for distributed rate limiting
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60; // per window for admin API
const RATE_LIMIT_WEBHOOK_MAX = 200; // higher limit for webhook

export async function rateLimitMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
  maxRequests = RATE_LIMIT_MAX_REQUESTS
): Promise<Response | void> {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const path = new URL(c.req.url).pathname;
  const key = `ratelimit:${ip}:${path.startsWith('/webhook') ? 'webhook' : 'admin'}`;

  try {
    const cached = await c.env.TENANT_CACHE.get(key);
    const data = cached ? JSON.parse(cached) as { count: number; windowStart: number } : null;
    const now = Date.now();

    if (data && (now - data.windowStart) < RATE_LIMIT_WINDOW_MS) {
      if (data.count >= maxRequests) {
        return c.json({ error: 'Too many requests' }, 429);
      }
      await c.env.TENANT_CACHE.put(key, JSON.stringify({ count: data.count + 1, windowStart: data.windowStart }), {
        expirationTtl: 120,
      });
    } else {
      await c.env.TENANT_CACHE.put(key, JSON.stringify({ count: 1, windowStart: now }), {
        expirationTtl: 120,
      });
    }
  } catch {
    // Rate limiting failure should not block requests
  }

  return next();
}

// --- CSRF Protection ---
// For dashboard forms, validate that the Origin/Referer matches

export async function csrfProtectionMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  // Only check POST/PUT/DELETE
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    return next();
  }

  // Skip for API calls with Bearer token (programmatic access)
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return next();
  }

  // For form submissions, check Origin or Referer
  const origin = c.req.header('Origin');
  const referer = c.req.header('Referer');
  const host = c.req.header('Host');

  if (!host) {
    return next();
  }

  const allowedOrigin = `https://${host}`;

  if (origin) {
    if (origin !== allowedOrigin && origin !== `http://${host}`) {
      return c.text('CSRF validation failed', 403);
    }
  } else if (referer) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.host !== host) {
        return c.text('CSRF validation failed', 403);
      }
    } catch {
      return c.text('CSRF validation failed', 403);
    }
  }
  // If neither Origin nor Referer is present, allow (for local dev and same-origin)

  return next();
}

// --- Security Headers ---

export async function securityHeadersMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  await next();

  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // CSP for dashboard pages
  if (c.req.path.startsWith('/admin') && !c.req.path.startsWith('/admin/api')) {
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'"
    );
  }
}

// --- Session token hashing ---
// Instead of storing plain API key in cookie, hash it

export function hashSessionToken(apiKey: string): string {
  return createHmac('sha256', 'line-attend-session')
    .update(apiKey)
    .digest('hex');
}

export function verifySessionToken(cookieValue: string, apiKey: string): boolean {
  return cookieValue === hashSessionToken(apiKey);
}
