/**
 * Time as an injected dependency.
 *
 * Carl reasons about time constantly — trial expiry, an offline device's authorisation
 * window, a return window, which cash session a sale belongs to. Code that calls `Date.now()`
 * directly cannot be tested without either waiting or mocking globals, so those rules end up
 * untested. A `Clock` port makes "what happens 8 days into a 7-day grace period" a one-line
 * test.
 */

/** An instant, always in UTC. Carl stores `timestamptz` and converts for display only. */
export interface Clock {
  now(): Date;
  /** Epoch milliseconds. */
  timestamp(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  timestamp: () => Date.now(),
};

/** A controllable clock for tests. */
export function fixedClock(start: Date | string | number): Clock & {
  advance(ms: number): void;
  set(instant: Date | string | number): void;
} {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    timestamp: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (instant) => {
      current = new Date(instant).getTime();
    },
  };
}

export const MILLISECOND = 1;
export const SECOND = 1000 * MILLISECOND;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** ISO-8601 with millisecond precision, always UTC — the format Carl puts on the wire. */
export function toIso(date: Date): string {
  return date.toISOString();
}

export function parseIso(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO-8601 timestamp: ${value}`);
  }
  return date;
}

export function addMilliseconds(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function addDays(date: Date, days: number): Date {
  return addMilliseconds(date, days * DAY);
}

export function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

export function isAfter(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime();
}

/** Whether `instant` has passed. A null deadline means "no deadline", never "expired". */
export function hasElapsed(deadline: Date | null | undefined, clock: Clock): boolean {
  if (deadline == null) return false;
  return clock.timestamp() >= deadline.getTime();
}
