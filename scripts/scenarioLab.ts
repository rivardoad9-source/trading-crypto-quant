/**
 * Scenario lab: one cached dataset, many configurations.
 *
 *   node --import tsx scripts/scenarioLab.ts --cache=.cache/historical_data_micro.json
 *
 * WHY A SEPARATE RUNNER. `runMicroCapital` answers "what did the live formula do";
 * this answers "what would a DIFFERENT formula have done on the same bars". Ingest is
 * the expensive half (a shared GeckoTerminal rate limit), so the dataset is read from a
 * cache and never re-fetched: every scenario sees byte-identical bars, which is the only
 * way a difference between two rows can be attributed to the configuration.
 *
 * Scenario A is the LIVE V1.1 formula, built by `liveV11Config` from `src/config/env.ts`,
 * so the baseline cannot drift from the engine. Every other scenario is expressed as a
 * DIFF against A and prints that diff, so no row can silently change two things at once.
 *
 * Costs are the honest ones `backtest:integrity` uses (swap priced, every exit priced),
 * not the legacy accounting, and they are IDENTICAL across scenarios.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { env } from "../src/config/env.js";
import {
  runSimulation,
  type BacktestConfig,
  type BacktestResult,
  type ExitReason,
} from "../src/backtest/engine.js";
import type { Bar, HistoricalDataset, PoolHistory } from "../src/backtest/historicalData.js";
import { calibrateExitCostModel, LIVE_EXIT_OBSERVATIONS } from "../src/backtest/exitCost.js";
import { calibrateTvlModel, describeTvlModel, type TvlModel } from "../src/backtest/tvlModel.js";
import { liveV11Config } from "../src/backtest/runMicroCapital.js";
import { partitionLiveEligible } from "../src/backtest/liveEligibility.js";
import { renderTable } from "../src/backtest/report.js";
import type { DlmmPool } from "../src/services/meteora.js";

/* ------------------------------------------------------------------ */
/* Flags                                                               */
/* ------------------------------------------------------------------ */

const flags = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(arg);
  if (m) flags.set(m[1]!.toLowerCase(), m[2] ?? "true");
}
const numFlag = (k: string, d: number): number => {
  const raw = flags.get(k);
  if (raw === undefined) return d;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`--${k}=${raw} is not a number`);
  return v;
};

const CACHE = flags.get("cache") ?? ".cache/historical_data_micro.json";
const OUT = flags.get("out") ?? "scenario_lab.json";
const DAYS = numFlag("days", 90);
const CAPITAL = numFlag("capital", 300);
const SIZEPCT = numFlag("sizepct", 63);
const CONCURRENT = numFlag("concurrent", 1);
const GAS_SOL = numFlag("gas", 0.004);
const SWAP_SLIP = numFlag("swapslip", 0.25);
const SWAP_GAS = numFlag("swapgas", GAS_SOL);
const EXITCOST = (flags.get("exitcost") ?? "fit").toLowerCase();
/**
 * Absolute ceiling on one position's notional, in USD. Live's `LIVE_MAX_POSITION_SOL` is
 * an absolute cap an operator raises by hand, so without this every headline equity
 * assumes the operator scaled the position up in lockstep with the account. Defaults to
 * no cap, which is the compounding arm; pass the dollar value of the deployed cap for the
 * arm the live envelope can actually produce.
 */
const MAX_NOTIONAL = numFlag("maxnotional", Number.POSITIVE_INFINITY);
/** Restrict to pools a live entry could actually fund and screen. */
const ELIGIBLE_ONLY = !flags.has("full-universe");
const ONLY = flags.get("only");
/**
 * Ends the simulated window this many days BEFORE the cache's last bar, so one long
 * cache yields several non-overlapping windows. An in-sample winner that does not
 * survive a second window is a fit to noise, and there is no way to see that from
 * one window however many scenarios it runs.
 */
const END_OFFSET_DAYS = numFlag("endoffset", 0);
/**
 * `--sweep=field:v1,v2,v3` walks ONE config field, so the shape of a lever can be seen
 * instead of two points on it. Repeatable with `;` between fields, e.g.
 * `--sweep="minFeeCostCoverage:1,1.5,2,2.5;stopLossPct:-5,-8,-12"`.
 */
