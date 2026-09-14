/**
 * Token concentration: how many confirmed live opens one paired token has had recently.
 *
 * WHY. Four of the first five live trades (11-13 Sep 2026) were EMBER, inside ~21 hours.
 * Each rode the same price move, so the record that reads "5 wins" is closer to one bet
 * taken four times — and the gates never saw it, because the execution breaker counts
 * FAILED opens, the V1.1 cooldown counts closes of the same POOL, and EMBER traded through
 * two different pools.
 *
 * Keyed on the paired token's MINT. A pair name is never an automatic key (memecoin tickers
 * collide). An attempt row written without a mint is matched on its pool address instead,
 * which is narrower — it cannot see a sibling pool — and is counted separately so the report
 * says so rather than reading as complete.
 *
 * Pure: the rows are read by the caller, the clock is injected. Fails OPEN on an unparseable
 * timestamp (that row is ignored), like every other anti-churn gate: this protects the
 * sample's diversity, not capital.
 */
import { parseDbTimestamp } from "./meteora.js";

export interface OpenedAttempt {
  attemptedAt: string;
  poolAddress: string;
  tokenMint: string | null;
  pairName: string | null;
}

export interface ConcentrationVerdict {
  flagged: boolean;
  /** Confirmed opens of this token inside the window. */
  entries: number;
  /** Of those, how many matched on pool address only because their row has no mint. */
  matchedByPoolOnly: number;
  limit: number;
  windowHours: number;
  reason: string | null;
}

export function assessTokenConcentration(input: {
  attempts: readonly OpenedAttempt[];
  tokenMint: string | null;
  poolAddress: string;
  nowMs: number;
  limit: number;
  windowHours: number;
}): ConcentrationVerdict {
  const since = input.nowMs - input.windowHours * 3_600_000;
  let entries = 0;
  let matchedByPoolOnly = 0;
  for (const a of input.attempts) {
    const at = parseDbTimestamp(a.attemptedAt)?.getTime();
    if (at === undefined || at < since || at > input.nowMs) continue;
    if (input.tokenMint !== null && a.tokenMint === input.tokenMint) {
      entries++;
    } else if (a.tokenMint === null && a.poolAddress === input.poolAddress) {
      entries++;
      matchedByPoolOnly++;
    }
  }
  const flagged = entries >= input.limit;
  return {
    flagged,
    entries,
    matchedByPoolOnly,
    limit: input.limit,
    windowHours: input.windowHours,
    reason: flagged
      ? `token already opened ${entries}x in the last ${input.windowHours}h (limit ${input.limit})` +
        (matchedByPoolOnly > 0 ? `; ${matchedByPoolOnly} matched by pool only (no mint recorded)` : "")
      : null,
  };
}
