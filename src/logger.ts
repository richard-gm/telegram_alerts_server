import { createLogger, format, transports } from 'winston';

function serializeMeta(meta: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v instanceof Error) {
      out[k] = { message: v.message, stack: v.stack };
    } else {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? ` ${JSON.stringify(out)}` : '';
}

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.colorize(),
    format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level}] ${message}${serializeMeta(meta as Record<string, unknown>)}`;
    }),
  ),
  transports: [new transports.Console()],
});

export default logger;
