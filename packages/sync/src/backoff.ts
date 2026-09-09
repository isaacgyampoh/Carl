/**
 * Retry scheduling.
 *
 * ## Why exponential, and why jittered
 *
 * A shop's terminals all lose connectivity together — the router reboots, the line drops —
 * and they all recover together. Without jitter every terminal in the branch retries at
 * exactly the same instants, so the server sees a synchronised burst from every till at
 * once, fails some of them, and they all line up to retry together again. The jitter
 * spreads them out.
 *
 * The cap matters as much as the growth: a terminal that has been offline overnight must
 * not wait four hours before its first attempt in the morning.
 */

/** First retry delay. Short, because most failures are a momentary drop. */
const BASE_DELAY_MS = 2_000;

/** Longest a terminal will ever wait between attempts. */
const MAX_DELAY_MS = 5 * 60_000;

/** Full jitter: the delay is drawn from [0, computed], which spreads a recovering fleet. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_DELAY_MS);
  return Math.floor(random() * exponential);
}

export function nextAttemptAt(attempt: number, now: Date, random?: () => number): Date {
  return new Date(now.getTime() + retryDelayMs(attempt, random));
}
