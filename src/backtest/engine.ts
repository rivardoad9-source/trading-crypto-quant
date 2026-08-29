import {
  assessBreakeven,
  impermanentLossFraction,
  lpValueReturnFraction,
} from "../services/meteora.js";
import { computeMaxDrawdown, computeProfitFactor } from "../services/metrics.js";
import { estimateTvlAt, type TvlModel } from "./tvlModel.js";
import type { Bar, PoolHistory } from "./historicalData.js";

/**
 * Bar-by-bar DLMM paper-trading simulation.
 *
 * Pure: it takes already-fetched history and returns results, with no network or
 * database access, so the whole engine is unit-testable.
 */

export interface BacktestConfig {
  /**
   * Starting account balance in USD. When set, each position deploys the full
   * current equity, so results compound the way a real account would. Takes
   * precedence over virtualSol.
   */
  startingCapitalUsd: number | null;
  /**
   * Legacy SOL-denominated sizing, used only when startingCapitalUsd is null.
   * Notional is virtualSol x SOL/USD at entry.
   */
  virtualSol: number;
  /**
   * Share of current equity deployed per position, as a percentage.
   *
   * Deploying 100% means a single bad trade hits the whole account, which is why max
   * drawdown tracked the worst individual trade. Profit factor is unaffected (gross
   * profit and gross loss scale together) but drawdown scales roughly linearly, so
   * this is the direct lever on drawdown. Gas is fixed per trade, so sizing too small
   * lets fees be eaten by transaction cost.
   */
  positionSizePct: number;
  /**
   * Bin range as a fraction of entry price covered below spot.
   *
   * Wider is NOT safer. A wide band removes the effective stop and lets a position
   * ride a loss down. Measured on the 30-day unbiased set: 25% gave PF 1.36 / 39%
   * drawdown, 45% gave PF 1.20 / 66%.
   */
  downsideCoverPct: number;
  /** Bin range as a fraction of entry price covered above spot. */
  upsideCoverPct: number;
  /** Entry filter: trailing 24h volume in USD. */
  minVolume24hUsd: number;
  /** Entry filter: trailing 24h fees / TVL, as a ratio (0.008 === 0.8%). */
  minFeeTvlRatio: number;
  /** Entry filter: upper bound on fee/TVL, rejecting implausible yields. */
  maxFeeTvlRatio: number;
  /** Entry filter: minimum TVL in USD, applied to the MODELLED point-in-time TVL. */
  minTvlUsd: number;
  /**
   * Entry filter: reject a pool whose token gained more than this over the trailing
   * 24 bars. Entering at the top of a pump is how a position ends up fully converted
   * to the dumped token on the retrace.
   */
  maxPriceChange24hPct: number;
  /**
   * Entry filter: projected 24h fee income must be at least this multiple of the
   * round-trip cost (gas x2 + slippage in/out), or the pool is skipped.
   *
   * Counter-intuitively, RAISING this makes results worse. The gate is a floor on
   * fee/TVL (coverage x slippage), so a high setting selects for the highest-yield
   * pools — which are the least stable ones. Measured on the 30-day unbiased set at
   * $500: coverage 1.0 gave PF 1.55 / 20.3% drawdown, coverage 2.5 gave PF 0.62 /
   * 62.9%. Raise it only with fresh evidence.
   */
  minFeeCostCoverage: number;
  /** Exit: accumulated fees as a percentage of position notional. */
  takeProfitFeePct: number;
  /**
   * Exit: close when mark-to-market NET PnL reaches this percentage of notional.
   *
   * Distinct from takeProfitFeePct, and the one that mirrors the live engine:
   * `evaluateExit` compares TAKE_PROFIT_PCT against net PnL (fees + LP value change),
   * not against fees alone. Without this the harness could not answer what the live
   * take-profit should be, because it was measuring a different quantity.
   *
   * Defaults to Infinity, i.e. disabled, so existing backtest output is unchanged.
   */
  takeProfitNetPct: number;
  /**
   * Exit: close when net PnL falls to this percentage of notional (negative).
   *
   * The live engine has always had a stop-loss; the backtest did not, which both
   * understated the live rules and left drawdown with no direct lever. Set to a large
   * negative number (e.g. -100) to disable.
   */
  stopLossPct: number;
  /** Exit: maximum holding period in hours. */
  maxDurationHours: number;
  /** How many positions may be open at once across all pools. */
  maxConcurrentPositions: number;

