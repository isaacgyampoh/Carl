/**
 * Server-only configuration.
 *
 * The `server-only` import below is the enforcement mechanism, not documentation: if any
 * module reachable from a client component imports this file, the Next.js build fails. That
 * turns "don't leak the service-role key" from a code-review convention into a compile error.
 *
 * The service-role key bypasses Row Level Security completely. Anything holding it can read
 * and write every tenant's data, so it is used only by deliberate platform operations —
 * tenant provisioning, device activation — never to serve an ordinary user request.
 */

import 'server-only';

import { z } from 'zod';
import { formatIssues } from './public-env';

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, { error: 'SUPABASE_SERVICE_ROLE_KEY is missing or malformed.' }),
  SUPABASE_DB_URL: z.string().optional(),
  CARL_DEVICE_SECRET_PEPPER: z.string().min(32, {
    error:
      'CARL_DEVICE_SECRET_PEPPER must be at least 32 characters. Generate with: openssl rand -base64 48',
  }),
  CARL_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /*
   * The shared secret the scheduled health check presents.
   *
   * Optional: without it the monitoring endpoint does not exist at all, which is the right
   * behaviour for a deployment nobody is watching. Long enough that guessing is not a strategy.
   */
  CARL_MONITOR_TOKEN: z
    .string()
    .min(32, { error: 'CARL_MONITOR_TOKEN must be at least 32 characters.' })
    .optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SENTRY_DSN: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment configuration:\n${formatIssues(parsed.error)}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test-only reset so a suite can exercise different configurations in one process. */
export function resetServerEnvCache(): void {
  cached = null;
}
