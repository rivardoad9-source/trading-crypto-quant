/**
 * Walk-forward + Monte Carlo on the FlowMetrix micro-capital dataset.
 *
 *   npm run wfo:mc -- --train=45 --test=15 --folds=6 --k=median
 *
 * WHY THIS EXISTS
 * Every published backtest in this repo is ONE number over ONE window, and the docs
 * already showed that the number's SIGN is decided by the TVL model k, not by the
 * window: the same harness gave +158% on the 22-pool cache and -3.5% on the stitched
 * 120-day one. A single window cannot tell a fitted artefact from an edge, because the
 * parameters were chosen (or inherited) by looking at that same window.
 *
 * What this runner adds, and nothing else:
 *
 *  1. WALK-FORWARD. Rolling 45d-train / 15d-test folds, moving backwards from the last
 *     bar. Inside each fold the best exit/entry/range configuration is chosen ON THE
 *     TRAIN SLICE ONLY, then scored on the untouched TEST slice. The concatenation of
 *     those test trades is the only number in this report that was not picked with
 *     hindsight. The full-span in-sample optimum is printed next to it, which is the
 *     size of the optimism.
 *
 *  2. MONTE CARLO. The out-of-sample trade list is a SAMPLE. Resampling it (bootstrap),
 *     reshuffling it (order), and resampling whole FOLDS (regimes) gives the interval
 *     the point estimate deserves — and the fold-block version is the honest one, since
 *     trades inside a fold share a regime.
 *
 * Style rules followed on purpose: no number here is called significant; every arm is
 * reported even when it loses; the concentration counters (distinct pools, entry span)
 * are printed so a run that is really one pool cannot pass as a strategy.
 */
import { writeFileSync } from "node:fs";

import { runSimulation, summarise, type BacktestConfig, type BacktestTrade } from "../backtest/engine.js";
import { loadHistoricalData } from "../backtest/historicalData.js";
import { calibrateTvlModel, type TvlModel } from "../backtest/tvlModel.js";
import { liveV11Config, type MicroCapitalOptions } from "../backtest/runMicroCapital.js";
import { readProfileOverrides, resolveBacktestProfile, describeBacktestProfile } from "../backtest/liveProfile.js";
import { sliceDataset } from "../backtest/sweepHarness.js";
import type { DlmmPool } from "../services/meteora.js";

/* ------------------------------------------------------------------ */
/* flags                                                               */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const val = (key: string, dflt: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : dflt;
};
const num = (key: string, dflt: number): number => {
  const v = Number(val(key, String(dflt)));
  if (!Number.isFinite(v)) throw new Error(`--${key} must be a number`);
  return v;
};

const TRAIN_DAYS = num("train", 45);
const TEST_DAYS = num("test", 15);
const MAX_FOLDS = num("folds", 6);
const GAS = num("gas", 0.004);
/*
 * The account is resolved from the LIVE profile (LIVE_CAPITAL_SOL / LIVE_MAX_POSITION_SOL)
 * unless a flag overrides it — the same contract every other micro-capital runner follows,
 * so this report cannot silently describe an account live never runs. Assigned in main()
 * once the dataset supplies the window-start SOL/USD.
 */
let CAPITAL = 0;
let SIZE_PCT = 0;
let CONCURRENT = 0;
const FLAG_MAP = new Map<string, string>();
for (const a of argv) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) FLAG_MAP.set(m[1]!, m[2]!);
}
const PROFILE_OVERRIDES = readProfileOverrides(FLAG_MAP);
const K_MODE = val("k", "median"); // median | p25 | p75
const CACHE = val("cache", ".cache/historical_data_micro_273d_stitched.json");
const LABEL = val("label", `wfo_mc_k${K_MODE}_tr${TRAIN_DAYS}_te${TEST_DAYS}_f${MAX_FOLDS}`);
const ARMS_MODE = val("arms", "grid"); // grid | live — `live` scores ONE arm: the live config as-is
const MIN_TRAIN_TRADES = ARMS_MODE === "live" ? 0 : num("mintrades", 4);
const MC_RUNS = num("mc", 10000);

const DAY = 86_400;

/* ------------------------------------------------------------------ */
/* the configuration grid — the axes the engine actually moves         */
/* ------------------------------------------------------------------ */

interface Arm {
  key: string;
  label: string;
  apply: (base: BacktestConfig) => BacktestConfig;
}

