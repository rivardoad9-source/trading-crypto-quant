/**
 * Grid-searches the exit thresholds — TAKE_PROFIT_PCT and STOP_LOSS_PCT.
 *
 *   npm run sweep:exits
 *
 * Why this exists separately from `npm run sweep`: that one tunes the ENTRY guardrails
 * (fee coverage, slippage, range width). This one tunes the two numbers that decide how
 * a position is allowed to end, which is where the live engine's risk/reward asymmetry
 * lives — the 27-trade dry run risked 8% to make 5%, and lost $10.88 on an average loss
 * against $8.76 on an average win.
 *
 * Both thresholds are measured on NET PnL here, matching `evaluateExit` in the live
 * agent. `takeProfitFeePct` (fees only) is disabled for the sweep so it cannot close a
 * position first and hide what the net take-profit would have done.
 *
 * The window is split in half: every combination is fitted on the first half and then
 * scored on the second, which it never saw. A pairing that only works in-sample is
 * curve-fitting, and with a grid this size something will always look good by luck.
 */
import { defaultBacktestConfig, runSimulation, type BacktestConfig } from "../backtest/engine.js";
import { loadHistoricalData, type PoolHistory } from "../backtest/historicalData.js";
import { calibrateTvlModel } from "../backtest/tvlModel.js";
import {
  applySweepFlags,
  describeSweepAccount,
  eligibilityLines,
  readSweepFlags,
} from "../backtest/sweepHarness.js";
import type { DlmmPool } from "../services/meteora.js";
import { env } from "../config/env.js";

/** Net take-profit levels to try. Infinity = no take-profit, let the range decide. */
const TAKE_PROFITS = [4, 5, 6, 8, 10, 12, 15, Number.POSITIVE_INFINITY];
/** Net stop-loss levels. -100 is effectively "no stop". */
const STOP_LOSSES = [-5, -6, -8, -10, -12, -15, -20, -100];

/** A combination has to trade at least this often in a half before it means anything. */
const MIN_TRADES = 8;

interface Scored {
  takeProfit: number;
  stopLoss: number;
  trades: number;
  winRatePct: number;
  netPnlUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  payoff: number | null;
  expectancyUsd: number;
}

const fmt = (v: number, d = 2): string =>
  Number.isFinite(v) ? v.toFixed(d) : v > 0 ? "inf" : "-inf";

const tpLabel = (v: number): string => (Number.isFinite(v) ? `+${v}%` : "none");

const pf = (v: number | null): string => (v === null ? "—" : fmt(v));

/** Splits each pool's bars at a point in the overall time window. */
function sliceDataset(pools: PoolHistory[], from: number, to: number): PoolHistory[] {
  return pools
    .map((p) => ({ ...p, bars: p.bars.filter((b) => b.t >= from && b.t < to) }))
    .filter((p) => p.bars.length > 24);
}

