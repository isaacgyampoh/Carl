/**
 * Structured logging.
 *
 * Production incidents are diagnosed from logs, and free-text logs cannot be searched or
 * aggregated. Every Carl log line is a structured record carrying the tenant, branch and
 * device it happened in, so "which terminal is failing to sync" is a query rather than an
 * afternoon.
 *
 * The redaction pass below is not decoration. Sale payloads carry payment references and
 * device secrets travel through activation code paths; a log statement is an easy way to
 * write a credential to a third-party service permanently.
 */

export const LogLevel = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
} as const;

export type LogLevelName = keyof typeof LogLevel;

export interface LogContext {
  readonly tenantId?: string;
  readonly branchId?: string;
  readonly userId?: string;
  readonly deviceId?: string;
  readonly requestId?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext & { error?: unknown }): void;
  /** Returns a logger that stamps every line with the given context. */
  child(context: LogContext): Logger;
}

/** Keys whose values are replaced with `[redacted]` wherever they appear, at any depth. */
const REDACTED_KEYS = new Set([
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'servicerolekey',
  'anonkey',
  'authorization',
  'cookie',
  'devicesecret',
  'activationcode',
  'activation_code',
  'device_secret',
  'service_role_key',
  'pepper',
  'jwt',
  'pin',
]);

const MAX_REDACT_DEPTH = 8;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''))
      ? '[redacted]'
      : redact(item, depth + 1);
  }
  return output;
}

export interface LoggerOptions {
  readonly level?: LogLevelName;
  readonly base?: LogContext;
  readonly sink?: (line: string) => void;
}

/**
 * A JSON-lines logger.
 *
 * One JSON object per line is what Vercel, Sentry and every log aggregator ingest without
 * configuration.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LogLevel[options.level ?? 'info'];
  const base = options.base ?? {};
  // console.log is the one sink present in every runtime Carl targets, and is what Vercel
  // and every log aggregator ingest.
  // eslint-disable-next-line no-console
  const sink = options.sink ?? ((line: string) => console.log(line));

  function emit(level: LogLevelName, message: string, context?: LogContext): void {
    if (LogLevel[level] < threshold) return;
    const record = {
      level,
      time: new Date().toISOString(),
      message,
      ...(redact({ ...base, ...context }) as Record<string, unknown>),
    };
    sink(JSON.stringify(record));
  }

  return {
    trace: (message, context) => emit('trace', message, context),
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: (context) =>
      createLogger({
        ...options,
        base: { ...base, ...context },
      }),
  };
}

/** A logger that discards everything. For tests that do not assert on logging. */
export const silentLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
