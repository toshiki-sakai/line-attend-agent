import { Hono } from 'hono';
import type { Env } from './types';
import webhook from './routes/webhook';
import health from './routes/health';
import admin from './routes/admin';
import adminDashboard from './routes/admin-dashboard';
import api from './routes/api';
import { handleScheduled } from './services/scheduler';
import { handleQueueMessage } from './services/queue-handler';
import { rateLimitMiddleware, csrfProtectionMiddleware, securityHeadersMiddleware } from './middleware/security';

const app = new Hono<{ Bindings: Env }>();

// Global security headers
app.use('*', securityHeadersMiddleware);

// Rate limiting for API routes
app.use('/api/*', (c, next) => rateLimitMiddleware(c, next, 120));

// Rate limiting for webhook (higher limit)
app.use('/webhook/*', (c, next) => rateLimitMiddleware(c, next, 200));

// Rate limiting and CSRF for admin routes
app.use('/admin/*', (c, next) => rateLimitMiddleware(c, next, 60));
app.use('/admin/*', csrfProtectionMiddleware);

// API routes (Lステップ integration) — must be before admin routes
app.route('/', api);
app.route('/', webhook);
app.route('/', health);
app.route('/', admin);
app.route('/', adminDashboard);

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
  queue: handleQueueMessage as ExportedHandlerQueueHandler<Env>,
};
