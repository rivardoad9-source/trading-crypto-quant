/**
 * Grid-searches the ENTRY gates with an out-of-sample split.
 *
 *   npm run sweep:entry
 *
 * `npm run sweep` already grid-searches three of these, but it scores every combination
 * on the whole window — so a setting that only worked in one regime still looks good.
 * `npm run sweep:exits` established that the exit thresholds are not where the edge is
 * missing; this asks the same question of the gates that decide what gets bought, under
 * the same in/out-of-sample discipline and the same bar (payoff > 1 and positive
 * expectancy in BOTH halves).
 *
 * Exit thresholds are pinned to the live .env values throughout, so any difference
 * between rows is attributable to the entry gate and nothing else.
 */
import { defaultBacktestConfig, type BacktestConfig } from "../backtest/engine.js";
import { loadHistoricalData } from "../backtest/historicalData.js";
import { calibrateTvlModel } from "../backtest/tvlModel.js";
import {
  applySweepFlags,
  day,
  describeSweepAccount,
  eligibilityLines,
  fmt,
  pf,
  readSweepFlags,
  scoreConfig,
  splitWindow,
  survivedOutOfSample,
  type Scored,
} from "../backtest/sweepHarness.js";
import type { DlmmPool } from "../services/meteora.js";
import { env } from "../config/env.js";

/** How much 24h fee income must cover the round-trip cost before a pool is bought. */
const FEE_COST_COVERAGE = [0.5, 1.0, 1.5, 2.5];
/** Minimum 24h fees as a fraction of TVL. The screener's core quality filter. */
const FEE_TVL_RATIO = [0.004, 0.008, 0.015, 0.03];
/** How far below spot the range must reach. Wider = fewer out-of-range exits. */
const DOWNSIDE_COVER = [15, 25, 45];

const MIN_TRADES = 8;

interface Row {
  coverage: number;
  feeTvl: number;
  downside: number;
  inS: Scored;
  outS: Scored | null;
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

  const split = splitWindow(dataset.pools, dataset.solUsdBars);

  /*
   * Exits pinned to what the engine actually runs, so the only thing varying across
   * rows is the entry gate under test.
   */
  const base: BacktestConfig = applySweepFlags(
    {
      ...defaultBacktestConfig(),
      takeProfitFeePct: Number.POSITIVE_INFINITY,
      takeProfitNetPct: env.TAKE_PROFIT_PCT,
      stopLossPct: env.STOP_LOSS_PCT,
      upsideCoverPct: env.MIN_UPSIDE_COVER_PCT,
      maxConcurrentPositions: env.MAX_CONCURRENT_POSITIONS,
    },
    flags,
  );

  console.log("");
  console.log(describeSweepAccount(base, flags));
  for (const line of await eligibilityLines(
    dataset.pools,
    dataset.solUsdBars,
    tvlModel,
    base,
    env.LIVE_MAX_TOKEN_TRANSFER_FEE_BPS,
  )) {
    console.log(line);
  }
  console.log(`Window ${day(split.start)} -> ${day(split.end)}  (split at ${day(split.mid)})`);
  console.log(`In-sample pools ${split.inPools.length}, out-of-sample pools ${split.outPools.length}`);
  console.log(
    `Exits pinned to live: TP +${env.TAKE_PROFIT_PCT}% / SL ${env.STOP_LOSS_PCT}% / ` +
      `upside cover +${env.MIN_UPSIDE_COVER_PCT}%`,
  );
  console.log(
    `Grid: ${FEE_COST_COVERAGE.length} x ${FEE_TVL_RATIO.length} x ${DOWNSIDE_COVER.length} = ` +
      `${FEE_COST_COVERAGE.length * FEE_TVL_RATIO.length * DOWNSIDE_COVER.length} combinations`,
  );
  console.log("");

  const rows: Row[] = [];

  for (const coverage of FEE_COST_COVERAGE) {
    for (const feeTvl of FEE_TVL_RATIO) {
      for (const downside of DOWNSIDE_COVER) {
        const config: BacktestConfig = {
          ...base,
          minFeeCostCoverage: coverage,
          minFeeTvlRatio: feeTvl,
          downsideCoverPct: downside,
        };

        const inS = scoreConfig(split.inPools, split.inSol, tvlModel, config, "entry-sweep");
        if (!inS) continue;
        const outS = scoreConfig(split.outPools, split.outSol, tvlModel, config, "entry-sweep");
        rows.push({ coverage, feeTvl, downside, inS, outS });
      }
    }
  }

