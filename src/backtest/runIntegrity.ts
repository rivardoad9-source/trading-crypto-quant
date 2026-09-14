/**
 * Backtest integrity run — the V1.1 baseline and its TP / gate variants, measured the way
 * live actually trades.
 *
 *   npm run backtest:integrity
 *   npm run backtest:integrity -- --days=91 --windows=2 --pools=16 --deadpools=16
 *   npm run backtest:integrity -- --dataset=.cache/historical_data_integrity.json   # reuse, no TTL
 *
 * Three things every earlier runner got wrong, all in the optimistic direction:
 *
 *   1. UNIVERSE — it traded pools live cannot enter (no wSOL leg; Token-2022 fee/hook/
 *      non-transferable mints). Every figure here is printed for the live-eligible arm,
 *      the full universe, and the gap.
 *   2. SWAP — the balancing swap that runs on every entry was free.
 *   3. EXIT — a take-profit exit paid no concession at all, and forced exits a flat 2%
 *      on every pool. Here every exit pays a bin-step-aware concession, calibrated on the
 *      three live points and reported as a BAND (fit / envelope).
 *
 * The OLD accounting is run beside the new on the same data, so the report states how
 * much of the old number was cost and how much was universe — not a fresh number with no
 * anchor.
 *
 * Deploys ZERO capital, signs nothing, reads only public market data and mint accounts.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { runSimulation, type BacktestConfig, type BacktestResult } from "./engine.js";
import {
  BACKTEST_CAVEATS,
  FREE_TIER_HISTORY_DAYS,
  SOL_USDC_POOL,
  fetchHourlyBars,
  loadHistoricalData,
  type Bar,
  type HistoricalDataset,
  type PoolHistory,
} from "./historicalData.js";
import { ensureTvlSeries, heliusTvlDeps, seriesPoints } from "./onchainTvl.js";
import { calibrateTvlModel, describeTvlModel, type TvlModel } from "./tvlModel.js";
import { liveV11Config } from "./runMicroCapital.js";
import {
  describeBacktestProfile,
  readProfileOverrides,
  resolveBacktestProfile,
} from "./liveProfile.js";
import {
  annotateTokenScreens,
  describeEligibilityArms,
  partitionLiveEligible,
  type EligibilityPartition,
} from "./liveEligibility.js";
import {
  LIVE_EXIT_OBSERVATIONS,
  calibrateExitCostModel,
  flatExitCostModel,
  maxProfitableBinStep,
  takeProfitAfterCost,
  type ExitCostModel,
} from "./exitCost.js";
import {
  nonOverlappingWindows,
  scoreConfig,
  splitWindow,
  survivedOutOfSample,
  type DatasetWindow,
  type Scored,
} from "./sweepHarness.js";
import { renderTable } from "./report.js";
import { buildPointInTimeUniverse } from "./universe.js";
import {
  BRAKE_LABEL,
  DEFAULT_INGEST_PARAMS,
  barFilePath,
  loadWindowDataset,
  universeCoverage,
  windowFunnel,
  windowsEndingAt,
  type CacheOutcome,
  type IngestParams,
  type WindowDataset,
  type WindowSpec,
} from "./windowUniverse.js";
import type { DlmmPool } from "../services/meteora.js";
import { readFileSync } from "node:fs";

const CACHE_PATH = ".cache/historical_data_integrity.json";
const SUMMARY_PATH = "backtest_integrity_summary.json";
const REPORT_PATH = "backtest_integrity_report.txt";

const MIN_TRADES = 8;

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const usd = (n: number): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const signed = (n: number): string => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
const pf = (v: number | null): string => (v === null ? "—" : v.toFixed(2));
const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

export interface CostScenario {
  key: string;
  label: string;
  swapSlippagePct: number;
  swapGasSolPerLeg: number;
  exitCostModel: ExitCostModel | null;
}

/**
 * The cost ladder, cheapest (the published accounting) to most pessimistic. Each step
 * adds ONE cost, so the difference between adjacent rows is attributable to it.
 */
export function costLadder(input: {
  swapSlippagePct: number;
  swapGasSolPerLeg: number;
  forcedExitSlippagePct: number;
  fit: ExitCostModel;
  envelope: ExitCostModel;
}): CostScenario[] {
  const swap = { swapSlippagePct: input.swapSlippagePct, swapGasSolPerLeg: input.swapGasSolPerLeg };
  return [
    { key: "old", label: "LAMA: swap gratis, exit flat 2% (paksa saja)", swapSlippagePct: 0, swapGasSolPerLeg: 0, exitCostModel: null },
    { key: "swap", label: `+swap ${input.swapSlippagePct}%/kaki`, ...swap, exitCostModel: null },
    { key: "flat", label: `+swap, exit flat ${input.forcedExitSlippagePct}% SEMUA exit`, ...swap, exitCostModel: flatExitCostModel(input.forcedExitSlippagePct) },
    { key: "fit", label: "+swap, exit bin_step (fit)", ...swap, exitCostModel: input.fit },
    { key: "envelope", label: "+swap, exit bin_step (envelope)", ...swap, exitCostModel: input.envelope },
  ];
}

export interface Variant {
  key: string;
  label: string;
  apply: (c: BacktestConfig) => BacktestConfig;
}

export const VARIANTS: Variant[] = [
  { key: "base", label: "V1.1 (TP 5, cov 2.5)", apply: (c) => c },
  { key: "tp6", label: "TP 6%", apply: (c) => ({ ...c, takeProfitNetPct: 6 }) },
  { key: "tp8", label: "TP 8%", apply: (c) => ({ ...c, takeProfitNetPct: 8 }) },
  { key: "tp10", label: "TP 10%", apply: (c) => ({ ...c, takeProfitNetPct: 10 }) },
  { key: "cov2", label: "coverage 2.0x", apply: (c) => ({ ...c, minFeeCostCoverage: 2.0 }) },
  { key: "cov15", label: "coverage 1.5x", apply: (c) => ({ ...c, minFeeCostCoverage: 1.5 }) },
  // S1: the gate prices the exit per pool instead of flat. Only meaningful with a model.
  { key: "gatecost", label: "gate pakai biaya exit bin_step", apply: (c) => ({ ...c, gateUsesExitCostModel: true }) },
];

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

interface ArmRun {
  pools: number;
  result: BacktestResult | null;
  inS: Scored | null;
  outS: Scored | null;
  oosStatus: "lolos" | "gagal" | "belum bisa diverifikasi";
  /** Where the halves were cut and how many pools had more than a day of bars in each. Null with no pools. */
  split: { start: number; mid: number; end: number; inPools: number; outPools: number } | null;
}

