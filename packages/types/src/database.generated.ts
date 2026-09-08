/**
 * Generated PostgreSQL types.
 *
 * Regenerate with `pnpm db:types`, which runs the Supabase CLI against the migrated schema.
 * Never edit by hand — the file is overwritten, and a hand-edit that disagrees with the
 * database is worse than no type at all.
 *
 * Populated in Phase 1, once the schema exists.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