function score(
  base: BacktestConfig,
  pools: PoolHistory[],
  solUsdBars: PoolHistory["bars"],
  tvlModel: ReturnType<typeof calibrateTvlModel>,
  takeProfit: number,
  stopLoss: number,
): Scored | null {
  let result;
  try {
    result = runSimulation({
      label: "exit-sweep",
      pools,
      solUsdBars,
      tvlModel,
      config: {
        ...base,
        takeProfitNetPct: takeProfit,
        stopLossPct: stopLoss,
        // Disabled so the fee rule cannot pre-empt the net rule under test.
        takeProfitFeePct: Number.POSITIVE_INFINITY,
      },
    });
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
    takeProfit,
    stopLoss,
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

async function main(): Promise<void> {
  // Absent flags keep the published 30-day / $100 / 50% setup exactly.
  const flags = readSweepFlags(process.argv.slice(2));
  const dataset = await loadHistoricalData({
    poolCount: 16,
    deadPoolCount: 10,
    windowDays: flags.days,
    annotateTokens: true,
  });

  const survivors = dataset.pools.filter((p) => p.cohort === "survivor");
  const tvlModel = calibrateTvlModel(
    survivors.map(
      (p) =>
        ({
          address: p.address,
          tvlUsd: p.tvlTodayUsd,
          volume24hUsd: p.bars.slice(-24).reduce((s, b) => s + b.v, 0),
        }) as DlmmPool,
    ),
  );

  const times = dataset.pools.flatMap((p) => p.bars.map((b) => b.t));
  const start = Math.min(...times);
  const end = Math.max(...times);
  const mid = start + (end - start) / 2;

  const inPools = sliceDataset(dataset.pools, start, mid);
  const outPools = sliceDataset(dataset.pools, mid, end + 1);
  const inSol = dataset.solUsdBars.filter((b) => b.t >= start && b.t < mid);
  const outSol = dataset.solUsdBars.filter((b) => b.t >= mid);

  const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

  console.log("");
  console.log(`Window ${day(start)} -> ${day(end)}  (split at ${day(mid)})`);
  console.log(`In-sample pools ${inPools.length}, out-of-sample pools ${outPools.length}`);
  console.log(
    `Grid: ${TAKE_PROFITS.length} take-profits x ${STOP_LOSSES.length} stop-losses = ` +
      `${TAKE_PROFITS.length * STOP_LOSSES.length} combinations`,
  );

  /*
   * --live-entry aligns the ENTRY gates with the running .env instead of the backtest
   * defaults, which are looser (cover 25% vs 45%, coverage 1.0x vs 2.5x). Without it the
   * sweep tunes exits for a strategy the engine is not actually running; with it the
   * trade count can collapse, which is itself the answer.
   */
  const liveEntry = process.argv.includes("--live-entry");
  const base: BacktestConfig = applySweepFlags(
    liveEntry
      ? {
          ...defaultBacktestConfig(),
          downsideCoverPct: env.MIN_DOWNSIDE_COVER_PCT,
          upsideCoverPct: env.MIN_UPSIDE_COVER_PCT,
          minFeeCostCoverage: env.MIN_FEE_COST_COVERAGE,
          minTvlUsd: env.MIN_TVL_USD,
          minFeeTvlRatio: env.MIN_FEE_TVL_RATIO,
          maxPriceChange24hPct: env.MAX_PRICE_CHANGE_24H_PCT,
          maxConcurrentPositions: env.MAX_CONCURRENT_POSITIONS,
        }
      : defaultBacktestConfig(),
    flags,
  );

  console.log(describeSweepAccount(base, flags));
  for (const line of await eligibilityLines(
    dataset.pools,
    dataset.solUsdBars,
    tvlModel,
    { ...base, takeProfitNetPct: env.TAKE_PROFIT_PCT, stopLossPct: env.STOP_LOSS_PCT, takeProfitFeePct: Number.POSITIVE_INFINITY },
    env.LIVE_MAX_TOKEN_TRANSFER_FEE_BPS,
  )) {
    console.log(line);
  }

  console.log(
    liveEntry
      ? `Entry gates: LIVE (.env) — cover -${base.downsideCoverPct}%/+${base.upsideCoverPct}%, coverage ${base.minFeeCostCoverage}x`
      : `Entry gates: backtest defaults — cover -${base.downsideCoverPct}%/+${base.upsideCoverPct}%, coverage ${base.minFeeCostCoverage}x  (add --live-entry for the running config)`,
  );

  const rows: Array<{ inS: Scored; outS: Scored | null }> = [];

  for (const takeProfit of TAKE_PROFITS) {
    for (const stopLoss of STOP_LOSSES) {
      const inS = score(base, inPools, inSol, tvlModel, takeProfit, stopLoss);
      if (!inS) continue;
      const outS = score(base, outPools, outSol, tvlModel, takeProfit, stopLoss);
      rows.push({ inS, outS });
    }
  }

  const header = [
    "TP".padEnd(6),
    "SL".padStart(5),
    "trades".padStart(7),
    "win%".padStart(6),
    "PF".padStart(6),
    "payoff".padStart(7),
    "avgWin".padStart(8),
    "avgLoss".padStart(8),
    "exp$".padStart(7),
    "netPnl".padStart(8),
    "maxDD%".padStart(7),
    "OOS-PF".padStart(8),
    "OOS-exp".padStart(8),
  ].join(" ");

  console.log("");
  console.log("=== IN-SAMPLE (first half), out-of-sample columns on the right ===");
  console.log(header);
  console.log("-".repeat(header.length));

  const sorted = [...rows].sort((a, b) => b.inS.expectancyUsd - a.inS.expectancyUsd);

  for (const { inS, outS } of sorted) {
    console.log(
      [
        tpLabel(inS.takeProfit).padEnd(6),
        `${inS.stopLoss}%`.padStart(5),
        String(inS.trades).padStart(7),
        fmt(inS.winRatePct, 1).padStart(6),
        pf(inS.profitFactor).padStart(6),
        (inS.payoff === null ? "—" : fmt(inS.payoff)).padStart(7),
        fmt(inS.avgWinUsd).padStart(8),
        fmt(inS.avgLossUsd).padStart(8),
        fmt(inS.expectancyUsd).padStart(7),
        fmt(inS.netPnlUsd).padStart(8),
        fmt(inS.maxDrawdownPct, 1).padStart(7),
        (outS === null ? "—" : pf(outS.profitFactor)).padStart(8),
        (outS === null ? "—" : fmt(outS.expectancyUsd)).padStart(8),
      ].join(" "),
    );
  }

  /*
   * The pick is deliberately NOT "highest in-sample expectancy". Three bars, all of
   * which must hold in BOTH halves of the window:
   *
   *  1. payoff > 1 — the average win must be larger than the average loss. A hard
   *     requirement, not a preference: the live config risks 8% to make 5%, a
   *     structural ceiling of 0.63, and that asymmetry is the reason for this sweep.
   *     A setting that profits only by winning more OFTEN still leaves every single
   *     loss bigger than every single win.
   *  2. expectancy > 0 — payoff alone can be won by rare huge wins on a losing rate.
   *  3. enough trades that neither number is one lucky position.
   */
  const robust = rows.filter((r) => {
    const { inS, outS } = r;
    if (outS === null) return false;
    return (
      inS.trades >= MIN_TRADES &&
      outS.trades >= MIN_TRADES &&
      // Hard requirement: the average win must beat the average loss, in both halves.
      inS.payoff !== null &&
      outS.payoff !== null &&
      inS.payoff > 1 &&
      outS.payoff > 1 &&
      inS.expectancyUsd > 0 &&
      outS.expectancyUsd > 0
    );
  });

  console.log("");
  if (robust.length === 0) {
    console.log(
      `No combination cleared the bar: >= ${MIN_TRADES} trades in BOTH halves, payoff > 1 and positive\n` +
        "expectancy in BOTH. That is a result, not a failure to find one — it says the exit\n" +
        "thresholds are not where the edge is, and no TP/SL pairing rescues the entry rule.",
    );
    return;
  }

  robust.sort((a, b) => (b.outS?.expectancyUsd ?? 0) - (a.outS?.expectancyUsd ?? 0));

  console.log(`=== Survived out-of-sample (${robust.length} of ${rows.length}) ===`);
  for (const { inS, outS } of robust.slice(0, 10)) {
    if (!outS) continue;
    console.log(
      `  TP ${tpLabel(inS.takeProfit).padEnd(5)} SL ${String(inS.stopLoss).padStart(4)}%  ` +
        `payoff IS ${inS.payoff === null ? "—" : fmt(inS.payoff)} / OOS ${outS.payoff === null ? "—" : fmt(outS.payoff)}  ` +
        `IS exp $${fmt(inS.expectancyUsd)} / PF ${pf(inS.profitFactor)}  ` +
        `OOS exp $${fmt(outS.expectancyUsd)} / PF ${pf(outS.profitFactor)} ` +
        `over ${outS.trades} trades, maxDD ${fmt(outS.maxDrawdownPct, 1)}%`,
    );
  }
}

main().catch((err) => {
  console.error("[sweep:exits] failed:", err);
  process.exit(1);
});
