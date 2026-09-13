/**
 * Shared machinery for the parameter sweeps.
 *
 * Both `npm run sweep:exits` and `npm run sweep:entry` need the same three things: an
 * in/out-of-sample split of the window, a scored run of one configuration, and a bar
 * that a setting has to clear before it counts as a finding. Keeping them here means the
 * two sweeps cannot quietly diverge on what "survived out-of-sample" means — which is
 * the whole basis for trusting either of them.
 */
import { runSimulation, type BacktestConfig } from "./engine.js";
import type { PoolHistory } from "./historicalData.js";
import type { calibrateTvlModel } from "./tvlModel.js";

export type TvlModel = ReturnType<typeof calibrateTvlModel>;

export interface Scored {
  trades: number;
  winRatePct: number;
  netPnlUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  /** avgWin / |avgLoss|. Null when there were no losing trades to divide by. */
  payoff: number | null;
  expectancyUsd: number;
}

export interface Split {
  inPools: PoolHistory[];
  outPools: PoolHistory[];
  inSol: PoolHistory["bars"];
  outSol: PoolHistory["bars"];
  start: number;
  mid: number;
  end: number;
}

export const fmt = (v: number, d = 2): string =>
  Number.isFinite(v) ? v.toFixed(d) : v > 0 ? "inf" : "-inf";

export const pf = (v: number | null): string => (v === null ? "—" : fmt(v));

export const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

/** Keeps only the bars inside [from, to), dropping pools left with too little history. */
export function sliceDataset(pools: PoolHistory[], from: number, to: number): PoolHistory[] {
  return pools
    .map((p) => ({ ...p, bars: p.bars.filter((b) => b.t >= from && b.t < to) }))
    .filter((p) => p.bars.length > 24);
}

/**
 * Splits the window down the middle in TIME, not by pool.
 *
 * Splitting by pool would leak: the same market regime would sit on both sides and a
 * setting fitted to it would score well twice for the same reason.
 */
export function splitWindow(pools: PoolHistory[], solUsdBars: PoolHistory["bars"]): Split {
  const times = pools.flatMap((p) => p.bars.map((b) => b.t));
  const start = Math.min(...times);
  const end = Math.max(...times);
  const mid = start + (end - start) / 2;

  return {
    inPools: sliceDataset(pools, start, mid),
    outPools: sliceDataset(pools, mid, end + 1),
    inSol: solUsdBars.filter((b) => b.t >= start && b.t < mid),
    outSol: solUsdBars.filter((b) => b.t >= mid),
    start,
    mid,
    end,
  };
}

export interface DatasetWindow {
  label: string;
  start: number;
  end: number;
  pools: PoolHistory[];
  solUsdBars: PoolHistory["bars"];
  /** Days of data the window actually covers, which can be fewer than requested. */
  coveredDays: number;
}

/**
 * Cuts NON-OVERLAPPING windows of `days` backwards from the latest bar: window 1 is the
 * most recent, window 2 the `days` before it, and so on.
 *
 * Backwards because the newest data is the data that exists for every pool; the oldest
 * window is the one the free tier's ~208-day depth truncates, and a truncated window is
 * reported with its real coverage rather than silently shorter. A window with no bars at
 * all is dropped — "no data" is not a window of zero trades.
 */
export function nonOverlappingWindows(
  pools: PoolHistory[],
  solUsdBars: PoolHistory["bars"],
  days: number,
  count: number,
): DatasetWindow[] {
  const times = pools.flatMap((p) => p.bars.map((b) => b.t));
  if (times.length === 0) return [];
  const earliest = Math.min(...times);
  const latest = Math.max(...times);
  const span = days * 24 * 3600;

  const out: DatasetWindow[] = [];
  for (let i = 0; i < count; i++) {
    const end = latest + 1 - i * span;
    const start = end - span;
    if (end <= earliest) break;
    const windowPools = sliceDataset(pools, start, end);
    if (windowPools.length === 0) break;
    const firstBar = Math.max(start, earliest);
    out.push({
      label: `W${i + 1}`,
      start,
      end,
      pools: windowPools,
      solUsdBars: solUsdBars.filter((b) => b.t >= start && b.t < end),
      coveredDays: (end - firstBar) / 86_400,
    });
  }
  return out;
}

/**
 * Runs one configuration and reduces it to comparable numbers.
 *
 * Returns null when the simulation cannot run at all (for example every pool filtered
 * out), which the caller must treat as "no evidence", never as a zero.
 */
export function scoreConfig(
  pools: PoolHistory[],
  solUsdBars: PoolHistory["bars"],
  tvlModel: TvlModel,
  config: BacktestConfig,
  label = "sweep",
): Scored | null {
  let result;
  try {
    result = runSimulation({ label, pools, solUsdBars, tvlModel, config });
  } catch {
    return null;
  }

  const s = result.summary;
  const wins = result.trades.filter((t) => t.netPnlUsd > 0).map((t) => t.netPnlUsd);
  const losses = result.trades.filter((t) => t.netPnlUsd <= 0).map((t) => t.netPnlUsd);
  const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  const avgWinUsd = mean(wins);
  const avgLossUsd = mean(losses);

  return {
    trades: s.totalTrades,
    winRatePct: s.winRatePct,
    netPnlUsd: s.netPnlUsd,
    profitFactor: s.profitFactor,
    maxDrawdownPct: s.maxDrawdownPct,
    avgWinUsd,
    avgLossUsd,
    payoff: avgLossUsd < 0 ? avgWinUsd / Math.abs(avgLossUsd) : null,
    expectancyUsd: s.totalTrades > 0 ? s.netPnlUsd / s.totalTrades : 0,
  };
}

/**
 * The bar a setting must clear to be reported as a finding, in BOTH halves:
 *
 *  1. payoff > 1 — the average win must beat the average loss. A hard requirement: a
 *     setting that profits only by winning more OFTEN still leaves every individual
 *     loss bigger than every individual win.
 *  2. expectancy > 0 — payoff alone can be won by rare huge wins on a losing rate.
 *  3. enough trades that neither number is one lucky position.
 */
export function survivedOutOfSample(
  inS: Scored,
  outS: Scored | null,
  minTrades: number,
): outS is Scored {
  if (outS === null) return false;
  return (
    inS.trades >= minTrades &&
    outS.trades >= minTrades &&
    inS.payoff !== null &&
    outS.payoff !== null &&
    inS.payoff > 1 &&
    outS.payoff > 1 &&
    inS.expectancyUsd > 0 &&
    outS.expectancyUsd > 0
  );
}
