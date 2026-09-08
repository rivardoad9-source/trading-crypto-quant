import { env } from "../config/env.js";
import { hoursSince, parseDbTimestamp } from "./meteora.js";
import type { PoolExecutionRecord } from "../database/repositories.js";

/**
 * The two guards that stop the engine spending money on a pool it cannot open.
 *
 * Both exist because of 7 Sep 2026, when one pool (STONK-SOL) was selected by the LLM,
 * failed on-chain, and was selected again on the next 30-minute cycle — twice in one
 * day, for real money — while every gate in the engine reported the pool as a perfectly
 * good candidate. It was: the pool passed screening on its metrics, which is the only
 * question screening asks. Nothing was measuring whether the ENGINE could execute it.
 *
 * WHY THIS IS NOT THE V1.1 ANTI-CHURN GATE, and must never be merged into it.
 * `assessPoolCooldown` in `meteora.ts` reads `PoolExitRecord`, reconstructed from
 * CLOSED POSITION ROWS, and counts consecutive failed EXITS. A failed OPEN writes no
 * row at all — that is the deliberate "the chain decides, the database records" rule in
 * `liveExecution.ts`, and it is right: a row describing a position that does not exist
 * would be valued, accrued and eventually "closed", all of it about nothing. The
 * consequence is that the V1.1 lockout is structurally blind to execution failures.
 * This module is the missing half, not a duplicate: cooldown measures how the pool
 * TRADED, this measures whether it can be ENTERED. Merging them would also change the
 * V1.1 baseline, which is a change to the official configuration and needs its own
 * justification.
 *
 * INERT UNLESS LIVE. Both guards are consulted only on the live execution path. In
 * paper mode the candidate list is byte-identical to what it was before this file
 * existed — the same discipline `defaultBacktestConfig()` and `liveConfig.ts` follow,
 * and for the same reason: a gate that switched itself on would silently rewrite every
 * dry run and every cached sweep result.
 *
 * FAILS OPEN, like `assessPoolCooldown` and unlike `screenTokenSafety`. An unparseable
 * timestamp expires the bench rather than making it permanent, and a pool with no
 * history is never blocked. The reasoning is the same: this gate protects RETURNS and
 * gas, while the capital itself is protected by the anti-rug screen, the spend ceiling
 * and the pre-swap rehearsal, all of which fail closed. A broken clock must not be able
 * to freeze the whole engine.
 */

/* ------------------------------------------------------------------ */
/* Operator denylist                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parses `POOL_DENYLIST` into comparable entries.
 *
 * Lower-cased so a pair name typed in any case matches, and de-duplicated so the count
 * printed at boot is the number of distinct pools an operator actually named. Empty
 * entries are dropped rather than kept as an empty string, which would otherwise match
 * a pool whose pair name failed to resolve.
 */
export function parseDenylist(raw: string | undefined | null): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0 && !PLACEHOLDER.test(entry)),
    ),
  ];
}

/**
 * The same placeholder shapes `env.ts` treats as unset, applied PER ENTRY.
 *
 * `POOL_DENYLIST` is a list, so the check cannot live in the schema: one real address
 * beside one copied `<pool-address>` must keep the real one. None of these can collide
 * with a Solana address, which is base58 and so contains no `_`, `<` or `>`.
 */
const PLACEHOLDER = /^(your_|<|changeme|xxx+$|todo$|pool[_-]?address$)/i;

/** Whether the operator has named this pool, by address or by pair name. */
export function isPoolDenied(
  denylist: readonly string[],
  poolAddress: string,
  pairName: string,
): boolean {
  if (denylist.length === 0) return false;
  return (
    denylist.includes(poolAddress.trim().toLowerCase()) ||
    denylist.includes(pairName.trim().toLowerCase())
  );
}

/** Parsed once, at import, like every other setting. */
export const poolDenylist: readonly string[] = parseDenylist(env.POOL_DENYLIST);

/* ------------------------------------------------------------------ */
/* Execution-failure breaker                                           */
/* ------------------------------------------------------------------ */

export interface ExecutionBreakerThresholds {
  consecutiveFailures: number;
  hours: number;
}

/**
 * The stage an execution failure reached, which is what decides how much it counts.
 *
 * `rehearsal` costs NOTHING: the cluster refused a simulation, no transaction was
 * signed and no SOL moved. `open` means the balancing swap had already confirmed —
 * real money left the wallet and the auto-unwind had to sell a memecoin back.
 *
 * Weighting them equally was the first version of this gate, and an audit caught that
 * it made the gate miss its own founding case. On 7 Sep 2026 one pool cost money
 * EXACTLY TWICE; at a flat limit of two the first loss does not bench, so the second
 * loss still happens and the gate only prevents a third. A failure that has already
 * spent is not a data point to confirm — it is the outcome the gate exists to stop
 * repeating.
 */
export type ExecutionFailureStage = "rehearsal" | "open";

