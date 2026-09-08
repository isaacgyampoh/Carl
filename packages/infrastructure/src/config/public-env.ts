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
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
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