  /* ---- Realistic execution costs ---- */
  /** SOL burnt per transaction (priority + base fee). A position costs two. */
  gasSolPerTransaction: number;
  /** Price concession taken on a forced exit, as a percentage. */
  forcedExitSlippagePct: number;
  /**
   * Bars examined after an exit to decide whether the position could actually have
   * been liquidated at the exit price.
   */
  rugLookaheadBars: number;
  /**
   * Forward volume below this fraction of the entry-time 24h volume counts as
   * liquidity having dried up.
   */
  rugVolumeCollapseRatio: number;
}

export const defaultBacktestConfig = (): BacktestConfig => ({
  startingCapitalUsd: 100,
  virtualSol: 10,
  positionSizePct: 50,
  downsideCoverPct: 25,
  upsideCoverPct: 15,
  minVolume24hUsd: 10_000,
  minFeeTvlRatio: 0.008,
  maxFeeTvlRatio: 0.25,
  minTvlUsd: 50_000,
  maxPriceChange24hPct: 150,
  minFeeCostCoverage: 1.0,
  takeProfitFeePct: 5,
  takeProfitNetPct: Number.POSITIVE_INFINITY,
  stopLossPct: -15,
  maxDurationHours: 24,
  maxConcurrentPositions: 1,
  gasSolPerTransaction: 0.0035,
  forcedExitSlippagePct: 1.0,
  rugLookaheadBars: 24,
  rugVolumeCollapseRatio: 0.01,
});

export type ExitReason =
  | "OUT_OF_RANGE"
  | "FEE_TAKE_PROFIT"
  | "TAKE_PROFIT"
  | "TIMEOUT"
  | "END_OF_DATA"
  | "STOP_LOSS"
  | "RUGGED";

export interface BacktestTrade {
  poolAddress: string;
  pairName: string;
  /** Which cohort the pool came from — the survivorship-bias control. */
  cohort: string;
  entryTime: string;
  exitTime: string;
  durationHours: number;
  /** USD close at entry/exit. */
  entryPrice: number;
  exitPrice: number;
  /** Price actually realised after slippage on a forced exit. */
  effectiveExitPrice: number;
  /**
   * Base priced in the quote asset. For a USD-quoted pool this equals the USD price;
   * for a SOL-quoted pool it is the USD price divided by SOL/USD. The bin bounds below
   * are in THIS unit, not USD.
   */
  entryRatio: number;
  exitRatio: number;
  lowerBinPrice: number;
  upperBinPrice: number;
  quoteDenominatedIn: string;
  notionalUsd: number;
  /** Modelled point-in-time TVL used to size the fee share. */
  modelledTvlAtEntryUsd: number;
  solPriceAtEntry: number;
  feesEarnedUsd: number;
  feesEarnedPct: number;
  /**
   * Change in the LP position's value against the capital deployed, excluding fees:
   * notional x (sqrt(r) - 1). This is the number that moves the account balance.
   */
  positionValueChangeUsd: number;
  /**
   * How far the LP trailed simply holding the two tokens. Reported for diagnosis
   * only — it is NOT part of net PnL, because it measures a different thing.
   */
  divergenceVsHoldUsd: number;
  gasCostUsd: number;
  slippageCostUsd: number;
  /** fees + positionValueChange - gas - slippage. */
  netPnlUsd: number;
  netPnlPct: number;
  netPnlSol: number;
  exitReason: ExitReason;
  /** True when liquidity vanished and the exit price was not actually obtainable. */
  rugged: boolean;
  /** Loss of 80% or more of the deployed notional. */
  catastrophic: boolean;
  barsHeld: number;
  barsOutOfRange: number;
}

export interface BacktestSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRatePct: number;
  netPnlUsd: number;
  netPnlSol: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  avgTradeDurationHours: number;
  avgFeesUsd: number;
  totalFeesUsd: number;
  totalPositionValueChangeUsd: number;
  totalGasCostUsd: number;
  totalSlippageCostUsd: number;
  ruggedTrades: number;
  catastrophicTrades: number;
  ruggedLossUsd: number;
  tradesOnDeadPools: number;
  exitReasonCounts: Record<ExitReason, number>;
  startingEquityUsd: number;
  endingEquityUsd: number;
  returnPct: number;
  accountWipedOut: boolean;
}

