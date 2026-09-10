import { env } from "../config/env.js";
import { WSOL_MINT } from "../config/constants.js";
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
  /**
   * The bench a POST-SWAP failure earns, which is a different quantity from `hours`.
   *
   * `hours` governs the free case — a simulation the cluster refused, where nothing was
   * spent and a day is a generous wait for transient state to clear. This governs the
   * case where SOL left the wallet and no position came back. On 11 Sep 2026 three such
   * attempts on one token burned 0.0639 SOL inside half an hour, and the incident's own
   * conclusion was that a bench measured in hours is the wrong shape of answer for a
   * failure measured in spent capital.
   *
   * `env.ts` refuses a value below 24 and offers no zero-disable, unlike every other
   * lockout: this is the outcome the breaker exists to stop repeating.
   *
   * OPTIONAL so a caller that predates it — a hand-built threshold object in a test —
   * still compiles. Absent, it falls back to `hours`, never to zero: the expensive case
   * must not be able to become the shortest bench in the system by omission.
   */
  postSwapHours?: number;
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

/**
 * The bench a post-swap failure earns. Never shorter than the ordinary window — see
 * `ExecutionBreakerThresholds.postSwapHours`.
 */
export function postSwapWindow(thresholds: ExecutionBreakerThresholds): number {
  return Math.max(thresholds.postSwapHours ?? thresholds.hours, thresholds.hours);
}

export function defaultExecutionBreakerThresholds(): ExecutionBreakerThresholds {
  return {
    consecutiveFailures: env.EXECUTION_FAILURE_LOCKOUT_COUNT,
    hours: env.EXECUTION_FAILURE_LOCKOUT_HOURS,
    postSwapHours: env.EXECUTION_POST_SWAP_LOCKOUT_HOURS,
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

  /*
   * THE WINDOW IS CHOSEN BY STAGE, not shared.
   *
   * A post-swap failure has already spent, so the question "how long before trying
   * again" is not the same question a refused simulation asks. `postSwapHours` is the
   * longer answer (default a week) and cannot be configured below 24. Falls back to
   * `hours` only when a caller supplies thresholds without it — an older test, or a
   * caller built by hand — rather than defaulting to zero, which would silently turn
   * the expensive case into the SHORTEST bench in the system.
   */
  const window = stage === BENCH_IMMEDIATELY ? postSwapWindow(thresholds) : thresholds.hours;

  // An unparseable or missing timestamp expires the bench. See the fail-open note above.
  if (parseDbTimestamp(record.lastFailureAt) === null) return NOT_BLOCKED;

  const elapsed = hoursSince(record.lastFailureAt, now);
  if (elapsed >= window) return NOT_BLOCKED;

  const remaining = window - elapsed;
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
      `${remaining.toFixed(1)}h of ${window}h`,
  };
}

/* ------------------------------------------------------------------ */
/* Token-level bench propagation                                       */
/* ------------------------------------------------------------------ */

/**
 * Quote mints that must NEVER key a bench.
 *
 * The engine funds in SOL, so the "other side" of a pair is usually a memecoin — and a
 * failure there is usually a fact about the TOKEN (a transfer fee, a rug, a pool moving
 * several bins a minute), which is exactly what should propagate. But the other side of
 * a SOL-USDC pool is USDC, and benching "USDC" would bench every USDC-quoted SOL pool
 * over one pool's bad afternoon.
 *
 * Same reasoning as `isPoolAttributable` withholding a strike for a WALLET-level
 * refusal: one fact that is not about the token must not be allowed to bench the
 * universe a pool at a time. These pools keep their own per-pool bench; only the
 * propagation is withheld.
 */
const NEVER_A_BENCH_KEY: readonly string[] = [
  // wSOL comes from the shared constant rather than being typed out again: this list
  // is what stops one pool's bad afternoon benching a whole quote asset, and a
  // mistyped address here would silently disable that protection.
  WSOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
];

/**
 * The mint a bench should be keyed on, or null when there is no safe one.
 *
 * WHY THIS EXISTS. The breaker keyed on `pool_address` alone, and one token routinely
 * has several DLMM pools at different bin steps. Observed live on 9 Sep 2026: OTC-SOL
 * (Muk/SOL) exists as FOUR pools; one was benched at 13:32 and a SIBLING was opened at
 * 21:22, because the bench was never asked about that address. The operator's same-day
 * mitigation was to add the PAIR NAME to `POOL_DENYLIST`, which `isPoolDenied` matches
 * across siblings — a manual version of this, proving the shape of the gap.
 *
 * KEYED ON THE MINT, NOT THE PAIR NAME. A pair name is built from token SYMBOLS, and
 * memecoin tickers collide constantly; a symbol-keyed bench would eventually refuse an
 * unrelated token that happened to share three letters. The denylist may match on names
 * because a human chose those names and can see what they cover — an automatic gate
 * cannot.
 *
 * Null when neither side is wSOL (the live path refuses such pools anyway) and when the
 * non-SOL side is a major quote asset. Null propagates NOTHING; the pool keeps its own
 * bench.
 */
export function benchTokenKey(
  baseMint: string | null | undefined,
  quoteMint: string | null | undefined,
): string | null {
  const wsol = WSOL_MINT;
  const base = (baseMint ?? "").trim();
  const quote = (quoteMint ?? "").trim();

  const other = base === wsol ? quote : quote === wsol ? base : null;
  if (other === null || other === "") return null;
  return NEVER_A_BENCH_KEY.includes(other) ? null : other;
}

