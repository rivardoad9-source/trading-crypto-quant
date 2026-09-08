import { PublicKey } from "@solana/web3.js";
import { env, isLiveTradingEnabled } from "../config/env.js";
import { liveMicroCapital, LAMPORTS_PER_SOL } from "../config/liveConfig.js";
import {
  getPoolExecutionRecord,
  recordPoolExecutionFailure,
  recordPoolExecutionSuccess,
} from "../database/repositories.js";
import {
  assessExecutionBreaker,
  isPoolDenied,
  poolDenylist,
} from "./executionGuard.js";
import {
  DLMM_BIN_ARRAY_RENT_SOL,
  DLMM_BINS_PER_INIT,
  DLMM_MAX_BINS_PER_POSITION,
  WSOL_MINT,
  authorizeExecution,
  binRangeFromPrices,
  dlmmExecutor,
  executeJupiterSwap,
  getConnection,
  onchainConfig,
  quoteOpenCost,
  rehearseOpenPosition,
  type ExecutionAuthorization,
} from "./onchainExecutor.js";
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

/** Whether the engine should execute on-chain rather than simulate. */
export function isLiveExecutionActive(): boolean {
  return isLiveTradingEnabled && liveMicroCapital.enabled;
}

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
  constructor(
    mint: string,
    amount: string,
    swapSignature: string,
    cause: unknown,
    rescueSignature: string | null = null,
    rescueError: string | null = null,
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
        `${rescue} Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "StrandedSwapError";
    this.mint = mint;
    this.amount = amount;
    this.swapSignature = swapSignature;
    this.rescueSignature = rescueSignature;
    this.rescueError = rescueError;
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
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId);

  try {
    const balance = await getConnection().getTokenAccountBalance(ata, "confirmed");
    return BigInt(balance.value.amount);
  } catch {
    // No account, or an unreadable one. Zero is the safe reading: it deposits nothing
    // on that side rather than asserting a balance we could not confirm.
    return 0n;
  }
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
async function readWalletLamports(): Promise<number | null> {
  const address = liveMicroCapital.walletAddress;
  if (!address) return null;
  try {
    return (await getWalletBalanceSol(address)).lamports;
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

  const { pairedMint, pairedTokenProgram, binWidth } = await describePair(
    params.poolAddress,
    params.lowerBinPrice,
    params.upperBinPrice,
  );

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
  if (liveMicroCapital.enabled) {
    const cost = await quoteOpenCost({
      poolAddress: params.poolAddress,
      lowerBinPrice: params.lowerBinPrice,
      upperBinPrice: params.upperBinPrice,
      strategy: params.strategy,
    });
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
    const depositLamports = totalLamports - swapLamports;
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
          `(${(depositLamports / LAMPORTS_PER_SOL).toFixed(4)} deposit + ` +
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

  const { result: swap } = await executeJupiterSwap(auth, {
    inputMint: WSOL_MINT,
    outputMint: pairedMint.toBase58(),
    amountLamports: swapLamports,
  });

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
   */
  let pairedAmount = 0n;

  try {
    // The chain, not the quote.
    pairedAmount = await readTokenBalance(auth.wallet, pairedMint, pairedTokenProgram);

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

    return {
      positionAddress: opened.position,
      openSignature,
      swapSignature: swap.signature,
      depositedSolLamports: depositSolLamports,
      depositedPairedAmount: pairedAmount.toString(),
      walletLamportsBefore,
    };
  } catch (err) {
    /*
     * Auto-unwind, best effort: the balancing swap has already moved SOL into the
     * paired token, so a failed open must put the wallet back to SOL — not leave an
     * unmonitored memecoin balance behind. Sell the CURRENT on-chain balance (re-read:
     * a partial open may have consumed some), then report both the failure and the
     * rescue outcome in the alert.
     */
    let rescueSignature: string | null = null;
    let rescueError: string | null = null;
    try {
      const current = await readTokenBalance(auth.wallet, pairedMint, pairedTokenProgram);
      if (current > 0n) {
        const rescue = await executeJupiterSwap(auth, {
          inputMint: pairedMint.toBase58(),
          outputMint: WSOL_MINT,
          amountLamports: Number(current),
        });
        rescueSignature = rescue.result.signature;
      }
    } catch (rescueErr) {
      rescueError = rescueErr instanceof Error ? rescueErr.message : String(rescueErr);
    }

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
      });
    } catch (bookkeeping) {
      console.warn(`[live] could not record the execution failure for ${params.pairName}:`, bookkeeping);
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
    );
    console.error(stranded.message);
    // Best effort: a failed page must not swallow the original failure.
    await sendError("openLivePosition/stranded", stranded).catch(() => undefined);
    throw stranded;
  }
}

/**
 * Closes a real position: withdraws every bin, claims the fees and reclaims the rent,
 * atomically per transaction via `shouldClaimAndClose`.
 *
 * Returns the LAST signature, which is the one that actually closed the account. A
 * partial run raises `DlmmPartialExecutionError` from the executor and is deliberately
 * NOT caught here — the caller must not mark a half-closed position as closed.
 */
export async function closeLivePosition(params: {
  poolAddress: string;
  positionAddress: string;
  pairName: string;
}): Promise<{
  closeSignature: string;
  signatures: string[];
  /**
   * Wallet lamports read AFTER the close confirmed, or null when the read failed.
   *
   * With the balance recorded at open, this is the only measurement the engine has of
   * what a live trade actually did to the wallet. Every other number attached to a live
   * position is the paper model's opinion.
   */
  walletLamportsAfter: number | null;
}> {
  const auth = authorizeExecution();

  const closed = await dlmmExecutor.closePosition(auth, {
    poolAddress: params.poolAddress,
    positionAddress: params.positionAddress,
  });

  const signatures = closed.sent.map((s) => s.signature);
  const closeSignature = signatures.at(-1);
  if (!closeSignature) throw new Error("closePosition returned no signature");

  console.log(`[live] ${params.pairName}: position ${params.positionAddress} closed ` +
    `(${signatures.length} tx, final ${closeSignature})`);

  // After the close CONFIRMED, so the withdrawal and the reclaimed position rent are
  // both already in the balance. Best effort; see readWalletLamports.
  const walletLamportsAfter = await readWalletLamports();

  return { closeSignature, signatures, walletLamportsAfter };
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
  // Load the SDK via its CJS build: the ESM build (`dist/index.mjs`) imports an
  // Anchor CJS directory (`@coral-xyz/anchor/dist/cjs/utils/bytes`), which Node's
  // ESM resolver rejects — every live entry then dies in seekNewEntry. CJS
  // `module.exports` IS the DLMM class, so `.default` may be absent; normalise both
  // shapes before calling `.create`.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const dlmmModule = require("@meteora-ag/dlmm") as { default?: unknown };
  const DLMM = (dlmmModule.default ?? dlmmModule) as typeof import("@meteora-ag/dlmm")["default"];
  const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
  const { minBinId, maxBinId } = binRangeFromPrices(pool, lowerBinPrice, upperBinPrice);
  const wsol = new PublicKey(WSOL_MINT);

  if (pool.tokenX.publicKey.equals(wsol)) {
    return {
      pairedMint: pool.tokenY.publicKey,
      pairedTokenProgram: pool.tokenY.owner,
      binWidth: maxBinId - minBinId + 1,
    };
  }
  if (pool.tokenY.publicKey.equals(wsol)) {
    return {
      pairedMint: pool.tokenX.publicKey,
      pairedTokenProgram: pool.tokenX.owner,
      binWidth: maxBinId - minBinId + 1,
    };
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
