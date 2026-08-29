/**
 * A FIFO async mutex.
 *
 * The engine now mutates positions from three places on different clocks: the 1-minute
 * fast monitor, the 10-minute screener, and Telegram's /close_all. Two of them running
 * a valuation at once is not merely untidy — fee accrual is computed as
 * `rate x (now - last_checked_at)`, so two overlapping passes both measure from the same
 * stored timestamp and book the same interval twice. Worse, both could read a position as
 * ACTIVE and close it independently.
 *
 * `node-cron` job locks in `index.ts` only stop a job overlapping *itself*; this is the
 * lock that stops different jobs overlapping each other.
 */
export class Mutex {
  /** Resolves when the currently queued work is done. */
  private tail: Promise<void> = Promise.resolve();
  /**
   * Holders plus waiters. Counted rather than inferred from a boolean: a holder clears
   * its flag one microtask before the next waiter resumes, and a `tryRun` landing in
   * that window would queue behind the waiter instead of giving up as documented.
   */
  private queued = 0;

  /** True while anyone holds the lock or is waiting for it. */
  get busy(): boolean {
    return this.queued > 0;
  }

  /**
   * Queues `fn` behind any current holder. Use when the work must happen — opening a
   * position, an operator-triggered close.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.queued++;

    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      this.queued--;
      release();
    }
  }

  /**
   * Runs `fn` only if the lock is completely free, otherwise gives up immediately.
   *
   * The fast monitor uses this: a tick that cannot get the lock has nothing to add,
   * because whoever holds it is already valuing the same positions against the same
   * prices. Queuing instead would pile ticks up behind a slow screener and then run
   * them back-to-back against prices that have since moved.
   */
  async tryRun<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.busy) return { ran: false };
    return { ran: true, value: await this.run(fn) };
  }
}

/**
 * Guards every write to `simulated_positions`. Exported as a singleton because the
 * schedulers, the trading agent and the Telegram command handler must contend for the
 * same lock — a per-module instance would silently protect nothing.
 */
export const positionMutex = new Mutex();