/**
 * Every stored record, indexed both ways from ONE read.
 *
 * Two indexes off the same rows so they cannot describe different instants — the same
 * reason `/api/overview` reads the control file once.
 */
export interface ExecutionHistoryIndex {
  byPool: Map<string, PoolExecutionRecord>;
  byToken: Map<string, PoolExecutionRecord[]>;
  /**
   * Records that are BLOCKING but carry no token, so their bench covers one pool
   * address and no sibling of the same mint.
   *
   * Surfaced rather than silently skipped. On 11 Sep 2026 every one of the six stored
   * rows had a NULL `token_mint`, so the token-level bench — which exists, is tested,
   * and is correct — propagated nothing at all, and the gate read as armed while
   * covering a single address. A NULL still cannot be guessed into a mint (a pair name
   * is built from symbols and memecoin tickers collide), so the answer is not to invent
   * a key: it is to say out loud how many benches are narrower than they look, and to
   * BACKFILL the mint the moment the engine learns it. `learnPoolExecutionToken` is
   * that backfill; this list is what tells an operator it is still needed.
   */
  unkeyed: PoolExecutionRecord[];
}

export function indexExecutionHistory(
  records: readonly PoolExecutionRecord[],
): ExecutionHistoryIndex {
  const byPool = new Map<string, PoolExecutionRecord>();
  const byToken = new Map<string, PoolExecutionRecord[]>();
  const unkeyed: PoolExecutionRecord[] = [];

  for (const record of records) {
    byPool.set(record.poolAddress, record);
    // A record with no token propagates nothing — see `benchTokenKey`.
    if (!record.tokenMint) {
      // Counted only when it is actually holding something back. A cleared record with
      // no token is not a narrower bench, it is no bench.
      if (record.consecutiveFailures >= 1) unkeyed.push(record);
      continue;
    }
    const bucket = byToken.get(record.tokenMint);
    if (bucket) bucket.push(record);
    else byToken.set(record.tokenMint, [record]);
  }

  return { byPool, byToken, unkeyed };
}

/**
 * One warning line naming the benches that cover only their own pool, or null when
 * every stored bench is keyed on a token.
 *
 * Returned rather than logged so the caller decides how often it is printed — the same
 * reason `readEngineControlFile` hands back `warnings`.
 */
export function describeUnkeyedBenches(index: ExecutionHistoryIndex): string | null {
  if (index.unkeyed.length === 0) return null;
  const names = index.unkeyed
    .map((r) => r.pairName ?? `${r.poolAddress.slice(0, 8)}...`)
    .join(", ");
  return (
    `[guard] ${index.unkeyed.length} active bench${index.unkeyed.length === 1 ? "" : "es"} ` +
    `carr${index.unkeyed.length === 1 ? "ies" : "y"} NO token mint (${names}), so ` +
    `${index.unkeyed.length === 1 ? "it covers" : "they cover"} that pool address ONLY — ` +
    `a sibling pool of the same token is NOT blocked. The mint is backfilled the next ` +
    `time the engine resolves the pair; until then this bench is narrower than it reads.`
  );
}

/**
 * Whether a SIBLING pool of the same token is benched.
 *
 * Blocks when ANY record for the token blocks, rather than picking the most recent one.
 * A cheap "latest wins" would miss the case that matters: an expensive `open` strike on
 * pool A two hours ago, then a free `rehearsal` refusal on pool B ten minutes ago, would
 * let the still-live 24h bench from A go unseen behind B's fresher, weaker record.
 *
 * `self` is excluded so the caller can report a sibling bench in words that are true —
 * "another pool of this token", not "this pool". The pool's own bench is assessed
 * separately and reported separately.
 */
export function assessTokenBench(
  records: readonly PoolExecutionRecord[] | undefined,
  self: string,
  now: Date = new Date(),
  thresholds: ExecutionBreakerThresholds = defaultExecutionBreakerThresholds(),
): ExecutionBreakerVerdict {
  if (!records || records.length === 0) return NOT_BLOCKED;

  let worst: ExecutionBreakerVerdict = NOT_BLOCKED;
  for (const record of records) {
    if (record.poolAddress === self) continue;
    const verdict = assessExecutionBreaker(record, now, thresholds);
    if (verdict.blocked && verdict.hoursRemaining > worst.hoursRemaining) {
      worst = {
        blocked: true,
        hoursRemaining: verdict.hoursRemaining,
        reason:
          `a SIBLING pool of the same token (${record.pairName ?? record.poolAddress}, ` +
          `${record.poolAddress.slice(0, 8)}...) is benched: ${verdict.reason}`,
      };
    }
  }

  return worst;
}

/** One line for the boot log, so an empty or mistyped denylist is visible. */
export function describeExecutionGuard(): string {
  const thresholds = defaultExecutionBreakerThresholds();
  const breaker =
    thresholds.consecutiveFailures > 0 && thresholds.hours > 0
      ? `1 post-swap failure -> ${postSwapWindow(thresholds)}h bench (pool AND token), ` +
        `or ${thresholds.consecutiveFailures} pre-swap refusals -> ${thresholds.hours}h`
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