const SWEEP = flags.get("sweep");
const SWEEP_ONLY = flags.has("sweeponly");

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const usd = (n: number, d = 2): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`;
const pct = (n: number, d = 1): string => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(d)}%`;
const pf = (v: number | null): string => (v === null ? "—" : v.toFixed(2));

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

export interface Scenario {
  key: string;
  label: string;
  family: "baseline" | "entry" | "exit" | "range" | "risk" | "combo";
  /** What this row changes against scenario A. Printed verbatim. */
  diff: string;
  apply: (base: BacktestConfig) => BacktestConfig;
}

const INF = Number.POSITIVE_INFINITY;

export function scenarios(): Scenario[] {
  const s = (
    key: string,
    family: Scenario["family"],
    label: string,
    diff: string,
    patch: Partial<BacktestConfig>,
  ): Scenario => ({
    key,
    family,
    label,
    diff,
    apply: (base) => ({ ...base, ...patch }),
  });

  return [
    /* ---- A: the engine as it stands ---- */
    {
      key: "A",
      family: "baseline",
      label: "ENGINE SEKARANG (V1.1)",
      diff: "—",
      apply: (base) => base,
    },

    /* ---- Entry gates: does admitting more pools help? ---- */
    s("B1", "entry", "Coverage 2.5 -> 1.0", "minFeeCostCoverage 2.5 -> 1.0", {
      minFeeCostCoverage: 1.0,
    }),
    s("B2", "entry", "Coverage 2.5 -> 1.5", "minFeeCostCoverage 2.5 -> 1.5", {
      minFeeCostCoverage: 1.5,
    }),
    s("B3", "entry", "Fee/TVL floor 0.8% -> 0.4%", "minFeeTvlRatio 0.008 -> 0.004", {
      minFeeTvlRatio: 0.004,
    }),
    s("B4", "entry", "TVL band 50k-500k -> 30k-2M", "minTvlUsd 50k -> 30k, maxTvlUsd 500k -> 2M", {
      minTvlUsd: 30_000,
      maxTvlUsd: 2_000_000,
    }),
    s("B5", "entry", "Volatilitas longgar", "surge1h 10 -> 25, chg24h 150 -> 300", {
      maxPriceSurge1hPct: 25,
      maxPriceChange24hPct: 300,
    }),
    s("B6", "entry", "Umur pool 48h -> 12h", "minPoolAgeHours 48 -> 12", { minPoolAgeHours: 12 }),
    s("B7", "entry", "Volume floor 10k -> 3k", "minVolume24hUsd 10k -> 3k", { minVolume24hUsd: 3_000 }),
    s("B8", "entry", "SEMUA gate entry longgar", "B1+B3+B4+B5+B6+B7 sekaligus", {
      minFeeCostCoverage: 1.0,
      minFeeTvlRatio: 0.004,
      minTvlUsd: 30_000,
      maxTvlUsd: 2_000_000,
      maxPriceSurge1hPct: 25,
      maxPriceChange24hPct: 300,
      minPoolAgeHours: 12,
      minVolume24hUsd: 3_000,
    }),
    s("B9", "entry", "Gate entry KETAT", "coverage 4.0, fee/TVL 1.5%, chg24h 80", {
      minFeeCostCoverage: 4.0,
      minFeeTvlRatio: 0.015,
      maxPriceChange24hPct: 80,
    }),

    /* ---- Exits ---- */
    s("C1", "exit", "TP 8% / SL -8%", "takeProfitNetPct 5 -> 8", { takeProfitNetPct: 8 }),
    s("C2", "exit", "TP 8% / SL -5%", "TP 5 -> 8, SL -8 -> -5", { takeProfitNetPct: 8, stopLossPct: -5 }),
    s("C3", "exit", "TP 15% / SL -8%", "TP 5 -> 15", { takeProfitNetPct: 15 }),
    s("C4", "exit", "TP mati / SL -8%", "takeProfitNetPct 5 -> off", { takeProfitNetPct: INF }),
    s("C5", "exit", "TP 5% / SL -5%", "SL -8 -> -5", { stopLossPct: -5 }),
    s("C6", "exit", "TP 5% / SL -12%", "SL -8 -> -12", { stopLossPct: -12 }),
    s("C7", "exit", "Hold 24h -> 72h", "maxDurationHours 24 -> 72", { maxDurationHours: 72 }),
    s("C8", "exit", "Hold 24h -> 8h", "maxDurationHours 24 -> 8", { maxDurationHours: 8 }),
    s("C9", "exit", "Ratchet: arm +4%, stop +1.5%", "ratchetArmNetPct off -> 4, stop 1.5", {
      ratchetArmNetPct: 4,
      ratchetStopNetPct: 1.5,
    }),
    s("C10", "exit", "Ratchet + TP 10%", "ratchet arm 4 / stop 1.5, TP 5 -> 10", {
      ratchetArmNetPct: 4,
      ratchetStopNetPct: 1.5,
      takeProfitNetPct: 10,
    }),

    /* ---- Range width ---- */
    s("D1", "range", "Range -25%/+15%", "downsideCoverPct 45 -> 25", { downsideCoverPct: 25 }),
    s("D2", "range", "Range -25%/+25%", "45/15 -> 25/25", { downsideCoverPct: 25, upsideCoverPct: 25 }),
    s("D3", "range", "Range -60%/+20%", "45/15 -> 60/20", { downsideCoverPct: 60, upsideCoverPct: 20 }),

    /* ---- Risk / anti-churn ---- */
    s("E1", "risk", "Anti-churn MATI", "cooldown 4h -> 0, lockout off", {
      poolCooldownHours: 0,
      lockoutConsecutiveFailures: 0,
      lockoutHours: 0,
    }),
    s("E2", "risk", "Anti-churn lebih keras", "cooldown 4 -> 12h, lockout 24 -> 48h", {
      poolCooldownHours: 12,
      lockoutHours: 48,
    }),
    s("E3", "risk", "Size 63% -> 35% (1 posisi)", "positionSizePct 63 -> 35", { positionSizePct: 35 }),
    s("E4", "risk", "Size 33% x 3 posisi", "positionSizePct 63 -> 33, concurrent 1 -> 3", {
      positionSizePct: 33,
      maxConcurrentPositions: 3,
    }),
    s("E5", "risk", "Size 100% (1 posisi)", "positionSizePct 63 -> 100", { positionSizePct: 100 }),
  ];
}