function runArm(pools: PoolHistory[], sol: PoolHistory["bars"], tvl: TvlModel, config: BacktestConfig, label: string): ArmRun {
  if (pools.length === 0) {
    return { pools: 0, result: null, inS: null, outS: null, oosStatus: "belum bisa diverifikasi", split: null };
  }
  let result: BacktestResult | null = null;
  try {
    result = runSimulation({ label, pools, solUsdBars: sol, tvlModel: tvl, config });
  } catch {
    result = null;
  }
  const split = splitWindow(pools, sol);
  const inS = split.inPools.length ? scoreConfig(split.inPools, split.inSol, tvl, config, label) : null;
  const outS = split.outPools.length ? scoreConfig(split.outPools, split.outSol, tvl, config, label) : null;

  let oosStatus: ArmRun["oosStatus"];
  if (!inS || !outS || inS.trades < MIN_TRADES || outS.trades < MIN_TRADES) oosStatus = "belum bisa diverifikasi";
  else oosStatus = survivedOutOfSample(inS, outS, MIN_TRADES) ? "lolos" : "gagal";

  return {
    pools: pools.length,
    result,
    inS,
    outS,
    oosStatus,
    split: { start: split.start, mid: split.mid, end: split.end, inPools: split.inPools.length, outPools: split.outPools.length },
  };
}

/**
 * One half of the IS/OOS split as the report prints it. A half with no pool holding a day of
 * bars is an EMPTY SAMPLE — its 0 trades say nothing about the strategy, and printing a bare
 * 0 there is how W1's in-sample half read as a result in the 14 Sep run.
 */
export function describeHalf(pools: number, scored: Scored | null, minTrades = MIN_TRADES): string {
  if (pools === 0) return "sampel kosong (0 pool)";
  const trades = scored?.trades ?? 0;
  return `${pools} pool / ${trades} trd${trades < minTrades ? " (tipis)" : ""}`;
}

/**
 * The answer for ONE window: YA only when the variant beats base AND clears the bar there;
 * BELUM BISA DIVERIFIKASI whenever either half is short of the bar's trade count, whatever
 * the delta says; TIDAK otherwise.
 */
export function windowAnswer(delta: number | null, status: ArmRun["oosStatus"]): "YA" | "TIDAK" | "BELUM BISA DIVERIFIKASI" {
  if (delta === null || status === "belum bisa diverifikasi") return "BELUM BISA DIVERIFIKASI";
  return delta > 0 && status === "lolos" ? "YA" : "TIDAK";
}

const figures = (a: ArmRun) => ({
  pools: a.pools,
  trades: a.result?.summary.totalTrades ?? 0,
  netPnlUsd: a.result?.summary.netPnlUsd ?? 0,
  profitFactor: a.result?.summary.profitFactor ?? null,
  maxDrawdownPct: a.result?.summary.maxDrawdownPct ?? 0,
});

interface Cell {
  window: string;
  cost: string;
  variant: string;
  eligible: ArmRun;
  full: ArmRun;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(arg);
    if (m) flags.set(m[1]!.toLowerCase(), m[2] ?? "true");
  }
  return flags;
}

