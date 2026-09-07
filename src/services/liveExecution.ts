import { PublicKey } from "@solana/web3.js";
import { isLiveTradingEnabled } from "../config/env.js";
import { liveMicroCapital, LAMPORTS_PER_SOL } from "../config/liveConfig.js";
import {
  WSOL_MINT,
  authorizeExecution,
  binRangeFromPrices,
  dlmmExecutor,
  executeJupiterSwap,
  getConnection,
  onchainConfig,
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
 * The DLMM program creates ONE position account per initializePosition call and that
 * account spans at most `MAX_BIN_PER_POSITION` (70) bins — IDL constant, verified
 * on-chain by simulation: width 74 is rejected by the program ("InvalidPositionWidth"),
 * width 100+ dies in the runtime ("realloc limited to 10240 in inner instructions"),
 * width 1-70 initialises cleanly. The engine's -45%/+15% price range maps to a bin
 * width that grows as the pool's bin_step shrinks, and below ~106 bps it exceeds 70 —
 * the open then fails AFTER the balancing swap has already spent the SOL (7 Sep 2026:
 * 0.4 SOL stranded as an unmonitored memecoin). Raising this lets the entry be skipped
 * BEFORE any swap when the range cannot fit in one position.
 */
export class BinWidthExceededError extends Error {
  constructor(pairName: string, binWidth: number, poolAddress: string) {
    super(
      `[live] ${pairName} needs ${binWidth} bins, over the DLMM one-position maximum of ` +
        `${MAX_DLMM_POSITION_BINS} (pool ${poolAddress}); skipped before any swap`,
    );
    this.name = "BinWidthExceededError";
  }
}

/** Hard on-chain limit: the DLMM program IDL's MAX_BIN_PER_POSITION. */
const MAX_DLMM_POSITION_BINS = 70;

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

  const { pairedMint, pairedTokenProgram, binWidth } = await describePair(
    params.poolAddress,
    params.lowerBinPrice,
    params.upperBinPrice,
  );

  /*
   * Gate BEFORE the balancing swap spends anything. One DLMM position account holds
   * at most 70 bins; a wider range makes the open fail after the swap has already
   * converted SOL into the paired token, stranding an unmonitored memecoin balance.
   * `seekNewEntry` treats BinWidthExceededError as a routine skip, not a fault.
   */
  if (binWidth > MAX_DLMM_POSITION_BINS) {
    throw new BinWidthExceededError(params.pairName, binWidth, params.poolAddress);
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