export interface BacktestResult {
  label: string;
  config: BacktestConfig;
  windowStart: string;
  windowEnd: string;
  barsSimulated: number;
  poolsSimulated: Array<{
    pairName: string;
    address: string;
    cohort: string;
    tvlTodayUsd: number;
    feeRatePct: number;
    bars: number;
  }>;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  barsWithNoCandidate: number;
  /** How often each entry gate fired, so a zero-trade run is explainable. */
  gateRejections: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

function indexBars(bars: Bar[]): Map<number, number> {
  const map = new Map<number, number>();
  bars.forEach((b, i) => map.set(b.t, i));
  return map;
}

/**
 * Trailing 24-bar volume ending at (and including) `index`.
 * Returns null until a full 24-bar window exists, so the entry filter is never
 * evaluated against a partial window that would understate volume.
 */
export function trailing24hVolume(bars: Bar[], index: number): number | null {
  if (index < 23) return null;
  let sum = 0;
  for (let i = index - 23; i <= index; i++) sum += bars[i]?.v ?? 0;
  return sum;
}

/** Nearest SOL/USD price at or before `t`. */
export function solPriceAt(solBars: Bar[], t: number): number | null {
  let best: number | null = null;
  for (const bar of solBars) {
    if (bar.t > t) break;
    best = bar.c;
  }
  return best;
}

/**
 * Price of the base asset denominated in the quote asset.
 *
 * OHLCV closes are USD. For a USD-quoted pool that is already the pair ratio. For a
 * SOL-quoted pool the USD price also carries SOL's own move, so it is divided by
 * SOL/USD — otherwise the position return would be measured against the wrong pair.
 */
export function pairRatio(
  closeUsd: number,
  quoteIsUsd: boolean,
  solUsd: number | null,
): number | null {
  if (quoteIsUsd) return closeUsd;
  if (solUsd === null || !(solUsd > 0)) return null;
  return closeUsd / solUsd;
}

/**
 * Trailing 24-bar price change as a percentage. Returns null before a full window
 * exists — callers must treat that as unknown, not as flat.
 */
export function priceChange24hPct(bars: Bar[], index: number): number | null {
  if (index < 24) return null;
  const now = bars[index]?.c;
  const then = bars[index - 24]?.c;
  if (!now || !then || then <= 0) return null;
  return (now / then - 1) * 100;
}

export interface LiquidationCheck {
  rugged: boolean;
  /** Ratio the position could actually be liquidated at. */
  realisableRatio: number;
  forwardVolumeUsd: number;
}

/**
 * Decides whether a position could genuinely have been closed at the exit bar.
 *
 * Forward bars are consulted only to establish a market-microstructure fact — was
 * there anyone to sell to — never to inform the entry or exit decision itself. The
 * exit had already triggered on its own bar; this only determines the fill.
 *
 * When volume collapses and price never re-enters the range, the position is stuck
 * in a token nobody is buying, so it is marked to the worst forward price rather
 * than the (unobtainable) exit-bar price.
 */
export function assessLiquidation(params: {
  bars: Bar[];
  exitIndex: number;
  exitRatio: number;
  lower: number;
  upper: number;
  entryVolume24hUsd: number;
  quoteIsUsd: boolean;
  solBars: Bar[];
  lookaheadBars: number;
  volumeCollapseRatio: number;
}): LiquidationCheck {
  const {
    bars,
    exitIndex,
    exitRatio,
    lower,
    upper,
    entryVolume24hUsd,
    quoteIsUsd,
    solBars,
    lookaheadBars,
    volumeCollapseRatio,
  } = params;

  const end = Math.min(bars.length - 1, exitIndex + lookaheadBars);

  let forwardVolumeUsd = 0;
  let recovered = false;
  let worstRatio = exitRatio;

  for (let i = exitIndex + 1; i <= end; i++) {
    const bar = bars[i];
    if (!bar) continue;

    forwardVolumeUsd += bar.v;

    const solUsd = solPriceAt(solBars, bar.t);
    const ratio = pairRatio(bar.c, quoteIsUsd, solUsd);
    if (ratio === null) continue;

    if (ratio >= lower && ratio <= upper) recovered = true;
    if (ratio < worstRatio) worstRatio = ratio;
  }

  // Scale the entry-time 24h volume to the length of the look-ahead window.
  const expectedVolume = (entryVolume24hUsd / 24) * Math.max(1, end - exitIndex);
  const collapsed = expectedVolume > 0 && forwardVolumeUsd < expectedVolume * volumeCollapseRatio;

  const rugged = collapsed && !recovered && exitRatio < lower;

  return {
    rugged,
    realisableRatio: rugged ? worstRatio : exitRatio,
    forwardVolumeUsd,
  };
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

interface OpenPosition {
  pool: PoolHistory;
  entryIndex: number;
  entryTime: number;
  entryRatio: number;
  entryPriceUsd: number;
  lower: number;
  upper: number;
  notionalUsd: number;
  modelledTvlUsd: number;
  entryVolume24hUsd: number;
  solPriceAtEntry: number;
  feesUsd: number;
  barsHeld: number;
  barsOutOfRange: number;
}

export interface SimulationInput {
  label: string;
  pools: PoolHistory[];
  solUsdBars: Bar[];
  tvlModel: TvlModel;
  config?: BacktestConfig;
}

export function runSimulation(input: SimulationInput): BacktestResult {
  const config = input.config ?? defaultBacktestConfig();
  const { pools, solUsdBars, tvlModel } = input;

  const usablePools = pools.filter((p) => p.bars.length > 24);
  if (usablePools.length === 0) {
    throw new Error("[backtest] no pool has enough bars to simulate");
  }

  const timeline = [...new Set(usablePools.flatMap((p) => p.bars.map((b) => b.t)))].sort(
    (a, b) => a - b,
  );
  const poolIndexes = new Map(usablePools.map((p) => [p.address, indexBars(p.bars)]));

  const trades: BacktestTrade[] = [];
  const open: OpenPosition[] = [];
  let barsWithNoCandidate = 0;
  const gateRejections: Record<string, number> = {};

  const firstSolPrice = solUsdBars[0]?.c ?? 0;
  const startingEquityUsd =
    config.startingCapitalUsd !== null
      ? config.startingCapitalUsd
      : config.virtualSol * firstSolPrice;

  let equityUsd = startingEquityUsd;

  const closeAt = (pos: OpenPosition, t: number, exitIndex: number, reason: ExitReason): void => {
    const bar = pos.pool.bars[exitIndex];
    const exitPriceUsd = bar?.c ?? pos.entryPriceUsd;
    const solUsd = solPriceAt(solUsdBars, t) ?? pos.solPriceAtEntry;
    const exitRatio = pairRatio(exitPriceUsd, pos.pool.quoteIsUsd, solUsd) ?? pos.entryRatio;

    const liquidation = assessLiquidation({
      bars: pos.pool.bars,
      exitIndex,
      exitRatio,
      lower: pos.lower,
      upper: pos.upper,
      entryVolume24hUsd: pos.entryVolume24hUsd,
      quoteIsUsd: pos.pool.quoteIsUsd,
      solBars: solUsdBars,
      lookaheadBars: config.rugLookaheadBars,
      volumeCollapseRatio: config.rugVolumeCollapseRatio,
    });

    // Slippage applies whenever the exit was forced by the market rather than chosen.
    const forced = reason === "OUT_OF_RANGE" || reason === "STOP_LOSS" || liquidation.rugged;
    const slippageFactor = forced ? 1 - config.forcedExitSlippagePct / 100 : 1;
    const realisedRatio = Math.max(0, liquidation.realisableRatio * slippageFactor);

    const r = pos.entryRatio > 0 ? realisedRatio / pos.entryRatio : 1;

    // The number that actually moves the balance. NOT the divergence-vs-hold figure.
    const positionValueChangeUsd = pos.notionalUsd * lpValueReturnFraction(r);
    const divergenceVsHoldUsd = pos.notionalUsd * impermanentLossFraction(r);

    const grossRatio = pos.entryRatio > 0 ? liquidation.realisableRatio / pos.entryRatio : 1;
    const slippageCostUsd = forced
      ? Math.abs(
          pos.notionalUsd * (lpValueReturnFraction(grossRatio) - lpValueReturnFraction(r)),
        )
      : 0;

    // Open + close are two transactions.
    const gasCostUsd = config.gasSolPerTransaction * 2 * solUsd;

    const netPnlUsd = pos.feesUsd + positionValueChangeUsd - gasCostUsd - slippageCostUsd;
    const durationHours = (t - pos.entryTime) / 3600;

    equityUsd += netPnlUsd;

    const netPnlPct = pos.notionalUsd > 0 ? (netPnlUsd / pos.notionalUsd) * 100 : 0;

    trades.push({
      poolAddress: pos.pool.address,
      pairName: pos.pool.pairName,
      cohort: pos.pool.cohort,
      entryTime: iso(pos.entryTime),
      exitTime: iso(t),
      durationHours,
      entryPrice: pos.entryPriceUsd,
      exitPrice: exitPriceUsd,
      effectiveExitPrice:
        pos.pool.quoteIsUsd || solUsd <= 0 ? realisedRatio : realisedRatio * solUsd,
      entryRatio: pos.entryRatio,
      exitRatio,
      lowerBinPrice: pos.lower,
      upperBinPrice: pos.upper,
      quoteDenominatedIn: pos.pool.quoteIsUsd ? "USD" : pos.pool.quoteSymbol || "quote",
      notionalUsd: pos.notionalUsd,
      modelledTvlAtEntryUsd: pos.modelledTvlUsd,
      solPriceAtEntry: pos.solPriceAtEntry,
      feesEarnedUsd: pos.feesUsd,
      feesEarnedPct: pos.notionalUsd > 0 ? (pos.feesUsd / pos.notionalUsd) * 100 : 0,
      positionValueChangeUsd,
      divergenceVsHoldUsd,
      gasCostUsd,
      slippageCostUsd,
      netPnlUsd,
      netPnlPct,
      netPnlSol: solUsd > 0 ? netPnlUsd / solUsd : 0,
      exitReason: liquidation.rugged ? "RUGGED" : reason,
      rugged: liquidation.rugged,
      catastrophic: netPnlPct <= -80,
      barsHeld: pos.barsHeld,
      barsOutOfRange: pos.barsOutOfRange,
    });
  };

  for (const t of timeline) {
    /* ---- 1. mark and possibly close open positions ---- */
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!;
      const idx = poolIndexes.get(pos.pool.address)?.get(t);
      if (idx === undefined) continue;

      const bar = pos.pool.bars[idx]!;
      const solUsd = solPriceAt(solUsdBars, t) ?? pos.solPriceAtEntry;
      const ratio = pairRatio(bar.c, pos.pool.quoteIsUsd, solUsd);
      if (ratio === null) continue;

      pos.barsHeld++;

      const inRange = ratio >= pos.lower && ratio <= pos.upper;

      if (inRange && pos.modelledTvlUsd > 0) {
        const share = pos.notionalUsd / pos.modelledTvlUsd;
        pos.feesUsd += pos.pool.feeRate * bar.v * share;
      } else if (!inRange) {
        pos.barsOutOfRange++;
      }

      const durationHours = (t - pos.entryTime) / 3600;
      const feePct = pos.notionalUsd > 0 ? (pos.feesUsd / pos.notionalUsd) * 100 : 0;

      /*
       * Mark-to-market net PnL for the stop, using LP value vs capital plus accrued
       * fees. Costs are charged at close, so the stop is measured gross of them.
       */
      const markRatio = pos.entryRatio > 0 ? ratio / pos.entryRatio : 1;
      const markNetPct =
        pos.notionalUsd > 0
          ? ((pos.feesUsd + pos.notionalUsd * lpValueReturnFraction(markRatio)) /
              pos.notionalUsd) *
            100
          : 0;

      let reason: ExitReason | null = null;
      if (!inRange) reason = "OUT_OF_RANGE";
      else if (markNetPct <= config.stopLossPct) reason = "STOP_LOSS";
      else if (markNetPct >= config.takeProfitNetPct) reason = "TAKE_PROFIT";
      else if (feePct >= config.takeProfitFeePct) reason = "FEE_TAKE_PROFIT";
      else if (durationHours >= config.maxDurationHours) reason = "TIMEOUT";

      if (reason) {
        closeAt(pos, t, idx, reason);
        open.splice(i, 1);
      }
    }

    /* ---- 2. look for a new entry ---- */
    if (open.length >= config.maxConcurrentPositions) continue;

    const held = new Set(open.map((p) => p.pool.address));
    let best: {
      pool: PoolHistory;
      idx: number;
      score: number;
      tvl: number;
      vol24h: number;
    } | null = null;

    // Position size is needed by the breakeven gate, so resolve it before screening.
    const solUsdForSizing = solPriceAt(solUsdBars, t);
    const prospectiveNotional =
      config.startingCapitalUsd !== null
        ? equityUsd * (config.positionSizePct / 100)
        : config.virtualSol * (solUsdForSizing ?? 0);
    const gasRoundTripUsd =
      config.gasSolPerTransaction * 2 * (solUsdForSizing ?? 0);

    for (const pool of usablePools) {
      if (held.has(pool.address)) continue;

      const idx = poolIndexes.get(pool.address)?.get(t);
      if (idx === undefined) continue;

      const vol24h = trailing24hVolume(pool.bars, idx);
      if (vol24h === null) continue;
      if (vol24h < config.minVolume24hUsd) {
        gateRejections.lowVolume = (gateRejections.lowVolume ?? 0) + 1;
        continue;
      }

      // Modelled, not the current snapshot — a snapshot would reject every dead pool
      // and reinstate the survivorship bias this harness exists to remove.
      const tvl = estimateTvlAt(tvlModel, pool.address, vol24h).tvlUsd;
      if (tvl < config.minTvlUsd) {
        gateRejections.lowTvl = (gateRejections.lowTvl ?? 0) + 1;
        continue;
      }

      const feeTvl = (pool.feeRate * vol24h) / tvl;
      if (feeTvl < config.minFeeTvlRatio) {
        gateRejections.lowFeeTvl = (gateRejections.lowFeeTvl ?? 0) + 1;
        continue;
      }
      if (feeTvl > config.maxFeeTvlRatio) {
        gateRejections.feeTvlOutlier = (gateRejections.feeTvlOutlier ?? 0) + 1;
        continue;
      }

      // Volatility gate: never provide liquidity into the top of a pump.
      const change24h = priceChange24hPct(pool.bars, idx);
      if (change24h === null) {
        gateRejections.volatilityUnknown = (gateRejections.volatilityUnknown ?? 0) + 1;
        continue;
      }
      if (change24h > config.maxPriceChange24hPct) {
        gateRejections.pumped = (gateRejections.pumped ?? 0) + 1;
        continue;
      }

      // Breakeven gate: fees must clear the cost of getting in and out.
      const breakeven = assessBreakeven({
        notionalUsd: prospectiveNotional,
        feeTvlRatio24h: feeTvl,
        gasCostRoundTripUsd: gasRoundTripUsd,
        slippagePct: config.forcedExitSlippagePct,
        minCoverageRatio: config.minFeeCostCoverage,
      });
      if (!breakeven.passes) {
        gateRejections.belowBreakeven = (gateRejections.belowBreakeven ?? 0) + 1;
        continue;
      }

      const score = feeTvl * vol24h;
      if (!best || score > best.score) best = { pool, idx, score, tvl, vol24h };
    }

    if (!best) {
      barsWithNoCandidate++;
      continue;
    }

    const solUsd = solPriceAt(solUsdBars, t);
    if (solUsd === null || !(solUsd > 0)) continue;

    const bar = best.pool.bars[best.idx]!;
    const entryRatio = pairRatio(bar.c, best.pool.quoteIsUsd, solUsd);
    if (entryRatio === null || !(entryRatio > 0)) continue;

    const notionalUsd =
      config.startingCapitalUsd !== null
        ? equityUsd * (config.positionSizePct / 100)
        : config.virtualSol * solUsd;
    if (!(notionalUsd > 0)) {
      barsWithNoCandidate++;
      continue;
    }

    open.push({
      pool: best.pool,
      entryIndex: best.idx,
      entryTime: t,
      entryRatio,
      entryPriceUsd: bar.c,
      lower: entryRatio * (1 - config.downsideCoverPct / 100),
      upper: entryRatio * (1 + config.upsideCoverPct / 100),
      notionalUsd,
      modelledTvlUsd: best.tvl,
      entryVolume24hUsd: best.vol24h,
      solPriceAtEntry: solUsd,
      feesUsd: 0,
      barsHeld: 0,
      barsOutOfRange: 0,
    });
  }

  /* ---- 3. force-close anything still open ---- */
  const lastT = timeline[timeline.length - 1] ?? 0;
  for (const pos of open) {
    const idx = poolIndexes.get(pos.pool.address)?.get(lastT) ?? pos.pool.bars.length - 1;
    closeAt(pos, lastT, idx, "END_OF_DATA");
  }

  trades.sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));

  return {
    label: input.label,
    config,
    windowStart: iso(timeline[0] ?? 0),
    windowEnd: iso(lastT),
    barsSimulated: timeline.length,
    poolsSimulated: usablePools.map((p) => ({
      pairName: p.pairName,
      address: p.address,
      cohort: p.cohort,
      tvlTodayUsd: p.tvlTodayUsd,
      feeRatePct: p.feeRate * 100,
      bars: p.bars.length,
    })),
    trades,
    summary: summarise(trades, startingEquityUsd),
    barsWithNoCandidate,
    gateRejections,
  };
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