/** Combos: the levers that helped, applied together. */
export function comboScenarios(): Scenario[] {
  const LOOSE_ENTRY: Partial<BacktestConfig> = {
    minFeeCostCoverage: 1.0,
    minFeeTvlRatio: 0.004,
    minTvlUsd: 30_000,
    maxTvlUsd: 2_000_000,
    maxPriceSurge1hPct: 25,
    maxPriceChange24hPct: 300,
    minPoolAgeHours: 12,
    minVolume24hUsd: 3_000,
  };
  const RATCHET: Partial<BacktestConfig> = { ratchetArmNetPct: 4, ratchetStopNetPct: 1.5 };

  const s = (key: string, label: string, diff: string, patch: Partial<BacktestConfig>): Scenario => ({
    key,
    family: "combo",
    label,
    diff,
    apply: (base) => ({ ...base, ...patch }),
  });

  /*
   * The levers that beat A under BOTH the pessimistic and the optimistic cost
   * assumption, measured 16 Sep 2026 on the integrity dataset. Coverage is deliberately
   * NOT among them: loosening it won by $140 at optimistic costs and lost by $179 at
   * pessimistic ones, which is a lever that flips sign on an assumption, not an edge.
   */
  const ROBUST: Partial<BacktestConfig> = {
    stopLossPct: -12,
    minTvlUsd: 30_000,
    maxTvlUsd: 2_000_000,
    minPoolAgeHours: 12,
  };

  return [
    s("F1", "Entry longgar + ratchet", "B8 + C9", { ...LOOSE_ENTRY, ...RATCHET }),
    s("F2", "Entry longgar + ratchet + 33%x3", "B8 + C9 + E4", {
      ...LOOSE_ENTRY,
      ...RATCHET,
      positionSizePct: 33,
      maxConcurrentPositions: 3,
    }),
    s("F3", "Coverage 1.0 + range 25/15 + ratchet", "B1 + D1 + C9", {
      minFeeCostCoverage: 1.0,
      downsideCoverPct: 25,
      ...RATCHET,
    }),
    s("F4", "Entry longgar + hold 72h + ratchet", "B8 + C7 + C9", {
      ...LOOSE_ENTRY,
      ...RATCHET,
      maxDurationHours: 72,
    }),

    /* ---- G: the cost-robust levers, and what they cost apart ---- */
    s("G1", "TVL floor 50k -> 30k saja", "minTvlUsd 50k -> 30k (B4 setengah)", { minTvlUsd: 30_000 }),
    s("G2", "TVL ceiling 500k -> 2M saja", "maxTvlUsd 500k -> 2M (B4 setengah)", {
      maxTvlUsd: 2_000_000,
    }),
    s("G3", "ROBUST: SL -12 + TVL 30k-2M + umur 12h", "C6 + B4 + B6", { ...ROBUST }),
    s("G4", "ROBUST + TP 4%", "G3 + takeProfitNetPct 5 -> 4", { ...ROBUST, takeProfitNetPct: 4 }),
    s("G5", "ROBUST + anti-churn mati", "G3 + E1", {
      ...ROBUST,
      poolCooldownHours: 0,
      lockoutConsecutiveFailures: 0,
      lockoutHours: 0,
    }),
    s("G6", "ROBUST @ size 35% (endurance)", "G3 + positionSizePct 63 -> 35", {
      ...ROBUST,
      positionSizePct: 35,
    }),
    s("G7", "ROBUST @ size 35% + TP 4%", "G4 + positionSizePct 63 -> 35", {
      ...ROBUST,
      takeProfitNetPct: 4,
      positionSizePct: 35,
    }),

    /*
     * H: loosen the gate by making it HONEST rather than by lowering the bar.
     *
     * The V1.1 gate prices every exit at the flat FORCED_EXIT_SLIPPAGE_PCT (2%), which on
     * a $189 notional is $3.78 of a $7.22 modelled round trip — over half the cost the
     * 2.5x coverage multiplies. `exitCost.ts` prices the same exit from the pool's bin
     * step and the position's share of TVL, so on a liquid pool it is far below 2% and on
     * a thin one above it. Turning it on in the GATE admits the pools that were refused
     * by a cost they would not have paid, and refuses the ones the flat number was
     * under-charging. `gateUsesExitCostModel` is the switch the engine already has for
     * this, deliberately separate from the accounting model.
     */
    s("H1", "Gate pakai exit-cost model", "gateUsesExitCostModel false -> true", {
      gateUsesExitCostModel: true,
    }),
    s("H2", "Gate honest + SL -12", "H1 + C6", { gateUsesExitCostModel: true, stopLossPct: -12 }),
    s("H3", "Gate honest + ROBUST", "H1 + G3", { gateUsesExitCostModel: true, ...ROBUST }),
    s("H4", "Gate honest + ROBUST @ 35%", "H3 + size 35%", {
      gateUsesExitCostModel: true,
      ...ROBUST,
      positionSizePct: 35,
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

const EXIT_ORDER: ExitReason[] = [
  "STOP_LOSS",
  "RATCHET_STOP",
  "OUT_OF_RANGE",
  "TAKE_PROFIT",
  "TIMEOUT",
  "RUGGED",
  "FEE_TAKE_PROFIT",
  "END_OF_DATA",
];

function readCache(path: string): HistoricalDataset {
  const raw = JSON.parse(readFileSync(path, "utf8")) as HistoricalDataset;
  if (!Array.isArray(raw.pools) || raw.pools.length === 0) {
    throw new Error(`[lab] ${path} holds no pools`);
  }
  return raw;
}

/**
 * Keeps a `days`-long slice ending `endOffsetDays` before the cache's last bar, so a
 * 182-day cache serves two non-overlapping 90-day windows.
 */
function trimDataset(ds: HistoricalDataset, days: number, endOffsetDays = 0): HistoricalDataset {
  const lastT = Math.max(...ds.solUsdBars.map((b) => b.t));
  const end = lastT - endOffsetDays * 24 * 3600;
  const start = end - days * 24 * 3600;
  const keep = (bars: Bar[]): Bar[] => bars.filter((b) => b.t >= start && b.t <= end);
  return {
    ...ds,
    solUsdBars: keep(ds.solUsdBars),
    pools: ds.pools.map((p) => ({ ...p, bars: keep(p.bars) })).filter((p) => p.bars.length > 24),
  };
}

/** Builds one scenario per value of one config field, from `--sweep`. */
function sweepScenarios(spec: string | undefined): Scenario[] {
  if (!spec) return [];
  const out: Scenario[] = [];
  for (const group of spec.split(";").filter(Boolean)) {
    const [field, list] = group.split(":");
    if (!field || !list) throw new Error(`--sweep entry "${group}" is not field:v1,v2,...`);
    const key = field.trim() as keyof BacktestConfig;
    for (const rawValue of list.split(",").filter(Boolean)) {
      const value = rawValue.trim() === "off" ? INF : Number(rawValue);
      if (!Number.isFinite(value) && value !== INF) {
        throw new Error(`--sweep ${field}: "${rawValue}" is not a number (or "off")`);
      }
      out.push({
        key: `S:${field}=${rawValue}`,
        family: "combo",
        label: `${field} = ${rawValue}`,
        diff: `${field} -> ${rawValue}`,
        apply: (base) => ({ ...base, [key]: value }) as BacktestConfig,
      });
    }
  }
  return out;
}

function summaryRow(sc: Scenario, r: BacktestResult, baseline: BacktestResult | null): string[] {
  const s = r.summary;
  const delta = baseline ? s.endingEquityUsd - baseline.summary.endingEquityUsd : 0;
  return [
    sc.key,
    sc.label,
    String(s.totalTrades),
    pct(s.winRatePct),
    pf(s.profitFactor),
    usd(s.endingEquityUsd),
    pct(s.returnPct),
    pct(s.maxDrawdownPct),
    baseline && sc.key !== "A" ? usd(delta) : "—",
  ];
}

async function main(): Promise<void> {
  const rawDs = readCache(CACHE);
  const ds = trimDataset(rawDs, DAYS, END_OFFSET_DAYS);

  const first = ds.solUsdBars[0]!;
  const last = ds.solUsdBars[ds.solUsdBars.length - 1]!;
  const iso = (t: number): string => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

  console.log("\n================ SCENARIO LAB ================");
  console.log(`dataset   : ${CACHE} (ingested ${rawDs.fetchedAt})`);
  console.log(`window    : ${iso(first.t)} -> ${iso(last.t)} UTC (${DAYS}d)`);
  console.log(`account   : $${CAPITAL} / ${SIZEPCT}% per posisi / ${CONCURRENT} posisi / ${GAS_SOL} SOL per tx`);
  console.log(`biaya     : swap ${SWAP_SLIP}% per kaki + ${SWAP_GAS} SOL per kaki, exit model "${EXITCOST}"`);
  console.log(
    `cap posisi: ${
      Number.isFinite(MAX_NOTIONAL)
        ? `$${MAX_NOTIONAL} absolut (posisi TIDAK ikut membesar saat modal naik)`
        : "tidak ada - posisi ikut membesar bersama equity (compounding penuh)"
    }`,
  );

  /*
   * The live-eligible arm. Live cannot fund a pool with no wSOL leg and refuses a paired
   * mint whose transfer fee the screen rejects, so a scenario table built on the full
   * universe would compare formulas on pools none of them could enter.
   */
  let pools: PoolHistory[] = ds.pools;
  if (ELIGIBLE_ONLY) {
    const part = await partitionLiveEligible(ds.pools, {
      maxTransferFeeBps: env.LIVE_MAX_TOKEN_TRANSFER_FEE_BPS,
    });
    if (part.eligible.length === 0) {
      console.log(
        `universe  : FULL (${ds.pools.length} pool) - tidak ada pool live-eligible ` +
          `(noWsol ${part.counts.noWsol}, belum di-annotate ${part.counts.unannotated}, ` +
          `token screen ${part.counts.tokenScreen}); arm live-eligible TIDAK bisa dihitung di cache ini`,
      );
    } else {
      console.log(
        `universe  : LIVE-ELIGIBLE ${part.eligible.length}/${ds.pools.length} pool ` +
          `(ditolak: noWsol ${part.counts.noWsol}, unannotated ${part.counts.unannotated}, ` +
          `token screen ${part.counts.tokenScreen})`,
      );
      pools = part.eligible;
    }
  } else {
    console.log(`universe  : FULL (${ds.pools.length} pool)`);
  }

  const survivors = pools.filter((p) => p.cohort === "survivor");
  const dead = pools.filter((p) => p.cohort === "dead-or-dormant");
  console.log(`cohort    : ${survivors.length} survivor / ${dead.length} dead-or-dormant`);

  /*
   * The TVL model is calibrated on the SURVIVOR cross-section of the WHOLE dataset, not
   * of the filtered arm: the fit is a property of the market, and narrowing its sample to
   * the eligible pools would make two arms disagree about the same pool's TVL.
   */
  const calibrationSet: DlmmPool[] = ds.pools
    .filter((p) => p.cohort === "survivor")
    .map(
      (p) =>
        ({
          address: p.address,
          tvlUsd: p.tvlTodayUsd,
          volume24hUsd: p.bars.slice(-24).reduce((s, b) => s + b.v, 0),
        }) as DlmmPool,
    );
  const tvlModel: TvlModel = calibrateTvlModel(calibrationSet);
  if (tvlModel.samples === 0) throw new Error("[lab] TVL model could not be calibrated");
  console.log(`tvl       : ${describeTvlModel(tvlModel)}`);

  const calibration = calibrateExitCostModel(LIVE_EXIT_OBSERVATIONS);
  const exitCostModel =
    EXITCOST === "legacy"
      ? null
      : EXITCOST === "envelope"
        ? calibration.envelope
        : EXITCOST === "fit"
          ? calibration.fit
          : (() => {
              throw new Error("--exitcost must be legacy|fit|envelope");
            })();

  const base: BacktestConfig = {
    ...liveV11Config({
      capitalUsd: CAPITAL,
      positionSizePct: SIZEPCT,
      maxConcurrentPositions: CONCURRENT,
      gasSolPerTransaction: GAS_SOL,
    }),
    swapSlippagePct: SWAP_SLIP,
    swapGasSolPerLeg: SWAP_GAS,
    exitCostModel,
    maxPositionNotionalUsd: MAX_NOTIONAL,
  };

  const standard = SWEEP_ONLY
    ? scenarios().filter((sc) => sc.key === "A")
    : [...scenarios(), ...comboScenarios()];
  const all = [...standard, ...sweepScenarios(SWEEP)].filter(
    (sc) => !ONLY || ONLY.split(",").includes(sc.key),
  );

  console.log(`\nmenjalankan ${all.length} skenario...\n`);

  const results: Array<{ scenario: Scenario; result: BacktestResult }> = [];
  for (const sc of all) {
    const cfg = sc.apply(base);
    const result = runSimulation({
      label: sc.key,
      pools,
      solUsdBars: ds.solUsdBars,
      tvlModel,
      config: cfg,
    });
    results.push({ scenario: sc, result });
    process.stdout.write(
      `  ${sc.key.padEnd(4)} ${sc.label.padEnd(36)} ${String(result.summary.totalTrades).padStart(4)} trade  ` +
        `${usd(result.summary.endingEquityUsd).padStart(10)}\n`,
    );
  }

  const baseline = results.find((r) => r.scenario.key === "A")?.result ?? null;

  const byFamily = new Map<string, typeof results>();
  for (const r of results) {
    const list = byFamily.get(r.scenario.family) ?? [];
    list.push(r);
    byFamily.set(r.scenario.family, list);
  }

  const header = [
    { header: "#" },
    { header: "Skenario" },
    { header: "Trade", align: "right" as const },
    { header: "Win", align: "right" as const },
    { header: "PF", align: "right" as const },
    { header: "Modal akhir", align: "right" as const },
    { header: "Return", align: "right" as const },
    { header: "Max DD", align: "right" as const },
    { header: "vs A", align: "right" as const },
  ];

  const FAMILY_TITLE: Record<string, string> = {
    baseline: "A - ENGINE SEKARANG",
    entry: "B - GATE ENTRY",
    exit: "C - ATURAN EXIT",
    range: "D - LEBAR RANGE",
    risk: "E - SIZING & ANTI-CHURN",
    combo: "F - KOMBINASI",
  };

  for (const [family, list] of byFamily) {
    console.log(`\n### ${FAMILY_TITLE[family] ?? family}`);
    console.log(
      renderTable(
        header,
        list.map(({ scenario, result }) => summaryRow(scenario, result, baseline)),
      ),
    );
  }

  /* Ranked, so the conclusion is not eyeballed off the family tables. */
  const ranked = [...results].sort(
    (a, b) => b.result.summary.endingEquityUsd - a.result.summary.endingEquityUsd,
  );
  console.log("\n### PERINGKAT (modal akhir)");
  console.log(
    renderTable(
      header,
      ranked.map(({ scenario, result }) => summaryRow(scenario, result, baseline)),
    ),
  );

  /* Exit mix of the baseline and of the best rows: WHY a formula differs. */
  const exitMix = (r: BacktestResult): string =>
    EXIT_ORDER.filter((e) => r.summary.exitReasonCounts[e] > 0)
      .map((e) => `${e} ${r.summary.exitReasonCounts[e]}`)
      .join(", ") || "(tidak ada trade)";
  console.log("\n### DISTRIBUSI EXIT (5 teratas + A)");
  for (const { scenario, result } of ranked.slice(0, 5)) {
    console.log(`  ${scenario.key.padEnd(4)} ${exitMix(result)}`);
  }
  if (baseline) console.log(`  A    ${exitMix(baseline)}`);

  /*
   * Cohort composition of the trades. A run whose trades all land in ONE cohort is a
   * selection artefact that reads exactly like a strategy result — the survivor-sampling
   * bug `runMicroCapital` prints this same warning for. A scenario that beats the
   * baseline only by trading dead pools has not found an edge, it has found the dead
   * cohort, so this is printed for every row rather than only for the winner.
   */
  console.log("\n### KOMPOSISI COHORT PER SKENARIO (survivor / dead-or-dormant)");
  for (const { scenario, result } of ranked) {
    const dead = result.summary.tradesOnDeadPools;
    const total = result.summary.totalTrades;
    const surv = total - dead;
    const flag =
      total >= 8 && (dead === 0 || surv === 0)
        ? "  <-- SEMUA dari satu cohort: artefak seleksi, bukan hasil strategi"
        : "";
    console.log(
      `  ${scenario.key.padEnd(4)} ${String(surv).padStart(4)} / ${String(dead).padStart(4)}` +
        `  (dead ${total > 0 ? pct((dead / total) * 100) : "—"})${flag}`,
    );
  }

  if (baseline) {
    const entries = Object.entries(baseline.gateRejections).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    console.log("\n### GATE YANG PALING BANYAK MENOLAK (skenario A)");
    for (const [gate, n] of entries.slice(0, 8)) {
      console.log(`  ${gate.padEnd(18)} ${String(n).padStart(8)}  ${pct((n / total) * 100)}`);
    }
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataset: { path: CACHE, fetchedAt: rawDs.fetchedAt, windowDays: DAYS },
        window: { start: iso(first.t), end: iso(last.t) },
        universe: { pools: pools.length, survivors: survivors.length, dead: dead.length },
        account: { capitalUsd: CAPITAL, positionSizePct: SIZEPCT, maxConcurrentPositions: CONCURRENT },
        costs: {
          gasSolPerTransaction: GAS_SOL,
          swapSlippagePct: SWAP_SLIP,
          swapGasSolPerLeg: SWAP_GAS,
          exitCost: EXITCOST,
        },
        scenarios: results.map(({ scenario, result }) => ({
          key: scenario.key,
          label: scenario.label,
          family: scenario.family,
          diff: scenario.diff,
          summary: result.summary,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n[lab] JSON -> ${OUT}\n`);
}

void main();
