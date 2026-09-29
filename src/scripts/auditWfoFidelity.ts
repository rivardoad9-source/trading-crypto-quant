/**
 * Fidelity audit for the walk-forward report, answering two questions with evidence
 * rather than assertion:
 *
 *   (1) FORMULA — is the backtest config field-for-field the engine's own config, or a
 *       hand-rolled approximation? Prints every gate twice: the value the backtest runs
 *       with, and the env value the live engine reads.
 *
 *   (2) UNIVERSE — is the simulated pool set the whole live universe, or a slice? Prints
 *       how many pools Meteora currently reports, how many the live scanner pages in
 *       (fetchLivePools = the same call the agent makes), how many survive screenPools,
 *       and how many of those are even present in the backtest dataset.
 *
 * Read-only: one API GET plus local files. Run: node --import tsx src/scripts/auditWfoFidelity.ts
 */
import { readFileSync } from "node:fs";

import { env } from "../config/env.js";
import { MAX_CANDIDATE_POOLS } from "../config/constants.js";
import { liveV11Config } from "../backtest/runMicroCapital.js";
import { resolveBacktestProfile, describeBacktestProfile } from "../backtest/liveProfile.js";
import { defaultThresholds, fetchLivePools, screenPools, assessBreakeven } from "../services/meteora.js";

const DATASET = ".cache/historical_data_micro_273d_stitched.json";

interface PoolRow {
  address: string;
  pairName: string;
  cohort?: string;
}

