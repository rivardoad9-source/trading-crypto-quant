import { PublicKey } from "@solana/web3.js";
import { env } from "../config/env.js";
import {
  isLiveExecutionActive,
  liveMicroCapital,
  LAMPORTS_PER_SOL,
} from "../config/liveConfig.js";
import {
  countUnresolvedOrphanAttempts,
  getPoolExecutionRecord,
  getPoolExecutionRecords,
  learnPoolExecutionToken,
  recordLiveExecutionAttempt,
  recordPoolExecutionFailure,
  recordPoolExecutionSuccess,
  sumFailedAttemptCost,
  type LiveAttemptUnwind,
} from "../database/repositories.js";
import {
  assessLiveSizing,
  describeLiveSizing,
  type SizingGuardVerdict,
} from "./liveSizingGuard.js";
import {
  assessExecutionBreaker,
  assessTokenBench,
  benchTokenKey,
  indexExecutionHistory,
  isPoolDenied,
  poolDenylist,
} from "./executionGuard.js";
import {
  DLMM_BIN_ARRAY_RENT_SOL,
  DLMM_BINS_PER_INIT,
  DLMM_MAX_BINS_PER_POSITION,
  DlmmPartialExecutionError,
  WSOL_MINT,
  authorizeExecution,
  binRangeFromPrices,
  depositSlippage,
  dlmmExecutor,
  maxDepositLamports,
  executeJupiterSwap,
  exitSlippageCapBps,
  getConnection,
  getJupiterQuote,
  isSlippageRejection,
  resolveExitSlippageBps,
  closeEmptyTokenAccount,
  findLastSuccessfulSignature,
  type CloseTokenAccountOutcome,
  type PositionChainState,
  onchainConfig,
  quoteOpenCost,
  rehearseOpenPosition,
  TransactionFailedError,
  type ExecutionAuthorization,
  type OrphanPositionOutcome,
} from "./onchainExecutor.js";
import { fetchRealizedVolatilityPctPerHour } from "./marketData.js";
import { getWalletBalanceSol } from "./solana.js";
import { sendError } from "./telegram.js";

/**
 * The bridge between the trading engine and the signer.
 *
 * This module is the ONE place where the two halves meet, and it exists as a separate
 * file so that the join is a single reviewable edge rather than a scattering of import
 * statements across the agent. Before it, `onchainExecutor.ts` was unreachable from
 * `src/index.ts` and a test enforced that; now the engine reaches the signer through
 * here and only through here, and the test enforces THAT instead.
 *
 * Everything below is inert unless all three switches agree — `LIVE_MICRO_CAPITAL`,
 * `DRY_RUN=false` and `ONCHAIN_EXECUTION_ARMED` — which `env.ts` refuses to boot in an
 * incoherent combination. `isLiveExecutionActive()` is the single predicate the engine
 * asks; nothing else in the engine reads those flags directly.
 *
 * The rule that governs every function here: **the chain decides, the database
 * records.** No row is written describing a position until the transaction that
 * created it has confirmed, and no row is marked closed until the transaction that
 * closed it has confirmed. A database that disagrees with the chain is worse than one
 * that is merely behind it.
 */

/**
 * Whether the engine should execute on-chain rather than simulate.
 *
 * STILL THE SINGLE PREDICATE the engine asks, and still reached through this module by
 * every caller that was already asking it — this is a re-export, not a second copy.
 * The definition sits in `config/liveConfig.ts` so that `services/overview.ts` can ask
 * the same question without importing this file, which would have dragged the signer
 * into the import graph of the API-only process. See the note on the definition.
 */
export { isLiveExecutionActive };

export interface LiveOpenOutcome {
  /** The DLMM position account. Without this nothing can later claim or close. */
  positionAddress: string;
  openSignature: string;
  /** Null when no swap was needed (the pool's other side was already funded). */
  swapSignature: string | null;
  /** SOL actually deposited, in lamports. */
  depositedSolLamports: number;
  /** Paired token actually deposited, in base units. String: it can exceed 2^53. */
  depositedPairedAmount: string;
  /**
   * Wallet lamports read from the chain immediately BEFORE anything was spent, or null
   * when the read failed.
   *
   * The anchor for reconciliation. Everything the database knows about a live
   * position's PnL is produced by the same paper model that values simulated ones —
   * `closeLivePosition` returns signatures and nothing else, so the chain is asked to
   * close and never asked what came back. That model omits, in one direction, every
   * cost that is real: the balancing swap's slippage, priority fees, and bin-array rent
   * that never returns. Nothing compared the two, so the drift was unbounded and
   * invisible.
   *
   * Pairing this with the balance read after the close gives the trade's TRUE effect on
   * the wallet, measured rather than modelled. Null, never 0, when it could not be
   * read: an unknown balance is not an empty one, and a fabricated anchor would produce
   * a fabricated reconciliation.
   */
  walletLamportsBefore: number | null;
}

/**
 * Raised when the swap leg succeeded and the position open did not.
 *
 * This is the one partial state that costs money quietly. The wallet is no longer
 * holding SOL — it is holding some quantity of a memecoin it acquired purely in order
 * to provide liquidity. The engine now ATTEMPTS an automatic sell-back to SOL before
 * raising (best effort, thin pools can still fail), but the alert must stay loud and
 * must name the token, or any balance the rescue could not move simply sits there.
 */
