import { Hono } from 'hono';
import type { Env, QueuePayload } from './types';
import webhook from './routes/webhook';
import health from './routes/health';
import { handleScheduled } from './services/scheduler';
import { handleQueueMessage } from './services/queue-handler';

const app = new Hono<{ Bindings: Env }>();

app.route('/', webhook);
app.route('/', health);

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
  queue: handleQueueMessage as ExportedHandlerQueueHandler<Env>,
} satisfies ExportedHandler<Env>;
