import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.logLevel,
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l' } }
      : undefined,
  base: { service: 'solana-indexer' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createChildLogger(component: string) {
  return logger.child({ component });
}