/** Which stage a stored `last_stage` string describes. */
export function classifyFailureStage(stage: string | null | undefined): ExecutionFailureStage {
  // Stored as "rehearsal/<step>" by the pre-swap gate, and "open" by the post-swap
  // catch. Anything unrecognised is treated as the EXPENSIVE case: an unknown failure
  // after a swap is the one worth over-benching for.
  return (stage ?? "").toLowerCase().startsWith("rehearsal") ? "rehearsal" : "open";
}

/**
 * Failures at this stage or worse bench the pool immediately, whatever the count says.
 *
 * Only `open` qualifies: the swap confirmed, the SOL is gone, and repeating it costs
 * the same again. `consecutiveFailures` still governs the free case, where two
 * refusals are worth waiting for before writing a pool off for a day.
 */
const BENCH_IMMEDIATELY: ExecutionFailureStage = "open";

export function defaultExecutionBreakerThresholds(): ExecutionBreakerThresholds {
  return {
    consecutiveFailures: env.EXECUTION_FAILURE_LOCKOUT_COUNT,
    hours: env.EXECUTION_FAILURE_LOCKOUT_HOURS,
  };
}

export interface ExecutionBreakerVerdict {
  blocked: boolean;
  hoursRemaining: number;
  reason: string | null;
}

const NOT_BLOCKED: ExecutionBreakerVerdict = Object.freeze({
  blocked: false,
  hoursRemaining: 0,
  reason: null,
});

/**
 * Whether a pool is benched for repeatedly failing to execute. Pure: no database, no
 * clock of its own, so it is testable without either.
 *
 * A zero in either threshold disables the gate, and says so rather than behaving as if
 * "0 failures" meant "block immediately" — the same trap `POOL_COOLDOWN_HOURS=0`
 * documents in CLAUDE.md.
 */
export function assessExecutionBreaker(
  record: PoolExecutionRecord | undefined,
  now: Date = new Date(),
  thresholds: ExecutionBreakerThresholds = defaultExecutionBreakerThresholds(),
): ExecutionBreakerVerdict {
  if (!record) return NOT_BLOCKED;
  if (thresholds.consecutiveFailures <= 0 || thresholds.hours <= 0) return NOT_BLOCKED;
  if (record.consecutiveFailures < 1) return NOT_BLOCKED;

  /*
   * ONE expensive failure is enough; free ones are counted to the limit.
   *
   * See `ExecutionFailureStage`. The count still applies to rehearsal refusals, where
   * nothing was spent and a single cluster refusal may be transient state rather than
   * a broken pool.
   */
  const stage = classifyFailureStage(record.lastStage);
  const limit = stage === BENCH_IMMEDIATELY ? 1 : thresholds.consecutiveFailures;
  if (record.consecutiveFailures < limit) return NOT_BLOCKED;

  // An unparseable or missing timestamp expires the bench. See the fail-open note above.
  if (parseDbTimestamp(record.lastFailureAt) === null) return NOT_BLOCKED;

  const elapsed = hoursSince(record.lastFailureAt, now);
  if (elapsed >= thresholds.hours) return NOT_BLOCKED;

  const remaining = thresholds.hours - elapsed;
  const count = record.consecutiveFailures;
  return {
    blocked: true,
    hoursRemaining: remaining,
    reason:
      (stage === BENCH_IMMEDIATELY
        ? `${count} on-chain execution failure${count === 1 ? "" : "s"} AFTER the ` +
          `balancing swap spent (one is enough to bench)`
        : `${count} consecutive pre-swap rehearsal refusals (limit ${limit}, nothing spent)`) +
      `; last at the ${record.lastStage ?? "unknown"} stage: ` +
      `${record.lastReason ?? "no reason recorded"}; benched for another ` +
      `${remaining.toFixed(1)}h of ${thresholds.hours}h`,
  };
}

/** One line for the boot log, so an empty or mistyped denylist is visible. */
export function describeExecutionGuard(): string {
  const thresholds = defaultExecutionBreakerThresholds();
  const breaker =
    thresholds.consecutiveFailures > 0 && thresholds.hours > 0
      ? `1 post-swap failure, or ${thresholds.consecutiveFailures} pre-swap refusals ` +
        `-> ${thresholds.hours}h bench`
      : "DISABLED";

  const denylist =
    poolDenylist.length > 0
      ? `${poolDenylist.length} entr${poolDenylist.length === 1 ? "y" : "ies"} ` +
        `(${poolDenylist.join(", ")})`
      : "empty";

  /*
   * The width cap belongs on this line because CLAUDE.md makes it the authority on
   * what is actually armed, and a narrow-only engine filtering ~81% of the universe
   * before the LLM sees it is the single most consequential thing an operator can
   * misread as a broken screener. It is printed even when inert, so "no cap" is a
   * stated fact rather than an absent line.
   */
  const cap =
    env.LIVE_MAX_POSITION_BINS < 1400
      ? `${env.LIVE_MAX_POSITION_BINS} bins` +
        (env.LIVE_MAX_POSITION_BINS <= 70 ? " (NARROW ONLY - the wide path is benched)" : "")
      : "1400 bins (the DLMM maximum; no operator cap)";

  return (
    `[guard] execution breaker: ${breaker}; operator denylist: ${denylist}; ` +
    `live width cap: ${cap}`
  );
}
