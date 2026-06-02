import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';

const SENSITIVE_KEYS = [
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'authorization',
  'apikey',
  'api_key',
  'password',
  'secret',
  'token',
  'WHATSAPP_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

/**
 * Structured JSON logger with secret redaction. Never logs raw tokens or
 * credentials. All log lines are single-line JSON so they can be ingested by
 * a log aggregator.
 */
@Injectable()
export class AppLogger implements NestLoggerService {
  constructor(private readonly context = 'App') {}

  private redact(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
          out[k] = '[REDACTED]';
        } else {
          out[k] = this.redact(v);
        }
      }
      return out;
    }
    return value;
  }

  private write(level: string, message: unknown, meta?: Record<string, unknown>) {
    const line = {
      ts: new Date().toISOString(),
      level,
      context: this.context,
      message: typeof message === 'string' ? message : this.redact(message),
      ...(meta ? { meta: this.redact(meta) } : {}),
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  }

  log(message: unknown, meta?: Record<string, unknown>) {
    this.write('info', message, meta);
  }

  error(message: unknown, meta?: Record<string, unknown>) {
    this.write('error', message, meta);
  }

  warn(message: unknown, meta?: Record<string, unknown>) {
    this.write('warn', message, meta);
  }

  debug(message: unknown, meta?: Record<string, unknown>) {
    if (process.env.NODE_ENV !== 'production') this.write('debug', message, meta);
  }

  verbose(message: unknown, meta?: Record<string, unknown>) {
    if (process.env.NODE_ENV !== 'production') this.write('verbose', message, meta);
  }

  child(context: string): AppLogger {
    return new AppLogger(context);
  }
}