const EXITS: Array<{ key: string; label: string; sl: number; tp: number }> = [
  { key: "live", label: "V1.1 live (SL -8 / TP +5)", sl: -8, tp: 5 },
  { key: "wide", label: "lebar (SL -6 / TP +18)", sl: -6, tp: 18 },
  { key: "tight", label: "sempit (SL -10 / TP +10)", sl: -10, tp: 10 },
];
const COVERAGE = [1.0, 2.5];
const DOWNSIDE = [25, 45];

const ARMS: Arm[] = [];
for (const e of EXITS) {
  for (const cov of COVERAGE) {
    for (const ds of DOWNSIDE) {
      ARMS.push({
        key: `${e.key}-cov${cov}-ds${ds}`,
        label: `${e.label} · gate ${cov}x · downside ${ds}%`,
        apply: (base) => ({
          ...base,
          stopLossPct: e.sl,
          takeProfitNetPct: e.tp,
          minFeeCostCoverage: cov,
          downsideCoverPct: ds,
        }),
      });
    }
  }
}

/*
 * `--arms=live` collapses the grid to the single live configuration. There is then nothing to
 * select, so the walk-forward reduces to a pure out-of-sample replay of the engine as shipped:
 * no arm is ever "chosen", and no train window can flatter it.
 */
