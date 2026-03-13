import { Hono } from 'hono';
import type { Env } from './types';
import webhook from './routes/webhook';
import health from './routes/health';
import admin from './routes/admin';
import adminDashboard from './routes/admin-dashboard';
import { handleScheduled } from './services/scheduler';
import { handleQueueMessage } from './services/queue-handler';

const app = new Hono<{ Bindings: Env }>();

app.route('/', webhook);
app.route('/', health);
app.route('/', admin);
app.route('/', adminDashboard);

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
  queue: handleQueueMessage as ExportedHandlerQueueHandler<Env>,
};
