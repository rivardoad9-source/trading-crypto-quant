/**
 * Portfolio risk metrics. Pure functions over an ordered list of realised trade PnLs,
 * so they can be unit-tested without touching the database.
 */

export interface DrawdownResult {
  /** Largest peak-to-trough decline of the equity curve, as a positive percentage. */
  maxDrawdownPct: number;
  /** The same decline in USD, as a positive number. */
  maxDrawdownUsd: number;
  /** Equity at the peak preceding the worst decline. */
  peakEquityUsd: number;
  /** Equity at the trough of the worst decline. */
  troughEquityUsd: number;
  /** How far below the running peak the curve currently sits, as a percentage. */
  currentDrawdownPct: number;
}

/**
 * Max drawdown over the realised equity curve.
 *
 * The curve starts at `startingEquityUsd` and steps once per closed trade, in close
 * order. It deliberately ignores open positions: floating PnL would make the metric
 * jump around on every poll and would not be reproducible from history.
 *
 * A drawdown is only recorded once the curve actually turns down from a peak, so a
 * monotonically rising curve returns 0 rather than a spurious value.
 */
export function computeMaxDrawdown(
  realisedPnls: number[],
  startingEquityUsd: number,
): DrawdownResult {
  let equity = startingEquityUsd;
  let peak = startingEquityUsd;

  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let peakAtWorst = startingEquityUsd;
  let troughAtWorst = startingEquityUsd;

  for (const pnl of realisedPnls) {
    if (!Number.isFinite(pnl)) continue;
    equity += pnl;

    if (equity > peak) {
      peak = equity;
      continue;
    }

    const declineUsd = peak - equity;
    // Percentage is undefined against a non-positive peak; fall back to absolute only.
    const declinePct = peak > 0 ? (declineUsd / peak) * 100 : 0;

    if (declinePct > maxDrawdownPct || (peak <= 0 && declineUsd > maxDrawdownUsd)) {
      maxDrawdownPct = declinePct;
      maxDrawdownUsd = declineUsd;
      peakAtWorst = peak;
      troughAtWorst = equity;
    }
  }

  const currentDrawdownPct = peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0;

  return {
    maxDrawdownPct,
    maxDrawdownUsd,
    peakEquityUsd: peakAtWorst,
    troughEquityUsd: troughAtWorst,
    currentDrawdownPct,
  };
}

export interface ProfitFactorResult {
  /**
   * Gross profit / gross loss.
   *
   * null means the ratio is undefined, not zero: either there are no closed trades,
   * or there are no losing trades so the denominator is zero. Returning Infinity or 0
   * here would render as a real measurement on the dashboard.
   */
  profitFactor: number | null;
  grossProfitUsd: number;
  grossLossUsd: number;
  winningTrades: number;
  losingTrades: number;
}

/**
 * Profit factor over closed trades.
 *
 * A break-even trade (exactly 0) counts as neither profit nor loss but is still a
 * closed trade, matching how the win-rate card treats it as a non-win.
 */
export function computeProfitFactor(realisedPnls: number[]): ProfitFactorResult {
  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  let winningTrades = 0;
  let losingTrades = 0;

  for (const pnl of realisedPnls) {
    if (!Number.isFinite(pnl)) continue;
    if (pnl > 0) {
      grossProfitUsd += pnl;
      winningTrades++;
    } else if (pnl < 0) {
      grossLossUsd += Math.abs(pnl);
      losingTrades++;
    }
  }

  const profitFactor = grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : null;

  return { profitFactor, grossProfitUsd, grossLossUsd, winningTrades, losingTrades };
}