async function universeTotal(): Promise<number | null> {
  try {
    const url = `${env.METEORA_API_URL}/pools?page=1&page_size=1&sort_by=${encodeURIComponent("volume_24h:desc")}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { total?: number };
    return body.total ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  /* ---------------- (1) formula ---------------- */
  const dataset = JSON.parse(readFileSync(DATASET, "utf8")) as { pools: PoolRow[]; solUsdBars: Array<{ c: number }> };
  const solNow = dataset.solUsdBars.at(-1)?.c ?? null;
  const profile = resolveBacktestProfile({
    overrides: {},
    windowStartSolUsd: solNow,
    defaultGasSolPerTransaction: 0.004,
  });
  const cfg = liveV11Config(profile.options) as unknown as Record<string, unknown>;

  console.log("=".repeat(96));
  console.log("(1) FORMULA — backtest config vs the env the live engine reads");
  console.log("=".repeat(96));
  for (const line of describeBacktestProfile(profile)) console.log(line);

  const rows: Array<[string, string]> = [
    ["minPoolAgeHours", "MIN_POOL_AGE_HOURS"],
    ["maxPriceSurge1hPct", "MAX_PRICE_SURGE_1H_PCT"],
    ["minTvlUsd", "MIN_TVL_USD"],
    ["maxTvlUsd", "MAX_TVL_USD"],
    ["minFeeTvlRatio", "MIN_FEE_TVL_RATIO"],
    ["maxFeeTvlRatio", "MAX_FEE_TVL_RATIO"],
    ["minFeeCostCoverage", "MIN_FEE_COST_COVERAGE"],
    ["maxPriceChange24hPct", "MAX_PRICE_CHANGE_24H_PCT"],
    ["minVolume24hUsd", "MIN_24H_VOLUME_USD"],
    ["downsideCoverPct", "MIN_DOWNSIDE_COVER_PCT"],
    ["upsideCoverPct", "MIN_UPSIDE_COVER_PCT"],
    ["takeProfitNetPct", "TAKE_PROFIT_PCT"],
    ["stopLossPct", "STOP_LOSS_PCT"],
    ["maxDurationHours", "MAX_POSITION_AGE_HOURS"],
    ["poolCooldownHours", "POOL_COOLDOWN_HOURS"],
    ["lockoutConsecutiveFailures", "POOL_LOCKOUT_CONSECUTIVE_FAILURES"],
    ["lockoutHours", "POOL_LOCKOUT_HOURS"],
    ["forcedExitSlippagePct", "FORCED_EXIT_SLIPPAGE_PCT"],
  ];
  const envBag = env as unknown as Record<string, unknown>;
  console.log("\n  field                        backtest            env (live)          match");
  let mismatches = 0;
  for (const [field, envKey] of rows) {
    const a = cfg[field];
    const b = envBag[envKey];
    const same = a === b;
    if (!same) mismatches++;
    console.log(
      `  ${field.padEnd(26)} ${String(a).padEnd(19)} ${String(b).padEnd(19)} ${same ? "yes" : "NO"}`,
    );
  }
  console.log(
    `  ${"takeProfitFeePct".padEnd(26)} ${String(cfg["takeProfitFeePct"]).padEnd(19)} ` +
      `${"(none)".padEnd(19)} deliberate-off`,
  );
  console.log(`\n  mismatches: ${mismatches} (0 = the run's gates are literally the live gates)`);

  /* ---------------- (2) universe ---------------- */
  const total = await universeTotal();
  const live = await fetchLivePools({ pageSize: 200, pages: 3 });
  const throttles = defaultThresholds();
  const screened = screenPools(live, throttles);
  const dsAddr = new Set(dataset.pools.map((p) => p.address));
  const fetchedAddr = new Set(live.map((p) => p.address));
  const inDataset = screened.candidates.filter((c) => dsAddr.has(c.address));
  const survivors = dataset.pools.filter((p) => p.cohort === "survivor");
  const dead = dataset.pools.filter((p) => p.cohort === "dead-or-dormant");

  console.log(`\n${"=".repeat(96)}`);
  console.log("(2) UNIVERSE — what the report simulated vs what live looks at");
  console.log("=".repeat(96));
  console.log(`  Meteora reports            : ${total ?? "n/a"} pools total (all quotes, all TVL bands)`);
  console.log(`  live scanner pages in      : ${live.length} pools (fetchLivePools pages=3 x 200, sorted volume_24h desc — same call the agent makes)`);
  console.log(`  survive screenPools        : ${screened.candidates.length} candidates`);
  console.log(`    rejected                 : ${JSON.stringify(screened.rejected)}`);
  console.log(`  reach the LLM              : at most MAX_CANDIDATE_POOLS = ${MAX_CANDIDATE_POOLS} of those`);
  console.log(`  backtest dataset           : ${dataset.pools.length} pools (${survivors.length} survivor + ${dead.length} dead/dormant)`);
  console.log(`  of today's ${screened.candidates.length} live candidates, present in the dataset: ${inDataset.length}`);
  console.log(`  of the dataset's ${survivors.length} survivors, still in today's page-1..3 scan: ${survivors.filter((p) => fetchedAddr.has(p.address)).length}`);
  console.log(`  of the dataset's ${dead.length} dead/dormant, in today's scan: ${dead.filter((p) => fetchedAddr.has(p.address)).length}`);
  if (inDataset.length) {
    console.log("  overlap (live candidates the report could even see):");
    for (const c of inDataset.slice(0, 12)) {
      console.log(`    ${c.pairName.padEnd(20)} fee/tvl ${(c.feeTvlRatio24h * 100).toFixed(3)}% tvl $${c.tvlUsd.toFixed(0)}`);
    }
  }

  /* ---------------- (3) how many of today's candidates clear the friction gate ---- */
  const notionalUsd = profile.options.capitalUsd * (profile.options.positionSizePct / 100);
  const gasRoundTripUsd = 2 * profile.options.gasSolPerTransaction * (solNow ?? 0);
  console.log(`\n  friction gate today (notional $${notionalUsd.toFixed(2)}, gas r/t $${gasRoundTripUsd.toFixed(2)}):`);
  for (const coverage of [2.5, 1.5, 1.0]) {
    const passing = screened.candidates.filter(
      (c) =>
        assessBreakeven({
          notionalUsd,
          feeTvlRatio24h: c.feeTvlRatio24h,
          gasCostRoundTripUsd: gasRoundTripUsd,
          slippagePct: env.FORCED_EXIT_SLIPPAGE_PCT,
          minCoverageRatio: coverage,
        }).passes,
    );
    const floor = coverage * ((gasRoundTripUsd / notionalUsd) * 100 + env.FORCED_EXIT_SLIPPAGE_PCT);
    console.log(
      `    coverage ${coverage.toFixed(1)}x → floor fee/TVL ${floor.toFixed(2)}% · ${passing.length}/${screened.candidates.length} candidates pass` +
        (passing.length ? ` (${passing.slice(0, 4).map((p) => `${p.pairName} ${(p.feeTvlRatio24h * 100).toFixed(2)}%`).join(", ")})` : ""),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
