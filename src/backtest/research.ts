import { lpValueReturnFraction } from "../services/meteora.js";
import { estimateTvlAt, type TvlModel } from "./tvlModel.js";
import type { Bar, PoolHistory } from "./historicalData.js";

/**
 * Opportunity enumeration for quantitative research.
 *
 * Analysing only the trades the live filter executed would be selection bias: those
 * are precisely the observations that already passed the rules under test. Instead
 * every pool-bar with a full 24h lookback is treated as a hypothetical entry and
 * simulated forward under fixed mechanical rules, which turns ~43 executed trades
 * into ~13k observations spanning the pools the filter rejected as well.
 *
 * Every FEATURE is computed from data at or before the entry bar. Every OUTCOME uses
 * forward bars. Mixing the two would leak the answer into the predictors.
 */

export interface OpportunityFeatures {
  /** Modelled point-in-time TVL — see tvlModel.ts for why it is not a snapshot. */
  tvlUsd: number;
  vol24hUsd: number;
  /** Turnover: how many times the pool's liquidity traded over in 24h. */
  volTvlRatio: number;
  /** Fees over 24h as a fraction of TVL. */
  feeTvlRatio24h: number;
  priceChange24hPct: number;
  priceChange1hPct: number;
  /**
   * Volume surge: last hour annualised to a day, over actual 24h volume. 1.0 means
   * the last hour was typical; 5.0 means it was five times the running rate.
   */
  volumeSurge: number;
  /** Standard deviation of hourly log returns over the trailing 24 bars, in percent. */
  realizedVol24hPct: number;
  /** Hours since the pool was created, when known. */
  poolAgeHours: number | null;
  entryHourUtc: number;
  binStep: number;
  feeRatePct: number;
  cohort: string;
}

export interface OpportunityOutcome {
  feesPct: number;
  positionValuePct: number;
  costPct: number;
  netPnlPct: number;
  durationHours: number;
  exitReason: string;
  isLoss: boolean;
  /** Loss worse than 10% of notional — the tail this research exists to avoid. */
  isBigLoss: boolean;
}

export interface Opportunity extends OpportunityFeatures, OpportunityOutcome {
  poolAddress: string;
  pairName: string;
  entryTime: number;
}

export interface EnumerateConfig {
  downsideCoverPct: number;
  upsideCoverPct: number;
  takeProfitFeePct: number;
  maxDurationHours: number;
  gasSolPerTransaction: number;
  forcedExitSlippagePct: number;
  /** Fixed notional keeps outcomes comparable; compounding would be path-dependent. */
  notionalUsd: number;
}

export const defaultEnumerateConfig = (): EnumerateConfig => ({
  downsideCoverPct: 25,
  upsideCoverPct: 15,
  takeProfitFeePct: 5,
  maxDurationHours: 24,
  gasSolPerTransaction: 0.0035,
  forcedExitSlippagePct: 1.0,
  notionalUsd: 250,
});

/* ------------------------------------------------------------------ */
/* Feature computation                                                 */
/* ------------------------------------------------------------------ */

function trailingVolume(bars: Bar[], index: number, window: number): number {
  let sum = 0;
  for (let i = Math.max(0, index - window + 1); i <= index; i++) sum += bars[i]?.v ?? 0;
  return sum;
}

