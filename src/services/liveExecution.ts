import { PublicKey } from "@solana/web3.js";
import { isLiveTradingEnabled } from "../config/env.js";
import { liveMicroCapital, LAMPORTS_PER_SOL } from "../config/liveConfig.js";
import {
  DLMM_MAX_BINS_PER_POSITION,
  WSOL_MINT,
  authorizeExecution,
  binRangeFromPrices,
  dlmmExecutor,
  executeJupiterSwap,
  getConnection,
  onchainConfig,
  quoteOpenCost,
  type ExecutionAuthorization,
} from "./onchainExecutor.js";
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
export class BinWidthExceededError extends Error {
  constructor(pairName: string, binWidth: number, poolAddress: string, limit: string) {
    super(
      `[live] ${pairName} needs ${binWidth} bins, over ${limit} (pool ${poolAddress}); ` +
        `skipped before any swap`,
    );
    this.name = "BinWidthExceededError";
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
}): Promise<LiveOpenOutcome> {
  const auth = authorizeExecution();
  const totalLamports = Math.floor(params.sizeSol * LAMPORTS_PER_SOL);

  // Half to each side. Not a tuning parameter: an equal split is what makes the
  // deposit symmetric around the active bin, which is the shape the PnL model assumes.
  const swapLamports = Math.floor(totalLamports / 2);
  const depositSolLamports = totalLamports - swapLamports;

  /*
   * Operator denylist (POOL_DENYLIST: comma-separated pool addresses or pair names,
   * case-insensitive). Checked BEFORE any network call or swap so a denied pool is a
   * routine skip, never a spend. Added after STONK-SOL cost real money twice on
   * 7 Sep 2026 — once through a pre-fix width failure, once through the wide-create
   * CU bug — and the operator wanted that specific pool gone, not just fixed.
   */
  const deniedPools = (process.env.POOL_DENYLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (
    deniedPools.includes(params.poolAddress.toLowerCase()) ||
    deniedPools.includes(params.pairName.toLowerCase())
  ) {
    throw new BinWidthExceededError(
      params.pairName,
      0,
      params.poolAddress,
      "the operator POOL_DENYLIST",
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

    console.log(
      `[live] ${params.pairName}: ${binWidth} bins, open cost ${cost.totalSol.toFixed(4)} SOL ` +
        `of a ${rentBudgetSol.toFixed(4)} SOL rent budget, ~${cost.transactionCount} tx`,
    );
  }

  console.log(
    `[live] ${params.pairName}: swapping ${(swapLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
      `-> ${pairedMint.toBase58()} to balance the deposit`,
  );

  const { result: swap } = await executeJupiterSwap(auth, {
    inputMint: WSOL_MINT,
    outputMint: pairedMint.toBase58(),
    amountLamports: swapLamports,
  });

  // The chain, not the quote.
  const pairedAmount = await readTokenBalance(auth.wallet, pairedMint, pairedTokenProgram);

  if (pairedAmount === 0n) {
    throw new StrandedSwapError(
      pairedMint.toBase58(),
      "0 (balance read as zero after a confirmed swap)",
      swap.signature,
      new Error("the swap confirmed but no token balance could be read"),
    );
  }

  try {
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

    return {
      positionAddress: opened.position,
      openSignature,
      swapSignature: swap.signature,
      depositedSolLamports: depositSolLamports,
      depositedPairedAmount: pairedAmount.toString(),
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

    const stranded = new StrandedSwapError(
      pairedMint.toBase58(),
      pairedAmount.toString(),
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
}): Promise<{ closeSignature: string; signatures: string[] }> {
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

  return { closeSignature, signatures };
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

  const positionLamports = Math.ceil(liveMicroCapital.maxPositionSol * LAMPORTS_PER_SOL);
  if (onchainConfig.maxLamportsPerTx < positionLamports) {
    blockers.push(
      `ONCHAIN_MAX_LAMPORTS_PER_TX is ${onchainConfig.maxLamportsPerTx} lamports ` +
        `(${(onchainConfig.maxLamportsPerTx / LAMPORTS_PER_SOL).toFixed(4)} SOL) but one ` +
        `position deposits up to ${positionLamports} (${liveMicroCapital.maxPositionSol} SOL). ` +
        `Every entry would pass screening and then fail the spend ceiling. Set ` +
        `ONCHAIN_MAX_LAMPORTS_PER_TX=${positionLamports}.`,
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
