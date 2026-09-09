/**
 * Build-time configuration, typed once.
 *
 * `import.meta.env` is `any`, so every direct read of it is an untyped value spreading
 * through the app. It is narrowed here, in one place, and nowhere else.
 *
 * These are baked in at build time and are deliberately not editable from the terminal: a
 * till that can be pointed at a different server by someone standing in front of it is a
 * till whose sales can be redirected.
 */

interface DesktopEnv {
  readonly VITE_CARL_URL?: string;
  readonly VITE_APP_VERSION?: string;
}

const env = import.meta.env as unknown as DesktopEnv;

/** Where Carl is. */
export const CARL_URL: string = env.VITE_CARL_URL ?? 'https://app.carl.africa';

/** Reported at activation so an estate can be audited for out-of-date terminals. */
export const APP_VERSION: string = env.VITE_APP_VERSION ?? '0.1.0';