if (ARMS_MODE === "live") {
  ARMS.length = 0;
  ARMS.push({ key: "live", label: "LIVE V1.1 — profil + gate apa adanya", apply: (base) => base });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const usd = (n: number): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number): string => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(1)}%`;

interface ScoredRun {
  trades: number;
  winRatePct: number;
  netPnlUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  payoff: number | null;
  tradeList: BacktestTrade[];
}

function score(pools: Parameters<typeof runSimulation>[0]["pools"], solBars: Parameters<typeof runSimulation>[0]["solUsdBars"], tvl: TvlModel, cfg: BacktestConfig, label: string): ScoredRun | null {
  let res;
  try {
    res = runSimulation({ label, pools, solUsdBars: solBars, tvlModel: tvl, config: cfg });
  } catch {
    return null;
  }
  const wins = res.trades.filter((t) => t.netPnlUsd > 0);
  const losses = res.trades.filter((t) => t.netPnlUsd <= 0);
  const mean = (a: BacktestTrade[], f: (t: BacktestTrade) => number): number =>
    a.length ? a.reduce((s, t) => s + f(t), 0) / a.length : 0;
  const avgWin = mean(wins, (t) => t.netPnlUsd);
  const avgLoss = mean(losses, (t) => t.netPnlUsd);
  return {
    trades: res.trades.length,
    winRatePct: res.summary.winRatePct,
    netPnlUsd: res.summary.netPnlUsd,
    profitFactor: res.summary.profitFactor,
    maxDrawdownPct: res.summary.maxDrawdownPct,
    avgWin,
    avgLoss,
    expectancy: res.trades.length ? res.summary.netPnlUsd / res.trades.length : 0,
    payoff: avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null,
    tradeList: res.trades,
  };
}

/** Fixed-fraction equity curve; index 0 is the starting capital, so length = returns.length + 1. */
function equityCurve(returns: number[], capital: number, sizePct: number): number[] {
  const curve = [capital];
  let eq = capital;
  for (const r of returns) {
    eq += eq * (sizePct / 100) * r;
    curve.push(eq);
  }
  return curve;
}

/** Max drawdown % of an equity curve. */
function maxDdOf(curve: number[]): number {
  let peak = curve[0] ?? 0;
  let maxDd = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? ((peak - v) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Fixed-fraction equity path over a trade list; returns ending equity and max drawdown %. */
function equityPath(returns: number[], capital: number, sizePct: number): { end: number; maxDdPct: number } {
  const curve = equityCurve(returns, capital, sizePct);
  return { end: curve[curve.length - 1]!, maxDdPct: maxDdOf(curve) };
}

function percentiles(sorted: number[], qs: number[]): number[] {
  return qs.map((q) => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[idx]!;
  });
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const dataset = await loadHistoricalData({
    cachePath: CACHE,
    windowDays: 273,
    poolCount: 5,
    deadPoolCount: 1,
    annotateTokens: false,
  });

  /* The account: the LIVE profile unless a flag overrode it. Sizing needs the SOL/USD the
   * window opens at (using today's price would size the account with a price the simulation
   * had not reached yet). */
  const windowStartSolUsd = dataset.solUsdBars[0]?.c ?? null;
  const profile = resolveBacktestProfile({
    overrides: PROFILE_OVERRIDES,
    windowStartSolUsd,
    defaultGasSolPerTransaction: GAS,
  });
  CAPITAL = profile.options.capitalUsd;
  SIZE_PCT = profile.options.positionSizePct;
  CONCURRENT = profile.options.maxConcurrentPositions;

  const survivors = dataset.pools.filter((p) => p.cohort === "survivor");
  const calibrationSet: DlmmPool[] = survivors.map(
    (p) =>
      ({
        address: p.address,
        tvlUsd: p.tvlTodayUsd,
        volume24hUsd: p.bars.slice(-24).reduce((s, b) => s + b.v, 0),
      }) as DlmmPool,
  );
  let tvlModel: TvlModel = calibrateTvlModel(calibrationSet);
  if (K_MODE === "p25") tvlModel = { ...tvlModel, medianK: tvlModel.p25K };
  if (K_MODE === "p75") tvlModel = { ...tvlModel, medianK: tvlModel.p75K };

  const options: MicroCapitalOptions = {
    capitalUsd: CAPITAL,
    positionSizePct: SIZE_PCT,
    maxConcurrentPositions: CONCURRENT,
    gasSolPerTransaction: GAS,
  } as MicroCapitalOptions;
  /* `--coverage=` pins the gate multiplier so a single configuration can be replayed at a
   * different setting without re-enabling the whole grid (only meaningful with --arms=live). */
  const COVERAGE_OVERRIDE = val("coverage", "");
  const base0 = liveV11Config(options);
  const base: BacktestConfig =
    COVERAGE_OVERRIDE === "" ? base0 : { ...base0, minFeeCostCoverage: Number(COVERAGE_OVERRIDE) };

  /* Reduce rather than spread: a wide universe carries six figures of bars and
   * `Math.min(...times)` blows the call stack on it. */
  let firstT = Number.POSITIVE_INFINITY;
  let lastT = Number.NEGATIVE_INFINITY;
  for (const p of dataset.pools) for (const b of p.bars) {
    if (b.t < firstT) firstT = b.t;
    if (b.t > lastT) lastT = b.t;
  }
  const fmtDay = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

  console.log("=".repeat(100));
  console.log(`WALK-FORWARD + MONTE CARLO · label ${LABEL}`);
  console.log("=".repeat(100));
  console.log(`dataset      : ${CACHE}`);
  console.log(`universe     : ${dataset.pools.length} pool (${survivors.length} survivor, ${dataset.pools.length - survivors.length} dead/dormant)`);
  console.log(`span         : ${fmtDay(firstT)} → ${fmtDay(lastT)} (${((lastT - firstT) / DAY).toFixed(0)} hari)`);
  console.log(`TVL model k  : ${K_MODE} → ${tvlModel.medianK.toFixed(3)} (IQR ${tvlModel.p25K.toFixed(3)}–${tvlModel.p75K.toFixed(3)}, n=${tvlModel.samples})`);
  console.log(`account      : $${CAPITAL.toFixed(2)} · ${SIZE_PCT.toFixed(2)}% · ${CONCURRENT} concurrent · gas ${GAS} SOL/tx`);
  for (const l of describeBacktestProfile(profile)) console.log(l);
  console.log(`mode         : ${ARMS_MODE === "live" ? "LIVE apa adanya — 1 arm, tanpa pemilihan parameter" : `${ARMS.length} config grid (dipilih per fold dari data train)`}`);
  console.log(`folds        : train ${TRAIN_DAYS}d → test ${TEST_DAYS}d, max ${MAX_FOLDS}, gate ${base.minFeeCostCoverage}x · slippage ${base.forcedExitSlippagePct}%`);

  /* ---- reference: the in-sample optimum over the WHOLE span (the optimist's number) */
  const fullRuns = ARMS.map((a) => ({ arm: a, run: score(dataset.pools, dataset.solUsdBars, tvlModel, a.apply(base), `full-${a.key}`) }));
  const fullBest = fullRuns
    .filter((r) => r.run && r.run.trades >= MIN_TRAIN_TRADES)
    .sort((x, y) => (y.run!.expectancy - x.run!.expectancy))[0];

  console.log("\n--- (A) IN-SAMPLE: hasil terbaik di SELURUH span (angka 'optimis', pakai hindsight) ---");
  if (fullBest && fullBest.run) {
    const r = fullBest.run;
    console.log(`  config terbaik : ${fullBest.arm.label}`);
    console.log(`  trade ${r.trades} · WR ${r.winRatePct.toFixed(1)}% · net ${usd(r.netPnlUsd)} · PF ${r.profitFactor?.toFixed(2) ?? "—"} · maxDD ${r.maxDrawdownPct.toFixed(1)}% · expectancy/trade ${usd(r.expectancy)}`);
  } else {
    console.log("  tidak ada config yang mencapai jumlah trade minimum di seluruh span.");
  }

  /* ---- (B) WALK-FORWARD ---- */
  console.log(`\n--- (B) WALK-FORWARD: pilih config di TRAIN, ukur di TEST (tanpa hindsight) ---`);
  interface FoldRecord {
    fold: string;
    trainStart: string;
    trainEnd: string;
    testStart: string;
    testEnd: string;
    chosen: string | null;
    trainMetrics: ScoredRun | null;
    testMetrics: ScoredRun | null;
    testReturns: number[];
    testTrades: BacktestTrade[];
    armsTried: number;
  }
  const folds: FoldRecord[] = [];

  for (let i = 0; i < MAX_FOLDS; i++) {
    const testEnd = lastT + 1 - i * TEST_DAYS * DAY;
    const testStart = testEnd - TEST_DAYS * DAY;
    const trainStart = testStart - TRAIN_DAYS * DAY;
    if (trainStart < firstT && i > 0) {
      console.log(`  fold ${i + 1}: dilewati (data tidak cukup sebelum ${fmtDay(trainStart)})`);
      break;
    }
    const trainPools = sliceDataset(dataset.pools, trainStart, testStart);
    const testPools = sliceDataset(dataset.pools, testStart, testEnd);
    const trainSol = dataset.solUsdBars.filter((b) => b.t >= trainStart && b.t < testStart);
    const testSol = dataset.solUsdBars.filter((b) => b.t >= testStart && b.t < testEnd);

    const label = `F${i + 1}`;
    if (trainPools.length === 0 || testPools.length === 0) {
      console.log(`  ${label} ${fmtDay(trainStart)}→${fmtDay(testStart)} train / ${fmtDay(testStart)}→${fmtDay(testEnd)} test: tidak ada pool dengan cukup bar`);
      folds.push({
        fold: label,
        trainStart: fmtDay(trainStart),
        trainEnd: fmtDay(testStart),
        testStart: fmtDay(testStart),
        testEnd: fmtDay(testEnd),
        chosen: null,
        trainMetrics: null,
        testMetrics: null,
        testReturns: [],
        testTrades: [],
        armsTried: 0,
      });
      continue;
    }

    let best: { arm: Arm; run: ScoredRun } | null = null;
    let tried = 0;
    for (const a of ARMS) {
      const r = score(trainPools, trainSol, tvlModel, a.apply(base), `${label}-${a.key}`);
      if (!r) continue;
      tried++;
      if (r.trades < MIN_TRAIN_TRADES) continue;
      if (!best || r.expectancy > best.run.expectancy || (r.expectancy === best.run.expectancy && r.trades > best.run.trades)) {
        best = { arm: a, run: r };
      }
    }

    const testRun = best ? score(testPools, testSol, tvlModel, best.arm.apply(base), `${label}-test`) : null;
    const testReturns = (testRun?.tradeList ?? []).map((t) => t.netPnlPct / 100);

    folds.push({
      fold: label,
      trainStart: fmtDay(trainStart),
      trainEnd: fmtDay(testStart),
      testStart: fmtDay(testStart),
      testEnd: fmtDay(testEnd),
      chosen: best?.arm.label ?? null,
      trainMetrics: best?.run ?? null,
      testMetrics: testRun,
      testReturns,
      testTrades: testRun?.tradeList ?? [],
      armsTried: tried,
    });

    console.log(
      `  ${label} train ${fmtDay(trainStart)}→${fmtDay(testStart)} | test ${fmtDay(testStart)}→${fmtDay(testEnd)}` +
        `\n      train: ${best ? `${best.run.trades} trade, expectancy ${usd(best.run.expectancy)}, PF ${best.run.profitFactor?.toFixed(2) ?? "—"}` : `TIDAK ADA config dengan ≥${MIN_TRAIN_TRADES} trade (${tried} config dicoba)`}` +
        `\n      pilih: ${best?.arm.label ?? "—"}` +
        `\n      TEST : ${testRun ? `${testRun.trades} trade, net ${usd(testRun.netPnlUsd)}, expectancy ${usd(testRun.expectancy)}, WR ${testRun.winRatePct.toFixed(1)}%, maxDD ${testRun.maxDrawdownPct.toFixed(1)}%` : "tidak jalan"}`,
    );
  }

  const oosTrades = folds.flatMap((f) => f.testTrades);
  const oosReturns = folds.flatMap((f) => f.testReturns);
  const oosSummary = summarise(oosTrades, CAPITAL);
  const oosPath = equityPath(oosReturns, CAPITAL, SIZE_PCT);
  const distinctPools = new Set(oosTrades.map((t) => t.poolAddress)).size;
  const entryTimes = oosTrades.map((t) => Date.parse(t.entryTime));
  let minEntryT = Number.POSITIVE_INFINITY;
  let maxEntryT = Number.NEGATIVE_INFINITY;
  for (const t of entryTimes) {
    if (t < minEntryT) minEntryT = t;
    if (t > maxEntryT) maxEntryT = t;
  }
  const entrySpanDays = entryTimes.length > 1 ? (maxEntryT - minEntryT) / DAY / 1000 : 0;

  console.log(`\n--- (C) GABUNGAN OUT-OF-SAMPLE (satu-satunya angka tanpa hindsight) ---`);
  console.log(`  trade ${oosSummary.totalTrades} · WR ${oosSummary.winRatePct.toFixed(1)}% (${oosSummary.wins}W/${oosSummary.losses}L) · net ${usd(oosSummary.netPnlUsd)}`);
  console.log(`  PF ${oosSummary.profitFactor?.toFixed(2) ?? "—"} · expectancy ${usd(oosSummary.totalTrades ? oosSummary.netPnlUsd / oosSummary.totalTrades : 0)}/trade · maxDD ${oosSummary.maxDrawdownPct.toFixed(1)}%`);
  console.log(`  equity ${usd(CAPITAL)} → ${usd(oosPath.end)} (${pct((oosPath.end / CAPITAL - 1) * 100)}) · maxDD path ${oosPath.maxDdPct.toFixed(1)}%`);
  console.log(`  konsentrasi: ${distinctPools} pool berbeda · entry tersebar ${entrySpanDays.toFixed(0)} hari · exit ${JSON.stringify(oosSummary.exitReasonCounts)}`);
  if (fullBest?.run) {
    console.log(`  gap in-sample vs OOS (expectancy/trade): ${usd(fullBest.run.expectancy)} → ${usd(oosSummary.totalTrades ? oosSummary.netPnlUsd / oosSummary.totalTrades : 0)}`);
  }

  /* ---- (D) MONTE CARLO ---- */
  console.log(`\n--- (D) MONTE CARLO (${MC_RUNS.toLocaleString("en-US")} run per metode, berbasis trade OOS) ---`);
  let mcReport: Record<string, unknown> = {};
  /** Sampled i.i.d. bootstrap curves kept for the chart dump (`--dump=`). */
  const mcCurvesDump: number[][] = [];
  if (oosReturns.length >= 5) {
    const rng = (() => {
      let s = 987654321;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    })();
    const n = oosReturns.length;

    // 1) i.i.d. bootstrap
    const bootEnd: number[] = [];
    const bootDd: number[] = [];
    const bootCurves: number[][] = [];
    for (let r = 0; r < MC_RUNS; r++) {
      const sample: number[] = [];
      for (let k = 0; k < n; k++) sample.push(oosReturns[Math.floor(rng() * n)]!);
      const curve = equityCurve(sample, CAPITAL, SIZE_PCT);
      const p = { end: curve[curve.length - 1]!, maxDdPct: maxDdOf(curve) };
      bootEnd.push(p.end);
      bootDd.push(p.maxDdPct);
      if (r < 400) bootCurves.push(curve);
      if (mcCurvesDump.length < 1200) mcCurvesDump.push(curve);
    }

    // 2) reshuffle trade order (path dependence only)
    const shufDd: number[] = [];
    for (let r = 0; r < MC_RUNS; r++) {
      const arr = [...oosReturns];
      for (let k = arr.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [arr[k], arr[j]] = [arr[j]!, arr[k]!];
      }
      shufDd.push(equityPath(arr, CAPITAL, SIZE_PCT).maxDdPct);
    }

    // 3) fold-block bootstrap (regime-aware)
    const foldBlocks = folds.map((f) => f.testReturns).filter((b) => b.length > 0);
    const blockEnd: number[] = [];
    const blockDd: number[] = [];
    if (foldBlocks.length > 0) {
      for (let r = 0; r < MC_RUNS; r++) {
        const seq: number[] = [];
        const draws = Math.max(1, foldBlocks.length);
        for (let k = 0; k < draws; k++) seq.push(...foldBlocks[Math.floor(rng() * foldBlocks.length)]!);
        const p = equityPath(seq, CAPITAL, SIZE_PCT);
        blockEnd.push(p.end);
        blockDd.push(p.maxDdPct);
      }
    }

    const sEnd = [...bootEnd].sort((a, b) => a - b);
    const sDd = [...bootDd].sort((a, b) => a - b);
    const sShuf = [...shufDd].sort((a, b) => a - b);
    const sBlockEnd = [...blockEnd].sort((a, b) => a - b);
    const sBlockDd = [...blockDd].sort((a, b) => a - b);
    const p5 = percentiles(sEnd, [0.05, 0.5, 0.95]);
    const d5 = percentiles(sDd, [0.05, 0.5, 0.95]);
    const sh5 = percentiles(sShuf, [0.05, 0.5, 0.95]);
    const bp = percentiles(sBlockEnd, [0.05, 0.5, 0.95]);
    const bd = percentiles(sBlockDd, [0.05, 0.5, 0.95]);
    const pProfit = bootEnd.filter((e) => e > CAPITAL).length / bootEnd.length;
    const pProfitBlock = blockEnd.length ? blockEnd.filter((e) => e > CAPITAL).length / blockEnd.length : 0;

    console.log(`  1) bootstrap trade (i.i.d., n=${n})     : equity p5 ${usd(p5[0]!)} · p50 ${usd(p5[1]!)} · p95 ${usd(p5[2]!)} · P(profit) ${(pProfit * 100).toFixed(1)}%`);
    console.log(`     maxDD   p5 ${d5[0]!.toFixed(1)}% · p50 ${d5[1]!.toFixed(1)}% · p95 ${d5[2]!.toFixed(1)}%`);
    console.log(`  2) reshuffle urutan trade (path saja)   : maxDD p5 ${sh5[0]!.toFixed(1)}% · p50 ${sh5[1]!.toFixed(1)}% · p95 ${sh5[2]!.toFixed(1)}%`);
    if (foldBlocks.length) {
      console.log(`  3) bootstrap blok FOLD (${foldBlocks.length} fold)      : equity p5 ${usd(bp[0]!)} · p50 ${usd(bp[1]!)} · p95 ${usd(bp[2]!)} · P(profit) ${(pProfitBlock * 100).toFixed(1)}%`);
      console.log(`     maxDD   p5 ${bd[0]!.toFixed(1)}% · p50 ${bd[1]!.toFixed(1)}% · p95 ${bd[2]!.toFixed(1)}%`);
    }

    /*
     * 4) CLUSTER bootstrap over POOLS. Trades inside one pool share one price series,
     * so the i.i.d. resample above is the optimistic one and the fold block still
     * groups by time. Resampling the POOLS answers the question that actually matters
     * for a 121-trade sample: "if the universe had drawn different pools, would this
     * still have made money?" Clusters with no trades count as empty draws, they are
     * part of the sample.
     */
    const byPool = new Map<string, number[]>();
    for (const t of oosTrades) {
      const arr = byPool.get(t.poolAddress) ?? [];
      arr.push(t.netPnlPct / 100);
      byPool.set(t.poolAddress, arr);
    }
    const poolKeys = [...byPool.keys()];
    const clusterEnd: number[] = [];
    const clusterDd: number[] = [];
    if (poolKeys.length >= 3) {
      for (let r = 0; r < MC_RUNS; r++) {
        const seq: number[] = [];
        for (let k = 0; k < poolKeys.length; k++) seq.push(...(byPool.get(poolKeys[Math.floor(rng() * poolKeys.length)]!) ?? []));
        const p = equityPath(seq, CAPITAL, SIZE_PCT);
        clusterEnd.push(p.end);
        clusterDd.push(p.maxDdPct);
      }
    }
    const sClusterEnd = [...clusterEnd].sort((a, b) => a - b);
    const sClusterDd = [...clusterDd].sort((a, b) => a - b);
    const cp = percentiles(sClusterEnd, [0.05, 0.5, 0.95]);
    const cd = percentiles(sClusterDd, [0.05, 0.5, 0.95]);
    const pProfitCluster = clusterEnd.length ? clusterEnd.filter((e) => e > CAPITAL).length / clusterEnd.length : 0;
    if (poolKeys.length >= 3) {
      console.log(`  4) bootstrap CLUSTER per POOL (${poolKeys.length} pool)  : equity p5 ${usd(cp[0]!)} · p50 ${usd(cp[1]!)} · p95 ${usd(cp[2]!)} · P(profit) ${(pProfitCluster * 100).toFixed(1)}%`);
      console.log(`     maxDD   p5 ${cd[0]!.toFixed(1)}% · p50 ${cd[1]!.toFixed(1)}% · p95 ${cd[2]!.toFixed(1)}%`);
    }
    mcReport = {
      trades: n,
      iid: { equity: p5, maxDd: d5, pProfit },
      shuffle: { maxDd: sh5 },
      foldBlock: foldBlocks.length ? { equity: bp, maxDd: bd, pProfit: pProfitBlock, blocks: foldBlocks.length } : null,
      poolCluster: poolKeys.length >= 3 ? { equity: cp, maxDd: cd, pProfit: pProfitCluster, pools: poolKeys.length } : null,
    };
  } else {
    console.log(`  dilewati: cuma ${oosReturns.length} trade out-of-sample — resampling di bawah 5 trade tidak berarti apa-apa.`);
  }

  /* ---- (E) stabilitas pilihan ---- */
  const chosenCounts = new Map<string, number>();
  for (const f of folds) if (f.chosen) chosenCounts.set(f.chosen, (chosenCounts.get(f.chosen) ?? 0) + 1);
  console.log(`\n--- (E) STABILITAS: config mana yang menang di tiap fold (in-sample) ---`);
  for (const [k, v] of [...chosenCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v}x  ${k}`);
  if (chosenCounts.size === 0) console.log("  tidak ada fold yang punya cukup trade untuk memilih config.");

  /* ---- (F) konsentrasi pool + leave-one-pool-out ---- */
  const byPoolAll = new Map<string, { n: number; pnl: number; pair: string }>();
  for (const t of oosTrades) {
    const e = byPoolAll.get(t.poolAddress) ?? { n: 0, pnl: 0, pair: t.pairName };
    e.n++;
    e.pnl += t.netPnlUsd;
    byPoolAll.set(t.poolAddress, e);
  }
  const poolRows = [...byPoolAll.entries()].map(([addr, v]) => ({ addr, ...v })).sort((a, b) => b.pnl - a.pnl);
  console.log(`\n--- (F) KONSENTRASI: ${poolRows.length} pool menyumbang ${oosTrades.length} trade OOS ---`);
  for (const p of poolRows.slice(0, 8)) {
    console.log(`  ${p.pair.padEnd(20)} ${String(p.n).padStart(3)} trade · net ${usd(p.pnl)}`);
  }
  const equityWithout = (drop: Set<string>): { end: number; n: number } => {
    const rets = oosTrades.filter((t) => !drop.has(t.poolAddress)).map((t) => t.netPnlPct / 100);
    return { end: equityPath(rets, CAPITAL, SIZE_PCT).end, n: rets.length };
  };
  const top1 = new Set(poolRows.slice(0, 1).map((p) => p.addr));
  const top3 = new Set(poolRows.slice(0, 3).map((p) => p.addr));
  const w1 = equityWithout(top1);
  const w3 = equityWithout(top3);
  console.log(`  leave-one-pool-out: tanpa pool #1 → equity ${usd(w1.end)} (${w1.n} trade) · tanpa 3 pool teratas → equity ${usd(w3.end)} (${w3.n} trade)`);
  console.log(`  (equity OOS apa adanya: ${usd(oosPath.end)} dengan ${oosTrades.length} trade)`);
  const cohortRows = new Map<string, { n: number; pnl: number }>();
  for (const t of oosTrades) {
    const e = cohortRows.get(t.cohort) ?? { n: 0, pnl: 0 };
    e.n++;
    e.pnl += t.netPnlUsd;
    cohortRows.set(t.cohort, e);
  }
  for (const [c, v] of cohortRows) console.log(`  cohort ${c.padEnd(16)} ${String(v.n).padStart(3)} trade · net ${usd(v.pnl)}`);

  /* ---- (G) dump untuk grafik ---- */
  const dumpPath = val("dump", "");
  if (dumpPath) {
    const bands: Record<string, number[]> = { p5: [], p25: [], p50: [], p75: [], p95: [] };
    if (mcCurvesDump.length) {
      const len = mcCurvesDump[0]!.length;
      for (let i = 0; i < len; i++) {
        const col = mcCurvesDump.map((c) => c[i] ?? 0).sort((a, b) => a - b);
        const q = (p: number): number => col[Math.min(col.length - 1, Math.max(0, Math.round(p * (col.length - 1))))]!;
        bands.p5!.push(q(0.05));
        bands.p25!.push(q(0.25));
        bands.p50!.push(q(0.5));
        bands.p75!.push(q(0.75));
        bands.p95!.push(q(0.95));
      }
    }
    const inSampleReturns = (fullBest?.run?.tradeList ?? []).map((t) => t.netPnlPct / 100);
    writeFileSync(
      dumpPath,
      JSON.stringify(
        {
          label: LABEL,
          capital: CAPITAL,
          sizePct: SIZE_PCT,
          kMode: K_MODE,
          folds: folds.map((f) => ({
            fold: f.fold,
            trainStart: f.trainStart,
            trainEnd: f.trainEnd,
            testStart: f.testStart,
            testEnd: f.testEnd,
            chosen: f.chosen,
            testTrades: f.testTrades.length,
            testNet: f.testMetrics?.netPnlUsd ?? 0,
          })),
          oosCurve: equityCurve(oosReturns, CAPITAL, SIZE_PCT),
          oosTrades: oosTrades.map((t) => ({ time: t.entryTime, pool: t.pairName, ret: t.netPnlPct / 100, pnlUsd: t.netPnlUsd })),
          inSampleCurve: equityCurve(inSampleReturns, CAPITAL, SIZE_PCT),
          mcBands: bands,
          mcSampleCurves: mcCurvesDump.slice(0, 200),
          leaveOneOut: { full: oosPath.end, drop1: w1.end, drop3: w3.end },
          expectancy: {
            inSample: fullBest?.run?.expectancy ?? 0,
            oos: oosSummary.totalTrades ? oosSummary.netPnlUsd / oosSummary.totalTrades : 0,
          },
        },
        null,
        0,
      ),
    );
    console.log(`\nDUMP grafik: ${dumpPath}`);
  }

  /* ---- JSON ---- */
  const payload = {
    label: LABEL,
    generatedAt: new Date().toISOString(),
    cache: CACHE,
    kMode: K_MODE,
    tvlModel: { medianK: tvlModel.medianK, p25K: tvlModel.p25K, p75K: tvlModel.p75K, samples: tvlModel.samples },
    account: { capital: CAPITAL, sizePct: SIZE_PCT, concurrent: CONCURRENT, gasSolPerTx: GAS },
    universe: { pools: dataset.pools.length, survivors: survivors.length, firstDay: fmtDay(firstT), lastDay: fmtDay(lastT) },
    inSampleBest: fullBest?.run ? { arm: fullBest.arm.label, ...stripRun(fullBest.run) } : null,
    folds: folds.map((f) => ({
      fold: f.fold,
      trainStart: f.trainStart,
      trainEnd: f.trainEnd,
      testStart: f.testStart,
      testEnd: f.testEnd,
      chosen: f.chosen,
      armsTried: f.armsTried,
      train: f.trainMetrics ? stripRun(f.trainMetrics) : null,
      test: f.testMetrics ? stripRun(f.testMetrics) : null,
    })),
    outOfSample: { ...stripRun(oosSummary as unknown as ScoredRun), summary: oosSummary, equityEnd: oosPath.end, maxDdPctPath: oosPath.maxDdPct, distinctPools, entrySpanDays },
    monteCarlo: mcReport,
    chosenCounts: Object.fromEntries(chosenCounts),
  };
  const outPath = `docs/backtests/runs/${LABEL}.json`;
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nJSON: ${outPath}`);
}

function stripRun(r: ScoredRun | (ScoredRun & { tradeList?: unknown })): Omit<ScoredRun, "tradeList"> {
  const { tradeList, ...rest } = r as ScoredRun;
  void tradeList;
  return rest;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
