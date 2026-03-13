export const logger = {
  info(message: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: 'info', message, ...data, timestamp: new Date().toISOString() }));
  },
  error(message: string, data?: Record<string, unknown>) {
    console.error(JSON.stringify({ level: 'error', message, ...data, timestamp: new Date().toISOString() }));
  },
  warn(message: string, data?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: 'warn', message, ...data, timestamp: new Date().toISOString() }));
  },
};
