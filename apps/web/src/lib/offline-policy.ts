/**
 * How long a phone may keep selling with no connection, and how much it may hold.
 *
 * The Windows till keeps its sales in SQLite on a machine that belongs to the shop. A phone
 * keeps them in browser storage, which the browser may clear, the owner may reinstall, and a
 * dropped handset takes with it. That is fine for a connection that drops for an hour; it is not
 * somewhere a week of takings should live.
 *
 * So offline selling here is bounded, and the boundary is stated to the cashier rather than
 * discovered: past it, the till stops taking sales instead of quietly accumulating money nobody
 * can reconcile.
 *
 * Pure, so the rule is tested on its own and reads the same in the till and in the tests.
 */
export const OFFLINE_LIMITS = {
  /** Sales held on the device before it must reach Carl. About a busy hour at one counter. */
  maxQueuedSales: 100,
  /** How old the oldest unsent sale may be. A shift, not a week. */
  maxHours: 12,
} as const;

export interface QueueState {
  readonly queued: number;
  /** When the oldest unsent sale was made, or null when nothing is waiting. */
  readonly oldestQueuedAt: string | null;
  /** Sales the server refused, which a person has to look at. */
  readonly needingAttention?: number;
}

export interface OfflineVerdict {
  readonly allowed: boolean;
  /** Said to the cashier when it is not. */
  readonly reason?: string;
}

export function canSellOffline(state: QueueState, now: Date = new Date()): OfflineVerdict {
  if (state.queued >= OFFLINE_LIMITS.maxQueuedSales) {
    return {
      allowed: false,
      reason: `This device is holding ${state.queued} sales that have not reached Carl. Connect to the internet before selling again.`,
    };
  }

  if (state.oldestQueuedAt !== null) {
    const oldest = new Date(state.oldestQueuedAt).getTime();
    const hours = (now.getTime() - oldest) / 3_600_000;
    if (Number.isFinite(hours) && hours >= OFFLINE_LIMITS.maxHours) {
      return {
        allowed: false,
        reason: `Sales made on this device have been waiting more than ${OFFLINE_LIMITS.maxHours} hours. Connect to the internet before selling again.`,
      };
    }
  }

  return { allowed: true };
}

/** What the till says about what it is holding. */
export function queueSummary(state: QueueState): string | null {
  if (state.queued === 0) return null;
  const sales = state.queued === 1 ? '1 sale' : `${state.queued} sales`;
  return `${sales} waiting to reach Carl`;
}
