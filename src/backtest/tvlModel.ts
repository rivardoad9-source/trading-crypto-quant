import type { DlmmPool } from "../services/meteora.js";

/**
 * Point-in-time TVL estimation.
 *
 * THE LOAD-BEARING ASSUMPTION OF THE UNBIASED BACKTEST — read this before trusting
 * any number the harness produces.
 *
 * No free provider serves historical TVL for Meteora DLMM pools: DexScreener returns
 * only current `liquidity.usd`, and GeckoTerminal's OHLCV rows carry six fields
 * (t, o, h, l, c, v) with no liquidity at all. Yet an unbiased backtest cannot use
 * today's TVL snapshot either: a rugged pool reads ~$0 today, so a MIN_TVL_USD filter
 * applied to the snapshot would reject every dead pool and silently restore the exact
 * survivorship bias the harness exists to remove.
 *
 * So TVL is MODELLED from volume, calibrated against the live cross-section where
 * both quantities are observable:
 *
 *   TVL_t ≈ k × volume24h_t
 *
 * `k` is fitted per-pool when the pool is still alive today (k = TVL_today /
 * volume24h_today), and falls back to the cross-sectional median for pools that are
 * dead today. The fit is loose — the dispersion is reported so its width is visible
 * rather than assumed away.
 */

export interface TvlModel {
  /** Median TVL / 24h-volume across the calibration cross-section. */
  medianK: number;
  /** Interquartile range of k, as a measure of how loose the fit is. */
  p25K: number;
  p75K: number;
  samples: number;
  /** Per-pool k, keyed by pool address, for pools observable today. */
  perPoolK: Record<string, number>;
  /**
   * ON-CHAIN TVL series (see `onchainTvl.ts`), sorted by t. When present the model is NOT used at
   * all: `tvlAtBar` reads the last sample at or before the bar, refuses one older than
   * `seriesMaxStaleSec`, and a pool without a series has an UNKNOWN TVL. Absent = the volume model,
   * byte-identical to before this field existed.
   */
  series?: Record<string, ReadonlyArray<{ t: number; tvlUsd: number }>>;
  seriesMaxStaleSec?: number;
}

/** Clamps to keep a pathological k from producing absurd TVL. */
const MIN_K = 0.001;
const MAX_K = 50;

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx] ?? 0;
}

/**
 * Fits the model on pools where TVL and 24h volume are both currently observable.
 * Pools with no volume or no TVL contribute nothing — their ratio is undefined.
 */
export function calibrateTvlModel(livePools: DlmmPool[]): TvlModel {
  const perPoolK: Record<string, number> = {};
  const ks: number[] = [];

  for (const pool of livePools) {
    if (!(pool.tvlUsd > 0) || !(pool.volume24hUsd > 0)) continue;

    const k = pool.tvlUsd / pool.volume24hUsd;
    if (!Number.isFinite(k) || k < MIN_K || k > MAX_K) continue;

    perPoolK[pool.address] = k;
    ks.push(k);
  }

  ks.sort((a, b) => a - b);

  return {
    medianK: median(ks),
    p25K: quantile(ks, 0.25),
    p75K: quantile(ks, 0.75),
    samples: ks.length,
    perPoolK,
  };
}

export interface TvlEstimate {
  tvlUsd: number;
  /** "per-pool" when the pool's own ratio was usable, "median" when it fell back. */
  basis: "per-pool" | "median";
  k: number;
}

/**
 * Estimates a pool's TVL at a historical bar from that bar's trailing 24h volume.
 *
 * A pool that is dead today still has real historical volume, so this yields a
 * plausible historical TVL for exactly the pools a snapshot-based approach would
 * have thrown away.
 */
export function estimateTvlAt(
  model: TvlModel,
  poolAddress: string,
  trailing24hVolumeUsd: number,
): TvlEstimate {
  const perPool = model.perPoolK[poolAddress];
  const usable = perPool !== undefined && Number.isFinite(perPool) && perPool > 0;

  const k = usable ? perPool : model.medianK;
  const basis: TvlEstimate["basis"] = usable ? "per-pool" : "median";

  return {
    tvlUsd: Math.max(0, k * Math.max(0, trailing24hVolumeUsd)),
    basis,
    k,
  };
}

/**
 * The TVL the engine gates on at bar `t`. Volume model unless the model carries on-chain series;
 * then the series or NOTHING — null means unknown, and the engine refuses the bar rather than
 * falling back to a model the validation showed to be wrong by more than 2x most of the time.
 */
export function tvlAtBar(model: TvlModel, poolAddress: string, trailing24hVolumeUsd: number, t: number): number | null {
  if (!model.series) return estimateTvlAt(model, poolAddress, trailing24hVolumeUsd).tvlUsd;
  const points = model.series[poolAddress];
  if (!points || points.length === 0) return null;
  const maxStale = model.seriesMaxStaleSec ?? 18 * 3600;
  let lo = 0;
  let hi = points.length - 1;
  let best: { t: number; tvlUsd: number } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= t) {
      best = points[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best && t - best.t <= maxStale ? best.tvlUsd : null;
}

export function describeTvlModel(model: TvlModel): string {
  return (
    `TVL modelled as k x 24h volume; k median ${model.medianK.toFixed(3)} ` +
    `(IQR ${model.p25K.toFixed(3)}–${model.p75K.toFixed(3)}) from ${model.samples} live pools`
  );
}
