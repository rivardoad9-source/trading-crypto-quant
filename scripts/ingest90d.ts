/**
 * Ingest a 90-day point-in-time dataset into its own cache, for the scenario comparison
 * in `scripts/scenarioLab.ts`. Ingest ONCE, simulate many times — the GeckoTerminal rate
 * limit is shared, so re-ingesting per scenario is the slow path.
 *
 * KNOWN LIMIT, hit on 16 Sep 2026. `loadHistoricalData` writes its cache only after the
 * LAST pool is fetched, and at ~20s of rate-limit backoff per pool a 36-pool window runs
 * for well over half an hour. A run that was killed for memory pressure at 34/36 pools
 * left nothing on disk and had to start over. Prefer a smaller `poolCount`/`deadPoolCount`
 * over a long run, and do not run this alongside other node processes.
 */
import { env } from "../src/config/env.js";
import { loadHistoricalData } from "../src/backtest/historicalData.js";

const CACHE = ".cache/historical_data_scenario90.json";

async function main(): Promise<void> {
  const force = process.argv.includes("--refresh");
  const t0 = Date.now();
  const ds = await loadHistoricalData({
    poolCount: 18,
    deadPoolCount: 18,
    windowDays: 90,
    cachePath: CACHE,
    force,
    survivorTvlBand: { minUsd: env.MIN_TVL_USD, maxUsd: env.MAX_TVL_USD },
    annotateTokens: true,
  });
  const surv = ds.pools.filter((p) => p.cohort === "survivor").length;
  const dead = ds.pools.length - surv;
  const b = ds.solUsdBars;
  console.log(
    `[ingest90d] done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${ds.pools.length} pools ` +
      `(${surv} survivor / ${dead} dead), SOL series ${new Date(b[0]!.t * 1000).toISOString().slice(0, 16)} ` +
      `-> ${new Date(b[b.length - 1]!.t * 1000).toISOString().slice(0, 16)}`,
  );
}

void main();
