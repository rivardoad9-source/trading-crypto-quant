/**
 * Range physics for a Meteora DLMM position: can the promised depth be built at all,
 * and how much refundable bin rent does it tie up.
 *
 * Two numbers the signal card has no business getting wrong:
 *
 *  - **Bins are geometric.** A percent move costs a very different number of bins
 *    depending on `binStep`: the dlmmbot repo's planner notes -40% is 52 bins at step
 *    100, 256 at step 20 and 512 at step 10. A position account holds at most 1400
 *    (`DLMM_MAX_BINS_PER_POSITION`), and `LIVE_MAX_POSITION_BINS` can be stricter, so on
 *    a fine-step pool a configured "-45%" can be silently truncated to whatever fits —
 *    the failure mode their notes describe as positions coming out 11-15% deep while the
 *    config said 40%.
 *  - **Bin rent is a deposit, not a fee.** On-chain bin arrays are fixed 70-bin segments
 *    and cost ~0.075 SOL each to create. Refunded when the position closes, but it has to
 *    sit in the wallet while the position is open, so a deep range on a fine-step pool
 *    can tie up more SOL in rent than the position itself needs.
 *
 * Derivations (same as dlmmbot `ranges/planner.ts`, restated so the arithmetic can be
 * checked rather than trusted): for a step of `s` (in 1/10 000), one bin step moves the
 * price by the factor `(1 + s)`. A drop of `d` percent is the factor `1/(1 - d/100)`, so
 * `bins = ln(1/(1 - d/100)) / ln(1 + s)`. A rise is `ln(1 + d/100) / ln(1 + s)`.
 */
export const BINS_PER_BIN_ARRAY = 70;
export const BIN_ARRAY_RENT_SOL = 0.075;
export const DLMM_MAX_BINS_PER_POSITION = 1400;

/** Bins needed to span a drop of `downPct` percent, at bin step `binStep` (1/10 000). */
export function binsDownPct(downPct: number, binStep: number): number {
  if (!(downPct > 0) || downPct >= 100 || !(binStep > 0)) return 0;
  return Math.ceil(Math.log(1 / (1 - downPct / 100)) / Math.log(1 + binStep / 10_000));
}

/** Bins needed to span a rise of `upPct` percent, at bin step `binStep` (1/10 000). */
export function binsUpPct(upPct: number, binStep: number): number {
  if (!(upPct > 0) || !(binStep > 0)) return 0;
  return Math.ceil(Math.log(1 + upPct / 100) / Math.log(1 + binStep / 10_000));
}

/** Deepest drop, in percent, that `bins` bins can span below the active bin. */
export function depthForBins(bins: number, binStep: number): number {
  if (!(bins > 0) || !(binStep > 0)) return 0;
  return (1 - 1 / (1 + binStep / 10_000) ** bins) * 100;
}

/**
 * Bin arrays a range of `bins` bins may touch. Arrays are 70-bin segments aligned at
 * `floor(binId / 70)`, so a range always touches at least `ceil(bins/70)` and can touch
 * one more when it straddles a boundary (69 of every 70 placements). Estimating the
 * larger figure is the right side to be wrong on for a rent figure.
 */
export function binArraysEstimate(bins: number): number {
  if (!(bins > 0)) return 0;
  return Math.ceil(bins / BINS_PER_BIN_ARRAY) + 1;
}

export interface BinRangeAssessment {
  /** Bins needed for the whole range: downside leg plus upside leg. */
  binsNeeded: number;
  /** The ceiling this engine would actually fund (`min(LIVE_MAX_POSITION_BINS, 1400)`). */
  binCap: number;
  /** Whether the range can be built without truncation. */
  fits: boolean;
  /** When it does not fit: the deepest drop the cap can span. */
  deepestRealPct: number | null;
  /** Worst-case bin arrays touched, and the refundable deposit they imply. */
  binArrays: number;
  binRentSol: number;
}

export function assessBinRange(params: {
  downPct: number;
  upPct: number;
  binStep: number;
  binCap?: number;
}): BinRangeAssessment {
  const binCap = Math.min(
    params.binCap ?? DLMM_MAX_BINS_PER_POSITION,
    DLMM_MAX_BINS_PER_POSITION,
  );
  const downBins = binsDownPct(params.downPct, params.binStep);
  const upBins = binsUpPct(params.upPct, params.binStep);
  const binsNeeded = downBins + upBins;
  const fits = binsNeeded <= binCap;
  const binArrays = binArraysEstimate(binsNeeded);
  return {
    binsNeeded,
    binCap,
    fits,
    deepestRealPct: fits ? null : depthForBins(binCap, params.binStep),
    binArrays,
    binRentSol: binArrays * BIN_ARRAY_RENT_SOL,
  };
}

/** Indonesian number style, the way the rest of the card writes numbers. */
const fmtId = (n: number, digits: number): string =>
  n.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/**
 * The card lines for range physics. Lives here, next to the arithmetic it describes, so
 * the text the operator reads can be covered by the same tests that check the numbers —
 * a card that says "muat" while the cap says otherwise is worse than no line at all.
 */
export function binRangeCardLines(
  a: BinRangeAssessment,
  downPct: number,
  upPct: number,
): string[] {
  const out = [
    `Rentang −${fmtId(Math.abs(downPct), 0)}% / +${fmtId(Math.abs(upPct), 0)}% butuh ` +
      `${fmtId(a.binsNeeded, 0)} bin (batas ${fmtId(a.binCap, 0)}) — ${a.fits ? "muat" : "TIDAK muat"}`,
  ];
  if (!a.fits && a.deepestRealPct !== null) {
    out.push(
      `⚠️ Kalau dipaksa, kedalaman yang benar-benar bisa dibangun cuma sekitar ` +
        `−${fmtId(a.deepestRealPct, 1)}% — sisanya bin kosong yang nggak pernah kena harga`,
    );
  }
  out.push(
    `Sewa bin: paling banyak ${fmtId(a.binArrays, 0)} array × ${fmtId(BIN_ARRAY_RENT_SOL, 3)} SOL = ` +
      `${fmtId(a.binRentSol, 3)} SOL (titipan, bukan biaya — balik utuh saat posisi ditutup)`,
  );
  return out;
}
