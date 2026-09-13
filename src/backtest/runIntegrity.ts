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
  loadHistoricalData,
  type HistoricalDataset,
  type PoolHistory,
} from "./historicalData.js";
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
}

function runArm(pools: PoolHistory[], sol: PoolHistory["bars"], tvl: TvlModel, config: BacktestConfig, label: string): ArmRun {
  if (pools.length === 0) {
    return { pools: 0, result: null, inS: null, outS: null, oosStatus: "belum bisa diverifikasi" };
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

  return { pools: pools.length, result, inS, outS, oosStatus };
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

  const policy = { maxTransferFeeBps: env.LIVE_MAX_TOKEN_TRANSFER_FEE_BPS };
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[integrity] failed:", err);
    process.exit(1);
  });
}