function loadDatasetFile(path: string): HistoricalDataset {
  const parsed = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as HistoricalDataset;
  if (!Array.isArray(parsed.pools) || parsed.pools.length === 0) {
    throw new Error(`[integrity] ${path} holds no pools`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const num = (k: string, d: number): number => {
    const raw = flags.get(k);
    if (raw === undefined) return d;
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`--${k}=${raw} is not a number`);
    return v;
  };

  const days = num("days", 91);
  const windowsWanted = num("windows", 2);
  const swapSlippagePct = num("swapslip", 0.25);
  const gasSol = num("gas", 0.004);
  const swapGasSolPerLeg = num("swapgas", gasSol);

  // The live account per the 13 Sep work order: $300, 63%, one position, 0.004 SOL/tx.
  // Explicit flags win; absent ones fall back to THESE, not to the local .env profile.
  const accountFlags = new Map<string, string>([
    ["capital", flags.get("capital") ?? "300"],
    ["sizepct", flags.get("sizepct") ?? "63"],
    ["concurrent", flags.get("concurrent") ?? "1"],
    ["gas", String(gasSol)],
  ]);
  if (flags.has("solusd")) accountFlags.set("solusd", flags.get("solusd")!);

  const totalDays = days * windowsWanted;
  if (totalDays > FREE_TIER_HISTORY_DAYS && !process.env.COINGECKO_PRO_API_KEY) {
    console.warn(
      `[integrity] ${windowsWanted} x ${days} = ${totalDays} days exceeds the free tier's ~${FREE_TIER_HISTORY_DAYS}; ` +
        "the oldest window WILL be truncated and is reported with its real coverage.",
    );
  }

  const perWindowUniverse = flags.has("per-window-universe");
  const ingestOnly = flags.has("ingest-only");
  const policy = { maxTransferFeeBps: env.LIVE_MAX_TOKEN_TRANSFER_FEE_BPS };

  if (perWindowUniverse) {
    await runPerWindowUniverse({ flags, num, days, windowsWanted, ingestOnly, gasSol, swapSlippagePct, swapGasSolPerLeg, policy });
    return;
  }
  if (ingestOnly) throw new Error("--ingest-only is only meaningful with --per-window-universe");

  const datasetPath = flags.get("dataset");
  const dataset: HistoricalDataset = datasetPath
    ? loadDatasetFile(datasetPath)
    : await loadHistoricalData({
        poolCount: num("pools", 16),
        deadPoolCount: num("deadpools", 16),
        windowDays: totalDays,
        cachePath: CACHE_PATH,
        force: flags.has("refresh"),
        survivorTvlBand: { minUsd: env.MIN_TVL_USD, maxUsd: env.MAX_TVL_USD },
        annotateTokens: true,
        // A long window must not demand weeks of bars from the dead cohort it exists to capture.
        minBars: 72,
      });
  if (datasetPath) {
    const { rpcReads, failures, changed } = await annotateTokenScreens(dataset.pools);
    console.log(`[integrity] --dataset ${datasetPath}: ${rpcReads} RPC reads, ${failures} unreadable`);
    if (changed) writeFileSync(resolve(process.cwd(), datasetPath), JSON.stringify(dataset, null, 2), "utf8");
  }

  const profile = resolveBacktestProfile({
    overrides: readProfileOverrides(accountFlags),
    windowStartSolUsd: dataset.solUsdBars[0]?.c ?? null,
    defaultGasSolPerTransaction: gasSol,
  });
  const baseConfig = liveV11Config(profile.options);

  const calibration = calibrateExitCostModel(LIVE_EXIT_OBSERVATIONS);
  const ladder = costLadder({
    swapSlippagePct,
    swapGasSolPerLeg,
    forcedExitSlippagePct: baseConfig.forcedExitSlippagePct,
    fit: calibration.fit,
    envelope: calibration.envelope,
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
  if (tvlModel.samples === 0) throw new Error("[integrity] TVL model could not be calibrated");

  const partition: EligibilityPartition = await partitionLiveEligible(dataset.pools, policy);
  const eligibleSet = new Set(partition.eligible.map((p) => p.address));

  const windows: DatasetWindow[] = nonOverlappingWindows(dataset.pools, dataset.solUsdBars, days, windowsWanted);
  if (windows.length === 0) throw new Error("[integrity] no window has data");

  /* ---- simulate ---- */
  const cells: Cell[] = [];
  for (const w of windows) {
    const eligiblePools = w.pools.filter((p) => eligibleSet.has(p.address));
    for (const cost of ladder) {
      const costConfig: BacktestConfig = {
        ...baseConfig,
        swapSlippagePct: cost.swapSlippagePct,
        swapGasSolPerLeg: cost.swapGasSolPerLeg,
        exitCostModel: cost.exitCostModel,
      };
      for (const v of VARIANTS) {
        // A gate-cost variant without a cost model is the base row again; skip it.
        if (v.key === "gatecost" && !cost.exitCostModel) continue;
        const config = v.apply(costConfig);
        const tag = `${w.label}-${cost.key}-${v.key}`;
        cells.push({
          window: w.label,
          cost: cost.key,
          variant: v.key,
          eligible: runArm(eligiblePools, w.solUsdBars, tvlModel, config, `${tag}-eligible`),
          full: runArm(w.pools, w.solUsdBars, tvlModel, config, `${tag}-full`),
        });
      }
    }
  }

  const cell = (w: string, c: string, v: string) =>
    cells.find((x) => x.window === w && x.cost === c && x.variant === v);

  /* ---- report ---- */
  const out: string[] = [];
  const h = (t: string) => out.push("", "═".repeat(96), t, "═".repeat(96), "");

  h("BACKTEST INTEGRITY — V1.1 dengan biaya & universe yang live benar-benar hadapi");
  out.push(
    ...describeBacktestProfile(profile),
    `Dataset         : ${datasetPath ?? CACHE_PATH} · fetched ${dataset.fetchedAt} · ${dataset.pools.length} pools ` +
      `(${survivors.length} survivor / ${dataset.pools.length - survivors.length} dead)`,
    `TVL model       : ${describeTvlModel(tvlModel)}`,
    `Gates / exits   : coverage ${baseConfig.minFeeCostCoverage}x · TP +${baseConfig.takeProfitNetPct}% · ` +
      `SL ${baseConfig.stopLossPct}% · age ${baseConfig.maxDurationHours}h · range -${baseConfig.downsideCoverPct}%/+${baseConfig.upsideCoverPct}% · ` +
      `forced exit ${baseConfig.forcedExitSlippagePct}%`,
    `Swap (baru)     : ${swapSlippagePct}%/kaki + ${swapGasSolPerLeg} SOL gas/kaki`,
    `Token screen    : max transfer fee ${policy.maxTransferFeeBps} bps + hook + non-transferable ditolak` +
      (env.LIVE_TOKEN_FEE_SCREEN_ENABLED ? "" : " (catatan: switch live LIVE_TOKEN_FEE_SCREEN_ENABLED=false di env ini)"),
  );
  for (const w of windows) {
    out.push(
      `Window ${w.label}       : ${day(w.start)} → ${day(w.end)} · ${w.coveredDays.toFixed(1)} hari data · ${w.pools.length} pools`,
    );
  }
  if (windows.length < windowsWanted) {
    out.push(
      `** Hanya ${windows.length} dari ${windowsWanted} window yang punya data — kedalaman data gratis ~${FREE_TIER_HISTORY_DAYS} hari. **`,
    );
  }

  h("0. UNIVERSE — siapa yang live-eligible");
  out.push(
    `live-eligible ${partition.eligible.length} / ${dataset.pools.length} pools · ` +
      `noWsol ${partition.counts.noWsol} · token screen ${partition.counts.tokenScreen} · unread ${partition.counts.unannotated}`,
  );
  for (const { pool, verdict } of partition.ineligible.filter((x) => x.verdict.reason !== "noWsol")) {
    out.push(`  ${pool.pairName.padEnd(18)} ${verdict.reason}: ${verdict.detail}`);
  }

  h("1. KALIBRASI BIAYA EXIT (dari live, per kaki, bersih dari transfer fee)");
  out.push(
    renderTable(
      [
        { header: "Obs" },
        { header: "bin_step", align: "right" },
        { header: "notional/TVL", align: "right" },
        { header: "observed", align: "right" },
        { header: "fit", align: "right" },
        { header: "envelope", align: "right" },
      ],
      calibration.residuals.map((r) => {
        const o = LIVE_EXIT_OBSERVATIONS.find((x) => x.label === r.label)!;
        return [
          r.label,
          String(o.binStepBps),
          `${o.shareOfTvlPct.toFixed(3)}%`,
          `${r.observedPct.toFixed(2)}%`,
          `${r.fitPct.toFixed(2)}%`,
          `${r.envelopePct.toFixed(2)}%`,
        ];
      }),
    ),
    "",
    `fit      = ${calibration.fit.label}`,
    `envelope = ${calibration.envelope.label}`,
  );

  const solEnd = dataset.solUsdBars[dataset.solUsdBars.length - 1]?.c ?? profile.solUsd;
  const gasRoundTripPct = profile.notionalUsd > 0 ? ((gasSol * 2 * solEnd) / profile.notionalUsd) * 100 : 0;
  const binSteps = [10, 20, 50, 80, 100, 150, 200, 250, 300, 400];
  const tpRows = (model: ExitCostModel) =>
    takeProfitAfterCost({
      model,
      binStepsBps: binSteps,
      takeProfitPct: baseConfig.takeProfitNetPct,
      notionalUsd: profile.notionalUsd,
      tvlUsd: 100_000,
      gasRoundTripPctOfNotional: gasRoundTripPct,
      entrySwapPct: swapSlippagePct,
    });
  const fitTp = tpRows(calibration.fit);
  const envTp = tpRows(calibration.envelope);

  h(`2. NET SAAT TP +${baseConfig.takeProfitNetPct}% SETELAH BIAYA (notional ${usd(profile.notionalUsd)}, TVL $100k, SOL ${usd(solEnd)})`);
  out.push(
    renderTable(
      [
        { header: "bin_step", align: "right" },
        { header: "exit fit", align: "right" },
        { header: "net @TP fit", align: "right" },
        { header: "exit env", align: "right" },
        { header: "net @TP env", align: "right" },
      ],
      binSteps.map((b, i) => [
        String(b),
        `${fitTp[i]!.exitConcessionPct.toFixed(2)}%`,
        `${fitTp[i]!.netAtTakeProfitPct.toFixed(2)}%`,
        `${envTp[i]!.exitConcessionPct.toFixed(2)}%`,
        `${envTp[i]!.netAtTakeProfitPct.toFixed(2)}%`,
      ]),
    ),
    "",
    `bin_step terbesar yang TP masih profit: fit ${maxProfitableBinStep(fitTp) ?? "tidak ada"} · envelope ${maxProfitableBinStep(envTp) ?? "tidak ada"} ` +
      `(gas round trip ${gasRoundTripPct.toFixed(2)}% notional, swap masuk ${swapSlippagePct}% x 0.5)`,
    "Ini TP yang kena TEPAT di +5% gross. Harga yang lompat melewati TP antar bar menaikkan angka ini; exit paksa pakai max(model, flat).",
  );

  h("3. BASELINE V1.1 — akuntansi LAMA vs BARU, per window (tidak dirata-rata)");
  for (const w of windows) {
    out.push(`-- ${w.label} (${day(w.start)} → ${day(w.end)}) --`);
    out.push(
      renderTable(
        [
          { header: "Akuntansi" },
          { header: "elig trd", align: "right" },
          { header: "elig net", align: "right" },
          { header: "elig PF", align: "right" },
          { header: "full trd", align: "right" },
          { header: "full net", align: "right" },
          { header: "full PF", align: "right" },
          { header: "selisih net", align: "right" },
          { header: "swap", align: "right" },
          { header: "exit slip", align: "right" },
        ],
        ladder.map((c) => {
          const x = cell(w.label, c.key, "base")!;
          const e = figures(x.eligible);
          const f = figures(x.full);
          const fs = x.full.result?.summary;
          return [
            c.label,
            String(e.trades),
            usd(e.netPnlUsd),
            pf(e.profitFactor),
            String(f.trades),
            usd(f.netPnlUsd),
            pf(f.profitFactor),
            signed(f.netPnlUsd - e.netPnlUsd),
            usd(fs?.totalSwapCostUsd ?? 0),
            usd(fs?.totalSlippageCostUsd ?? 0),
          ];
        }),
      ),
    );
    const old = cell(w.label, "old", "base")!;
    for (const k of ["fit", "envelope"]) {
      const now = cell(w.label, k, "base")!;
      out.push(
        "",
        `${w.label} ${k}: turun karena BIAYA (full, lama→baru) ${signed(figures(now.full).netPnlUsd - figures(old.full).netPnlUsd)} · ` +
          `hilang karena UNIVERSE (baru, full→eligible) ${signed(figures(now.eligible).netPnlUsd - figures(now.full).netPnlUsd)} · ` +
          `total lama-full → baru-eligible ${signed(figures(now.eligible).netPnlUsd - figures(old.full).netPnlUsd)}`,
      );
      out.push(...describeEligibilityArms(figures(now.eligible), figures(now.full), partition).map((l) => `   ${l}`));
    }
    out.push("");
  }

  h("4. VARIAN TP & GATE — (live-eligible | full universe | selisih), OOS = split tengah window");
  for (const costKey of ["fit", "envelope"]) {
    for (const w of windows) {
      out.push(`-- ${w.label} · biaya exit ${costKey} --`);
      out.push(
        renderTable(
          [
            { header: "Varian" },
            { header: "elig trd", align: "right" },
            { header: "elig net", align: "right" },
            { header: "Δ vs base", align: "right" },
            { header: "elig PF", align: "right" },
            { header: "elig DD", align: "right" },
            { header: "IS/OOS trd", align: "right" },
            { header: "OOS exp", align: "right" },
            { header: "OOS (elig)", align: "right" },
            { header: "full net", align: "right" },
            { header: "selisih", align: "right" },
          ],
          VARIANTS.map((v) => {
            const x = cell(w.label, costKey, v.key);
            if (!x) return [v.label, "—", "—", "—", "—", "—", "—", "—", "—", "—", "—"];
            const base = cell(w.label, costKey, "base")!;
            const e = figures(x.eligible);
            const f = figures(x.full);
            return [
              v.label,
              String(e.trades),
              usd(e.netPnlUsd),
              v.key === "base" ? "—" : signed(e.netPnlUsd - figures(base.eligible).netPnlUsd),
              pf(e.profitFactor),
              `${e.maxDrawdownPct.toFixed(1)}%`,
              `${x.eligible.inS?.trades ?? 0}/${x.eligible.outS?.trades ?? 0}`,
              x.eligible.outS ? signed(x.eligible.outS.expectancyUsd) : "—",
              x.eligible.oosStatus,
              usd(f.netPnlUsd),
              signed(f.netPnlUsd - e.netPnlUsd),
            ];
          }),
        ),
        "",
      );
    }
  }

  h("5. JAWABAN: naikin TP (6/8/10) dan/atau gate 2.0x/1.5x menaikkan NET live-eligible di KEDUA window?");
  const answers: Array<{ costKey: string; variant: string; perWindow: Array<{ window: string; delta: number; oos: string; trades: number }>; answer: string }> = [];
  for (const costKey of ["fit", "envelope"]) {
    for (const v of VARIANTS.filter((x) => x.key !== "base")) {
      const perWindow = windows.map((w) => {
        const x = cell(w.label, costKey, v.key)!;
        const base = cell(w.label, costKey, "base")!;
        return {
          window: w.label,
          delta: figures(x.eligible).netPnlUsd - figures(base.eligible).netPnlUsd,
          oos: x.eligible.oosStatus,
          trades: figures(x.eligible).trades,
        };
      });
      const allUp = windows.length >= 2 && perWindow.every((p) => p.delta > 0);
      const allVerified = perWindow.every((p) => p.oos === "lolos");
      const answer =
        windows.length < 2
          ? "BELUM BISA DIVERIFIKASI (kurang dari 2 window)"
          : !allUp
            ? "TIDAK"
            : allVerified
              ? "YA (naik di kedua window, lolos OOS)"
              : "NAIK DI KEDUA WINDOW, TAPI OOS belum bisa diverifikasi/gagal — bukan temuan";
      answers.push({ costKey, variant: v.key, perWindow, answer });
      out.push(
        `${costKey.padEnd(8)} ${v.label.padEnd(32)} ` +
          perWindow.map((p) => `${p.window} ${signed(p.delta)} (${p.trades} trd, OOS ${p.oos})`).join(" · ") +
          `  →  ${answer}`,
      );
    }
  }

  h("CAVEATS");
  BACKTEST_CAVEATS.forEach((c, i) => out.push(`${i + 1}. ${c}`));
  out.push(
    `${BACKTEST_CAVEATS.length + 1}. Biaya exit dikalibrasi dari TIGA observasi live yang tercampur faktor lain (momentum, routing Jupiter, TVL hari ini). Fit vs envelope beda ~3x; percayai kesimpulan hanya kalau sama di keduanya.`,
    `${BACKTEST_CAVEATS.length + 2}. Gas ${gasSol} SOL/tx adalah asumsi, bukan seri historis.`,
    `${BACKTEST_CAVEATS.length + 3}. Arm live-eligible memakai ekstensi mint HARI INI; fee Token-2022 bisa berubah per epoch.`,
  );

  const report = out.join("\n");
  console.log(report);
  writeFileSync(resolve(process.cwd(), REPORT_PATH), report, "utf8");

  const strip = (a: ArmRun) => ({
    pools: a.pools,
    summary: a.result?.summary ?? null,
    gateRejections: a.result?.gateRejections ?? null,
    inSample: a.inS,
    outOfSample: a.outS,
    oosStatus: a.oosStatus,
  });
  writeFileSync(
    resolve(process.cwd(), SUMMARY_PATH),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataset: { path: datasetPath ?? CACHE_PATH, fetchedAt: dataset.fetchedAt, pools: dataset.pools.length },
        profile,
        baseConfig,
        tvlModel: { medianK: tvlModel.medianK, p25K: tvlModel.p25K, p75K: tvlModel.p75K, samples: tvlModel.samples },
        eligibility: {
          eligible: partition.eligible.map((p) => p.pairName),
          ineligible: partition.ineligible.map((x) => ({ pair: x.pool.pairName, reason: x.verdict.reason, detail: x.verdict.detail })),
        },
        calibration,
        takeProfitAfterCost: { fit: fitTp, envelope: envTp },
        windows: windows.map((w) => ({ label: w.label, start: day(w.start), end: day(w.end), coveredDays: w.coveredDays, pools: w.pools.length })),
        ladder: ladder.map((c) => ({ key: c.key, label: c.label, swapSlippagePct: c.swapSlippagePct, exitCostModel: c.exitCostModel })),
        cells: cells.map((c) => ({ window: c.window, cost: c.cost, variant: c.variant, eligible: strip(c.eligible), full: strip(c.full) })),
        answers,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[integrity] wrote ${REPORT_PATH} and ${SUMMARY_PATH}`);
}

/* ------------------------------------------------------------------ */
/* --per-window-universe                                               */
/* ------------------------------------------------------------------ */

const WINDOW_SUMMARY_PATH = "backtest_window_universe_summary.json";
const WINDOW_REPORT_PATH = "backtest_window_universe_report.txt";

/**
 * `--candidates` / `--survivor-pages` / `--cohort-pages`, each a positive integer. The pages
 * were hardcoded 12 / 40 on this path; a deeper dead-cohort walk now needs no code edit.
 */
export function readIngestFlags(flags: ReadonlyMap<string, string>): IngestParams {
  const int = (key: string, fallback: number): number => {
    const raw = flags.get(key);
    if (raw === undefined) return fallback;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 1) throw new Error(`--${key}=${raw} must be a positive integer`);
    return v;
  };
  return {
    candidatesCap: int("candidates", DEFAULT_INGEST_PARAMS.candidatesCap),
    survivorPages: int("survivor-pages", DEFAULT_INGEST_PARAMS.survivorPages),
    cohortPages: int("cohort-pages", DEFAULT_INGEST_PARAMS.cohortPages),
  };
}

/**
 * `--tvl=model|onchain` (default model), `--tvl-cadence-hours` (default 12), `--tvl-concurrency`
 * (default 6). On-chain costs two RPC reads per pool per grid instant, cached per pool; the model
 * default keeps every earlier per-window run reproducible.
 */
export function readTvlFlags(flags: ReadonlyMap<string, string>): { basis: "model" | "onchain"; cadenceSec: number; concurrency: number } {
  const basis = flags.get("tvl") ?? "model";
  if (basis !== "model" && basis !== "onchain") throw new Error(`--tvl=${basis} must be model or onchain`);
  const hours = Number(flags.get("tvl-cadence-hours") ?? 12);
  if (!Number.isInteger(hours) || hours < 1 || 24 % hours !== 0) throw new Error(`--tvl-cadence-hours=${flags.get("tvl-cadence-hours")} must divide 24 (1,2,3,4,6,8,12,24)`);
  const concurrency = Number(flags.get("tvl-concurrency") ?? 6);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("--tvl-concurrency must be 1..32");
  return { basis, cadenceSec: hours * 3600, concurrency };
}

/**
 * `--end=YYYY-MM-DD` pins the newest window's end (00:00 UTC). Without it windows end NOW,
 * so their dates — and the cache files named after them — move every day; pinning the end
 * is how a later run reuses an earlier run's candidate lists instead of starting new ones.
 */
export function readEndFlag(flags: ReadonlyMap<string, string>): number | null {
  const raw = flags.get("end");
  if (raw === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`--end=${raw} must be YYYY-MM-DD`);
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`--end=${raw} is not a date`);
  return ms / 1000;
}

/** The per-window funnel as printed before any analysis: every stage, reconciled, with the binding brake. */
export function renderWindowFunnels(
  windows: ReadonlyArray<{ label: string; spec: WindowSpec; dataset: WindowDataset; cache: CacheOutcome }>,
  ctx: { ingest: IngestParams; hasProKey: boolean; nowSec: number },
): string[] {
  const funnels = windows.map((w) => ({ w, f: windowFunnel(w.dataset, w.spec) }));
  const out = [
    "",
    `FUNNEL PER WINDOW (cap kandidat ${ctx.ingest.candidatesCap}, pages survivor ${ctx.ingest.survivorPages} / dead cohort ${ctx.ingest.cohortPages})`,
    renderTable(
      [
        { header: "Window" },
        { header: "Periode" },
        { header: "Cache" },
        { header: "Kandidat", align: "right" },
        { header: "Dipakai", align: "right" },
        { header: "Lahir sesudah", align: "right" },
        { header: "<24 bar", align: "right" },
        { header: "Band TVL (bawah/atas)", align: "right" },
        { header: "Di luar top N", align: "right" },
        { header: "Fetch gagal", align: "right" },
        { header: "Coverage", align: "right" },
        { header: "k", align: "right" },
      ],
      funnels.map(({ w, f }) => [
        w.label,
        `${w.dataset.window.start} -> ${w.dataset.window.end}`,
        w.cache,
        String(f.candidates),
        String(f.used),
        String(f.rejected.bornAfterWindow),
        String(f.rejected.noBarsInWindow),
        `${f.rejected.tvlBand}${f.tvlBandDetail ? ` (${f.tvlBandDetail.belowMin}/${f.tvlBandDetail.aboveMax})` : ""}`,
        String(f.rejected.belowTopN),
        String(f.fetchFailed),
        `${f.coverage.withData}/${f.coverage.n}`,
        w.dataset.selection.tvlBasis === "onchain" ? "on-chain" : w.dataset.selection.k === null ? "—" : w.dataset.selection.k.toFixed(3),
      ]),
    ),
  ];
  for (const { w, f } of funnels) {
    const refusals = Object.entries(w.dataset.selection.tvlRefusals ?? {});
    if (w.dataset.selection.tvlBasis === "onchain") {
      out.push(
        `${w.label}: TVL on-chain · tanpa seri: ${refusals.length ? refusals.map(([r, n]) => `${n}x ${r}`).join("; ") : "0"} · band TVL tidak diketahui: ${f.tvlBandDetail?.unknown ?? 0}`,
      );
    }
    if (!f.reconciles) {
      out.push(`${w.label}: ** funnel TIDAK rekonsiliasi (kandidat ${f.candidates} != dipakai + ditolak + gagal) — cache robek atau bug, jangan pakai window ini **`);
    }
    if (w.spec.start < ctx.nowSec - FREE_TIER_HISTORY_DAYS * 86_400 && !ctx.hasProKey) {
      out.push(
        `${w.label}: mulai sebelum kedalaman data gratis ~${FREE_TIER_HISTORY_DAYS} hari — sebagian "<24 bar" di sini adalah BATAS PLAN, bukan fakta pool.`,
      );
    }
    if (f.binding) {
      out.push(
        `${w.label}: TEMUAN — universe ${f.coverage.withData}/${f.coverage.n}, kurang ${f.binding.short}. ` +
          `Rem pengikat: ${BRAKE_LABEL[f.binding.brake]} (${f.binding.count}). ` +
          (f.walkExhausted ? `Walk listing cuma menghasilkan ${f.candidates} dari cap ${w.dataset.selection.ingest?.candidatesCap} kandidat (pages juga mengikat). ` : "") +
          "Window tipis = sampel kurang, BUKAN \"tidak ada trade karena strategi\".",
      );
    }
  }
  return out;
}

/**
 * Each window judged on a universe picked from activity INSIDE it (see `windowUniverse.ts`).
 *
 * Deliberately a separate path rather than a branch threaded through `main`: with the flag
 * off, `main` runs exactly the code that produced the published figures. Windows are
 * reported side by side and never averaged; a window short of the bar says so.
 */
async function runPerWindowUniverse(ctx: {
  flags: Map<string, string>;
  num: (k: string, d: number) => number;
  days: number;
  windowsWanted: number;
  ingestOnly: boolean;
  gasSol: number;
  swapSlippagePct: number;
  swapGasSolPerLeg: number;
  policy: { maxTransferFeeBps: number };
}): Promise<void> {
  const n = ctx.num("pools", 16) + ctx.num("deadpools", 16);
  const ingest = readIngestFlags(ctx.flags);
  const tvlMode = readTvlFlags(ctx.flags);
  const solFullBars = (): Bar[] => {
    try {
      return (JSON.parse(readFileSync(resolve(process.cwd(), barFilePath(SOL_USDC_POOL)), "utf8")) as { bars: Bar[] }).bars;
    } catch {
      return [];
    }
  };
  const tvlDeps = tvlMode.basis === "onchain" ? heliusTvlDeps(env.SOLANA_RPC_URL, (l) => console.log(l)) : null;
  let tvlCalls = 0;
  /*
   * The account is the LIVE profile unless a flag says otherwise — the same resolver `main`
   * feeds, but fed the raw flags. The 14 Sep run passed a hardcoded $300 / 63% / 1 account
   * here, so its header read "NOT THE LIVE PROFILE" over every figure. Resolved up front
   * (at a placeholder price) so an incomplete profile throws BEFORE a multi-hour ingest, not
   * after it; the real resolution below sizes at the window-start SOL/USD.
   */
  const overrides = readProfileOverrides(ctx.flags);
  if (!ctx.ingestOnly) {
    resolveBacktestProfile({ overrides, windowStartSolUsd: 1, defaultGasSolPerTransaction: ctx.gasSol });
  }
  const endSec = readEndFlag(ctx.flags) ?? Math.floor(Date.now() / 1000);
  const specs = windowsEndingAt(endSec, ctx.days, ctx.windowsWanted);
  const oldestStart = specs[specs.length - 1]?.start ?? 0;
  /*
   * As deep as the OLDEST window, so the one per-pool bar file on disk serves every window
   * (the windows share most candidates, and each fetch pages through a 4-second rate limit).
   * Nothing is memoised in memory: the first version did, and was killed for low memory.
   */
  const oldestBars = Math.ceil(((Date.now() / 1000 - oldestStart) / 3600) * 1.05);

  const loaded: Array<{ label: string; spec: WindowSpec; dataset: WindowDataset; cache: CacheOutcome }> = [];
  for (const [i, spec] of specs.entries()) {
    const { dataset, cache, cachePath } = await loadWindowDataset({
      window: spec,
      n,
      candidatesCap: ingest.candidatesCap,
      survivorPages: ingest.survivorPages,
      cohortPages: ingest.cohortPages,
      // The newest window's candidates are today's survivors of every age: its k serves all windows.
      kOverride: i === 0 ? null : (loaded[0]?.dataset.selection.k ?? null),
      solUsdPool: SOL_USDC_POOL,
      refresh: ctx.flags.has("refresh"),
      barsWanted: oldestBars,
      barsFromSec: oldestStart,
      tvlBand: { minUsd: env.MIN_TVL_USD, maxUsd: env.MAX_TVL_USD },
      onchainTvl:
        tvlMode.basis === "onchain" && tvlDeps
          ? {
              cadenceSec: tvlMode.cadenceSec,
              async seriesFor(address, times) {
                let bars: Bar[] = [];
                try {
                  bars = (JSON.parse(readFileSync(resolve(process.cwd(), barFilePath(address)), "utf8")) as { bars: Bar[] }).bars;
                } catch {
                  return { points: [], refused: "no cached bars for pricing" };
                }
                const { file, fetched, failed } = await ensureTvlSeries({
                  address,
                  bars,
                  solUsdBars: solFullBars(),
                  times,
                  deps: tvlDeps,
                  concurrency: tvlMode.concurrency,
                });
                tvlCalls += fetched * 2;
                if (failed > 0) console.warn(`[tvl] ${address}: ${failed} sample(s) failed in transport — retried on the next run`);
                if (file.refused) return { points: [], refused: file.refused };
                return { points: seriesPoints(file, times[0] ?? 0, Number.MAX_SAFE_INTEGER), refused: null };
              },
            }
          : undefined,
      deps: {
        /*
         * Survivors inside the strategy's TVL band, exactly as the legacy ingest asks for.
         * Without it the survivor cohort is the volume leaderboard — SOL-USDC-scale pools —
         * and the first per-window run traded nothing in any window. Today's TVL is a fair
         * filter for SURVIVORS only (they are alive today); the dead cohort is unfiltered.
         */
        buildUniverse: (daysBack, pages) =>
          buildPointInTimeUniverse({
            windowDays: daysBack,
            survivorPages: pages.survivorPages,
            cohortPages: pages.cohortPages,
            survivorTvlBand: { minUsd: env.MIN_TVL_USD, maxUsd: env.MAX_TVL_USD },
          }),
        fetchBars: fetchHourlyBars,
        log: (line) => console.log(line),
        nowMs: () => Date.now(),
      },
    });
    const { rpcReads, failures } = await annotateTokenScreens(dataset.pools);
    writeFileSync(resolve(process.cwd(), cachePath), JSON.stringify(dataset), "utf8");
    console.log(
      `[integrity] W${i + 1} ${dataset.window.start}->${dataset.window.end}: cache ${cache} · ${dataset.pools.length}/${n} pools ` +
        `from ${dataset.selection.candidates} candidates · token reads ${rpcReads} (${failures} unreadable) · ${cachePath}`,
    );
    loaded.push({ label: `W${i + 1}`, spec, dataset, cache });
  }
  // The funnel BEFORE any analysis, so coverage is visible while an ingest is still the only thing that ran.
  const funnelLines = renderWindowFunnels(
    loaded.map((w) => ({ label: w.label, spec: w.spec, dataset: w.dataset, cache: w.cache })),
    { ingest, hasProKey: Boolean(process.env.COINGECKO_PRO_API_KEY), nowSec: Math.floor(Date.now() / 1000) },
  );
  console.log(funnelLines.join("\n"));
  if (tvlMode.basis === "onchain") {
    console.log(
      `[integrity] on-chain TVL: ${tvlCalls} RPC reads this run (~${tvlCalls * 10} Helius credits at 10 per getTransactionsForAddress); the rest came from .cache/tvl_series`,
    );
  }
  if (ctx.ingestOnly) {
    console.log("[integrity] --ingest-only: caches written, no analysis run");
    return;
  }

  const profile = resolveBacktestProfile({
    overrides,
    windowStartSolUsd: loaded[loaded.length - 1]?.dataset.solUsdBars[0]?.c ?? null,
    defaultGasSolPerTransaction: ctx.gasSol,
  });
  const baseConfig = liveV11Config(profile.options);
  const calibration = calibrateExitCostModel(LIVE_EXIT_OBSERVATIONS);
  const ladder = costLadder({
    swapSlippagePct: ctx.swapSlippagePct,
    swapGasSolPerLeg: ctx.swapGasSolPerLeg,
    forcedExitSlippagePct: baseConfig.forcedExitSlippagePct,
    fit: calibration.fit,
    envelope: calibration.envelope,
  }).filter((c) => c.key === "old" || c.key === "fit" || c.key === "envelope");

  type WindowCell = { window: string; cost: string; variant: string; eligible: ArmRun; full: ArmRun };
  const cells: WindowCell[] = [];
  const meta: Array<{
    label: string;
    window: WindowDataset["window"];
    cache: CacheOutcome;
    k: number | null;
    coverage: { withData: number; n: number };
    selection: WindowDataset["selection"];
    universe: number;
    eligiblePools: number;
  }> = [];

  for (const w of loaded) {
    const k = w.dataset.selection.k;
    // The same k the universe was selected with, so the gates cannot disagree with the selection.
    const onchain = w.dataset.selection.tvlBasis === "onchain";
    const tvlModel: TvlModel = onchain
      ? {
          medianK: 0,
          p25K: 0,
          p75K: 0,
          samples: Object.keys(w.dataset.tvlSeries ?? {}).length,
          perPoolK: {},
          series: w.dataset.tvlSeries ?? {},
          // A sample older than 1.5 cadences is unknown TVL, not the last known one.
          seriesMaxStaleSec: Math.round((w.dataset.selection.tvlCadenceSec ?? tvlMode.cadenceSec) * 1.5),
        }
      : { medianK: k ?? 0, p25K: k ?? 0, p75K: k ?? 0, samples: k === null ? 0 : 1, perPoolK: {} };
    const partition = await partitionLiveEligible(w.dataset.pools, ctx.policy);
    const eligible = new Set(partition.eligible.map((p) => p.address));
    meta.push({
      label: w.label,
      window: w.dataset.window,
      cache: w.cache,
      k,
      coverage: universeCoverage(w.dataset.pools, n, w.spec),
      selection: w.dataset.selection,
      universe: w.dataset.pools.length,
      eligiblePools: partition.eligible.length,
    });
    if ((!onchain && k === null) || w.dataset.pools.length === 0) continue;

    for (const cost of ladder) {
      const costConfig: BacktestConfig = {
        ...baseConfig,
        swapSlippagePct: cost.swapSlippagePct,
        swapGasSolPerLeg: cost.swapGasSolPerLeg,
        exitCostModel: cost.exitCostModel,
      };
      for (const v of VARIANTS) {
        if (v.key === "gatecost" && !cost.exitCostModel) continue;
        const config = v.apply(costConfig);
        const tag = `${w.label}-${cost.key}-${v.key}`;
        cells.push({
          window: w.label,
          cost: cost.key,
          variant: v.key,
          eligible: runArm(w.dataset.pools.filter((p) => eligible.has(p.address)), w.dataset.solUsdBars, tvlModel, config, `${tag}-eligible`),
          full: runArm(w.dataset.pools, w.dataset.solUsdBars, tvlModel, config, `${tag}-full`),
        });
      }
    }
  }

  const find = (w: string, c: string, v: string) => cells.find((x) => x.window === w && x.cost === c && x.variant === v);
  const out: string[] = [];
  const h = (t: string) => out.push("", "═".repeat(96), t, "═".repeat(96), "");

  h("BACKTEST INTEGRITY — UNIVERSE PER WINDOW (dipilih dari aktivitas di dalam window)");
  out.push(
    ...describeBacktestProfile(profile),
    `Universe        : top ${n} per window by in-window fees, from up to ${ingest.candidatesCap} candidates ` +
      `(pages survivor ${ingest.survivorPages} / dead cohort ${ingest.cohortPages}), ` +
      `modelled TVL band $${env.MIN_TVL_USD}-$${env.MAX_TVL_USD}`,
    `TVL             : ${tvlMode.basis === "onchain" ? `ON-CHAIN (reserve x harga, grid ${tvlMode.cadenceSec / 3600}h, sampel basi > ${(tvlMode.cadenceSec * 1.5) / 3600}h = TVL tidak diketahui = ditolak; tanpa fallback ke model k)` : "MODEL k x volume (tervalidasi buruk: docs/backtests/2026-09-14-tvl-model-validation.md)"}`,
    `Swap (baru)     : ${ctx.swapSlippagePct}%/kaki + ${ctx.swapGasSolPerLeg} SOL gas/kaki · exit model fit & envelope`,
    `Live-eligible   : ${meta.map((m) => `${m.label} ${m.eligiblePools}/${m.universe}`).join(" · ")}`,
    ...funnelLines,
  );

  for (const costKey of ["old", "fit", "envelope"]) {
    h(`PER WINDOW · ${costKey === "old" ? "akuntansi LAMA (swap gratis, exit flat paksa saja)" : `akuntansi baru, exit ${costKey}`} — TIDAK dirata-rata`);
    for (const w of loaded) {
      const rows: string[][] = [];
      for (const v of VARIANTS) {
        const c = find(w.label, costKey, v.key);
        const base = find(w.label, costKey, "base");
        if (!c || !base) continue;
        const e = figures(c.eligible);
        const f = figures(c.full);
        rows.push([
          v.label,
          String(e.trades),
          usd(e.netPnlUsd),
          v.key === "base" ? "—" : signed(e.netPnlUsd - figures(base.eligible).netPnlUsd),
          String(f.trades),
          usd(f.netPnlUsd),
          signed(f.netPnlUsd - e.netPnlUsd),
          describeHalf(c.eligible.split?.inPools ?? 0, c.eligible.inS),
          describeHalf(c.eligible.split?.outPools ?? 0, c.eligible.outS),
          c.eligible.inS?.payoff == null ? "—" : c.eligible.inS.payoff.toFixed(2),
          c.eligible.outS?.payoff == null ? "—" : c.eligible.outS.payoff.toFixed(2),
          c.eligible.inS ? signed(c.eligible.inS.expectancyUsd) : "—",
          c.eligible.outS ? signed(c.eligible.outS.expectancyUsd) : "—",
          c.eligible.oosStatus,
        ]);
      }
      const baseCell = find(w.label, costKey, "base");
      const s = baseCell?.eligible.split;
      out.push(
        `-- ${w.label} ${w.dataset.window.start} -> ${w.dataset.window.end} --` +
          (s ? ` split live-eligible: IS ${day(s.start)} -> ${day(s.mid)} · OOS ${day(s.mid)} -> ${day(s.end)}` : ""),
      );
      const thin = windowFunnel(w.dataset, w.spec);
      if (thin.binding) {
        out.push(
          `   TEMUAN (sampel, BUKAN hasil strategi): universe ${thin.coverage.withData}/${thin.coverage.n}; ` +
            `rem pengikat ${BRAKE_LABEL[thin.binding.brake]} = ${thin.binding.count}.`,
        );
      }
      out.push(
        rows.length === 0
          ? "(tidak ada pool atau k untuk window ini — belum bisa diverifikasi)"
          : renderTable(
              [
                { header: "Varian" },
                { header: "elig trd", align: "right" },
                { header: "elig net", align: "right" },
                { header: "Δ vs base", align: "right" },
                { header: "full trd", align: "right" },
                { header: "full net", align: "right" },
                { header: "selisih", align: "right" },
                { header: "IS (elig)", align: "right" },
                { header: "OOS (elig)", align: "right" },
                { header: "IS payoff", align: "right" },
                { header: "OOS payoff", align: "right" },
                { header: "IS exp", align: "right" },
                { header: "OOS exp", align: "right" },
                { header: "bar (elig)" },
              ],
              rows,
            ),
        "",
      );
    }
  }

  h("JAWABAN PER VARIAN, PER WINDOW — {YA / TIDAK / BELUM BISA DIVERIFIKASI}, tidak dirata-rata");
  const answers: Array<{
    cost: string;
    variant: string;
    per: Array<{ window: string; delta: number | null; status: string; answer: ReturnType<typeof windowAnswer> }>;
    answer: string;
  }> = [];
  for (const costKey of ["fit", "envelope"]) {
    for (const v of VARIANTS.filter((x) => x.key !== "base")) {
      const per = loaded.map((w) => {
        const c = find(w.label, costKey, v.key);
        const base = find(w.label, costKey, "base");
        const delta = c && base ? figures(c.eligible).netPnlUsd - figures(base.eligible).netPnlUsd : null;
        const status: ArmRun["oosStatus"] = c ? c.eligible.oosStatus : "belum bisa diverifikasi";
        return { window: w.label, delta, status, answer: windowAnswer(delta, status) };
      });
      // Across windows: YA only when YA in every window; any unverifiable window keeps it unverified.
      const answer = per.some((p) => p.answer === "BELUM BISA DIVERIFIKASI")
        ? "BELUM BISA DIVERIFIKASI"
        : per.every((p) => p.answer === "YA")
          ? "YA"
          : "TIDAK";
      answers.push({ cost: costKey, variant: v.key, per, answer });
      out.push(
        `${costKey.padEnd(8)} ${v.label.padEnd(32)} ` +
          per.map((p) => `${p.window} ${p.delta === null ? "—" : signed(p.delta)} → ${p.answer}`).join(" · ") +
          `  ||  semua window: ${answer}`,
      );
    }
  }
  const everyCell = answers.flatMap((a) => a.per);
  if (everyCell.length > 0 && everyCell.every((p) => p.answer === "BELUM BISA DIVERIFIKASI")) {
    out.push("", "** SEMUA varian di SEMUA window: BELUM BISA DIVERIFIKASI. Pertanyaan TP/gate belum terjawab oleh run ini. **");
  }
  out.push(
    "",
    "Bar = payoff > 1 DAN expectancy > 0 di kedua paruh window, minimal 8 trade per paruh.",
    "k = rasio TVL/volume HARI INI dipakai untuk window lama. Universe dipilih dengan fee di window (bukan hasil strategi).",
    "Kandidat dibatasi lifetime volume; pool mati yang lahir sebelum walk urut-pembuatan tidak terlihat.",
  );

  const report = out.join("\n");
  console.log(report);
  writeFileSync(resolve(process.cwd(), WINDOW_REPORT_PATH), report, "utf8");
  const strip = (a: ArmRun) => ({ pools: a.pools, summary: a.result?.summary ?? null, inSample: a.inS, outOfSample: a.outS, oosStatus: a.oosStatus, split: a.split });
  writeFileSync(
    resolve(process.cwd(), WINDOW_SUMMARY_PATH),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        n,
        candidatesCap: ingest.candidatesCap,
        ingest,
        tvl: tvlMode,
        profile,
        windows: meta.map((m) => ({ ...m, funnel: windowFunnel(loaded.find((w) => w.label === m.label)!.dataset, loaded.find((w) => w.label === m.label)!.spec) })),
        cells: cells.map((c) => ({ ...c, eligible: strip(c.eligible), full: strip(c.full) })),
        answers,
        report,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[integrity] wrote ${WINDOW_REPORT_PATH} and ${WINDOW_SUMMARY_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[integrity] failed:", err);
    process.exit(1);
  });
}