/** Standard deviation of hourly log returns, expressed as a percentage. */
export function realizedVolPct(bars: Bar[], index: number, window = 24): number | null {
  if (index < window) return null;

  const returns: number[] = [];
  for (let i = index - window + 1; i <= index; i++) {
    const prev = bars[i - 1]?.c;
    const now = bars[i]?.c;
    if (!prev || !now || prev <= 0 || now <= 0) continue;
    returns.push(Math.log(now / prev));
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * 100;
}

function pctChange(bars: Bar[], index: number, lookback: number): number | null {
  const now = bars[index]?.c;
  const then = bars[index - lookback]?.c;
  if (!now || !then || then <= 0) return null;
  return (now / then - 1) * 100;
}

/* ------------------------------------------------------------------ */
/* Forward simulation                                                  */
/* ------------------------------------------------------------------ */

function simulateForward(
  pool: PoolHistory,
  entryIndex: number,
  tvlUsd: number,
  solUsd: number,
  config: EnumerateConfig,
): OpportunityOutcome | null {
  const entryBar = pool.bars[entryIndex];
  if (!entryBar || !(entryBar.c > 0) || !(tvlUsd > 0)) return null;

  const entryPrice = entryBar.c;
  const lower = entryPrice * (1 - config.downsideCoverPct / 100);
  const upper = entryPrice * (1 + config.upsideCoverPct / 100);
  const share = config.notionalUsd / tvlUsd;

  let feesUsd = 0;
  let exitPrice = entryPrice;
  let exitReason = "END_OF_DATA";
  let hoursHeld = 0;
  let forced = false;

  for (let i = entryIndex + 1; i < pool.bars.length; i++) {
    const bar = pool.bars[i]!;
    hoursHeld = i - entryIndex;
    exitPrice = bar.c;

    const inRange = bar.c >= lower && bar.c <= upper;
    if (inRange) feesUsd += pool.feeRate * bar.v * share;

    const feePct = (feesUsd / config.notionalUsd) * 100;

    if (!inRange) {
      exitReason = "OUT_OF_RANGE";
      forced = true;
      break;
    }
    if (feePct >= config.takeProfitFeePct) {
      exitReason = "FEE_TAKE_PROFIT";
      break;
    }
    if (hoursHeld >= config.maxDurationHours) {
      exitReason = "TIMEOUT";
      break;
    }
  }

  if (hoursHeld === 0) return null; // no forward bar to evaluate

  const slippageFactor = forced ? 1 - config.forcedExitSlippagePct / 100 : 1;
  const realisedPrice = exitPrice * slippageFactor;
  const r = realisedPrice / entryPrice;

  const positionValueUsd = config.notionalUsd * lpValueReturnFraction(r);
  const grossValueUsd = config.notionalUsd * lpValueReturnFraction(exitPrice / entryPrice);
  const slippageUsd = Math.abs(grossValueUsd - positionValueUsd);
  const gasUsd = config.gasSolPerTransaction * 2 * solUsd;

  const costUsd = gasUsd + slippageUsd;
  const netUsd = feesUsd + positionValueUsd - gasUsd - slippageUsd;
  const netPnlPct = (netUsd / config.notionalUsd) * 100;

  return {
    feesPct: (feesUsd / config.notionalUsd) * 100,
    positionValuePct: (positionValueUsd / config.notionalUsd) * 100,
    costPct: (costUsd / config.notionalUsd) * 100,
    netPnlPct,
    durationHours: hoursHeld,
    exitReason,
    isLoss: netPnlPct < 0,
    isBigLoss: netPnlPct <= -10,
  };
}

/* ------------------------------------------------------------------ */
/* Enumeration                                                         */
/* ------------------------------------------------------------------ */

function solPriceAt(solBars: Bar[], t: number): number | null {
  let best: number | null = null;
  for (const bar of solBars) {
    if (bar.t > t) break;
    best = bar.c;
  }
  return best;
}

export function enumerateOpportunities(
  pools: PoolHistory[],
  solUsdBars: Bar[],
  tvlModel: TvlModel,
  config: EnumerateConfig = defaultEnumerateConfig(),
  poolAgeMsByAddress: Record<string, number> = {},
): Opportunity[] {
  const out: Opportunity[] = [];

  for (const pool of pools) {
    const createdAtMs = poolAgeMsByAddress[pool.address];

    for (let i = 24; i < pool.bars.length - 1; i++) {
      const bar = pool.bars[i]!;

      const vol24h = trailingVolume(pool.bars, i, 24);
      if (!(vol24h > 0)) continue;

      const tvlUsd = estimateTvlAt(tvlModel, pool.address, vol24h).tvlUsd;
      if (!(tvlUsd > 0)) continue;

      const change24h = pctChange(pool.bars, i, 24);
      const change1h = pctChange(pool.bars, i, 1);
      const rvol = realizedVolPct(pool.bars, i, 24);
      if (change24h === null || change1h === null || rvol === null) continue;

      const solUsd = solPriceAt(solUsdBars, bar.t);
      if (solUsd === null || !(solUsd > 0)) continue;

      const outcome = simulateForward(pool, i, tvlUsd, solUsd, config);
      if (!outcome) continue;

      const vol1h = pool.bars[i]?.v ?? 0;

      out.push({
        poolAddress: pool.address,
        pairName: pool.pairName,
        entryTime: bar.t,
        tvlUsd,
        vol24hUsd: vol24h,
        volTvlRatio: vol24h / tvlUsd,
        feeTvlRatio24h: (pool.feeRate * vol24h) / tvlUsd,
        priceChange24hPct: change24h,
        priceChange1hPct: change1h,
        volumeSurge: vol24h > 0 ? (vol1h * 24) / vol24h : 0,
        realizedVol24hPct: rvol,
        poolAgeHours:
          createdAtMs !== undefined && createdAtMs > 0
            ? (bar.t * 1000 - createdAtMs) / 3_600_000
            : null,
        entryHourUtc: new Date(bar.t * 1000).getUTCHours(),
        binStep: pool.binStep,
        feeRatePct: pool.feeRate * 100,
        cohort: pool.cohort,
        ...outcome,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Bucketed statistics                                                 */
/* ------------------------------------------------------------------ */

export interface BucketStats {
  label: string;
  n: number;
  meanNetPct: number;
  medianNetPct: number;
  winRatePct: number;
  bigLossRatePct: number;
  meanFeesPct: number;
  meanPositionValuePct: number;
  /** Mean fee income divided by mean absolute value loss. Higher is better. */
  feeToLossRatio: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

export function summarise(label: string, rows: Opportunity[]): BucketStats {
  const n = rows.length;
  if (n === 0) {
    return {
      label,
      n: 0,
      meanNetPct: 0,
      medianNetPct: 0,
      winRatePct: 0,
      bigLossRatePct: 0,
      meanFeesPct: 0,
      meanPositionValuePct: 0,
      feeToLossRatio: 0,
    };
  }

  const mean = (fn: (o: Opportunity) => number) => rows.reduce((s, o) => s + fn(o), 0) / n;
  const meanFees = mean((o) => o.feesPct);
  const meanValue = mean((o) => o.positionValuePct);

  return {
    label,
    n,
    meanNetPct: mean((o) => o.netPnlPct),
    medianNetPct: median(rows.map((o) => o.netPnlPct)),
    winRatePct: (rows.filter((o) => !o.isLoss).length / n) * 100,
    bigLossRatePct: (rows.filter((o) => o.isBigLoss).length / n) * 100,
    meanFeesPct: meanFees,
    meanPositionValuePct: meanValue,
    feeToLossRatio: meanValue < 0 ? meanFees / Math.abs(meanValue) : Infinity,
  };
}

/* ------------------------------------------------------------------ */
/* Sequential book                                                     */
/* ------------------------------------------------------------------ */

export interface BookResult {
  trades: number;
  winRatePct: number;
  meanNetPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  totalReturnPct: number;
  bigLossRatePct: number;
}

/**
 * Walks the enumerated opportunities as a tradeable book: one position at a time,
 * no overlaps, best-ranked candidate taken at each free moment.
 *
 * This exists because compounding the raw enumeration is meaningless — those entries
 * overlap in time, so treating them as a sequence multiplies returns that could never
 * have been earned together and drives any drawdown figure straight to 100%. Profit
 * factor and drawdown are only interpretable on a non-overlapping book.
 */
export function simulateBook(
  rows: Opportunity[],
  rank: (o: Opportunity) => number,
  eligible: (o: Opportunity) => boolean = () => true,
): BookResult {
  const candidates = rows.filter(eligible).sort((a, b) => a.entryTime - b.entryTime);

  const taken: Opportunity[] = [];
  let freeFrom = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const o = candidates[i]!;
    if (o.entryTime < freeFrom) continue;

    // Among everything opening at this same timestamp, keep the best-ranked one.
    let best = o;
    let j = i;
    while (j < candidates.length && candidates[j]!.entryTime === o.entryTime) {
      if (rank(candidates[j]!) > rank(best)) best = candidates[j]!;
      j++;
    }

    taken.push(best);
    freeFrom = best.entryTime + best.durationHours * 3600;
  }

  if (taken.length === 0) {
    return {
      trades: 0,
      winRatePct: 0,
      meanNetPct: 0,
      profitFactor: null,
      maxDrawdownPct: 0,
      totalReturnPct: 0,
      bigLossRatePct: 0,
    };
  }

  let equity = 100;
  let peak = 100;
  let maxDd = 0;
  let gross = 0;
  let loss = 0;

  for (const o of taken) {
    if (o.netPnlPct > 0) gross += o.netPnlPct;
    else loss += Math.abs(o.netPnlPct);

    equity *= 1 + o.netPnlPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  }

  return {
    trades: taken.length,
    winRatePct: (taken.filter((o) => !o.isLoss).length / taken.length) * 100,
    meanNetPct: taken.reduce((s, o) => s + o.netPnlPct, 0) / taken.length,
    profitFactor: loss > 0 ? gross / loss : null,
    maxDrawdownPct: maxDd,
    totalReturnPct: equity - 100,
    bigLossRatePct: (taken.filter((o) => o.isBigLoss).length / taken.length) * 100,
  };
}

/** Splits rows into buckets by a numeric feature, using the supplied edges. */
export function bucketBy(
  rows: Opportunity[],
  feature: (o: Opportunity) => number,
  edges: number[],
  format: (n: number) => string = (n) => n.toFixed(2),
): BucketStats[] {
  const out: BucketStats[] = [];

  for (let i = 0; i <= edges.length; i++) {
    const lo = i === 0 ? -Infinity : edges[i - 1]!;
    const hi = i === edges.length ? Infinity : edges[i]!;

    const label =
      i === 0
        ? `< ${format(hi)}`
        : i === edges.length
          ? `>= ${format(lo)}`
          : `${format(lo)} – ${format(hi)}`;

    out.push(summarise(label, rows.filter((o) => feature(o) >= lo && feature(o) < hi)));
  }

  return out;
}