export class StrandedSwapError extends Error {
  readonly mint: string;
  readonly amount: string;
  readonly swapSignature: string;
  readonly rescueSignature: string | null;
  readonly rescueError: string | null;
  /** What became of a position the failed open had already funded. */
  readonly orphan: OrphanRecovery | null;
  /**
   * What the attempt took out of the wallet, in lamports, or null when unmeasured.
   *
   * The alert said "the open failed" and named signatures for months, and said NOTHING
   * about money. The 11 Sep 2026 incident's -0.0639 SOL had to be derived by hand from
   * two balance snapshots taken hours apart — three alerts had already fired, none of
   * them carrying a number, so nothing about the alerts distinguished a free refusal
   * from a repeated real loss.
   */
  readonly costLamports: number | null;
  /** clean | orphan | none | unknown — see `LiveAttemptUnwind`. */
  readonly unwind: LiveAttemptUnwind;
  constructor(
    mint: string,
    amount: string,
    swapSignature: string,
    cause: unknown,
    rescueSignature: string | null = null,
    rescueError: string | null = null,
    orphan: OrphanRecovery | null = null,
    costLamports: number | null = null,
    unwind: LiveAttemptUnwind = "unknown",
  ) {
    const rescue =
      rescueSignature !== null
        ? `Auto-unwind back to SOL submitted (${rescueSignature}).`
        : rescueError !== null
          ? `Auto-unwind back to SOL FAILED (${rescueError}). Sell it back or open the position by hand — do NOT assume the SOL is still SOL.`
          : `Auto-unwind found no paired balance to sell. Sell it back or open the position by hand — do NOT assume the SOL is still SOL.`;
    super(
      `[live] the balancing swap CONFIRMED but the position open failed. The wallet now ` +
        `holds ${amount} base units of ${mint} that nothing monitors (swap ${swapSignature}). ` +
        `${describeUnwindVerdict(unwind)} ${describeAttemptCost(costLamports)} ` +
        `${rescue}${describeOrphan(cause, orphan)} ` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "StrandedSwapError";
    this.mint = mint;
    this.amount = amount;
    this.swapSignature = swapSignature;
    this.rescueSignature = rescueSignature;
    this.rescueError = rescueError;
    this.orphan = orphan;
    this.costLamports = costLamports;
    this.unwind = unwind;
  }
}

/**
 * The two words an operator needs first, before any signature.
 *
 * UNWOUND CLEAN means nothing of value is left on-chain: the swap was sold back and no
 * position was funded. ORPHAN LEFT means the opposite and needs a human now. They are
 * never collapsed, and an unverified rescue is reported as UNKNOWN rather than as
 * clean — "the rescue was submitted" and "the rescue worked" are different facts, and
 * only one of them lets the operator go back to sleep.
 */
function describeUnwindVerdict(unwind: LiveAttemptUnwind): string {
  switch (unwind) {
    case "clean":
      return "UNWOUND CLEAN (nothing of value left on-chain).";
    case "orphan":
      return "ORPHAN LEFT — capital is STILL ON-CHAIN and needs a human.";
    case "none":
      return "NOTHING TO UNWIND (no balance had been swapped).";
    case "unknown":
      return "UNWIND OUTCOME UNKNOWN — verify on-chain before assuming it is clean.";
  }
}

/** The cost line. Null renders as "not measured", never as zero. */
function describeAttemptCost(costLamports: number | null): string {
  if (costLamports === null) {
    return "COST NOT MEASURED (a wallet balance read failed) — check the chain.";
  }
  return `COST ${(costLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL taken out of the wallet.`;
}

/**
 * Turns the two recovery reports into the single verdict above.
 *
 * A funded position that could not be closed, or a partial execution whose recovery
 * never ran, is an ORPHAN regardless of how the token rescue went — the position holds
 * more value than the leftover dust ever does. A rescue that FAILED, or one whose
 * outcome nobody established, is UNKNOWN rather than clean, for the reason above.
 */
function classifyUnwind(
  orphan: OrphanRecovery | null,
  rescueSignature: string | null,
  rescueError: string | null,
): LiveAttemptUnwind {
  if (orphan !== null && (orphan.state === "failed" || orphan.state === "empty")) return "orphan";
  if (rescueError !== null) return "orphan";
  if (rescueSignature !== null) return "clean";
  /*
   * No signature and no error means the re-read found no balance to sell. On a plain
   * failed open that is genuinely nothing to unwind; where a position was recovered it
   * is also clean, because the withdrawal's proceeds were swept in the same pass.
   */
  return orphan !== null && orphan.state === "closed" ? "clean" : "none";
}

/**
 * The one sentence in the alert that says whether real capital is still on-chain.
 *
 * FAIL-LOUD ON A MISSING REPORT. `orphan` defaults to null because most failed opens
 * never created a position, but a `DlmmPartialExecutionError` says one exists and was
 * part-funded — so null there means the recovery did not run, not that there is nothing
 * to recover, and the alert says exactly that with the address to check. A default that
 * quietly renders as "all clear" on the one failure that leaves money on the table is
 * how the 10 Sep 2026 KNOTS-SOL position sat unmonitored for four hours.
 */
function describeOrphan(cause: unknown, orphan: OrphanRecovery | null): string {
  if (orphan === null) {
    if (cause instanceof DlmmPartialExecutionError) {
      return (
        ` A POSITION MAY STILL BE FUNDED ON-CHAIN and no recovery was attempted: ` +
        `CHECK ${cause.position} BY HAND.`
      );
    }
    return "";
  }

  switch (orphan.state) {
    case "closed":
      return (
        ` The open had already funded position ${orphan.position}; it was withdrawn, ` +
        `claimed and CLOSED (${orphan.signatures.join(", ") || "no signature"}), so the ` +
        `capital is back in the wallet.`
      );
    case "empty":
      return ` Position ${orphan.position} exists but holds nothing; only its rent is at stake.`;
    case "absent":
      return ` No position account exists at ${orphan.position}; nothing was left on-chain.`;
    case "failed":
      return (
        ` POSITION ${orphan.position} IS FUNDED AND COULD NOT BE CLOSED ` +
        `(${orphan.error ?? "unknown error"}). THE ON-CHAIN POSITION IS STILL OPEN and ` +
        `nothing monitors it — close it by hand.`
      );
  }
}

/** What the recovery of a partially funded position found, and what it did. */
export interface OrphanRecovery {
  position: string;
  /** The executor's three states, plus "failed" for a recovery that itself threw. */
  state: OrphanPositionOutcome["state"] | "failed";
  signatures: string[];
  error: string | null;
}

/**
 * ADOPT-OR-CLOSE: what to do when an open lands SOME of its transactions and then fails.
 *
 * The wide path funds a position with several transactions sent one at a time. When the
 * third is refused and the first two landed, the position account exists AND HOLDS
 * LIQUIDITY — it earns fees, it moves with the price, and it is at risk — while the
 * engine, correctly, writes no row for it (a row describing a position the open did not
 * complete would be a fabricated holding). The result on 10 Sep 2026 was a real,
 * profitable, entirely unmonitored KNOTS-SOL position that only a human noticed: the
 * engine reported zero active positions for four hours, and its only remediation was to
 * sell the leftover tokens in the WALLET, which is the half of the problem that was
 * never the risk.
 *
 * So: ask the chain what the position holds, and if it holds anything, close it — the
 * one action that is right whether or not anything else worked, because an unmonitored
 * position is exactly what the engine cannot be allowed to own. Nothing is written to
 * the database either way: this recovers capital, it does not create a holding.
 *
 * NEVER THROWS. It runs on a failure path whose remaining job — unwinding the wallet
 * back to SOL — must happen regardless, so a recovery that threw would trade a funded
 * position for a stranded token balance. A failure is reported as `state: "failed"` and
 * the alert says the position is still open, in those words.
 *
 * The closer is injected rather than reached for directly so this decision is testable
 * without a cluster. It still cannot spend on its own: the only implementation is
 * `dlmmExecutor.closeOrphanPosition`, which demands an `ExecutionAuthorization` like
 * every other fund-moving method.
 */
export async function recoverPartiallyFundedPosition(
  context: { pairName: string; poolAddress: string; positionAddress: string },
  close: (params: {
    poolAddress: string;
    positionAddress: string;
  }) => Promise<OrphanPositionOutcome>,
): Promise<OrphanRecovery> {
  try {
    const outcome = await close({
      poolAddress: context.poolAddress,
      positionAddress: context.positionAddress,
    });

    if (outcome.state === "closed") {
      console.warn(
        `[live] ${context.pairName}: the failed open had FUNDED position ` +
          `${context.positionAddress} (${outcome.liquidityX} X / ${outcome.liquidityY} Y, ` +
          `${outcome.unclaimedFeeX}/${outcome.unclaimedFeeY} unclaimed fees). Closed on-chain: ` +
          `${outcome.signatures.join(", ")}`,
      );
    } else {
      console.log(
        `[live] ${context.pairName}: position ${context.positionAddress} is ` +
          `${outcome.state === "absent" ? "not on-chain" : "on-chain but empty"}; ` +
          `nothing to recover beyond its rent`,
      );
    }

    return {
      position: context.positionAddress,
      state: outcome.state,
      signatures: outcome.signatures,
      error: null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[live] ${context.pairName}: COULD NOT RECOVER position ${context.positionAddress} ` +
        `after a partial open — THE ON-CHAIN POSITION MAY STILL BE OPEN AND UNMONITORED: ` +
        `${reason}`,
    );
    return {
      position: context.positionAddress,
      state: "failed",
      signatures: [],
      error: reason,
    };
  }
}

/**
 * How many extra quotes a swap may try after the pool moved past the one it was built on.
 *
 * Two, matching the re-quote bounds either side of it. One re-quote covers the ordinary case
 * (0.5% of drift in the seconds between quote and simulation); the second exists for a token
 * that is moving hard, which is exactly when the entry is worth making. Beyond that the price
 * is not a quote problem and chasing it is how a swap pays for a spike.
 */
const SWAP_REQUOTE_ATTEMPTS = 2;

/**
 * Runs a Jupiter swap, RE-QUOTING when the refusal says the quote went stale.
 *
 * `executeJupiterSwap` fetches a quote and then builds against it; `sendAndConfirm` rebuilds on
 * a new blockhash but reuses that same quote, so a `SlippageToleranceExceeded` (0x1771) refusal
 * repeats identically on every rebuild. On 12 Sep 2026 the balancing swap burned all EIGHT
 * rebuilds that way and the entry aborted — the engine could not enter any token moving more
 * than 0.5% between quote and preflight, which is precisely the kind of pool a DLMM fee entry
 * wants.
 *
 * Retrying is safe in both shapes of that refusal: a preflight rejection never entered the
 * network, and a landed-and-reverted swap moved no tokens. Anything else propagates untouched
 * — an unknown outcome must never be retried, because that is how the same swap executes twice.
 *
 * Used for all three swaps the live path makes: the balancing swap before an open, the
 * auto-unwind after a failed open, and the residual sale after an exit. The last two matter
 * most: they are the paths that put capital back in SOL, and failing them because the market
 * moved is what leaves tokens in a wallet.
 */
async function executeJupiterSwapFreshQuote(
  auth: ExecutionAuthorization,
  params: Parameters<typeof executeJupiterSwap>[1],
  label: string,
): Promise<Awaited<ReturnType<typeof executeJupiterSwap>>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await executeJupiterSwap(auth, params);
    } catch (err) {
      const logs = err instanceof TransactionFailedError ? err.logs : null;
      const message = err instanceof Error ? err.message : String(err);
      if (!isSlippageRejection(logs, message) || attempt >= SWAP_REQUOTE_ATTEMPTS) throw err;
      console.warn(
        `[live] ${label}: the swap quote went stale (slippage exceeded on attempt ` +
          `${attempt + 1}/${SWAP_REQUOTE_ATTEMPTS + 1}); fetching a FRESH quote and rebuilding ` +
          `— the refusal was a preflight rejection, so nothing is in flight`,
      );
    }
  }
}

/**
 * The requested price range does not fit in ONE DLMM position account.
 *
 * Two different limits produce this, and the message says which, because the operator
 * response differs: the program one is permanent, the rent one is a funding decision.
 *
 *  - PROGRAM. A position account holds at most `DLMM_MAX_BINS_PER_POSITION` (1400)
 *    bins. That is a hard constant — width 1401 fails with InvalidPositionWidth — so a
 *    pool needing more can only be traded by splitting the range across several
 *    positions, which the one-position-per-pool model does not support.
 *  - RENT. A position account is rent-exempt and its rent scales linearly with width
 *    (~0.052 SOL at 70 bins, ~0.996 SOL at 1400). The live envelope reserves only
 *    `deployableSol - maxExposureSol` for rent, so a range can be perfectly legal
 *    on-chain and still be unaffordable. Raising `LIVE_CAPITAL_SOL` is the lever.
 *
 * Both fire BEFORE the balancing swap. That ordering is the whole point: on 7 Sep 2026
 * a width failure landed AFTER the swap and stranded 0.4 SOL as an unmonitored
 * memecoin. `seekNewEntry` treats this as a routine skip, not a fault.
 */
export class LiveEntryRefusedError extends Error {
  readonly poolAddress: string;
  readonly pairName: string;
  /**
   * Whether this refusal says something about the POOL that should be remembered.
   *
   * A range too wide, an operator denylist entry or an unaffordable rent bill are
   * facts about the current configuration, not about the pool's ability to execute:
   * raise `LIVE_CAPITAL_SOL` and the same pool opens fine. A rehearsal the cluster
   * refused is different — it is the chain saying this open would fail — and that is
   * what the execution breaker counts.
   */
  readonly countsAsExecutionFailure: boolean;

  constructor(
    message: string,
    pairName: string,
    poolAddress: string,
    countsAsExecutionFailure = false,
  ) {
    super(message);
    this.name = "LiveEntryRefusedError";
    this.pairName = pairName;
    this.poolAddress = poolAddress;
    this.countsAsExecutionFailure = countsAsExecutionFailure;
  }
}

export class BinWidthExceededError extends LiveEntryRefusedError {
  constructor(pairName: string, binWidth: number, poolAddress: string, limit: string) {
    super(
      `[live] ${pairName} needs ${binWidth} bins, over ${limit} (pool ${poolAddress}); ` +
        `skipped before any swap`,
      pairName,
      poolAddress,
    );
    this.name = "BinWidthExceededError";
  }
}

/**
 * The operator named this pool in `POOL_DENYLIST`.
 *
 * Its own type rather than a `BinWidthExceededError` with a width of 0, which is how
 * this first shipped and which logged the line "needs 0 bins, over the operator
 * POOL_DENYLIST". That reads months later as a width bug, and it made an operator
 * decision indistinguishable from a program limit in the funnel. A skip reason is
 * evidence; it has to say what actually happened.
 */
/**
 * The entry would burn more UNRECOVERABLE rent than it is projected to earn.
 *
 * The gate next to this one asks "can I afford this open" and is answered from the
 * rent budget. That is a different question from "is this open worth making", and
 * nothing was asking the second one: a candidate admitted on a $1.50 projected net
 * could create a bin array costing several times that, permanently, and still pass —
 * because the rent fitted in the budget.
 *
 * Bin-array rent is the one cost this engine cannot recover. The position account's
 * rent returns on close; a bin array is a pool-level account shared by every LP, and
 * nothing here can reclaim it. So it is not friction to be amortised over the trade,
 * it is capital spent to make the trade possible, and a trade that spends more than it
 * makes is a loss decided at entry.
 *
 * A refusal here is FREE and routine: it fires before the balancing swap, so nothing
 * has been spent, and `seekNewEntry` treats it as a skip rather than a fault. It is
 * NOT counted against the execution breaker either — the arrays exist or they do not,
 * which is a fact about the pool's state and the operator's economics, not evidence
 * that the chain would reject this open.
 */
export class UnrecoverableRentError extends LiveEntryRefusedError {
  constructor(
    pairName: string,
    poolAddress: string,
    rentUsd: number,
    projectedNetPnlUsd: number,
    arrays: number,
    limitMultiple: number,
  ) {
    super(
      `[live] ${pairName} would create ${arrays} bin array(s) costing ` +
        `$${rentUsd.toFixed(2)} of UNRECOVERABLE rent against a projected net PnL of ` +
        `$${projectedNetPnlUsd.toFixed(2)} (limit ${limitMultiple}x). Bin-array rent is ` +
        `never reclaimed, so this entry loses money at the moment it opens. Skipped ` +
        `before any swap (pool ${poolAddress})`,
      pairName,
      poolAddress,
    );
    this.name = "UnrecoverableRentError";
  }
}

export class PoolDeniedError extends LiveEntryRefusedError {
  constructor(pairName: string, poolAddress: string) {
    super(
      `[live] ${pairName} (pool ${poolAddress}) is on the operator POOL_DENYLIST; ` +
        `skipped before any network call`,
      pairName,
      poolAddress,
    );
    this.name = "PoolDeniedError";
  }
}

/** The pool has failed to execute repeatedly and is serving its bench. */
export class ExecutionBenchedError extends LiveEntryRefusedError {
  constructor(pairName: string, poolAddress: string, reason: string) {
    super(
      `[live] ${pairName} (pool ${poolAddress}) is benched by the execution breaker: ` +
        `${reason}; skipped before any network call`,
      pairName,
      poolAddress,
    );
    this.name = "ExecutionBenchedError";
  }
}

/**
 * The engine is sizing against SOL the wallet does not hold, or against a balance it
 * could not read.
 *
 * NOT a fact about the pool, so it must never earn an execution strike:
 * `countsAsExecutionFailure` stays false and this error is thrown before any
 * `recordPoolExecutionFailure` call can run. Same reasoning as `isPoolAttributable`
 * withholding a strike for a wallet-level simulation refusal — one wallet-level
 * condition benching the universe a pool at a time is a self-inflicted outage that a
 * top-up would otherwise not fix.
 *
 * It IS, however, a refusal to spend, and it fails closed on an unreadable balance.
 * See `liveSizingGuard.ts`.
 */
export class LiveSizingError extends LiveEntryRefusedError {
  readonly verdict: SizingGuardVerdict;
  constructor(pairName: string, poolAddress: string, verdict: SizingGuardVerdict) {
    super(
      `[live] ${pairName} (pool ${poolAddress}) refused before any spend — ` +
        `${verdict.reason ?? "the capital guard refused"}`,
      pairName,
      poolAddress,
    );
    this.name = "LiveSizingError";
    this.verdict = verdict;
  }
}

/**
 * FAILED live attempts have cost more than the 24-hour budget allows.
 *
 * The gate the 11 Sep 2026 incident asked for by existing. Three attempts on one token
 * spent 0.0639 SOL between 02:0x and 02:31 and produced no position, no row and no PnL;
 * every accounting surface in the engine reported a healthy, idle book. This is the one
 * number that can see that pattern, because it is summed from spends rather than from
 * outcomes.
 *
 * ENTRY-ONLY. It is raised inside `openLivePosition` and nowhere else, so monitoring,
 * fee accrual and closes are untouched — holding an exit is how a stop-loss stops being
 * enforced, which is the failure this file already documents twice.
 */
export class FailedCostBreakerError extends LiveEntryRefusedError {
  readonly spentSol: number;
  readonly budgetSol: number;
  constructor(
    pairName: string,
    poolAddress: string,
    spentSol: number,
    budgetSol: number,
    attempts: number,
    unmeasured: number,
    windowHours: number,
  ) {
    super(
      `[live] NEW ENTRIES ARE HELD: failed live attempts have cost ` +
        `${spentSol.toFixed(6)} SOL in the last ${windowHours}h, over the ` +
        `${budgetSol} SOL budget (LIVE_MAX_FAILED_COST_SOL). ` +
        `${attempts} failed attempt${attempts === 1 ? "" : "s"} recorded` +
        (unmeasured > 0
          ? `, of which ${unmeasured} carr${unmeasured === 1 ? "ies" : "y"} no ` +
            `measurement and are NOT in that total — the real spend is higher`
          : ``) +
        `. Monitoring, fee claims and closes continue. Clear the cause, then clear the ` +
        `attempts, before re-arming entries. (${pairName} / ${poolAddress} was next.)`,
      pairName,
      poolAddress,
    );
    this.name = "FailedCostBreakerError";
    this.spentSol = spentSol;
    this.budgetSol = budgetSol;
  }
}

/**
 * Capital from an EARLIER failure is still on-chain, so this entry is refused.
 *
 * A half-landed open funds a position account the engine does not track: no
 * `simulated_positions` row exists, because the open as a whole failed. On 12 Sep 2026 that
 * was 1.802543 SOL sitting in bins nothing was watching, and the entry path had no opinion
 * about it — the engine was one candidate away from opening a SECOND position with the rest
 * of a wallet that was already partly spoken for.
 *
 * The sizing guard does not cover this and never did: it compares `LIVE_CAPITAL_SOL` against
 * the wallet's total, so a wallet holding 2.9 SOL with 0.84 of it stranded in a position
 * would size a fresh 1.8 SOL deposit and pass.
 *
 * `unwind = 'orphan'` is the engine's own record that an unwind failed or could not be
 * confirmed, so this is not a heuristic — and it CLEARS ITSELF: recovering the position and
 * recording it (scripts/recoverFundedOrphan.ts + scripts/settleRecoveredAttempt.cjs, or the
 * orphan self-heal cron that does both) drops the count back to zero.
 *
 * A `LiveEntryRefusedError` like every other pre-swap refusal, so a cycle skips the candidate
 * and no operator is paged for a condition an operator is already working on.
 */
export class StrandedCapitalError extends LiveEntryRefusedError {
  constructor(pairName: string, poolAddress: string, attempts: number) {
    super(
      `[live] NEW ENTRIES ARE HELD: ${attempts} failed attempt${attempts === 1 ? "" : "s"} ` +
        `still record${attempts === 1 ? "s" : ""} capital left ON-CHAIN (unwind = 'orphan'). ` +
        `A half-landed open funds a position the engine does not track, so opening another one ` +
        `treats the same wallet as if it were whole. Recover it (scripts/recoverFundedOrphan.ts, ` +
        `or the orphan self-heal cron), then record it (scripts/settleRecoveredAttempt.cjs) and ` +
        `entries resume on their own. Monitoring, fee claims and closes continue. ` +
        `(${pairName} / ${poolAddress} was next.)`,
      pairName,
      poolAddress,
    );
    this.name = "StrandedCapitalError";
  }
}

/**
 * A SIBLING pool of the same token is benched.
 *
 * Its own class rather than an `ExecutionBenchedError` with different words, because
 * the two say different things to whoever reads the log: that one means THIS pool
 * failed, this one means this pool's record is clean and another pool of the same
 * token is what is holding it out. The message also cannot borrow that one's "skipped
 * before any network call" — identifying the token needs `describePair`, so this
 * refusal comes one RPC later. Still free: it is well before the balancing swap.
 *
 * A `LiveEntryRefusedError` like every other pre-swap refusal, so `seekNewEntry`
 * treats it as a routine skip and no operator is paged for a pool the engine merely
 * declined to enter.
 */
export class TokenBenchedError extends LiveEntryRefusedError {
  constructor(pairName: string, poolAddress: string, reason: string) {
    super(
      `[live] ${pairName} (pool ${poolAddress}) is held out by a token-level bench: ` +
        `${reason}; skipped before the balancing swap`,
      pairName,
      poolAddress,
    );
    this.name = "TokenBenchedError";
  }
}

/**
 * The pool is moving faster than the deposit's active-bin tolerance can absorb.
 *
 * A REFUSAL, and a free one: it is decided before the balancing swap, from a
 * measurement, with nothing signed. It earns no execution-breaker strike, for the same
 * reason `UnrecoverableRentError` does not — volatility is a fact about the pool right
 * now, not evidence that this pool can never be entered, and benching it for 24 hours
 * over a busy half-hour would be the gate punishing the wrong thing.
 *
 * WHY IT IS NOT THE SCREENER'S VOLATILITY GATE. That one asks whether the pool is a
 * good place to hold liquidity and answers in percent per hour. This one asks whether
 * the pool will hold still long enough for the funding to LAND, and answers in BINS —
 * the unit the DLMM program actually rejects on. A pool at 15%/h clears the screener's
 * 20%/h limit and, at bin_step 100, still drifts about 15 bins an hour against a
 * 3-bin tolerance.
 */
export class ActiveBinRaceError extends LiveEntryRefusedError {
  constructor(
    pairName: string,
    poolAddress: string,
    readonly projectedBins: number,
    readonly toleranceBins: number,
    rvolPctPerHour: number | null,
    windowSeconds: number,
  ) {
    super(
      `[live] ${pairName} (pool ${poolAddress}) is moving too fast to fund: ` +
        (rvolPctPerHour === null
          ? "its realized volatility could not be measured"
          : `${rvolPctPerHour.toFixed(1)}%/h of realized volatility projects ` +
            `${projectedBins.toFixed(1)} bin(s) of active-bin drift over the ` +
            `${windowSeconds}s execution window, against a ${toleranceBins}-bin ` +
            `tolerance`) +
        `. Refused before the swap; nothing was signed or spent.`,
      pairName,
      poolAddress,
    );
    this.name = "ActiveBinRaceError";
  }
}

/**
 * The cluster refused the open in simulation, before anything was signed or spent.
 *
 * This is the gate that did not exist on 7 Sep 2026. It is a REFUSAL rather than a
 * fault — the engine skips the pool and moves on, exactly like any other gate — but
 * unlike the others it counts towards the execution breaker, because the chain has
 * said this specific open does not work and repeating it every 30 minutes would burn
 * the entry slot indefinitely.
 */
export class OpenRehearsalFailedError extends LiveEntryRefusedError {
  readonly stage: string;
  constructor(pairName: string, poolAddress: string, stage: string, detail: string) {
    super(
      `[live] ${pairName} (pool ${poolAddress}) failed its pre-swap rehearsal at ` +
        `"${stage}": ${detail}. Nothing was signed, sent or spent.`,
      pairName,
      poolAddress,
      true,
    );
    this.name = "OpenRehearsalFailedError";
    this.stage = stage;
  }
}

/*
 * The program's hard maximum, re-exported from the executor so there is ONE definition.
 *
 * This was 70 until 7 Sep 2026, which was wrong in a way that cost universe coverage:
 * 70 is `DEFAULT_BIN_PER_POSITION`, all a single `initializePosition` allocates, not
 * what the account can hold. Mainnet simulation (nothing sent) confirmed one account
 * reaching 1400 bins via top-level `increasePositionLength` instructions, and 1401
 * failing. Measured against the live 600-pool scan, the gate at 70 admitted 19.2% of
 * the universe; at 1400 it admits 93.2%.
 */
const MAX_DLMM_POSITION_BINS = DLMM_MAX_BINS_PER_POSITION;

/**
 * The OPERATOR's cap on live position width, which is a different question from the
 * program's and is checked separately for that reason.
 *
 * `MAX_DLMM_POSITION_BINS` answers "can this exist on-chain at all". This answers
 * "may live capital go down this code path today". They are deliberately not merged:
 * collapsing them would make a temporary operational decision read months later like
 * a program limit, which is exactly the confusion that made 70 look like a hard
 * maximum until 7 Sep 2026.
 *
 * At the default of 70 the engine is narrow-only — one atomic transaction, the path
 * that has never failed. See `LIVE_MAX_POSITION_BINS` in `env.ts` for what has to be
 * true before it is raised.
 */
export function maxLivePositionBins(): number {
  return Math.min(env.LIVE_MAX_POSITION_BINS, MAX_DLMM_POSITION_BINS);
}

/**
 * Whether the operator cap is doing anything, i.e. whether it is stricter than the
 * program limit that would apply anyway.
 *
 * The candidate filter and the boot line both ask this, because a cap equal to the
 * program maximum should neither filter anything nor claim in the log that it did.
 */
export function isLivePositionBinCapActive(): boolean {
  return maxLivePositionBins() < MAX_DLMM_POSITION_BINS;
}

/**
 * Reads a token balance from the chain rather than trusting the swap's quote.
 *
 * The quote says what Jupiter expected to deliver; only the account says what arrived.
 * Depositing the quoted figure would, on any adverse fill, ask the DLMM program to
 * move tokens the wallet does not have — the transaction fails and the swap's cost has
 * already been paid. Same reasoning as valuing a position from the pool rather than
 * from what we hoped it was worth.
 */
async function readTokenBalance(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
): Promise<bigint> {
  // No account, or an unreadable one. Zero is the safe reading HERE: it deposits nothing
  // on that side rather than asserting a balance we could not confirm.
  return (await readTokenBalanceOrNull(owner, mint, tokenProgramId)) ?? 0n;
}

/**
 * The same read, with "could not read" kept apart from "holds nothing".
 *
 * `readTokenBalance` collapses both to 0n, which is right for a DEPOSIT (deposit nothing
 * you cannot confirm) and wrong for the residual sweep after an exit: there, a zero means
 * "settled, nothing left to sell" and licenses recording the wallet balance as the trade's
 * final effect. An RPC hiccup must not earn that. A token account that does not exist is a
 * genuine zero — the SDK closes nothing here, but a wallet that never held the mint has no
 * ATA — and is reported as one.
 */
async function readTokenBalanceOrNull(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
): Promise<bigint | null> {
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId);

  try {
    const balance = await getConnection().getTokenAccountBalance(ata, "confirmed");
    return BigInt(balance.value.amount);
  } catch (err) {
    try {
      const info = await getConnection().getAccountInfo(ata, "confirmed");
      if (info === null) return 0n;
    } catch {
      // Fall through: neither read answered, so the balance is unknown.
    }
    console.warn(
      `[live] could not read the ${mint.toBase58()} balance: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * The POST-SWAP balance read — retried, and confirmed by a second source.
 *
 * 13 Sep 2026: `NEARKAT-SOL`'s balancing swap CONFIRMED, the very next read of the
 * token account answered `Invalid param: could not find account`, the single unretried
 * attempt below was taken as "nothing arrived", the open aborted, and the auto-unwind
 * sold the tokens back for 0.822476 of the 0.901586 SOL that had just left the wallet —
 * 0.079110 SOL of real money, 8.77% of the swap, spent to learn that an ATA created
 * inside a confirmed swap transaction can briefly be invisible to the next read.
 *
 * The account did exist: seconds later the engine tried to CLOSE it and the Token-2022
 * program refused because it still held a withheld-fee balance. So this is a measurement
 * problem, not a chain problem, and the abort was the expensive reaction to it.
 *
 * Three attempts with a short backoff, then the wallet's FULL token list as an
 * independent second source (both token programs, one call). A genuine zero is still a
 * zero and still aborts the open the way it must — the point is only that "the read did
 * not answer" stops being reported as "the swap delivered nothing".
 *
 * Never throws: the caller already has an unwind for a zero balance, and a read failure
 * here must not become a different exception that skips it.
 */
export interface PostSwapReadDeps {
  readPaired: (
    owner: PublicKey,
    mint: PublicKey,
    tokenProgramId: PublicKey,
  ) => Promise<bigint | null>;
  listBalances: (owner: PublicKey) => Promise<TokenBalanceReading[]>;
  sleep: (ms: number) => Promise<void>;
}

const POST_SWAP_READ_ATTEMPTS = 3;
/**
 * 1.5s then 3s. The swap's destination account is created INSIDE the swap transaction,
 * so the gap being waited out is one node's propagation lag — seconds, not confirmations.
 */
const POST_SWAP_READ_DELAYS_MS = [1500, 3000];

function defaultPostSwapReadDeps(): PostSwapReadDeps {
  return {
    readPaired: (owner, mint, tokenProgramId) =>
      readTokenBalanceOrNull(owner, mint, tokenProgramId),
    listBalances: (owner) => listWalletTokenBalances(owner),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function readPostSwapTokenBalance(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
  deps: PostSwapReadDeps = defaultPostSwapReadDeps(),
): Promise<bigint> {
  for (let attempt = 1; attempt <= POST_SWAP_READ_ATTEMPTS; attempt += 1) {
    let read: bigint | null = null;
    try {
      read = await deps.readPaired(owner, mint, tokenProgramId);
    } catch (err) {
      console.warn(
        `[live] post-swap balance read ${attempt}/${POST_SWAP_READ_ATTEMPTS} threw: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (read !== null && read > 0n) return read;

    if (attempt < POST_SWAP_READ_ATTEMPTS) {
      const delay = POST_SWAP_READ_DELAYS_MS[attempt - 1] ?? 3000;
      console.warn(
        `[live] post-swap balance for ${mint.toBase58()} read as ` +
          `${read === null ? "unreadable" : "zero"} on attempt ${attempt}/` +
          `${POST_SWAP_READ_ATTEMPTS}; retrying in ${delay}ms`,
      );
      try {
        await deps.sleep(delay);
      } catch {
        // A sleep that cannot be taken must not end the loop's evidence gathering.
      }
    }
  }

  /*
   * The second source, and it answers a different question from the retries: not "what
   * does this ATA hold" but "what does the WALLET hold". If the two disagree the wallet
   * is right — it is the account the deposit is funded from.
   */
  try {
    const listed = await deps.listBalances(owner);
    const hit = listed.find((b) => b.mint === mint.toBase58());
    if (hit) {
      console.log(
        `[live] the paired-token read never answered for ${mint.toBase58()}, but the ` +
          `wallet's own token listing shows ${hit.amount} base unit(s) — using it`,
      );
      return BigInt(hit.amount);
    }
  } catch (err) {
    console.warn(
      `[live] the wallet's token listing also failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return 0n;
}

/**
 * The wallet's lamports, for reconciliation bookkeeping only.
 *
 * NEVER throws and never returns 0 as a stand-in: a balance that could not be read is
 * null, exactly as `walletBalance.ts` and the three-state rules elsewhere require. The
 * callers are recording evidence, not gating a spend, so a provider hiccup must cost a
 * measurement and never a trade.
 *
 * Reads the PUBLIC address from the live profile rather than deriving a pubkey from the
 * signing key, so this path never touches secret material.
 */
/**
 * The wallet's balance in SOL for the SIZING GUARD, which is a different contract from
 * `readWalletLamports` below even though both read the same account.
 *
 * That one is bookkeeping: it must never cost a trade, so a failure is null and the
 * caller proceeds. This one GATES a spend, so a failure is null and the caller REFUSES
 * — the null means the same thing, and the two callers are required to do opposite
 * things with it. Kept as its own function so neither contract can be edited into the
 * other by someone reading one call site.
 *
 * A wallet address that is not configured is `null` too, and therefore also a refusal:
 * the live profile cannot verify capital it cannot see, and `runLivePreflight` already
 * refuses to boot in that state.
 */
async function readWalletBalanceForGuard(): Promise<number | null> {
  const address = liveMicroCapital.walletAddress;
  if (!address) return null;
  try {
    return (await getWalletBalanceSol(address)).sol;
  } catch (err) {
    console.warn(
      `[live] the capital guard could not read the wallet balance: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function readWalletLamports(): Promise<number | null> {
  const address = liveMicroCapital.walletAddress;
  if (!address) return null;
  try {
    // `confirmed`, not the provider default: every read here measures the effect of a
    // transaction the executor has just seen CONFIRM. See `getWalletBalanceSol`.
    return (await getWalletBalanceSol(address, { commitment: "confirmed" })).lamports;
  } catch (err) {
    console.warn(
      `[live] could not read the wallet balance for reconciliation: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Opens a real DLMM position, swapping half the SOL into the pool's other token first.
 *
 * WHY THE SWAP. `dlmmExecutor.openPosition` deposits whatever it is given, and the
 * engine's range brackets the active bin (-45%/+15% after `computeBinRange`'s floors).
 * A range spanning the active bin is only two-sided if BOTH tokens are supplied: the
 * program fills bins above the active one from token X and bins below it from token Y.
 * Funding it with SOL alone lands a real but ONE-SIDED position, and the engine's PnL
 * model — `lpValueReturnFraction`, sqrt(r) - 1 — is the balanced-LP formula. The
 * numbers would not describe the position. Swapping to a two-sided deposit is what
 * makes the existing accounting true rather than approximately true.
 *
 * The cost is honest and was accepted: one extra swap per entry, which is friction the
 * 2.5x coverage gate already prices at 2% slippage per leg.
 */
export async function openLivePosition(params: {
  poolAddress: string;
  pairName: string;
  sizeSol: number;
  lowerBinPrice: number;
  upperBinPrice: number;
  strategy: "SPOT" | "BID_ASK" | "CURVE";
  /**
   * The net PnL this entry was admitted on, in USD, from the friction gate that let it
   * through. Used to decide whether the entry's UNRECOVERABLE rent is worth paying.
   *
   * Optional so a caller with no projection (a manual script) is not forced to invent
   * one — and when it is absent the rent check is SKIPPED rather than defaulted, since
   * a made-up projection would either refuse everything or nothing.
   */
  projectedNetPnlUsd?: number | null;
  /** SOL/USD, to price the rent above. Ignored when no projection is supplied. */
  solPriceUsd?: number | null;
}): Promise<LiveOpenOutcome> {
  const auth = authorizeExecution();
  const totalLamports = Math.floor(params.sizeSol * LAMPORTS_PER_SOL);

  // Half to each side. Not a tuning parameter: an equal split is what makes the
  // deposit symmetric around the active bin, which is the shape the PnL model assumes.
  const swapLamports = Math.floor(totalLamports / 2);
  const depositSolLamports = totalLamports - swapLamports;

  /*
   * Two local refusals first, in this order, because neither costs a network call.
   *
   * The DENYLIST is the operator's manual override: "that pool specifically, gone".
   * The BREAKER is its automatic counterpart, and the one that matters more, because
   * it does not need anyone to be awake. On 7 Sep 2026 the same pool was re-elected
   * every 30 minutes and spent real money twice before a human added a denylist entry;
   * the breaker is what closes the window between the first failure and that
   * intervention.
   */
  if (isPoolDenied(poolDenylist, params.poolAddress, params.pairName)) {
    throw new PoolDeniedError(params.pairName, params.poolAddress);
  }

  const benched = assessExecutionBreaker(getPoolExecutionRecord(params.poolAddress));
  if (benched.blocked) {
    throw new ExecutionBenchedError(
      params.pairName,
      params.poolAddress,
      benched.reason ?? "benched",
    );
  }

  /*
   * IS CAPITAL STILL STRANDED FROM AN EARLIER FAILURE? (12 Sep 2026)
   *
   * Before the breaker below, because it is the more literal question: the breaker asks what
   * recent failures COST, this asks whether any of them is still HOLDING something. On
   * 12 Sep 2026 the answer was yes for ten minutes — 1.802543 SOL in a funded position
   * nothing tracked — and nothing in this path would have stopped a second open spending the
   * rest of the wallet while it sat there.
   *
   * Free, local, and before any network call, exactly like the breaker: it reads one row
   * count from `live_execution_attempts`, and it is cleared by the operator/recovery path
   * rather than by time. Inert when the live profile is off.
   */
  const stranded = countUnresolvedOrphanAttempts();
  if (stranded > 0) {
    throw new StrandedCapitalError(params.pairName, params.poolAddress, stranded);
  }

  /*
   * THE FAILED-COST BREAKER — the gate that makes "three failures in one night"
   * structurally impossible, and the only one here that is not about this pool.
   *
   * Every other refusal above asks something about the candidate. This asks about the
   * ENGINE: how much SOL has left the wallet recently on attempts that produced no
   * position. On 11 Sep 2026 that number was 0.0639 SOL across three attempts inside
   * thirty minutes, and nothing anywhere could answer the question, because a failed
   * open writes no position row — correctly — and nothing else wrote anything at all.
   * `live_execution_attempts` is where the spend is now recorded and this is what acts
   * on it.
   *
   * Still free, still local, still before any network call. Infinity disables it.
   */
  if (Number.isFinite(env.LIVE_MAX_FAILED_COST_SOL)) {
    const spent = sumFailedAttemptCost(env.LIVE_FAILED_COST_WINDOW_HOURS);
    const spentSol = spent.lamports / LAMPORTS_PER_SOL;
    if (spentSol > env.LIVE_MAX_FAILED_COST_SOL) {
      throw new FailedCostBreakerError(
        params.pairName,
        params.poolAddress,
        spentSol,
        env.LIVE_MAX_FAILED_COST_SOL,
        spent.attempts,
        spent.unmeasured,
        env.LIVE_FAILED_COST_WINDOW_HOURS,
      );
    }
  }

  /*
   * DOES THE WALLET ACTUALLY HOLD THE CAPITAL THIS ENTRY IS SIZED AGAINST?
   *
   * `params.sizeSol` was produced by `sizeNextPositionSol` from `LIVE_CAPITAL_SOL`
   * minus the reserve — a number in `.env`, which on 11 Sep 2026 was 3.05 while the
   * wallet held 2.880994. The engine read that balance at every boot and printed it,
   * and never once compared the two. The deposit leg then failed on
   * `TransferChecked -> insufficient funds` three times, each time with the balancing
   * swap already confirmed.
   *
   * Checked HERE rather than only at boot because the balance moves and the pin does
   * not: fees, slippage and rent erode the margin between restarts, which is exactly
   * how a pin that was correct when it was set became wrong. One RPC read per entry,
   * against at most one entry per cycle.
   *
   * FAILS CLOSED on an unreadable balance, and never earns the pool a strike — see
   * `LiveSizingError`. Inert when the live profile is off.
   */
  const sizing = assessLiveSizing({ balanceSol: await readWalletBalanceForGuard() });
  if (!sizing.ok) {
    console.error(describeLiveSizing(sizing));
    await sendError(
      "openLivePosition/sizingGuard",
      new Error(describeLiveSizing(sizing)),
    ).catch(() => undefined);
    throw new LiveSizingError(params.pairName, params.poolAddress, sizing);
  }

  const { pairedMint, pairedTokenProgram, binWidth } = await describePair(
    params.poolAddress,
    params.lowerBinPrice,
    params.upperBinPrice,
  );

  /*
   * BACKFILL THE BENCH'S TOKEN, on the way IN.
   *
   * Every failure writer below passes `tokenMint`, and that was still not enough: a row
   * written before the column existed keeps its NULL until the pool fails AGAIN, and
   * "fails again" is the event the bench exists to prevent. On 11 Sep 2026 all six
   * stored rows were NULL, so the token-level bench — which is implemented, tested and
   * correct — was propagating nothing at all while reading as armed.
   *
   * `pairedMint` is the SDK's own answer for the non-SOL side, the same value the
   * strike would be recorded under, so the backfilled key cannot drift from the one the
   * candidate filter looks it up by. It updates only rows that already exist and only
   * where the key is NULL; a pool with no history stays with no history.
   *
   * Diagnostic, so it is wrapped: a bookkeeping failure must not refuse an entry.
   */
  try {
    learnPoolExecutionToken(params.poolAddress, pairedMint.toBase58());
  } catch (bookkeeping) {
    console.warn(
      `[live] could not backfill the bench token for ${params.pairName}:`,
      bookkeeping,
    );
  }

  /*
   * THE SAME BENCH, ASKED ABOUT THE TOKEN.
   *
   * The check above asks only about this pool ADDRESS, and one token routinely has
   * several DLMM pools at different bin steps. Observed live on 9 Sep 2026: OTC-SOL
   * (Muk/SOL) exists as four pools, one was benched at 13:32 and a SIBLING was opened
   * at 21:22, because nothing ever asked the bench about that address. The operator's
   * same-day mitigation was to put the PAIR NAME in `POOL_DENYLIST`, which
   * `isPoolDenied` matches across siblings — a manual version of this check.
   *
   * It sits HERE, not beside the per-pool check, because naming the token needs
   * `describePair` — `pairedMint` is the SDK's own answer for the non-SOL side, so the
   * key cannot drift from the one the strike is recorded under below. Still free, and
   * still well before the balancing swap spends anything.
   *
   * The candidate filter in `seekNewEntry` applies the same rule before the LLM ever
   * sees the list; this is the second line, for the window between a cycle building
   * its candidates and acting on one.
   */
  const tokenKey = benchTokenKey(pairedMint.toBase58(), WSOL_MINT);
  if (tokenKey) {
    const siblings = indexExecutionHistory(getPoolExecutionRecords()).byToken.get(tokenKey);
    const tokenBench = assessTokenBench(siblings, params.poolAddress);
    if (tokenBench.blocked) {
      throw new TokenBenchedError(
        params.pairName,
        params.poolAddress,
        tokenBench.reason ?? "a sibling pool of this token is benched",
      );
    }
  }

  /*
   * Two gates BEFORE the balancing swap spends anything, because a failure after the
   * swap strands an unmonitored memecoin balance (7 Sep 2026, 0.4 SOL).
   * `seekNewEntry` treats BinWidthExceededError as a routine skip, not a fault.
   */
  if (binWidth > MAX_DLMM_POSITION_BINS) {
    throw new BinWidthExceededError(
      params.pairName,
      binWidth,
      params.poolAddress,
      `the DLMM one-position maximum of ${MAX_DLMM_POSITION_BINS} bins`,
    );
  }

  /*
   * The operator cap, checked after the program limit and reported as its own reason.
   * A pool refused here is refused by CONFIGURATION and can be admitted by changing a
   * setting; one refused above cannot. Saying which is which is the difference between
   * an operator raising `LIVE_MAX_POSITION_BINS` and an operator hunting a bug.
   */
  if (binWidth > maxLivePositionBins()) {
    throw new BinWidthExceededError(
      params.pairName,
      binWidth,
      params.poolAddress,
      `the operator cap LIVE_MAX_POSITION_BINS=${maxLivePositionBins()} ` +
        `(the wide create-then-fund path is not yet validated by a funded open)`,
    );
  }

  /*
   * Rent affordability. A range can be perfectly legal on-chain and still be
   * unfundable, and the two costs behave differently:
   *
   *  - the POSITION account's rent scales with the width (0.057 SOL at 70 bins,
   *    0.996 at 1400) and is always charged;
   *  - BIN ARRAY rent is 0.0714 SOL per array that does not exist yet, and a wide
   *    range spans many. On a liquid pool they already exist and this is zero; on a
   *    fresh one it is the LARGER of the two. Estimating it from the width would be
   *    wrong in both directions, so the SDK is asked instead — it reads the chain.
   *
   * The budget is what the envelope leaves over after exposure and the reserve, which
   * is exactly the "rent headroom" the 1.15 SOL capital base exists to provide.
   *
   * Skipped entirely when the live micro-capital profile is off, so an unarmed engine
   * behaves exactly as it did before this gate existed.
   */
  /*
   * Carried out of the block below so the execution-time volatility gate can convert a
   * rate of price movement into bins. Null means the quote never ran, which the gate
   * REPORTS rather than treats as clear — the same lesson as the log line that used to
   * claim "all bin arrays exist" on a path that had checked nothing.
   */
  let poolBinStep: number | null = null;

  if (liveMicroCapital.enabled) {
    const cost = await quoteOpenCost({
      poolAddress: params.poolAddress,
      lowerBinPrice: params.lowerBinPrice,
      upperBinPrice: params.upperBinPrice,
      strategy: params.strategy,
    });
    poolBinStep = cost.binStep;
    const rentBudgetSol = liveMicroCapital.deployableSol - liveMicroCapital.maxExposureSol;

    if (cost.totalSol > rentBudgetSol) {
      throw new BinWidthExceededError(
        params.pairName,
        binWidth,
        params.poolAddress,
        `the ${rentBudgetSol.toFixed(4)} SOL rent budget (opening it costs ` +
          `${cost.totalSol.toFixed(4)} SOL: ${cost.positionSol.toFixed(4)} position + ` +
          `${cost.binArraySol.toFixed(4)} for ${cost.binArraysToCreate} new bin arrays; ` +
          `raise LIVE_CAPITAL_SOL to admit it)`,
      );
    }

    /*
     * IS IT WORTH IT — as distinct from "can I afford it", which is the gate above.
     *
     * `cost.binArraySol` is the CHAIN's answer for this exact range, not an estimate:
     * zero on a pool whose arrays already exist, 0.0714 SOL for each one that does not.
     * That rent is never recovered, so an entry creating arrays starts the trade down
     * by that amount, and the screening gates that admitted it priced only gas and
     * slippage. On a $1.50 projected net a single new array is roughly a $7 hole.
     *
     * Checked here, before the swap, so the refusal is free. Skipped when the caller
     * supplied no projection — inventing one would make this gate either vacuous or
     * absolute — and disabled entirely by `LIVE_MAX_RENT_TO_PNL=Infinity`.
     */
    const projected = params.projectedNetPnlUsd;
    const solPriceUsd = params.solPriceUsd;
    if (
      cost.binArraySol > 0 &&
      Number.isFinite(liveMicroCapital.maxRentToPnl) &&
      typeof projected === "number" &&
      Number.isFinite(projected) &&
      typeof solPriceUsd === "number" &&
      solPriceUsd > 0
    ) {
      const rentUsd = cost.binArraySol * solPriceUsd;
      if (rentUsd > projected * liveMicroCapital.maxRentToPnl) {
        throw new UnrecoverableRentError(
          params.pairName,
          params.poolAddress,
          rentUsd,
          projected,
          cost.binArraysToCreate,
          liveMicroCapital.maxRentToPnl,
        );
      }
    }

    /*
     * THE PER-TRANSACTION SPEND CEILING, CHECKED HERE RATHER THAN AFTER THE SWAP.
     *
     * `dlmmExecutor.openPosition` charges deposit + rent to `assertWithinSpendLimit`,
     * which is correct — but every one of those calls happens AFTER the balancing swap
     * has confirmed. A wide position's account rent approaches 1 SOL, so
     * `deposit + positionRent + binArrayRent` can breach a ceiling set to the position
     * size, and the resulting `ExecutionLimitError` lands with the swap already spent
     * and a memecoin to unwind. That is a configuration error producing a stranded
     * swap — exactly the shape of failure every gate in this function exists to move
     * in front of the spend.
     *
     * The rehearsal below cannot catch it either: it simulates against the CLUSTER,
     * which knows nothing about our own ceiling.
     *
     * Deliberately checked against the worst of the two shapes the executor will
     * actually assert, not their sum: the wide path splits rent and deposit across
     * separate transactions, the narrow path sends one. Asserting the sum would refuse
     * wide positions the executor would have accepted.
     */
    /*
     * THE WIDENED DEPOSIT, not the nominal one.
     *
     * The executor charges `maxDepositLamports(amount, depositCeilingFactor)` to
     * `assertWithinSpendLimit` (onchainExecutor.ts, both paths), because the SDK lets
     * the program pull `amount x (100 + activeBinSlippagePct) / 100`. This gate charged
     * the nominal figure, so a deposit sitting just under the ceiling passed HERE and
     * was refused THERE — after the balancing swap had spent. Advertised bound, larger
     * enforced bound: the same defect class this file has already fixed for bin-array
     * rent and for the coverage gate, pointing the other way.
     *
     * `poolBinStep` is the same value the executor will resolve the tolerance against,
     * so the two figures cannot disagree.
     */
    const depositLamports = maxDepositLamports(
      totalLamports - swapLamports,
      depositSlippage(auth, cost.binStep).depositCeilingFactor,
    );
    const positionRentLamports = Math.ceil(cost.positionSol * LAMPORTS_PER_SOL);
    const binArrayRentLamports = Math.ceil(cost.binArraySol * LAMPORTS_PER_SOL);
    const narrowPathLamports = depositLamports + positionRentLamports + binArrayRentLamports;
    const widePathLamports = Math.max(
      positionRentLamports,
      depositLamports + binArrayRentLamports,
    );
    /*
     * `DLMM_BINS_PER_INIT`, not a literal 70. The same boundary is decided three times
     * in this file and the other two already read the constant, which
     * `onchainExecutor.test.ts` binds to the installed SDK. A hand-written copy is
     * invisible to that test, so an SDK bump would move the real narrow/wide boundary
     * while this line kept charging the wrong transaction shape against the spend
     * ceiling — the failure mode is a refusal after the swap, which is what every gate
     * in this function exists to move in front of the spend. CLAUDE.md says not to
     * hand-write these constants; this was one.
     */
    const worstLamports = binWidth <= DLMM_BINS_PER_INIT ? narrowPathLamports : widePathLamports;

    if (worstLamports > onchainConfig.maxLamportsPerTx) {
      throw new BinWidthExceededError(
        params.pairName,
        binWidth,
        params.poolAddress,
        `ONCHAIN_MAX_LAMPORTS_PER_TX (${(onchainConfig.maxLamportsPerTx / LAMPORTS_PER_SOL).toFixed(4)} ` +
          `SOL): opening it needs one transaction to move ` +
          `${(worstLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
          `(${(depositLamports / LAMPORTS_PER_SOL).toFixed(4)} max deposit after the ` +
          `active-bin slippage widening + ` +
          `${cost.positionSol.toFixed(4)} position rent + ${cost.binArraySol.toFixed(4)} bin arrays). ` +
          `Raise the ceiling; it bounds the transaction, not the position`,
      );
    }

    console.log(
      `[live] ${params.pairName}: ${binWidth} bins, open cost ${cost.totalSol.toFixed(4)} SOL ` +
        `of a ${rentBudgetSol.toFixed(4)} SOL rent budget, ` +
        `worst single tx ${(worstLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL of a ` +
        `${(onchainConfig.maxLamportsPerTx / LAMPORTS_PER_SOL).toFixed(4)} SOL ceiling, ` +
        `~${cost.transactionCount} tx`,
    );
  }

  /*
   * EXECUTION-TIME VOLATILITY — will this pool hold still long enough to fund?
   *
   * Added 9 Sep 2026, with the two fixes it belongs to: the deposit's active-bin
   * tolerance now has its own bound (it used to inherit Jupiter's 0.5%, which is ONE
   * bin on most of the universe), and the funding transactions are rebuilt against a
   * fresh active bin when their blockhash expires. This gate is the third leg: some
   * pools move faster than any tolerance worth sending, and the cheapest response is
   * to not start.
   *
   * The arithmetic is deliberately crude and deliberately in BINS. `binStep` is bps,
   * so one bin is `binStep/100` percent of price; realized volatility in percent per
   * hour therefore divides straight into bins per hour, and the execution window
   * scales it. It is an order-of-magnitude check, not a forecast — which is why the
   * default ratio is 1 rather than something finer.
   *
   * FAILS AS THE SCREENER DOES. `VOLATILITY_ON_UNKNOWN` already answers "what do we do
   * when volatility cannot be measured" for this engine, and answering it twice, two
   * different ways, is how one concept becomes two configurations. Default is reject.
   */
  if (Number.isFinite(env.LIVE_MAX_BIN_DRIFT_RATIO)) {
    if (poolBinStep === null) {
      console.warn(
        `[live] ${params.pairName}: NO BIN-DRIFT CHECK — the open cost quote did not ` +
          `run (LIVE_MICRO_CAPITAL is off), so the pool's bin step is unknown and the ` +
          `execution-time volatility gate was skipped, not passed`,
      );
    } else {
      const tolerance = depositSlippage(auth, poolBinStep);
      const rvol = await fetchRealizedVolatilityPctPerHour(params.poolAddress);

      if (rvol === null) {
        if (env.VOLATILITY_ON_UNKNOWN === "reject") {
          throw new ActiveBinRaceError(
            params.pairName,
            params.poolAddress,
            Number.NaN,
            tolerance.bins,
            null,
            env.LIVE_EXECUTION_WINDOW_SECONDS,
          );
        }
        console.warn(
          `[live] ${params.pairName}: realized volatility unavailable; admitted by ` +
            `VOLATILITY_ON_UNKNOWN=allow`,
        );
      } else {
        const binsPerHour = rvol / (poolBinStep / 100);
        const projectedBins = binsPerHour * (env.LIVE_EXECUTION_WINDOW_SECONDS / 3600);
        const limitBins = tolerance.bins * env.LIVE_MAX_BIN_DRIFT_RATIO;

        if (projectedBins > limitBins) {
          throw new ActiveBinRaceError(
            params.pairName,
            params.poolAddress,
            projectedBins,
            tolerance.bins,
            rvol,
            env.LIVE_EXECUTION_WINDOW_SECONDS,
          );
        }

        console.log(
          `[live] ${params.pairName}: bin drift ${projectedBins.toFixed(2)} bin(s) ` +
            `projected over ${env.LIVE_EXECUTION_WINDOW_SECONDS}s ` +
            `(${rvol.toFixed(1)}%/h at bin_step ${poolBinStep}) against a ` +
            `${tolerance.bins}-bin tolerance x ${env.LIVE_MAX_BIN_DRIFT_RATIO}`,
        );
      }
    }
  }

  /*
   * DRESS REHEARSAL — the last gate before anything is spent, and the only one that
   * catches a failure nobody anticipated.
   *
   * Every other gate here names a condition and checks it: the width, the rent, the
   * denylist. This one asks the CLUSTER to run the account-creation transactions and
   * reports what it says. That is the difference between the gates that existed on
   * 7 Sep 2026 and the failure that got through them — a compute-budget overflow that
   * no named condition would have caught, discovered only after the swap had spent and
   * a position account had been created and abandoned.
   *
   * It cannot rehearse the liquidity phase, because that deposits a token the wallet
   * does not hold until the swap below. `rehearseOpenPosition` documents that boundary
   * honestly rather than implying wider cover than it has; the liquidity phase is
   * protected instead by the SDK's own compute budget now being honoured.
   *
   * A rehearsal the RPC could not RUN is not a refusal — it yields no failure and the
   * open proceeds. Failing closed on a provider outage would stop all trading for a
   * reason that has nothing to do with the pool.
   */
  const rehearsal = await rehearseOpenPosition({
    poolAddress: params.poolAddress,
    lowerBinPrice: params.lowerBinPrice,
    upperBinPrice: params.upperBinPrice,
    wallet: auth.wallet,
  });

  if (!rehearsal.ok && rehearsal.failure) {
    const failure = rehearsal.failure;
    const meter = failure.logs?.find((line) => /compute|exceeded/i.test(line));

    /*
     * Counted against the pool even though NOTHING WAS SPENT. The cost of a refused
     * rehearsal is not gas, it is the entry slot: `seekNewEntry` opens at most one
     * position per cycle and returns as soon as its chosen pool is refused, so a pool
     * the chain will always reject would otherwise consume every 30-minute cycle
     * forever while the engine reports itself healthy.
     *
     * UNLESS the refusal was the WALLET's fault. A simulation that failed for want of
     * lamports would fail identically on every pool, so counting it would let one
     * wallet-level fact bench the universe a pool at a time. The open is refused either
     * way; only the strike is withheld.
     */
    if (rehearsal.poolAttributable) {
      try {
        recordPoolExecutionFailure({
          poolAddress: params.poolAddress,
          pairName: params.pairName,
          stage: `rehearsal/${failure.stage}`,
          reason: (failure.error ?? "simulation refused").slice(0, 500),
          // The SDK's own answer for the non-SOL side, so the key a bench is stored
          // under cannot drift from the one the candidate filter looks it up by.
          tokenMint: pairedMint.toBase58(),
        });
      } catch (bookkeeping) {
        console.warn(`[live] could not record the rehearsal failure for ${params.pairName}:`, bookkeeping);
      }
    } else {
      console.warn(
        `[live] ${params.pairName}: rehearsal refused for a WALLET-level reason, not a ` +
          `pool one - refusing the entry but not counting a strike against the pool`,
      );
    }

    throw new OpenRehearsalFailedError(
      params.pairName,
      params.poolAddress,
      failure.stage,
      `${failure.error}` +
        (failure.unitsConsumed !== null
          ? ` (used ${failure.unitsConsumed} of ${failure.computeUnitLimit} CU)`
          : "") +
        (meter ? ` — ${meter}` : ""),
    );
  }

  for (const step of rehearsal.tight) {
    console.warn(
      `[live] ${params.pairName}: rehearsal step "${step.stage}" used ` +
        `${step.unitsConsumed} of ${step.computeUnitLimit} CU — within 10% of its budget`,
    );
  }

  /*
   * Say plainly what was and was not checked, and never assert more than that.
   *
   * This line used to print "no account creation needed (all bin arrays exist)"
   * whenever no step ran — which on the NARROW path is always, because the narrow
   * path's inits are fused into the open and are deliberately not rehearsed. So on a
   * narrow range that was about to create bin arrays, the log stated the opposite of
   * the truth about the one cost this engine can never recover (0.0714 SOL each,
   * pool-level accounts, no wrapper in the SDK to close them).
   *
   * Under a narrow-only cap this is EVERY entry, which is the part worth stating out
   * loud: `LIVE_MAX_POSITION_BINS` at 70 means the rehearsal never simulates anything
   * and `preCreateMissingBinArrays` never runs, so the whole pre-swap apparatus built
   * after 7-8 Sep 2026 is inert and the narrow path's only protection is the SDK
   * simulating its own fused transaction. True and adequate — but it must not read as
   * "verified".
   */
  const arrays =
    rehearsal.binArraysToCreate > 0
      ? `${rehearsal.binArraysToCreate} bin array(s) still to create ` +
        `(~${(rehearsal.binArraysToCreate * DLMM_BIN_ARRAY_RENT_SOL).toFixed(4)} SOL of ` +
        `UNRECOVERABLE rent)`
      : `all bin arrays already exist`;

  console.log(
    rehearsal.steps.length === 0
      ? `[live] ${params.pairName}: NOTHING WAS REHEARSED - ` +
        (rehearsal.fusedIntoOpen
          ? `narrow range (${rehearsal.binWidth} bins), so the inits are fused into the ` +
            `open and the SDK budgets that transaction by simulating it itself`
          : `no account creation needed`) +
        `; ${arrays}; the deposit itself cannot be simulated before the swap that funds it`
      : `[live] ${params.pairName}: rehearsal clean (${rehearsal.steps.length} transaction(s), ` +
        `${arrays})`,
  );

  /*
   * THE RECONCILIATION ANCHOR — the last read before anything is spent.
   *
   * Everything downstream that says what this trade "made" is the paper valuation
   * model, the same one that values simulated positions. It cannot see the swap's
   * slippage, the priority fees, or the bin-array rent that never returns, and
   * `closeLivePosition` returns signatures only, so nothing ever asked the chain what
   * came back. Recording the balance here and again after the close makes the trade's
   * real effect on the wallet a MEASUREMENT rather than an inference.
   *
   * Best effort by design: a failed read is null and the open proceeds. Refusing to
   * trade because a bookkeeping read failed would fail closed on the wrong thing —
   * this is diagnostics, and every gate that protects capital has already passed.
   */
  const walletLamportsBefore = await readWalletLamports();

  console.log(
    `[live] ${params.pairName}: swapping ${(swapLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
      `-> ${pairedMint.toBase58()} to balance the deposit`,
  );

  /*
   * PRE-CREATE MISSING BIN ARRAYS — BEFORE ANY SPEND. Only for wide ranges: a wide
   * position's funding transactions are built by the SDK AFTER the swap, and the SDK
   * packs every bin array the range still needs into the first funding transaction as
   * InitializeBinArray instructions. Two of them exceed any compute budget that fits
   * with the liquidity work (measured twice with real money on 7 Sep 2026: STONK-SOL
   * 0.2657 SOL of orphaned rent, SOLCAT-SOL another 0.0572). The rehearsal cannot see
   * it — the funding phase cannot be simulated before the swap funds the deposit —
   * and the executor's own post-swap prep runs after the swap has already spent.
   *
   * Creating the arrays HERE means every post-swap transaction is pure liquidity.
   * A failure at this stage costs nothing: no swap has happened, so the entry is a
   * routine refusal instead of a stranded balance.
   */
  if (binWidth > DLMM_BINS_PER_INIT) {
    try {
      const prep = await dlmmExecutor.ensureBinArrays(auth, {
        poolAddress: params.poolAddress,
        lowerBinPrice: params.lowerBinPrice,
        upperBinPrice: params.upperBinPrice,
      });
      if (prep.created > 0) {
        console.log(
          `[live] ${params.pairName}: pre-created ${prep.created} bin array(s) ` +
            `(${prep.existed} already existed) BEFORE the swap`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const walletOrInfra = /insufficient|balance|lamports|rate.?limit|timeout|fetch|network|429/i.test(
        reason,
      );
      if (!walletOrInfra) {
        try {
          recordPoolExecutionFailure({
            poolAddress: params.poolAddress,
            pairName: params.pairName,
            stage: "bin-array-prep",
            reason: reason.slice(0, 500),
            tokenMint: pairedMint.toBase58(),
          });
        } catch (bookkeeping) {
          console.warn(
            `[live] could not record bin-array-prep failure for ${params.pairName}:`,
            bookkeeping,
          );
        }
      }
      throw new OpenRehearsalFailedError(
        params.pairName,
        params.poolAddress,
        "bin-array-prep",
        reason,
      );
    }
  }

  const { result: swap } = await executeJupiterSwapFreshQuote(auth, {
    inputMint: WSOL_MINT,
    outputMint: pairedMint.toBase58(),
    amountLamports: swapLamports,
  }, "balancing swap");

  /*
   * FROM HERE THE SWAP HAS SPENT. Everything below is inside the try, and that
   * placement is load-bearing rather than tidy.
   *
   * The balance read and the zero check used to sit OUTSIDE it. Both can fail after a
   * confirmed swap — an RPC error on the read, or a balance that comes back zero — and
   * outside the try neither the auto-unwind nor the execution-breaker bookkeeping ran.
   * That made it the one path that leaves an unmonitored memecoin in the wallet AND
   * leaves no record that the pool cost anything, which is precisely the combination
   * the breaker exists to notice. A zero balance now falls into the catch as well, so
   * the rescue at least RE-READS the chain before concluding there is nothing to sell.
   *
   * 13 Sep 2026: the read itself is no longer a single attempt. `readPostSwapTokenBalance`
   * retries three times and then asks the wallet's full token listing, because that
   * evening one unretried read of an ATA the swap had just created cost 0.079110 SOL of
   * real money in a forced round trip. A zero from that function is now a measured zero.
   */
  let pairedAmount = 0n;

  try {
    // The chain, not the quote.
    pairedAmount = await readPostSwapTokenBalance(auth.wallet, pairedMint, pairedTokenProgram);

    if (pairedAmount === 0n) {
      throw new Error("the swap confirmed but no token balance could be read");
    }

    const opened = await dlmmExecutor.openPosition(auth, {
      poolAddress: params.poolAddress,
      amountLamports: depositSolLamports,
      pairedTokenAmount: Number(pairedAmount),
      lowerBinPrice: params.lowerBinPrice,
      upperBinPrice: params.upperBinPrice,
      strategy: params.strategy,
    });

    const openSignature = opened.sent[0]?.signature;
    if (!openSignature) {
      // Unreachable: sendAndConfirm either returns a signature or throws. Guarded
      // because a row written without one describes a position nothing can prove.
      throw new Error("openPosition returned no signature");
    }

    console.log(
      `[live] ${params.pairName}: position ${opened.position} opened (${openSignature})`,
    );

    /*
     * A confirmed open clears the pool's consecutive-failure run. Recorded here rather
     * than by the caller because this is the only place that knows the open CONFIRMED
     * — the same reason no position row is written anywhere else. Diagnostic, so it is
     * wrapped: a breaker bookkeeping error must never turn a successful, already-paid
     * open into a thrown failure that the caller would then treat as no position.
     */
    try {
      recordPoolExecutionSuccess(params.poolAddress, params.pairName);
    } catch (bookkeeping) {
      console.warn(`[live] could not clear the execution breaker for ${params.pairName}:`, bookkeeping);
    }

    /*
     * The attempt ledger records SUCCESSES too, not only the failures it was built for.
     *
     * A budget summed only from failures cannot be sanity-checked against anything: an
     * operator reading "0.04 SOL of failures" has no denominator. More importantly the
     * successful row's `wallet_lamports_after` is deliberately LEFT NULL here — the
     * open has confirmed but the position is still open, so there is no "after" yet and
     * the honest cost is not measurable. Writing the pre-open balance into both columns
     * would manufacture a zero cost, which is the "unmeasured counted as zero" mistake
     * `est_gas_cost_usd` and `driftPctOfModel` both exist to avoid.
     */
    try {
      recordLiveExecutionAttempt({
        poolAddress: params.poolAddress,
        pairName: params.pairName,
        tokenMint: pairedMint.toBase58(),
        outcome: "opened",
        stage: null,
        walletLamportsBefore,
        walletLamportsAfter: null,
        unwind: "none",
        swapSignature: swap.signature,
        rescueSignature: null,
        positionAddress: opened.position,
        reason: null,
      });
    } catch (bookkeeping) {
      console.warn(`[live] could not record the open attempt for ${params.pairName}:`, bookkeeping);
    }

    return {
      positionAddress: opened.position,
      openSignature,
      swapSignature: swap.signature,
      depositedSolLamports: depositSolLamports,
      /*
       * The EXECUTOR's figure, not this function's earlier read. The narrow path may
       * re-quote the deposit down when the pre-send simulation finds the account short,
       * and reporting what we intended rather than what the chain was asked for is how a
       * database figure starts disagreeing with the position it describes.
       */
      depositedPairedAmount: opened.depositedPairedAmount,
      walletLamportsBefore,
    };
  } catch (err) {
    /*
     * FIRST, THE POSITION; THEN THE WALLET. The order is the fix.
     *
     * `DlmmPartialExecutionError` is the executor saying some of the open's transactions
     * LANDED. On the wide path that means the position account exists and may already
     * hold liquidity — a live, fee-earning, price-exposed position that no database row
     * describes and therefore no monitor watches and no stop-loss protects. Until 10 Sep
     * 2026 the only remediation here was the wallet auto-unwind below, which addresses
     * the leftover TOKENS and is blind to the POSITION; a partially funded KNOTS-SOL
     * position ran unwatched for four hours while the engine reported an empty book.
     *
     * Closing it first is also what makes the unwind complete: the withdrawal returns
     * the paired token to the wallet, so the re-read below picks it up and sells it in
     * the same pass. Reversed, the unwind would run against a balance the position was
     * still holding.
     *
     * Only for a partial execution, because only that error names a position address.
     * Every other failure means the open never created one.
     */
    const orphan =
      err instanceof DlmmPartialExecutionError
        ? await recoverPartiallyFundedPosition(
            {
              pairName: params.pairName,
              poolAddress: params.poolAddress,
              positionAddress: err.position,
            },
            (p) => dlmmExecutor.closeOrphanPosition(auth, p),
          )
        : null;

    /*
     * Auto-unwind, best effort: the balancing swap has already moved SOL into the
     * paired token, so a failed open must put the wallet back to SOL — not leave an
     * unmonitored memecoin balance behind. Sell the CURRENT on-chain balance (re-read:
     * a partial open may have consumed some, and the recovery above may have returned
     * some), then report the failure, the recovery and the rescue outcome in the alert.
     */
    let rescueSignature: string | null = null;
    let rescueError: string | null = null;
    let rescueBalance: bigint | null = null;
    try {
      const current = await readTokenBalance(auth.wallet, pairedMint, pairedTokenProgram);
      rescueBalance = current;
      if (current > 0n) {
        const rescue = await executeJupiterSwapFreshQuote(auth, {
          inputMint: pairedMint.toBase58(),
          outputMint: WSOL_MINT,
          amountLamports: Number(current),
          /*
           * An EXIT leg: this swap exists to put the wallet back into SOL, and the same
           * 50 bps entry bound that governs a fresh entry must not be what strands the
           * token here. 13 Sep 2026 is the worked example — a residual sale refused at
           * 0.5% and finished by hand while the price moved.
           */
          leg: "exit",
        }, "auto-unwind after a failed open");
        rescueSignature = rescue.result.signature;
      }
    } catch (rescueErr) {
      rescueError = rescueErr instanceof Error ? rescueErr.message : String(rescueErr);
    }

    /*
     * The unwind empties the paired-token account the balancing swap created, and nothing
     * else would ever close it — so its rent goes back here too, not only on a clean exit.
     * Only after an unwind that did not fail, and never while a funded position could not
     * be recovered (a human will close it, and its withdrawal needs somewhere to land).
     * The executor re-reads the account and leaves it alone if anything is still in it.
     * Before the cost read below, so the rent that came back is not charged as cost.
     */
    const tokenAccount =
      rescueError === null &&
      orphan?.state !== "failed" &&
      (rescueSignature !== null || rescueBalance === 0n)
        ? await reclaimEmptyTokenAccount(
            { pairName: params.pairName, mint: pairedMint.toBase58() },
            () =>
              closeEmptyTokenAccount(auth, {
                mint: pairedMint.toBase58(),
                tokenProgram: pairedTokenProgram.toBase58(),
              }),
          )
        : TOKEN_ACCOUNT_SKIPPED;

    /*
     * Count it against the pool BEFORE reporting. This is the failure that costs money
     * — the swap confirmed and the open did not — and it is exactly the one that
     * repeated on 7 Sep 2026 because nothing remembered it. Wrapped for the same
     * reason as the success path: bookkeeping must not replace the real error.
     */
    try {
      recordPoolExecutionFailure({
        poolAddress: params.poolAddress,
        pairName: params.pairName,
        stage: "open",
        reason: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        tokenMint: pairedMint.toBase58(),
      });
    } catch (bookkeeping) {
      console.warn(`[live] could not record the execution failure for ${params.pairName}:`, bookkeeping);
    }

    /*
     * WHAT DID THIS COST, AND IS ANYTHING STILL ON-CHAIN?
     *
     * Read AFTER the recovery and the unwind, so the balance reflects everything that
     * came back. This is the number the 11 Sep 2026 incident had to be reconstructed
     * from two hand-taken snapshots because nothing in the engine recorded it: three
     * attempts, -0.0639 SOL, zero rows, zero PnL, a clean snapshot table.
     *
     * Null when either read failed, never 0 — an unmeasured cost silently counted as
     * free would deflate the budget `FailedCostBreakerError` enforces, which is the one
     * gate standing between this failure and its fourth repetition.
     */
    const walletLamportsAfter = await readWalletLamports();
    const costLamports =
      walletLamportsBefore !== null && walletLamportsAfter !== null
        ? walletLamportsBefore - walletLamportsAfter
        : null;
    const unwind = classifyUnwind(orphan, rescueSignature, rescueError);

    try {
      recordLiveExecutionAttempt({
        poolAddress: params.poolAddress,
        pairName: params.pairName,
        tokenMint: pairedMint.toBase58(),
        outcome: "failed",
        stage: "open",
        walletLamportsBefore,
        walletLamportsAfter,
        unwind,
        swapSignature: swap.signature,
        rescueSignature,
        positionAddress: orphan?.position ?? null,
        reason: err instanceof Error ? err.message : String(err),
        ataCloseSignature: tokenAccount.signature,
      });
    } catch (bookkeeping) {
      console.warn(`[live] could not record the failed attempt for ${params.pairName}:`, bookkeeping);
    }

    const stranded = new StrandedSwapError(
      pairedMint.toBase58(),
      // Zero here means the balance never read back, not that the swap delivered
      // nothing — the rescue above re-read the chain and is the authority on that.
      pairedAmount === 0n ? "0 (balance never read back after a confirmed swap)" : pairedAmount.toString(),
      swap.signature,
      err,
      rescueSignature,
      rescueError,
      orphan,
      costLamports,
      unwind,
    );
    console.error(stranded.message);
    // Best effort: a failed page must not swallow the original failure.
    await sendError("openLivePosition/stranded", stranded).catch(() => undefined);
    throw stranded;
  }
}

/* ------------------------------------------------------------------ */
/* Residual sweep — the exit's second half                             */
/* ------------------------------------------------------------------ */

/**
 * Below this many lamports of estimated SOL out, a residual balance is DUST: left where it
 * is, and the exit counts as settled.
 *
 * 0.001 SOL. A Jupiter sell costs a base fee plus a priority fee that `sendAndConfirm`
 * escalates on a rebuild, so selling much less than this can spend more than it recovers,
 * and a route for a crumb is the likeliest quote to fail and page a human over nothing.
 * Against the positions this engine opens (~0.8-1.8 SOL) it is well under a tenth of a
 * percent, which is below what the reconciliation can meaningfully resolve anyway.
 */
export const RESIDUAL_DUST_LAMPORTS = 1_000_000;

/**
 * What became of the paired token a close returned to the wallet.
 *
 *  - `swept`      a sell back to SOL CONFIRMED.
 *  - `dust`       nothing worth selling was there (zero, or quoted under the dust line).
 *  - `failed`     there was something to sell and the sell (or its quote) did not land.
 *  - `unmeasured` the balance or the pool's paired mint could not be read, so nobody
 *                 knows whether value is still sitting in the token.
 *
 * Only the first two are SETTLED — the state in which the wallet's SOL balance is the
 * trade's final effect and may be recorded as `wallet_lamports_after`.
 *
 * The `residual_sweep` column can hold one more value the engine never writes, `operator`
 * (see `scripts/settleResidualByHand.cjs` and `reconciliation.ts`).
 */
export type ResidualSweepState = "swept" | "dust" | "failed" | "unmeasured";

export interface ResidualSweep {
  state: ResidualSweepState;
  /** The paired mint, or null when it could not be resolved. */
  mint: string | null;
  /** Base units found in the wallet. String: it can exceed 2^53. Null when unread. */
  amount: string | null;
  /** Jupiter's quoted SOL out for `amount`, in lamports, or null when never quoted. */
  estimatedLamports: number | null;
  /** The confirmed sell, when there was one. */
  signature: string | null;
  error: string | null;
  /** Which route sold it, when one did. Optional so rows and fixtures written before it still type. */
  route?: "jupiter" | "dlmm-pool";
  /** The slippage bound of the rung that sold (the exit cap for the pool route). */
  slippageBps?: number;
}

/** Whether the wallet balance after this sweep is the trade's final effect. */
export function isSettledSweep(sweep: Pick<ResidualSweep, "state">): boolean {
  return sweep.state === "swept" || sweep.state === "dust";
}

/**
 * Everything the sweep touches, injected so the whole decision is testable offline.
 * The production implementation is `defaultResidualSweepDeps`, which reaches the chain
 * only through `executeJupiterSwap` — the swap path every entry and every failed-open
 * unwind already uses. There is deliberately no second swap path.
 */
export interface ResidualSweepDeps {
  resolvePairedMint(): Promise<string>;
  /** Null when the balance could not be READ; 0n only when it is genuinely zero. */
  readBalance(mint: string): Promise<bigint | null>;
  /** Estimated SOL out, in lamports. Read-only. `slippageBps` defaults to the exit cap. */
  quoteToSol(mint: string, amount: bigint, slippageBps?: number): Promise<number>;
  /**
   * Sells `amount` to SOL and returns the CONFIRMED signature, or throws.
   *
   * `slippageBps` is the EXIT-leg bound for THIS attempt — the sweep walks a ladder, so a
   * failure at 0.5% is retried wider rather than repeated at the same width.
   */
  swapToSol(mint: string, amount: bigint, slippageBps?: number): Promise<string>;
  /** Pages the operator. Its own failure is swallowed by the caller. */
  alert(message: string): Promise<unknown>;
  /**
   * The LAST RESORT, after every Jupiter rung failed: quote selling `amount` straight into
   * the pool the position just left. Optional so a caller without a pool (and every
   * existing test harness) keeps the ladder-then-page behaviour exactly.
   */
  quotePoolSale?(mint: string, amount: bigint): Promise<{ outLamports: number; minOutLamports: number }>;
  /** Sells into that pool with a FIXED minimum out; returns the confirmed signature or throws. */
  sellInPool?(mint: string, amount: bigint, minOutLamports: number): Promise<string>;
}

export interface PoolSaleVerdict {
  ok: boolean;
  /** The floor the sale is sent with. 0 when refused. */
  minOutLamports: number;
  reason: string | null;
}

/**
 * Whether the pool's own quote is fit to sell into, and at what floor.
 *
 * WHY THIS CHECK EXISTS. The pool route runs only after Jupiter refused the sale at every
 * bound up to the exit cap — i.e. when the market is already moving or thin. Jupiter's
 * quote, taken before the ladder, is the best independent reading of what the token is
 * worth. A pool quoting LESS than that by more than the exit cap is not a fallback, it is
 * a worse market than the one just refused, and selling into it would be the weaker second
 * swap path this route must not be. So it is refused before anything is signed.
 *
 * The floor is the STRICTER of the pool's own slippage-bounded minimum and the market
 * estimate less the cap. Both are at or below the pool's quoted out once the check passes,
 * so the floor never demands more than the pool says it will pay.
 *
 * A market estimate that is missing or non-positive fails CLOSED: with nothing to judge the
 * pool against, the pool's word alone is not enough to sell on.
 */
export function assessPoolSaleQuote(input: {
  quoteOutLamports: number;
  quoteMinOutLamports: number;
  marketEstimateLamports: number | null;
  capBps: number;
}): PoolSaleVerdict {
  const { quoteOutLamports, quoteMinOutLamports, marketEstimateLamports, capBps } = input;
  if (marketEstimateLamports === null || !(marketEstimateLamports > 0)) {
    return { ok: false, minOutLamports: 0, reason: "no market estimate to judge the pool quote against" };
  }
  if (!(quoteOutLamports > 0) || !Number.isFinite(quoteOutLamports)) {
    return { ok: false, minOutLamports: 0, reason: `the pool quoted ${quoteOutLamports} lamports out` };
  }
  const cap = Math.max(0, Math.min(10_000, Math.floor(capBps)));
  const marketFloor = Math.floor((marketEstimateLamports * (10_000 - cap)) / 10_000);
  if (quoteOutLamports < marketFloor) {
    return {
      ok: false,
      minOutLamports: 0,
      reason:
        `the pool quotes ${quoteOutLamports} lamports, below the market estimate ` +
        `${marketEstimateLamports} less the ${cap} bps exit cap (${marketFloor})`,
    };
  }
  return { ok: true, minOutLamports: Math.max(Math.floor(quoteMinOutLamports), marketFloor), reason: null };
}

/**
 * The slippage ladder the residual sale walks, in basis points.
 *
 * WHY A LADDER AND NOT ONE NUMBER (13 Sep 2026). A close returned 1,568 EMBER, the residual
 * sale was refused at the 50 bps ENTRY bound, and the engine retried — three times, at the
 * same 0.5% — while the price moved. The operator sold it by hand. Each rung here is a
 * FRESH quote at a wider bound, so a sale into a thin pool can complete instead of being
 * refused for being 0.6% off. It stops at the first success, and the last rung is always
 * the configured cap (`EXIT_MAX_SLIPPAGE_BPS`, hard-capped at 500 bps).
 */
export const SWEEP_SLIPPAGE_LADDER_BPS = [50, 150, 300] as const;

/** The ladder, filtered to the configured exit cap, always ending AT the cap. */
export function sweepSlippageLadder(exitCapBps: number): number[] {
  const cap = Math.max(1, Math.floor(exitCapBps));
  return [...SWEEP_SLIPPAGE_LADDER_BPS.filter((bps) => bps < cap), cap];
}

/**
 * Sells the paired token a confirmed close returned to the wallet back to SOL.
 *
 * WHY. `closePosition` is withdraw + claim + close: it returns SOL AND the paired token,
 * and until 11 Sep 2026 nothing sold the token. The engine's first successful live trade
 * (MANLET-SOL, +$9.49 booked) left ~0.84 SOL of value sitting as a memecoin that nothing
 * monitored and no entry could size against, and it became SOL only because an operator
 * happened to sell it by hand 37 minutes later. The failed-open path had an auto-unwind
 * for months; the successful path — the one that runs on every exit — had none.
 *
 * NEVER THROWS. The position is already closed on-chain when this runs, so no outcome of
 * the sweep may stop the row being marked closed: a thrown sweep would leave an ACTIVE row
 * describing a position that no longer exists, and the monitor would retry a close the
 * program must refuse. A failure is RETURNED, logged, and paged — with the amount, the
 * mint and the estimated value first, because `sendError` truncates and those are what a
 * human needs to act.
 *
 * IDEMPOTENT. It sells what the wallet holds NOW, re-read from the chain, never an amount
 * carried in from the close. Run again on a wallet already swept it finds dust and sends
 * nothing.
 *
 * WHAT IT SELLS IS THE WHOLE BALANCE OF THE MINT, which is exactly the residual at the
 * shipped `LIVE_MAX_CONCURRENT_POSITIONS=1`: the row is still ACTIVE while this runs, so
 * the book is full and no entry can be mid-flight holding the same token. Above 1, an open
 * on ANOTHER pool paired with the SAME mint could in principle be between its swap and its
 * deposit; its deposit would then fail and take the ordinary failed-open unwind. Rare, and
 * bounded, but it is a real limit of the per-mint balance and is stated rather than hidden.
 */
export async function sweepResidualPairedToken(
  context: { pairName: string; positionAddress: string },
  deps: ResidualSweepDeps,
  dustLamports: number = RESIDUAL_DUST_LAMPORTS,
): Promise<ResidualSweep> {
  const result: ResidualSweep = {
    state: "unmeasured",
    mint: null,
    amount: null,
    estimatedLamports: null,
    signature: null,
    error: null,
  };

  const page = async (headline: string): Promise<void> => {
    const message =
      `[live] ${context.pairName}: ${headline} ` +
      `Position ${context.positionAddress} IS CLOSED on-chain and its row is marked ` +
      `closed; only the residual token is at stake. Sell it back to SOL by hand. ` +
      `wallet_lamports_after was left NULL for this trade, because the balance is not final.`;
    console.error(message);
    try {
      await deps.alert(message);
    } catch {
      // A failed page must not turn a closed position into a thrown close.
    }
  };

  try {
    result.mint = await deps.resolvePairedMint();
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await page(
      `RESIDUAL TOKEN NOT SWEPT — could not resolve the pool's paired mint ` +
        `(${result.error}), so any token the close returned is still in the wallet, ` +
        `amount and value UNKNOWN.`,
    );
    return result;
  }
  const mint = result.mint;

  let balance: bigint | null;
  try {
    balance = await deps.readBalance(mint);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    balance = null;
  }
  if (balance === null) {
    result.error ??= "the token balance could not be read";
    await page(
      `RESIDUAL TOKEN NOT SWEPT — the ${mint} balance could not be read ` +
        `(${result.error}); amount and value UNKNOWN.`,
    );
    return result;
  }
  result.amount = balance.toString();

  if (balance === 0n) {
    result.state = "dust";
    return result;
  }

  try {
    result.estimatedLamports = await deps.quoteToSol(mint, balance);
  } catch (err) {
    result.state = "failed";
    result.error = err instanceof Error ? err.message : String(err);
    await page(
      `RESIDUAL TOKEN NOT SWEPT — ${result.amount} base units of ${mint} left in the ` +
        `wallet, estimated value UNKNOWN (the quote failed: ${result.error}).`,
    );
    return result;
  }

  if (result.estimatedLamports < dustLamports) {
    result.state = "dust";
    console.log(
      `[live] ${context.pairName}: ${result.amount} base units of ${mint} left after the ` +
        `close quote at ${(result.estimatedLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL — ` +
        `dust, not sold`,
    );
    return result;
  }

  const ladder = sweepSlippageLadder(exitSlippageCapBps());
  let lastError: string | null = null;
  for (let rung = 0; rung < ladder.length; rung += 1) {
    const slippageBps = ladder[rung]!;
    try {
      result.signature = await deps.swapToSol(mint, balance, slippageBps);
      result.state = "swept";
      result.route = "jupiter";
      result.slippageBps = slippageBps;
      console.log(
        `[live] ${context.pairName}: swept ${result.amount} base units of ${mint} back to SOL ` +
          `(~${(result.estimatedLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL at ${slippageBps} bps, ` +
          `${result.signature})`,
      );
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      result.error = lastError;
      const next = ladder[rung + 1];
      console.warn(
        `[live] ${context.pairName}: the residual sale of ${mint} was refused at ` +
          `${slippageBps} bps slippage (attempt ${rung + 1}/${ladder.length}): ${lastError}` +
          (next === undefined
            ? " — this was the widest bound; the token needs a hand sale"
            : ` — retrying with a FRESH quote at ${next} bps`),
      );
    }
  }

  /*
   * LAST RESORT: the pool the position just left. It still holds the other side of this
   * token (the position was withdrawn from it seconds ago), so it is the one venue known
   * to have a book for it even when Jupiter's routes refuse. Judged against Jupiter's own
   * estimate by `assessPoolSaleQuote` BEFORE anything is signed, and sold with a fixed floor.
   */
  const jupiterError = lastError ?? result.error;
  let poolError: string | null = null;
  if (result.state !== "swept" && deps.quotePoolSale && deps.sellInPool) {
    try {
      const quote = await deps.quotePoolSale(mint, balance);
      const verdict = assessPoolSaleQuote({
        quoteOutLamports: quote.outLamports,
        quoteMinOutLamports: quote.minOutLamports,
        marketEstimateLamports: result.estimatedLamports,
        capBps: ladder[ladder.length - 1]!,
      });
      if (!verdict.ok) throw new Error(`refused before signing: ${verdict.reason}`);
      console.warn(
        `[live] ${context.pairName}: Jupiter refused the residual sale at every bound; selling ` +
          `${result.amount} base units of ${mint} directly into the pool (quote ${quote.outLamports} ` +
          `lamports, floor ${verdict.minOutLamports})`,
      );
      result.signature = await deps.sellInPool(mint, balance, verdict.minOutLamports);
      result.state = "swept";
      result.route = "dlmm-pool";
      result.slippageBps = ladder[ladder.length - 1]!;
      result.error = null;
      console.log(
        `[live] ${context.pairName}: swept ${result.amount} base units of ${mint} through the ` +
          `pool (${result.signature})`,
      );
    } catch (err) {
      poolError = err instanceof Error ? err.message : String(err);
      result.error = `jupiter: ${jupiterError} | pool: ${poolError}`;
    }
  }

  if (result.state !== "swept") {
    result.state = "failed";
    // Amount, mint and value FIRST: `sendError` truncates, and those are what a human needs.
    await page(
      `RESIDUAL TOKEN NOT SWEPT — ${result.amount} base units of ${mint} ` +
        `(~${(result.estimatedLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) left in the ` +
        `wallet; the sell back to SOL failed at every bound up to ${ladder[ladder.length - 1]} bps: ` +
        `${jupiterError}.` +
        (deps.quotePoolSale && deps.sellInPool
          ? ` The direct pool sale failed too: ${poolError}.`
          : " No pool route was available.") +
        ` Check the chain before selling: the swap's outcome may be ambiguous.`,
    );
  }

  return result;
}

/**
 * The production sweep: the SDK for the mint, the chain for the balance, Jupiter to sell.
 *
 * EXPORTED 12 Sep 2026 for `scripts/retryResidualSweep.ts` — the operator tool that retries a
 * sweep the close could not finish (`residual_sweep = 'failed' | 'unmeasured'`). Exporting it
 * changes nothing at runtime, so the running engine does NOT need a rebuild for that tool to
 * work: the script loads this same source through tsx. That is the point — a retry path must
 * reuse this exact function (dust floor, quote, fresh-quote swap, alerts) rather than grow a
 * second, weaker copy of it.
 */
export function defaultResidualSweepDeps(
  auth: ExecutionAuthorization,
  poolAddress: string,
  /** Filled by `resolvePairedMint`, so the account close uses the SDK's token program. */
  shared: { tokenProgram: PublicKey | null } = { tokenProgram: null },
): ResidualSweepDeps {
  return {
    async resolvePairedMint() {
      const side = pairedSideOf(await loadDlmmPool(poolAddress), poolAddress);
      shared.tokenProgram = side.pairedTokenProgram;
      return side.pairedMint.toBase58();
    },
    async readBalance(mint) {
      if (shared.tokenProgram === null) return null;
      return readTokenBalanceOrNull(auth.wallet, new PublicKey(mint), shared.tokenProgram);
    },
    async quoteToSol(mint, amount, slippageBps) {
      const quote = await getJupiterQuote({
        inputMint: mint,
        outputMint: WSOL_MINT,
        amountLamports: Number(amount),
        slippageBps: resolveExitSlippageBps(slippageBps),
      });
      return Number(quote.outAmount);
    },
    async swapToSol(mint, amount, slippageBps) {
      const sold = await executeJupiterSwapFreshQuote(auth, {
        inputMint: mint,
        outputMint: WSOL_MINT,
        amountLamports: Number(amount),
        ...(slippageBps === undefined ? {} : { slippageBps }),
        leg: "exit",
      }, "residual sale after an exit");
      return sold.result.signature;
    },
    alert: (message) => sendError("closeLivePosition/residual", new Error(message)),
    async quotePoolSale(mint, amount) {
      const quote = await dlmmExecutor.quotePoolSaleToSol({
        poolAddress,
        mint,
        amount: amount.toString(),
        slippageBps: exitSlippageCapBps(),
      });
      return { outLamports: Number(quote.outLamports), minOutLamports: Number(quote.minOutLamports) };
    },
    async sellInPool(mint, amount, minOutLamports) {
      const sold = await dlmmExecutor.sellToSolInPool(auth, {
        poolAddress,
        mint,
        amount: amount.toString(),
        slippageBps: exitSlippageCapBps(),
        minOutLamports: String(minOutLamports),
      });
      return sold.signature;
    },
  };
}

export interface LiveCloseOutcome {
  closeSignature: string;
  signatures: string[];
  /**
   * Wallet lamports read AFTER the close confirmed AND the residual sweep settled, or null.
   *
   * With the balance recorded at open, this is the only measurement the engine has of what
   * a live trade actually did to the wallet. It is NULL — never the balance of the moment —
   * whenever the sweep did not settle: a balance read while value still sits in the paired
   * token is not the trade's result, and recording it is what made the reconciliation report
   * a $127 "drift" on a trade that made money.
   */
  walletLamportsAfter: number | null;
  residual: ResidualSweep;
  /** What became of the emptied paired-token account. */
  tokenAccount: TokenAccountReclaim;
  /**
   * Token balances OTHER than the paired token and wSOL, reported and not sold.
   *
   * `walletLamportsAfter` keeps its definition regardless: it is the wallet's SOL once the
   * trade's own token was dealt with, and it stays the final SOL figure for THIS trade.
   * Whatever these balances are worth is NOT in it, which is exactly why they are reported
   * next to it rather than folded in or used to null it — a USDC crumb a route left behind
   * weeks ago would otherwise unsettle every trade that follows.
   */
  nonPaired: NonPairedResiduals;
}

/** Everything `closeLivePosition` does to the outside world, injected for offline tests. */
export interface LiveCloseDeps {
  /** Withdraw + claim + close. Returns the confirmed signatures, or throws. */
  closeOnChain(params: { poolAddress: string; positionAddress: string }): Promise<string[]>;
  sweep: ResidualSweepDeps;
  /** Closes the wallet's EMPTY account for `mint`; see `closeEmptyTokenAccount`. */
  closeTokenAccount(mint: string): Promise<CloseTokenAccountOutcome>;
  /** Every non-zero token balance the wallet holds, SPL Token AND Token-2022. Throws on failure. */
  listTokenBalances(): Promise<TokenBalanceReading[]>;
  readWalletLamports(): Promise<number | null>;
  /**
   * The position account's state on-chain, read by ADDRESS. Optional so existing harnesses
   * keep the old behaviour (no precheck). Throwing means "unreadable".
   */
  readPositionState?(params: { poolAddress: string; positionAddress: string }): Promise<PositionChainState>;
  /** The newest successful signature on the position address — its close, once it is gone. */
  findCloseSignature?(positionAddress: string): Promise<string | null>;
}

function defaultLiveCloseDeps(poolAddress: string): LiveCloseDeps {
  // Evaluated when a close is REQUESTED, so an unarmed engine still refuses before any
  // network call — the behaviour `/close_all`'s tests depend on.
  const auth = authorizeExecution();
  const shared: { tokenProgram: PublicKey | null } = { tokenProgram: null };
  return {
    async closeOnChain(p) {
      const closed = await dlmmExecutor.closePosition(auth, p);
      return closed.sent.map((s) => s.signature);
    },
    sweep: defaultResidualSweepDeps(auth, poolAddress, shared),
    async closeTokenAccount(mint) {
      if (shared.tokenProgram === null) {
        throw new Error("the paired token program was never resolved");
      }
      return closeEmptyTokenAccount(auth, { mint, tokenProgram: shared.tokenProgram.toBase58() });
    },
    listTokenBalances: () => listWalletTokenBalances(auth.wallet),
    readWalletLamports,
    readPositionState: (p) => dlmmExecutor.readPositionState(auth, p),
    findCloseSignature: (positionAddress) => findLastSuccessfulSignature(positionAddress),
  };
}

/**
 * Every non-zero token balance `owner` holds, across BOTH token programs.
 *
 * Token-2022 is not optional: a large share of new memecoins are minted under it, and a
 * listing of the classic program alone would report a clean wallet while one sat there.
 * Throws when either listing fails — a half listing is not "nothing left".
 */
async function listWalletTokenBalances(owner: PublicKey): Promise<TokenBalanceReading[]> {
  const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
  const connection = getConnection();
  const out: TokenBalanceReading[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await connection.getParsedTokenAccountsByOwner(
      owner,
      { programId },
      "confirmed",
    );
    for (const { account } of value) {
      const info = (account.data as { parsed?: { info?: Record<string, unknown> } }).parsed?.info;
      const tokenAmount = info?.tokenAmount as { amount?: string; uiAmount?: number | null } | undefined;
      if (typeof info?.mint !== "string" || typeof tokenAmount?.amount !== "string") continue;
      if (tokenAmount.amount === "0") continue;
      out.push({
        mint: info.mint,
        amount: tokenAmount.amount,
        uiAmount: typeof tokenAmount.uiAmount === "number" ? tokenAmount.uiAmount : null,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Token account rent — the housekeeping after a sell-back             */
/* ------------------------------------------------------------------ */

/**
 * What became of the paired token's account once its balance was sold back to SOL.
 *
 *  - `closed`     closed, rent back in the wallet (`signature` is the evidence).
 *  - `absent`     no account to close — already closed or never created. Success.
 *  - `not-empty`  still holds tokens (e.g. a dust balance), so it was left alone.
 *  - `skipped`    the sell-back did not settle, so the account was not touched: value may
 *                 still be in it, and closing a non-empty account is refused anyway.
 *  - `failed`     the close was attempted and did not land.
 */
export interface TokenAccountReclaim {
  state: "closed" | "absent" | "not-empty" | "skipped" | "failed";
  signature: string | null;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Non-paired residuals — reported, never sold                         */
/* ------------------------------------------------------------------ */

/** One non-zero token balance the wallet holds. */
export interface TokenBalanceReading {
  mint: string;
  /** Base units, as a string: it can exceed 2^53. */
  amount: string;
  /** The RPC's human amount, for the log line. Null when it did not supply one. */
  uiAmount: number | null;
}

export interface NonPairedResiduals {
  /** Every non-zero balance that is neither wSOL nor the pool's paired token. */
  balances: Array<TokenBalanceReading & { estimatedLamports: number | null }>;
  /** Sum of the balances that COULD be priced. Unpriced ones are counted, not guessed. */
  pricedLamports: number;
  unpriced: number;
  /** Why the listing could not be read, when it could not. Null otherwise. */
  readError: string | null;
  /** Whether the priced total crossed `NON_PAIRED_PAGE_LAMPORTS` and a page was sent. */
  paged: boolean;
}

/**
 * Above this much estimated SOL, unsold non-paired tokens earn a page of their own.
 *
 * 0.05 SOL: the same figure `LIVE_MAX_FAILED_COST_SOL` defaults to — the amount this engine
 * already treats as worth a human's attention when it leaves the wallet in a day. Below it
 * (the 1.06 USDC a Jupiter route left behind on 11 Sep is ~0.01 SOL) the balances are named
 * in the log line and in the close alert, and nobody is woken up for them.
 */
export const NON_PAIRED_PAGE_LAMPORTS = 50_000_000;

/** At most this many balances are quoted per close, so a wallet full of airdrops cannot
 * turn an exit into dozens of HTTP calls. The rest are listed as unpriced. */
const NON_PAIRED_MAX_QUOTES = 5;

/**
 * Names every token balance the close left behind that the sweep did not touch.
 *
 * The sweep sells exactly one mint — the pool's paired token. Anything else in the wallet is
 * invisible to it: on 11 Sep 2026 the live wallet held 1.062727 USDC that a Jupiter route had
 * left behind, and nothing in the engine could see it. That is the defect the sweep was
 * written for — value sitting in a token while the book reads "done" — at a smaller size.
 *
 * It REPORTS and it NEVER SELLS. Deciding to sell an asset the engine did not choose to hold
 * (an airdrop, a scam token, an operator's own position) is a separate decision with its own
 * risks, not a default to be slipped into an exit.
 *
 * NEVER THROWS: it runs after the position has closed. An unreadable listing is reported as
 * such (`readError`), never as "nothing left".
 */
export async function reportNonPairedResiduals(
  context: { pairName: string; pairedMint: string | null },
  deps: {
    listTokenBalances(): Promise<TokenBalanceReading[]>;
    quoteToSol(mint: string, amount: bigint): Promise<number>;
    alert(message: string): Promise<unknown>;
  },
): Promise<NonPairedResiduals> {
  const result: NonPairedResiduals = {
    balances: [],
    pricedLamports: 0,
    unpriced: 0,
    readError: null,
    paged: false,
  };

  let listed: TokenBalanceReading[];
  try {
    listed = await deps.listTokenBalances();
  } catch (err) {
    result.readError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[live] ${context.pairName}: could not list the wallet's token balances, so any ` +
        `non-paired residual is UNKNOWN: ${result.readError}`,
    );
    return result;
  }

  const others = listed.filter(
    (b) => b.mint !== WSOL_MINT && b.mint !== context.pairedMint && b.amount !== "0",
  );

  for (const [i, balance] of others.entries()) {
    let estimatedLamports: number | null = null;
    if (i < NON_PAIRED_MAX_QUOTES) {
      try {
        estimatedLamports = await deps.quoteToSol(balance.mint, BigInt(balance.amount));
      } catch {
        estimatedLamports = null;
      }
    }
    if (estimatedLamports === null) result.unpriced += 1;
    else result.pricedLamports += estimatedLamports;
    result.balances.push({ ...balance, estimatedLamports });
  }

  if (result.balances.length === 0) return result;

  const line = describeNonPairedResiduals(result);
  console.warn(`[live] ${context.pairName}: ${line}`);

  if (result.pricedLamports >= NON_PAIRED_PAGE_LAMPORTS) {
    result.paged = true;
    try {
      await deps.alert(
        `[live] ${context.pairName}: ${line}. Over the ` +
          `${NON_PAIRED_PAGE_LAMPORTS / LAMPORTS_PER_SOL} SOL line. The engine does NOT sell ` +
          `tokens it did not choose to hold — decide by hand.`,
      );
    } catch {
      // A failed page must not turn a closed position into a thrown close.
    }
  }
  return result;
}

/** The one line: count, then each mint with its human amount and estimated SOL. */
export function describeNonPairedResiduals(r: NonPairedResiduals): string | null {
  if (r.readError !== null) return `residual: non-paired token balances UNKNOWN (${r.readError})`;
  if (r.balances.length === 0) return null;
  const items = r.balances
    .map(
      (b) =>
        `${b.mint.slice(0, 8)}…: ${b.uiAmount ?? `${b.amount} base units`}` +
        (b.estimatedLamports === null
          ? ` (unpriced)`
          : ` (~${(b.estimatedLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`),
    )
    .join(", ");
  return (
    `residual: ${r.balances.length} non-paired token balance(s) left after the close ` +
    `(${items}); not sold, and NOT in wallet_lamports_after`
  );
}

export const TOKEN_ACCOUNT_SKIPPED: TokenAccountReclaim = {
  state: "skipped",
  signature: null,
  error: null,
};

/**
 * Closes the emptied paired-token account and takes its rent back. NEVER THROWS, NEVER PAGES.
 *
 * ~0.002 SOL of rent per mint is locked in every ATA the engine leaves behind, and nothing
 * else ever closes one: two sat empty in the live wallet on 11 Sep 2026. Against a ~$9
 * take-profit that is about 2% of the trade per mint, for good.
 *
 * Best effort and quiet on purpose, unlike the sweep before it. A failed SWEEP leaves value
 * parked in a memecoin and pages a human; a failed CLOSE here leaves ~$0.20 of rent, which
 * is logged and nothing more — paging for it would teach the operator to ignore the pages
 * that matter. And it runs after a position has already closed (or after a failed open has
 * already unwound), where nothing is allowed to turn the outcome into a throw.
 */
export async function reclaimEmptyTokenAccount(
  context: { pairName: string; mint: string },
  close: () => Promise<CloseTokenAccountOutcome>,
): Promise<TokenAccountReclaim> {
  try {
    const outcome = await close();
    switch (outcome.state) {
      case "closed":
        console.log(
          `[live] ${context.pairName}: closed the empty ${context.mint} account ` +
            `${outcome.ata}, rent returned (${outcome.signature})`,
        );
        return { state: "closed", signature: outcome.signature, error: null };
      case "absent":
        return { state: "absent", signature: null, error: null };
      case "not-empty":
        console.log(
          `[live] ${context.pairName}: the ${context.mint} account still holds ` +
            `${outcome.amount} base units; left open`,
        );
        return { state: "not-empty", signature: null, error: null };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[live] ${context.pairName}: could not close the empty ${context.mint} account ` +
        `(~0.002 SOL of rent stays locked; not paged): ${reason}`,
    );
    return { state: "failed", signature: null, error: reason };
  }
}

/**
 * Closes a real position: withdraws every bin, claims the fees and reclaims the rent,
 * atomically per transaction via `shouldClaimAndClose` — then sells the paired token that
 * came back to SOL, and only then reads the wallet.
 *
 * Returns the LAST close signature, which is the one that actually closed the account. A
 * partial run raises `DlmmPartialExecutionError` from the executor and is deliberately
 * NOT caught here — the caller must not mark a half-closed position as closed. Nothing
 * AFTER the close may throw: from that point the position is gone, and the row must follow.
 *
 * Every live exit reaches the chain through here — take-profit, stop-loss, out-of-range and
 * timeout from the monitor, and `/close_all` — via `settleLiveCloses`, so the sweep covers
 * them all by construction.
 */
export async function closeLivePosition(
  params: {
    poolAddress: string;
    positionAddress: string;
    pairName: string;
  },
  deps: LiveCloseDeps = defaultLiveCloseDeps(params.poolAddress),
): Promise<LiveCloseOutcome> {
  const target = { poolAddress: params.poolAddress, positionAddress: params.positionAddress };

  /*
   * STATE BEFORE ACTION (13 Sep 2026). A close can land while the engine records it as
   * failed — a confirmation poll that gave up, an RPC error after broadcast — and the row
   * then stays ACTIVE, so the next tick sends a SECOND close for an account that no longer
   * exists. The program refuses it, the row stays ACTIVE forever, and the residual token the
   * first close returned is never swept. So the account is read first, by address:
   *
   *   absent     the close already happened. Nothing is sent; the chain's own newest
   *              signature on the address is recorded as the close. If that cannot be read
   *              the call THROWS rather than invent one — the row stays ACTIVE and the next
   *              tick looks again, which costs a read, not a transaction.
   *   otherwise  close as before. "Unreadable" also closes as before: an RPC that did not
   *              answer is not evidence the position is gone.
   */
  let state: PositionChainState | "unreadable" = "unreadable";
  if (deps.readPositionState) {
    try {
      state = await deps.readPositionState(target);
    } catch {
      state = "unreadable";
    }
  }

  let signatures: string[];
  if (state === "absent") {
    let found: string | null = null;
    try {
      found = deps.findCloseSignature ? await deps.findCloseSignature(params.positionAddress) : null;
    } catch {
      found = null;
    }
    if (!found) {
      throw new Error(
        `position ${params.positionAddress} is already GONE on-chain but its closing signature ` +
          `could not be read; NOT sending a second close. The row stays active and the next ` +
          `check reads the chain again.`,
      );
    }
    console.warn(
      `[live] ${params.pairName}: position ${params.positionAddress} was already closed on-chain ` +
        `(${found}) — an earlier close landed while it was reported failed; recording that close ` +
        `instead of sending another`,
    );
    signatures = [found];
  } else {
    signatures = await deps.closeOnChain(target);
  }

  const closeSignature = signatures.at(-1);
  if (!closeSignature) throw new Error("closePosition returned no signature");

  console.log(`[live] ${params.pairName}: position ${params.positionAddress} closed ` +
    `(${signatures.length} tx, final ${closeSignature})`);

  /*
   * THE CLOSE HAS CONFIRMED. The sweep runs only now — selling before the withdrawal landed
   * would sell a balance the position was still holding — and it never throws.
   */
  const residual = await sweepResidualPairedToken(
    { pairName: params.pairName, positionAddress: params.positionAddress },
    deps.sweep,
  );

  /*
   * The emptied account's rent, ONLY once the sweep settled with nothing left in it: a sale
   * that confirmed, or a balance that read exactly 0. A dust balance is not zero and the
   * program would refuse the close; a failed or unmeasured sweep may still hold value.
   * Before the wallet read, so the rent that comes back is part of the trade's result.
   */
  const mint = residual.mint;
  const tokenAccount =
    mint !== null && (residual.state === "swept" || (residual.state === "dust" && residual.amount === "0"))
      ? await reclaimEmptyTokenAccount({ pairName: params.pairName, mint }, () =>
          deps.closeTokenAccount(mint),
        )
      : TOKEN_ACCOUNT_SKIPPED;

  /*
   * Then everything the sweep cannot see: balances of OTHER tokens, e.g. what a Jupiter route
   * left behind. Listed and priced where possible, never sold, and paged only above
   * `NON_PAIRED_PAGE_LAMPORTS`. Never throws.
   */
  const nonPaired = await reportNonPairedResiduals(
    { pairName: params.pairName, pairedMint: residual.mint },
    {
      listTokenBalances: () => deps.listTokenBalances(),
      quoteToSol: (m, amount) => deps.sweep.quoteToSol(m, amount),
      alert: (message) => deps.sweep.alert(message),
    },
  );

  /*
   * After the sweep, and only if it settled. Read at `confirmed`, so the withdrawal, the
   * reclaimed position rent and the sweep's proceeds are all in the balance. An unsettled
   * sweep leaves this NULL: "not measured" is honest, a balance with value still parked in
   * a memecoin is not. Best effort either way; see readWalletLamports.
   */
  let walletLamportsAfter: number | null = null;
  if (isSettledSweep(residual)) {
    try {
      walletLamportsAfter = await deps.readWalletLamports();
    } catch {
      walletLamportsAfter = null;
    }
  }

  return { closeSignature, signatures, walletLamportsAfter, residual, tokenAccount, nonPaired };
}

/**
 * Claims swap fees WITHOUT closing the position.
 *
 * Not on the automatic path, and that is deliberate rather than an omission:
 * `closeLivePosition` already claims atomically through `shouldClaimAndClose`, so
 * claiming on a schedule would pay a second set of gas to realise fees the close will
 * collect anyway. At micro notional that is the churn the friction gates exist to
 * prevent. It is wired for the operator — Telegram `/claim` — because a position held
 * across a long in-range stretch is the one case where realising early is worth its
 * own gas, and that is a judgement call, not a rule.
 */
export async function claimLiveFees(params: {
  poolAddress: string;
  positionAddress: string;
}): Promise<{ signatures: string[] }> {
  const auth = authorizeExecution();
  const claimed = await dlmmExecutor.claimFees(auth, {
    poolAddress: params.poolAddress,
    positionAddress: params.positionAddress,
  });
  return { signatures: claimed.sent.map((s) => s.signature) };
}

/** The non-SOL side of a pair, the token program that owns it, and how wide the
 * requested price range is on the pool's bin grid (bins are the unit the DLMM
 * program sizes position accounts in — see `MAX_DLMM_POSITION_BINS`). */
async function describePair(
  poolAddress: string,
  lowerBinPrice: number,
  upperBinPrice: number,
): Promise<{ pairedMint: PublicKey; pairedTokenProgram: PublicKey; binWidth: number }> {
  const pool = await loadDlmmPool(poolAddress);
  const { minBinId, maxBinId } = binRangeFromPrices(pool, lowerBinPrice, upperBinPrice);
  return { ...pairedSideOf(pool, poolAddress), binWidth: maxBinId - minBinId + 1 };
}

async function loadDlmmPool(poolAddress: string) {
  // Load the SDK via its CJS build: the ESM build (`dist/index.mjs`) imports an
  // Anchor CJS directory (`@coral-xyz/anchor/dist/cjs/utils/bytes`), which Node's
  // ESM resolver rejects — every live entry then dies in seekNewEntry. CJS
  // `module.exports` IS the DLMM class, so `.default` may be absent; normalise both
  // shapes before calling `.create`.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const dlmmModule = require("@meteora-ag/dlmm") as { default?: unknown };
  const DLMM = (dlmmModule.default ?? dlmmModule) as typeof import("@meteora-ag/dlmm")["default"];
  return DLMM.create(getConnection(), new PublicKey(poolAddress));
}

/** The non-wSOL side of a pool, from the SDK's own reading of it. */
function pairedSideOf(
  pool: Awaited<ReturnType<typeof loadDlmmPool>>,
  poolAddress: string,
): { pairedMint: PublicKey; pairedTokenProgram: PublicKey } {
  const wsol = new PublicKey(WSOL_MINT);

  if (pool.tokenX.publicKey.equals(wsol)) {
    return { pairedMint: pool.tokenY.publicKey, pairedTokenProgram: pool.tokenY.owner };
  }
  if (pool.tokenY.publicKey.equals(wsol)) {
    return { pairedMint: pool.tokenX.publicKey, pairedTokenProgram: pool.tokenX.owner };
  }
  throw new Error(
    `[live] pool ${poolAddress} has no wSOL side; the engine sizes in SOL and cannot ` +
      `fund this pair`,
  );
}

/**
 * Boot check for the live path. Returns the reasons it must NOT start, empty when it
 * may.
 *
 * Separate from `runLivePreflight`'s balance gate because these are configuration
 * errors rather than funding ones, and they are all silent: an
 * `ONCHAIN_MAX_LAMPORTS_PER_TX` below the position size does not misbehave, it simply
 * makes every entry fail `assertWithinSpendLimit` after the screening work is done and
 * the operator sees a healthy engine that never opens anything.
 */
export function describeLiveExecutionBlockers(): string[] {
  if (!isLiveExecutionActive()) return [];
  const blockers: string[] = [];

  /*
   * The ceiling has to clear the DEPOSIT PLUS RENT, not the deposit alone.
   *
   * This check used to compare it against the position size and tell the operator to
   * set the two equal — advice that guarantees the failure it was written to prevent.
   * A single transaction on the narrow path carries the deposit, the position account's
   * rent and any new bin arrays together, and rent is the larger term on a wide range
   * (~1 SOL at 1400 bins). Set equal, every such entry passes screening and then dies
   * on `assertWithinSpendLimit` AFTER the balancing swap has spent.
   *
   * The rent side is bounded by the envelope's own rent budget — the affordability gate
   * refuses anything above it — so `maxPosition + rentBudget` is the largest sum any
   * one transaction can legitimately ask for.
   */
  const positionLamports = Math.ceil(liveMicroCapital.maxPositionSol * LAMPORTS_PER_SOL);
  const rentBudgetLamports = Math.ceil(
    Math.max(liveMicroCapital.deployableSol - liveMicroCapital.maxExposureSol, 0) *
      LAMPORTS_PER_SOL,
  );
  const requiredLamports = positionLamports + rentBudgetLamports;

  if (onchainConfig.maxLamportsPerTx < requiredLamports) {
    blockers.push(
      `ONCHAIN_MAX_LAMPORTS_PER_TX is ${onchainConfig.maxLamportsPerTx} lamports ` +
        `(${(onchainConfig.maxLamportsPerTx / LAMPORTS_PER_SOL).toFixed(4)} SOL) but one ` +
        `transaction can carry a ${liveMicroCapital.maxPositionSol} SOL deposit PLUS up to ` +
        `${(rentBudgetLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL of position and bin-array ` +
        `rent (the envelope's rent budget). Entries would pass screening and then fail the ` +
        `spend ceiling after the balancing swap had already spent. Set ` +
        `ONCHAIN_MAX_LAMPORTS_PER_TX=${requiredLamports}.`,
    );
  }

  if (!liveMicroCapital.walletAddress) {
    blockers.push(
      "SOLANA_WALLET_ADDRESS is not set: the balance gate cannot read the wallet it is " +
        "meant to protect.",
    );
  }

  return blockers;
}

export type { ExecutionAuthorization };

/*
 * The slippage bounds, re-exported through the bridge (13 Sep 2026).
 *
 * WHY HERE. `onchainExecutor.test.ts` pins the list of files allowed to import the executor,
 * and that list IS the security boundary — every addition widens who can move funds. A test
 * that wants to assert the EXIT-leg bound is not a reason to widen it: re-exporting the two
 * pure resolvers through the bridge keeps the importer list exactly as reviewed, and the
 * test reaches them the same way the engine does.
 */
export {
  HARD_MAX_SLIPPAGE_BPS,
  HARD_MAX_EXIT_SLIPPAGE_BPS,
  exitSlippageCapBps,
  onchainConfig,
  resolveExitSlippageBps,
  resolveSlippageBps,
} from "./onchainExecutor.js";
