/**
 * The arithmetic of a Zap-Out close, kept away from the I/O so it can be tested directly.
 *
 * WHY THIS EXISTS (19 Sep 2026). The engine's exit used to be a SEQUENCE: remove liquidity,
 * claim fees, close the position — then sell the residual token in a SEPARATE transaction.
 * Between those two steps the position is gone and the token is not: whatever fails in the
 * second step leaves a balance sitting in the wallet with nothing tracking it. That is
 * exactly what happened on 19 Sep 2026 (51.067138 CATE stranded after the process was killed
 * mid-swap; see `controlled-open-interrupted-unwind-2026-09-19.md`).
 *
 * Meteora's Zap program composes the whole exit into ONE transaction: withdraw + claim +
 * close + swap + unwrap WSOL, atomic — either it all happens or none of it does, and there
 * is no window in which a token is orphaned. `zap.zapOutThroughDlmm` is the swap-only half;
 * the withdrawal is the DLMM SDK's own `removeLiquidity(..., shouldClaimAndClose: true)`,
 * and the caller glues the two instruction lists into a single message. That composition is
 * what the numbers below have to hold up under.
 *
 * TWO MEASURED CONSTRAINTS, both from the read-only spike on the operator's live position
 * (`/tmp/zap-spike/REPORT.md`, mainnet simulation):
 *
 *  1. ONE TRANSACTION IS 1 232 BYTES. The composed close measured 1 176 B with the SDK's own
 *     compute-budget instruction (a 68-bin position, 4 bin arrays) — 56 bytes of headroom,
 *     which is less than a memo or a second compute-budget instruction. So a composition that
 *     does not fit must be REFUSED, not trimmed: the caller falls back to the sequential
 *     close, which is slow but never oversized.
 *
 *  2. A TOKEN-2022 TRANSFER FEE IS CHARGED ON THE WAY OUT AND AGAIN ON THE WAY BACK IN, and
 *     the swap floor has to be quoted on what the POOL will receive, not on what the wallet
 *     holds. On the spike's position (300 bps) that is 5.910% of the withdrawn amount gone
 *     before the pool sees it. A floor quoted on the full amount is a FALSE POSITIVE: at the
 *     300 bps exit cap it passed by 0-1 lamport and at 100 bps it reverted on-chain with
 *     DLMM `Swap2` `ExceededAmountSlippageTolerance` (Custom:6003). So the quote input is
 *     reduced by the fee — once, the amount the token program withholds on the transfer the
 *     quote covers — which is the guard that simulated clean at both 300 and 100 bps.
 */

/*
 * A v0 message that serializes past this is refused by the runtime, and the SDK does not
 * warn first: `VersionedTransaction` compiles and the send fails. Checked before the send,
 * so an oversized composition costs a rebuild, never a transaction.
 */
export const MAX_TRANSACTION_BYTES = 1232;

/**
 * The compute budget the composed close is asked for, at MINIMUM.
 *
 * Measured at 501 908 CU on the spike's position (withdrawal 502k, zap swap ~30k). The
 * DLMM SDK's own estimate covers the withdrawal and lands around 550 000; the zap leg is
 * work the DLMM SDK never sized. `resolveComputeUnitLimit` keeps whichever budget is
 * larger, so this is a floor and never a downgrade — the alternative is an exit that dies
 * on the compute meter because two SDKs each budgeted for half the job.
 */
export const ZAP_CLOSE_COMPUTE_UNITS_FLOOR = 620_000;

/**
 * Raised when the atomic close cannot be built. It means "use the sequential path", NOT
 * "the exit failed": the caller must fall back rather than report a failed close.
 */
export class ZapCloseUnavailableError extends Error {
  constructor(reason: string) {
    super(`[zap] atomic close unavailable: ${reason}`);
    this.name = "ZapCloseUnavailableError";
  }
}

/**
 * What a Token-2022 transfer fee withholds from a transfer of `amount`.
 *
 * `maximumFee` is an absolute cap in the same units as `amount`, and it is applied — a fee
 * schedule that caps at 5 tokens does not withhold 3% of a 10 000-token transfer. A mint
 * with no fee extension reports zero basis points and lands in the first branch, which is
 * every classic SPL token the engine trades today: this is a no-op for them.
 */
export function transferFeeUnits(params: {
  amount: bigint;
  feeBps: number;
  maximumFee: bigint | null;
}): bigint {
  const { amount, feeBps, maximumFee } = params;
  if (amount <= 0n) return 0n;
  if (!Number.isFinite(feeBps) || feeBps <= 0) return 0n;

  const raw = (amount * BigInt(Math.round(feeBps))) / 10_000n;
  if (maximumFee !== null && maximumFee > 0n && raw > maximumFee) return maximumFee;
  return raw;
}

/**
 * The amount that actually reaches the pool on a sale, and the fee withheld on the way.
 *
 * This is the number a floor has to be quoted from. Throws when the fee would consume the
 * whole balance: a swap with no input is not a sale, and quoting it would produce a floor
 * of zero — an exit with no floor is a donation.
 */
export function swapInputAfterTransferFee(params: {
  amount: bigint;
  feeBps: number;
  maximumFee: bigint | null;
}): { swappedIn: bigint; feeUnits: bigint } {
  const feeUnits = transferFeeUnits(params);
  const swappedIn = params.amount - feeUnits;
  if (swappedIn <= 0n) {
    throw new ZapCloseUnavailableError(
      `a transfer fee of ${feeUnits} leaves nothing of ${params.amount} to swap`,
    );
  }
  return { swappedIn, feeUnits };
}

/**
 * Whether a serialized message fits. `bytes <= 0` is treated as "cannot tell" and is
 * refused: an unknown size is not a small one.
 */
export function zapCloseFits(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_TRANSACTION_BYTES;
}
