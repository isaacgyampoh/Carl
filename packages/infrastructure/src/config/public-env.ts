/**
 * Public configuration.
 *
 * Everything in this module is compiled into the browser bundle and must be treated as
 * world-readable. The Supabase anon key lives here legitimately: it is safe to publish *only*
 * because Row Level Security is enforced on every tenant-owned table. If RLS were ever
 * disabled on a table, this key would expose it — which is why the RLS test suite is a
 * blocking CI gate rather than a nice-to-have.
 *
 * Values are read through explicit `process.env.NEXT_PUBLIC_*` property accesses because
 * Next.js inlines them statically at build time; a dynamic lookup would resolve to undefined
 * in the browser.
 */

import { z } from 'zod';

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ error: 'NEXT_PUBLIC_SUPABASE_URL must be a valid URL.' }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, { error: 'NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or malformed.' }),
  /*
   * No production default, deliberately.
   *
   * This used to default to `http://localhost:3000` unconditionally. Every other required
   * value in this schema fails loudly when it is missing; this one failed silently, and the
   * value it invented is handed to merchants: `clientAppUrl()` builds the shop address shown
   * on the onboarding handover screen, next to a Copy button. A customer can be given a link
   * that works on nobody's machine, and nothing anywhere reports a problem.
   *
   * A localhost default is a development convenience, so it applies only in development. In
   * production the variable is required and a missing one stops the deployment instead of
   * reaching a shop.
   */
  NEXT_PUBLIC_APP_URL:
    process.env.NODE_ENV === 'production'
      ? z.url({ error: 'NEXT_PUBLIC_APP_URL must be set in production.' })
      : z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

let cached: PublicEnv | null = null;

export function publicEnv(): PublicEnv {
  if (cached) return cached;

  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  });

  if (!parsed.success) {
    // Fail loudly at startup rather than producing confusing 401s at runtime.
    throw new Error(
      `Invalid public environment configuration:\n${formatIssues(parsed.error)}\n` +
        'Copy .env.example to .env.local and fill in the required values.',
    );
  }

  cached = parsed.data;
  return cached;
}

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
}