export function summarise(trades: BacktestTrade[], startingEquityUsd: number): BacktestSummary {
  const pnls = trades.map((t) => t.netPnlUsd);

  const drawdown = computeMaxDrawdown(pnls, startingEquityUsd);
  const profit = computeProfitFactor(pnls);

  const wins = trades.filter((t) => t.netPnlUsd > 0).length;
  const losses = trades.filter((t) => t.netPnlUsd < 0).length;
  const breakEven = trades.length - wins - losses;

  const sum = (fn: (t: BacktestTrade) => number): number => trades.reduce((s, t) => s + fn(t), 0);
  const avg = (fn: (t: BacktestTrade) => number): number =>
    trades.length === 0 ? 0 : sum(fn) / trades.length;

  const netPnlUsd = sum((t) => t.netPnlUsd);

  const exitReasonCounts: Record<ExitReason, number> = {
    OUT_OF_RANGE: 0,
    FEE_TAKE_PROFIT: 0,
    TAKE_PROFIT: 0,
    TIMEOUT: 0,
    END_OF_DATA: 0,
    STOP_LOSS: 0,
    RUGGED: 0,
  };
  for (const t of trades) exitReasonCounts[t.exitReason]++;

  const endingEquityUsd = startingEquityUsd + netPnlUsd;

  return {
    totalTrades: trades.length,
    wins,
    losses,
    breakEven,
    winRatePct: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    netPnlUsd,
    netPnlSol: sum((t) => t.netPnlSol),
    grossProfitUsd: profit.grossProfitUsd,
    grossLossUsd: profit.grossLossUsd,
    profitFactor: profit.profitFactor,
    maxDrawdownPct: drawdown.maxDrawdownPct,
    maxDrawdownUsd: drawdown.maxDrawdownUsd,
    avgTradeDurationHours: avg((t) => t.durationHours),
    avgFeesUsd: avg((t) => t.feesEarnedUsd),
    totalFeesUsd: sum((t) => t.feesEarnedUsd),
    totalPositionValueChangeUsd: sum((t) => t.positionValueChangeUsd),
    totalGasCostUsd: sum((t) => t.gasCostUsd),
    totalSlippageCostUsd: sum((t) => t.slippageCostUsd),
    ruggedTrades: trades.filter((t) => t.rugged).length,
    catastrophicTrades: trades.filter((t) => t.catastrophic).length,
    ruggedLossUsd: trades.filter((t) => t.rugged).reduce((s, t) => s + t.netPnlUsd, 0),
    tradesOnDeadPools: trades.filter((t) => t.cohort === "dead-or-dormant").length,
    exitReasonCounts,
    startingEquityUsd,
    endingEquityUsd,
    returnPct: startingEquityUsd > 0 ? (netPnlUsd / startingEquityUsd) * 100 : 0,
    accountWipedOut: endingEquityUsd <= 0,
  };
}
