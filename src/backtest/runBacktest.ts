/**
 * Survivorship-bias controlled backtest runner.
 *
 *   npm run backtest
 *   npm run backtest -- --days=30 --capital=100 --refresh
 *   npm run backtest -- --downside=20 --upside=20 --tp=3 --maxhours=48
 *
 * Runs the SAME strategy twice over the same window:
 *
 *   BIASED   — survivor pools only, i.e. what a naive harness that picks today's
 *              top-ranked pools would have measured.
 *   UNBIASED — survivors plus pools that died during or after the window, with real
 *              gas, forced-exit slippage, and rug/no-liquidity handling.
 *
 * The gap between the two is the size of the survivorship bias.
 *
 * Deploys ZERO real capital and signs nothing on-chain.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  defaultBacktestConfig,
  runSimulation,
  type BacktestConfig,
  type BacktestResult,
} from "./engine.js";
import { BACKTEST_CAVEATS, loadHistoricalData } from "./historicalData.js";
import { calibrateTvlModel } from "./tvlModel.js";
import { renderComparisonReport } from "./report.js";
import type { DlmmPool } from "../services/meteora.js";

const outputPathFor = (days: number): string => `backtest_results_${days}d.json`;

function parseArgs(argv: string[]): {
  days: number;
  pools: number;
  deadPools: number;
  refresh: boolean;
  config: BacktestConfig;
} {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z]+)(?:=(.*))?$/i.exec(arg);
    if (match) flags.set(match[1]!.toLowerCase(), match[2] ?? "true");
  }

  const num = (key: string, fallback: number): number => {
    const raw = flags.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      console.warn(`[backtest] ignoring --${key}=${raw}: not a number`);
      return fallback;
    }
    return parsed;
  };

  const base = defaultBacktestConfig();
  const usesSolSizing = flags.has("sol") && !flags.has("capital");

  return {
    days: num("days", 30),
    pools: num("pools", 6),
    deadPools: num("deadpools", 8),
    refresh: flags.has("refresh"),
    config: {
      ...base,
      startingCapitalUsd: usesSolSizing ? null : num("capital", base.startingCapitalUsd ?? 100),
      virtualSol: num("sol", base.virtualSol),
      downsideCoverPct: num("downside", base.downsideCoverPct),
      upsideCoverPct: num("upside", base.upsideCoverPct),
      minVolume24hUsd: num("minvol", base.minVolume24hUsd),
      minFeeTvlRatio: num("minfeetvl", base.minFeeTvlRatio),
      maxFeeTvlRatio: num("maxfeetvl", base.maxFeeTvlRatio),
      minTvlUsd: num("mintvl", base.minTvlUsd),
      takeProfitFeePct: num("tp", base.takeProfitFeePct),
      maxDurationHours: num("maxhours", base.maxDurationHours),
      maxConcurrentPositions: num("concurrent", base.maxConcurrentPositions),
      gasSolPerTransaction: num("gas", base.gasSolPerTransaction),
      forcedExitSlippagePct: num("slippage", base.forcedExitSlippagePct),
    },
  };
}

async function main(): Promise<void> {
  const { days, pools, deadPools, refresh, config } = parseArgs(process.argv.slice(2));

  console.log(
    `[backtest] window ${days}d · $${config.startingCapitalUsd} compounding · ` +
      `${pools} survivors + ${deadPools} dead pools`,
  );

  const dataset = await loadHistoricalData({
    poolCount: pools,
    deadPoolCount: deadPools,
    windowDays: days,
    force: refresh,
  });

  const survivorPools = dataset.pools.filter((p) => p.cohort === "survivor");
  const deadCohort = dataset.pools.filter((p) => p.cohort === "dead-or-dormant");

  /*
   * The TVL model is calibrated on the SURVIVOR cross-section, because those are the
   * pools where TVL and volume are both observable today. It is then applied to the
   * dead cohort, whose current TVL is ~0 and therefore useless as an anchor.
   */
  const calibrationSet: DlmmPool[] = survivorPools.map(
    (p) =>
      ({
        address: p.address,
        tvlUsd: p.tvlTodayUsd,
        volume24hUsd: p.bars.slice(-24).reduce((s, b) => s + b.v, 0),
      }) as DlmmPool,
  );

  const tvlModel = calibrateTvlModel(calibrationSet);
  if (tvlModel.samples === 0) {
    throw new Error("[backtest] TVL model could not be calibrated: no usable survivor pools");
  }

  console.log(
    `[backtest] simulating — biased (${survivorPools.length} pools) then ` +
      `unbiased (${dataset.pools.length} pools incl. ${deadCohort.length} dead)…`,
  );

  const biased: BacktestResult = runSimulation({
    label: "biased-survivors-only",
    pools: survivorPools,
    solUsdBars: dataset.solUsdBars,
    tvlModel,
    config,
  });

  const unbiased: BacktestResult = runSimulation({
    label: "unbiased-with-failed-pools",
    pools: dataset.pools,
    solUsdBars: dataset.solUsdBars,
    tvlModel,
    config,
  });

  console.log(
    renderComparisonReport({
      biased,
      unbiased,
      tvlModel,
      survivorPools: survivorPools.length,
      deadPools: deadCohort.length,
    }),
  );

  if (deadCohort.length === 0) {
    console.warn(
      "[backtest] the dead cohort is empty, so the two runs are identical and the " +
        "comparison demonstrates nothing. Re-run with --refresh.",
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    dataSource: "GeckoTerminal hourly OHLCV + Meteora point-in-time pool universe",
    dataFetchedAt: dataset.fetchedAt,
    caveats: BACKTEST_CAVEATS,
    tvlModel: {
      medianK: tvlModel.medianK,
      p25K: tvlModel.p25K,
      p75K: tvlModel.p75K,
      samples: tvlModel.samples,
    },
    universe: {
      survivorPools: survivorPools.length,
      deadPools: deadCohort.length,
    },
    biased,
    unbiased,
  };

  const outputPath = outputPathFor(days);
  writeFileSync(resolve(process.cwd(), outputPath), JSON.stringify(payload, null, 2), "utf8");
  console.log(
    `[backtest] biased=${biased.trades.length} trades, unbiased=${unbiased.trades.length} trades ` +
      `written to ${outputPath}`,
  );
}

main().catch((err) => {
  console.error("[backtest] failed:", err);
  process.exit(1);
});
