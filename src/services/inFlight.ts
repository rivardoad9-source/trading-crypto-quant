/**
 * Registry of work that must not be cut in half by a shutdown.
 *
 * WHY THIS EXISTS (19 Sep 2026)
 * ----------------------------
 * `shutdown()` stopped the cron tasks, stopped the Telegram bridge, stopped the API,
 * closed the database and called `process.exit(0)` — it awaited NOTHING. A DLMM cycle
 * that opens a position runs for 26 seconds to 8.4 minutes (measured over every entry
 * cycle 11-17 Sep in `scan_funnel_cycles`; a screening-only cycle is ~6 s). The open is
 * not atomic — the balancing swap confirms, then the position account is created and
 * funded across several transactions — and `live_execution_attempts` is not written
 * until the outcome is KNOWN. So a signal landing inside that window killed the engine
 * with a swap already submitted: its own unwind never ran and the book held no row
 * saying capital was on-chain. That is the 12 Sep 2026 incident (1.802543 SOL, 61% of
 * live capital, stranded until the operator closed it by hand) and it is the shape the
 * operator's two worst cases share — "swap landed but the open failed" and "close landed
 * but the sell-back failed". The wallet sweep can only DETECT those states.
 *
 * This module is the missing prevention:
 *   * every cron task registers its in-flight promise here (`track`);
 *   * `shutdown()` drains them — bounded — before exiting;
 *   * `/api/health` publishes the count so a deploy can wait for IDLE before it even
 *     sends the signal, instead of racing a 26-second-to-8-minute window.
 *
 * Deliberately dependency-free: no database, no RPC, no clock of its own, so the drain
 * contract is unit-testable in isolation.
 */

const registry = new Map<string, Set<Promise<unknown>>>();

export interface InFlightReport {
  count: number;
  /** One label per in-flight unit of work, `name xN` when a name is running more than once. */
  labels: string[];
}

/**
 * Registers a promise as in-flight work and returns it untouched, so a caller keeps
 * awaiting exactly what it passed in.
 */
export function track<T>(label: string, promise: Promise<T>): Promise<T> {
  let set = registry.get(label);
  if (!set) {
    set = new Set();
    registry.set(label, set);
  }
  set.add(promise);

  const done = (): void => {
    const live = registry.get(label);
    if (!live) return;
    live.delete(promise);
    if (live.size === 0) registry.delete(label);
  };
  /*
   * A separate observer chain, not `.finally()` on the caller's promise: `done` never
   * throws and handles the rejection branch, so registering work can neither swallow the
   * caller's error nor create a second unhandled rejection.
   */
  promise.then(done, done);

  return promise;
}

/** What is running right now — this is what `/api/health` publishes. */
export function describeInFlight(): InFlightReport {
  const labels: string[] = [];
  let count = 0;
  for (const [label, set] of registry) {
    count += set.size;
    labels.push(set.size > 1 ? `${label} x${set.size}` : label);
  }
  labels.sort();
  return { count, labels };
}

export function pendingCount(): number {
  return describeInFlight().count;
}

export interface DrainResult {
  drained: boolean;
  pending: number;
  labels: string[];
  waitedMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits, bounded, for every tracked promise to settle.
 *
 * Bounded on purpose. A wedged RPC must not hold the process open past the supervisor's
 * kill timeout — there it would be SIGKILLed mid-swap anyway, which is the exact state
 * this prevents. On timeout the caller reports it and exits; recovery is then the wallet
 * sweep's and the self-heal crons' business, not a process that refuses to die.
 */
export async function drain(timeoutMs: number, pollMs = 250): Promise<DrainResult> {
  const started = Date.now();
  for (;;) {
    const pending: Promise<unknown>[] = [];
    for (const set of registry.values()) for (const p of set) pending.push(p);

    if (pending.length === 0) {
      return { drained: true, pending: 0, labels: [], waitedMs: Date.now() - started };
    }

    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      const { count, labels } = describeInFlight();
      return { drained: false, pending: count, labels, waitedMs: Date.now() - started };
    }

    // New work may register while we wait (a tick already queued), so re-read the registry
    // every pass instead of awaiting one fixed snapshot.
    await Promise.race([Promise.allSettled(pending), sleep(Math.min(pollMs, remaining))]);
  }
}

/** Test-only: forget every tracked promise. */
export function resetInFlightForTests(): void {
  registry.clear();
}