  const header = [
    "cover".padEnd(6),
    "fee/TVL".padStart(8),
    "down%".padStart(6),
    "trades".padStart(7),
    "win%".padStart(6),
    "PF".padStart(6),
    "payoff".padStart(7),
    "avgWin".padStart(8),
    "avgLoss".padStart(8),
    "exp$".padStart(7),
    "maxDD%".padStart(7),
    "OOS-PF".padStart(8),
    "OOS-pay".padStart(8),
    "OOS-exp".padStart(8),
  ].join(" ");

  console.log("=== IN-SAMPLE (first half), out-of-sample columns on the right ===");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of [...rows].sort((a, b) => b.inS.expectancyUsd - a.inS.expectancyUsd)) {
    console.log(
      [
        `${r.coverage}x`.padEnd(6),
        `${(r.feeTvl * 100).toFixed(1)}%`.padStart(8),
        `${r.downside}`.padStart(6),
        String(r.inS.trades).padStart(7),
        fmt(r.inS.winRatePct, 1).padStart(6),
        pf(r.inS.profitFactor).padStart(6),
        (r.inS.payoff === null ? "—" : fmt(r.inS.payoff)).padStart(7),
        fmt(r.inS.avgWinUsd).padStart(8),
        fmt(r.inS.avgLossUsd).padStart(8),
        fmt(r.inS.expectancyUsd).padStart(7),
        fmt(r.inS.maxDrawdownPct, 1).padStart(7),
        (r.outS === null ? "—" : pf(r.outS.profitFactor)).padStart(8),
        (r.outS?.payoff == null ? "—" : fmt(r.outS.payoff)).padStart(8),
        (r.outS === null ? "—" : fmt(r.outS.expectancyUsd)).padStart(8),
      ].join(" "),
    );
  }

  const robust = rows.filter((r) => survivedOutOfSample(r.inS, r.outS, MIN_TRADES));

  console.log("");
  if (robust.length === 0) {
    console.log(
      `No combination cleared the bar: >= ${MIN_TRADES} trades in BOTH halves, payoff > 1 in\n` +
        "BOTH, and positive expectancy in BOTH. Taken together with sweep:exits, neither the\n" +
        "entry gates nor the exit thresholds turn this strategy positive on the 30-day window.",
    );

    const near = rows
      .filter((r) => r.outS !== null && r.inS.trades >= MIN_TRADES && r.outS.trades >= MIN_TRADES)
      .sort((a, b) => (b.outS?.expectancyUsd ?? 0) - (a.outS?.expectancyUsd ?? 0))
      .slice(0, 8);

    if (near.length > 0) {
      console.log("");
      console.log("Least-bad by out-of-sample expectancy (still not a recommendation):");
      for (const r of near) {
        if (!r.outS) continue;
        console.log(
          `  cover ${r.coverage}x  fee/TVL ${(r.feeTvl * 100).toFixed(1)}%  down ${r.downside}%  ` +
            `OOS exp $${fmt(r.outS.expectancyUsd)}  payoff ${r.outS.payoff === null ? "—" : fmt(r.outS.payoff)}  ` +
            `${r.outS.trades} trades`,
        );
      }
    }
    return;
  }

  robust.sort((a, b) => (b.outS?.expectancyUsd ?? 0) - (a.outS?.expectancyUsd ?? 0));
  console.log(`=== Survived out-of-sample (${robust.length} of ${rows.length}) ===`);
  for (const r of robust.slice(0, 10)) {
    if (!r.outS) continue;
    console.log(
      `  cover ${r.coverage}x  fee/TVL ${(r.feeTvl * 100).toFixed(1)}%  down ${r.downside}%  ` +
        `payoff IS ${r.inS.payoff === null ? "—" : fmt(r.inS.payoff)} / OOS ${fmt(r.outS.payoff ?? 0)}  ` +
        `exp IS $${fmt(r.inS.expectancyUsd)} / OOS $${fmt(r.outS.expectancyUsd)}  ` +
        `${r.outS.trades} trades, maxDD ${fmt(r.outS.maxDrawdownPct, 1)}%`,
    );
  }
}

main().catch((err) => {
  console.error("[sweep:entry] failed:", err);
  process.exit(1);
});
