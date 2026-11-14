// Structured logging with pino.
// - JSON lines on stdout (what Docker / log shippers expect); pretty output in development.
// - Optional daily-rotated files in LOG_DIR (useful outside Docker).
// - Credentials and transcripts are redacted; request bodies are never logged.
import { createRequire } from 'node:module';
import path from 'node:path';
import pino from 'pino';

const require = createRequire(import.meta.url);

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.token',
  '*.apiKey',
  '*.authorization',
  '*.transcript',
  '*.prompt',
];

function hasModule(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/** @param {{ level: string, pretty: boolean, dir?: string, retentionDays: number }} options */
export function createLogger({ level = 'info', pretty = false, dir, retentionDays = 30 } = {}) {
  const targets = [];
  if (pretty && hasModule('pino-pretty')) {
    targets.push({
      target: 'pino-pretty',
      level,
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' },
    });
  } else {
    targets.push({ target: 'pino/file', level, options: { destination: 1 } });
  }
  if (dir) {
    targets.push({
      target: 'pino-roll',
      level,
      options: {
        file: path.join(dir, 'api'),
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        extension: '.log',
        mkdir: true,
        limit: { count: retentionDays },
      },
    });
  }
  return pino({
    level,
    base: { service: 'optivus-api' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: { targets },
  });
}

/** A silent logger for unit tests. */
export const nullLogger = pino({ level: 'silent' });
