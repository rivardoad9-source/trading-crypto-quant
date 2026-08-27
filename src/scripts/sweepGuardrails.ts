/**
 * Grid-searches the risk guardrails against the cached unbiased dataset.
 *
 *   npm run sweep
 *
 * The tightened rules produce zero trades, so this shows WHERE the strategy starts
 * trading again and what profit factor and drawdown look like at each setting. It
 * reuses the cache — no API calls — so it is cheap to re-run while tuning.
 */
import { defaultBacktestConfig, runSimulation } from "../backtest/engine.js";
import { loadHistoricalData } from "../backtest/historicalData.js";
import { calibrateTvlModel } from "../backtest/tvlModel.js";
import { renderTable } from "../backtest/report.js";
import type { DlmmPool } from "../services/meteora.js";

const PF_TARGET = 1.5;
const DD_TARGET = 25;

async function main(): Promise<void> {
  const dataset = await loadHistoricalData({ poolCount: 16, deadPoolCount: 10, windowDays: 30 });

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

  const base = defaultBacktestConfig();

  const coverages = [2.5, 2.0, 1.5, 1.0, 0.5];
  const slippages = [2.0, 1.0, 0.5];
  const downsides = [45, 50];

  const rows: string[][] = [];

  for (const downsideCoverPct of downsides) {
    for (const forcedExitSlippagePct of slippages) {
      for (const minFeeCostCoverage of coverages) {
        const result = runSimulation({
          label: "sweep",
          pools: dataset.pools,
          solUsdBars: dataset.solUsdBars,
          tvlModel,
          config: { ...base, downsideCoverPct, forcedExitSlippagePct, minFeeCostCoverage },
        });

        const s = result.summary;

        // The fee/TVL floor this combination implicitly demands, ignoring gas.
        const impliedFeeFloorPct = minFeeCostCoverage * forcedExitSlippagePct;

        const pfLabel =
          s.profitFactor === null
            ? s.totalTrades > 0 && s.grossProfitUsd > 0
              ? "inf"
              : "—"
            : s.profitFactor.toFixed(2);

        const hitsTargets =
          s.totalTrades > 0 &&
          s.profitFactor !== null &&
          s.profitFactor >= PF_TARGET &&
          s.maxDrawdownPct < DD_TARGET;

        rows.push([
          `-${downsideCoverPct}%`,
          `${forcedExitSlippagePct}%`,
          `${minFeeCostCoverage}x`,
          `>=${impliedFeeFloorPct.toFixed(2)}%`,
          String(s.totalTrades),
          s.totalTrades > 0 ? `${s.winRatePct.toFixed(1)}%` : "—",
          s.totalTrades > 0 ? `${s.returnPct.toFixed(1)}%` : "—",
          pfLabel,
          s.totalTrades > 0 ? `${s.maxDrawdownPct.toFixed(1)}%` : "—",
          hitsTargets ? "YES" : "",
        ]);
      }
    }
  }

  console.log("");
  console.log("GUARDRAIL SWEEP — unbiased universe, $100 compounding, 30d");
  console.log(
    `targets: profit factor >= ${PF_TARGET}, max drawdown < ${DD_TARGET}%\n` +
      `"fee floor" is the fee/TVL per 24h the breakeven rule implicitly demands\n` +
      `(coverage x slippage), before gas. The plausibility ceiling is ${(base.maxFeeTvlRatio * 100).toFixed(0)}%.`,
  );
  console.log("");
  console.log(
    renderTable(
      [
        { header: "Downside" },
        { header: "Slippage", align: "right" },
        { header: "Coverage", align: "right" },
        { header: "Fee floor", align: "right" },
        { header: "Trades", align: "right" },
        { header: "Win rate", align: "right" },
        { header: "Return", align: "right" },
        { header: "PF", align: "right" },
        { header: "MaxDD", align: "right" },
        { header: "Targets" },
      ],
      rows,
    ),
  );
  console.log("");
}

main().catch((err) => {
  console.error("[sweep] failed:", err);
  process.exit(1);
});
