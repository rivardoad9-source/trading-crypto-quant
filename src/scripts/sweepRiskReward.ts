/**
 * Risk-to-reward sweep of the LIVE V1.1 exit rules, on the micro-capital dataset.
 *
 *   npm run sweep:rr                    # every variant, comparison table
 *   npm run sweep:rr -- --variant=v1    # one variant, JSON to --out
 *
 * Answers one question: does WIDENING the reward target earn more than it costs, once
 * the positions that would have banked +5% instead keep running and die out-of-range?
 *
 * Everything except the exit ladder is pinned to `liveV11Config`, which reads
 * `src/config/env.ts` directly, so the arms cannot differ on anything else. The
 * dataset, window, capital and gas are identical across arms by construction: the
 * cache is loaded once per process and shared by every run in it.
 *
 * The in/out-of-sample split is not decoration. `sweep:exits` already found that the
 * payoff ratio can be "fixed" in one half of this window and reversed in the other, so
 * a variant that only wins on the full window is a fit to noise. Same bar, same
 * `survivedOutOfSample` helper, so the two sweeps cannot diverge on what survived.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { env } from "../config/env.js";
import {
  runSimulation,
  type BacktestConfig,
  type BacktestResult,
  type ExitReason,
} from "../backtest/engine.js";
import { loadHistoricalData } from "../backtest/historicalData.js";
import { calibrateTvlModel, describeTvlModel, type TvlModel } from "../backtest/tvlModel.js";
import { liveV11Config, type MicroCapitalOptions } from "../backtest/runMicroCapital.js";
import {
  describeBacktestProfile,
  readProfileOverrides,
  resolveBacktestProfile,
  type ProfileOverrides,
} from "../backtest/liveProfile.js";
import { renderTable } from "../backtest/report.js";
import { splitWindow, scoreConfig, survivedOutOfSample } from "../backtest/sweepHarness.js";
import type { DlmmPool } from "../services/meteora.js";

/* The SAME cache the merged $100 V1.1 run used. Do not point this elsewhere. */
const CACHE_PATH = ".cache/historical_data_micro.json";

const usd = (n: number, d = 2): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`;
const pct = (n: number, d = 1): string => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(d)}%`;
const num = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : "inf");
const pf = (v: number | null): string => (v === null ? "undefined" : num(v));

/* ------------------------------------------------------------------ */
/* The arms                                                            */
/* ------------------------------------------------------------------ */

interface Variant {
  key: string;
  label: string;
  /** Human-readable risk:reward, for the report only. */
  rr: string;
  apply: (base: BacktestConfig) => BacktestConfig;
}

/*
 * Baseline is the merged run verbatim: TAKE_PROFIT_PCT=+5 net, STOP_LOSS_PCT=-8 net.
 * The brief described the baseline take-profit as "+10%"; the live env value is +5,
 * and the merged headline (20 trades / 80% / PF 3.10 / +$27.35) reproduces at +5.
 * Everything below is measured against what the engine actually ran.
 */
const VARIANTS: Variant[] = [
  {
    key: "baseline",
    label: "Baseline V1.1",
    rr: "1:0.63",
    apply: (c) => c,
  },
  {
    key: "v1",
    label: "V1 Tighter risk",
    rr: "1:3.00",
    apply: (c) => ({ ...c, stopLossPct: -6, takeProfitNetPct: 18 }),
  },
  {
    key: "v2",
    label: "V2 Wider reward",
    rr: "1:2.75",
    apply: (c) => ({ ...c, stopLossPct: -8, takeProfitNetPct: 22 }),
  },
  {
    key: "v3",
    label: "V3 Ratchet",
    rr: "1:2.50",
    apply: (c) => ({
      ...c,
      stopLossPct: -8,
      takeProfitNetPct: 20,
      ratchetArmNetPct: 7,
      ratchetStopNetPct: 1,
    }),
  },
];

/**
 * Cross-product of explicit grids, for scanning the SHAPE of the curve rather than the
 * four named points. Baseline is always prepended as the reference arm, so a grid run
 * still says what it is being compared against.
 *
 * `--slgrid=-6,-8 --tpgrid=5,10,15,20` gives the take-profit ladder at both stops;
 * `--sl=-8 --tp=20 --armgrid=3,5,7 --floorgrid=0,1,2` gives the ratchet grid.
 */
function gridVariants(flags: Map<string, string>): Variant[] | null {
  const list = (key: string): number[] | null => {
    const raw = flags.get(key);
    if (raw === undefined) return null;
    const parsed = raw
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x));
    return parsed.length > 0 ? parsed : null;
  };
  const one = (key: string, fallback: number): number => {
    const raw = flags.get(key);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const sls = list("slgrid") ?? [one("sl", -8)];
  const tps = list("tpgrid") ?? [one("tp", 5)];
  const arms = list("armgrid") ?? [Number.POSITIVE_INFINITY];
  const floors = list("floorgrid") ?? [one("floor", 1)];

  const anyGrid = ["slgrid", "tpgrid", "armgrid", "floorgrid"].some((k) => flags.has(k));
  if (!anyGrid) return null;

  const out: Variant[] = [VARIANTS[0]!];
  for (const sl of sls) {
    for (const tp of tps) {
      for (const arm of arms) {
        for (const floor of floors) {
          const armed = Number.isFinite(arm);
          out.push({
            key: `sl${sl}-tp${tp}${armed ? `-a${arm}f${floor}` : ""}`,
            label: `SL${sl} TP+${tp}${armed ? ` R${arm}/+${floor}` : ""}`,
            rr: sl < 0 ? `1:${(tp / Math.abs(sl)).toFixed(2)}` : "n/a",
            apply: (c) => ({
              ...c,
              stopLossPct: sl,
              takeProfitNetPct: tp,
              ratchetArmNetPct: arm,
              ratchetStopNetPct: floor,
            }),
          });
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

export interface VariantMetrics {
  key: string;
  label: string;
  rr: string;
  stopLossPct: number;
  takeProfitNetPct: number;
  ratchetArmNetPct: number;
  ratchetStopNetPct: number;
  trades: number;
  winRatePct: number;
  profitFactor: number | null;
  netPnlUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  /** netPnl / maxDrawdown in dollars. Null when the run never drew down. */
  returnToDrawdown: number | null;
  avgHoldHours: number;
  medianHoldHours: number;
  /** Sum of every position's holding time — total on-chain exposure. */
  totalHoursInMarket: number;
  exits: Record<ExitReason, number>;
  avgWinUsd: number;
  avgLossUsd: number;
  /** avgWin / |avgLoss|. Null when nothing lost. */
  payoff: number | null;
  expectancyUsd: number;
  totalFeesUsd: number;
  totalPositionValueChangeUsd: number;
  gasUsd: number;
  slippageUsd: number;
  frictionUsd: number;
  frictionPerTradeUsd: number;
  /** Friction as a multiple of the gross fees earned. */
  frictionVsFees: number | null;
}

function measure(v: Variant, config: BacktestConfig, result: BacktestResult): VariantMetrics {
  const s = result.summary;
  const wins = result.trades.filter((t) => t.netPnlUsd > 0).map((t) => t.netPnlUsd);
  const losses = result.trades.filter((t) => t.netPnlUsd <= 0).map((t) => t.netPnlUsd);
  const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const avgWinUsd = mean(wins);
  const avgLossUsd = mean(losses);

  const holds = result.trades.map((t) => t.durationHours).sort((a, b) => a - b);
  const median = holds.length ? (holds[Math.floor(holds.length / 2)] ?? 0) : 0;
  const friction = s.totalGasCostUsd + s.totalSlippageCostUsd;

  return {
    key: v.key,
    label: v.label,
    rr: v.rr,
    stopLossPct: config.stopLossPct,
    takeProfitNetPct: config.takeProfitNetPct,
    ratchetArmNetPct: config.ratchetArmNetPct,
    ratchetStopNetPct: config.ratchetStopNetPct,
    trades: s.totalTrades,
    winRatePct: s.winRatePct,
    profitFactor: s.profitFactor,
    netPnlUsd: s.netPnlUsd,
    returnPct: s.returnPct,
    maxDrawdownPct: s.maxDrawdownPct,
    maxDrawdownUsd: s.maxDrawdownUsd,
    /* Null, not Infinity: "never drew down" is not a ratio. */
    returnToDrawdown: s.maxDrawdownUsd > 0 ? s.netPnlUsd / s.maxDrawdownUsd : null,
    avgHoldHours: s.avgTradeDurationHours,
    medianHoldHours: median,
    totalHoursInMarket: result.trades.reduce((sum, t) => sum + t.durationHours, 0),
    exits: s.exitReasonCounts,
    avgWinUsd,
    avgLossUsd,
    payoff: avgLossUsd < 0 ? avgWinUsd / Math.abs(avgLossUsd) : null,
    expectancyUsd: s.totalTrades > 0 ? s.netPnlUsd / s.totalTrades : 0,
    totalFeesUsd: s.totalFeesUsd,
    totalPositionValueChangeUsd: s.totalPositionValueChangeUsd,
    gasUsd: s.totalGasCostUsd,
    slippageUsd: s.totalSlippageCostUsd,
    frictionUsd: friction,
    frictionPerTradeUsd: s.totalTrades > 0 ? friction / s.totalTrades : 0,
    frictionVsFees: s.totalFeesUsd > 0 ? friction / s.totalFeesUsd : null,
  };
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

function parseArgs(argv: string[]): {
  days: number;
  pools: number;
  deadPools: number;
  refresh: boolean;
  variant: string;
  out: string | null;
  flags: Map<string, string>;
  overrides: ProfileOverrides;
} {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([a-z]+)(?:=(.*))?$/i.exec(arg);
    if (m) flags.set(m[1]!.toLowerCase(), m[2] ?? "true");
  }
  const n = (key: string, fallback: number): number => {
    const raw = flags.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    days: n("days", 91),
    pools: n("pools", 10),
    deadPools: n("deadpools", 12),
    refresh: flags.has("refresh"),
    variant: flags.get("variant") ?? "all",
    out: flags.get("out") ?? null,
    flags,
    // The account comes from the live profile unless a flag overrides it; see liveProfile.ts.
    overrides: readProfileOverrides(flags),
  };
}

/* The merged 3-month run's friction assumption. */
const DEFAULT_GAS_SOL_PER_TX = 0.0005;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const grid = gridVariants(args.flags);
  const catalogue = grid ?? VARIANTS;
  const selected =
    args.variant === "all" ? catalogue : catalogue.filter((v) => v.key === args.variant);
  if (selected.length === 0) {
    throw new Error(
      `[rr] unknown --variant=${args.variant}; expected "all" or one of ` +
        catalogue.map((v) => v.key).join(", "),
    );
  }

  const dataset = await loadHistoricalData({
    poolCount: args.pools,
    deadPoolCount: args.deadPools,
    windowDays: args.days,
    cachePath: CACHE_PATH,
    force: args.refresh,
    survivorTvlBand: { minUsd: env.MIN_TVL_USD, maxUsd: env.MAX_TVL_USD },
  });

  const profile = resolveBacktestProfile({
    overrides: args.overrides,
    windowStartSolUsd: dataset.solUsdBars[0]?.c ?? null,
    defaultGasSolPerTransaction: DEFAULT_GAS_SOL_PER_TX,
  });
  const options: MicroCapitalOptions = profile.options;
  const base = liveV11Config(options);

  const survivors = dataset.pools.filter((p) => p.cohort === "survivor");
  const calibrationSet: DlmmPool[] = survivors.map(
    (p) =>
      ({
        address: p.address,
        tvlUsd: p.tvlTodayUsd,
        volume24hUsd: p.bars.slice(-24).reduce((s, b) => s + b.v, 0),
      }) as DlmmPool,
  );
  const tvlModel: TvlModel = calibrateTvlModel(calibrationSet);
  if (tvlModel.samples === 0) {
    throw new Error("[rr] TVL model could not be calibrated: no usable survivor pools");
  }

  const split = splitWindow(dataset.pools, dataset.solUsdBars);

  const rows = selected.map((v) => {
    const config = v.apply(base);
    const result = runSimulation({
      label: v.key,
      pools: dataset.pools,
      solUsdBars: dataset.solUsdBars,
      tvlModel,
      config,
    });
    const inS = scoreConfig(split.inPools, split.inSol, tvlModel, config, `${v.key}-in`);
    const outS = scoreConfig(split.outPools, split.outSol, tvlModel, config, `${v.key}-out`);
    return {
      metrics: measure(v, config, result),
      inSample: inS,
      outSample: outS,
      /* Same bar sweep:exits uses. */
      survived: inS !== null && survivedOutOfSample(inS, outS, 5),
      /* A run whose trades all come from one cohort is an artefact, not a result. */
      cohorts: result.trades.reduce<Record<string, { trades: number; pnl: number }>>(
        (acc, t) => {
          const row = acc[t.cohort] ?? { trades: 0, pnl: 0 };
          row.trades++;
          row.pnl += t.netPnlUsd;
          acc[t.cohort] = row;
          return acc;
        },
        {},
      ),
      /*
       * Cohort concentration is not the only way a run can be one thing wearing the
       * costume of a strategy. On this dataset every arm trades a SINGLE pool inside a
       * ten-day stretch of a 91-day window, so the whole comparison is one pool's price
       * series chopped up by different exit rules. Counting distinct pools and the span
       * of entry dates makes that visible on every future run instead of only when
       * someone thinks to go and look.
       */
      concentration: {
        distinctPools: new Set(result.trades.map((t) => t.poolAddress)).size,
        pairs: [...new Set(result.trades.map((t) => t.pairName))],
        firstEntry: result.trades[0]?.entryTime ?? null,
        lastEntry: result.trades[result.trades.length - 1]?.entryTime ?? null,
        entrySpanDays:
          result.trades.length > 1
            ? (Date.parse(result.trades[result.trades.length - 1]!.entryTime) -
                Date.parse(result.trades[0]!.entryTime)) /
              86_400_000
            : 0,
      },
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    dataFetchedAt: dataset.fetchedAt,
    window: { days: args.days, solBars: dataset.solUsdBars.length },
    universe: { survivors: survivors.length, dead: dataset.pools.length - survivors.length },
    tvlModel: { medianK: tvlModel.medianK, p25K: tvlModel.p25K, p75K: tvlModel.p75K },
    options,
    profile,
    splitAt: new Date(split.mid * 1000).toISOString(),
    variants: rows,
  };

  if (args.out) {
    writeFileSync(resolve(process.cwd(), args.out), JSON.stringify(payload, null, 2), "utf8");
  }

  const out: string[] = [];
  out.push(
    "",
    "=".repeat(110),
    `RISK-TO-REWARD SWEEP - LIVE V1.1 EXIT RULES, $${options.capitalUsd.toFixed(0)} ACCOUNT` +
      (profile.matchesLive ? " (LIVE PROFILE)" : " - NOT THE LIVE PROFILE"),
    "=".repeat(110),
    "",
    ...describeBacktestProfile(profile),
    `Window     : ${args.days} days, ${dataset.pools.length} pools ` +
      `(${survivors.length} survivors + ${payload.universe.dead} dead)`,
    `TVL model  : ${describeTvlModel(tvlModel)}`,
    `Fixed      : $${options.capitalUsd.toFixed(2)} capital, ${options.positionSizePct.toFixed(2)}% per position, ` +
      `max ${options.maxConcurrentPositions} concurrent, ${options.gasSolPerTransaction} SOL/tx, ` +
      `${base.forcedExitSlippagePct}% forced-exit slippage, ${base.maxDurationHours}h timeout, ` +
      `range -${base.downsideCoverPct}%/+${base.upsideCoverPct}%`,
    "",
    renderTable(
      [
        { header: "Variant" },
        { header: "SL/TP" },
        { header: "Trades", align: "right" },
        { header: "Win %", align: "right" },
        { header: "PF", align: "right" },
        { header: "Net PnL", align: "right" },
        { header: "Max DD", align: "right" },
        { header: "Avg hold", align: "right" },
        { header: "TP", align: "right" },
        { header: "SL", align: "right" },
        { header: "OOR", align: "right" },
        { header: "RAT", align: "right" },
        { header: "TMO", align: "right" },
      ],
      rows.map(({ metrics: m }) => [
        m.label,
        `${m.stopLossPct}/+${m.takeProfitNetPct}`,
        String(m.trades),
        pct(m.winRatePct),
        pf(m.profitFactor),
        usd(m.netPnlUsd),
        pct(m.maxDrawdownPct, 2),
        `${num(m.avgHoldHours, 2)}h`,
        String(m.exits.TAKE_PROFIT),
        String(m.exits.STOP_LOSS),
        String(m.exits.OUT_OF_RANGE),
        String(m.exits.RATCHET_STOP),
        String(m.exits.TIMEOUT),
      ]),
    ),
    "",
    "EFFICIENCY AND FRICTION",
    "",
    renderTable(
      [
        { header: "Variant" },
        { header: "Return/DD", align: "right" },
        { header: "Payoff", align: "right" },
        { header: "Expectancy", align: "right" },
        { header: "Avg win", align: "right" },
        { header: "Avg loss", align: "right" },
        { header: "Hrs in mkt", align: "right" },
        { header: "Friction", align: "right" },
        { header: "Fric/trade", align: "right" },
        { header: "Gross fees", align: "right" },
        { header: "LP value", align: "right" },
      ],
      rows.map(({ metrics: m }) => [
        m.label,
        m.returnToDrawdown === null ? "no DD" : num(m.returnToDrawdown),
        m.payoff === null ? "undefined" : num(m.payoff),
        usd(m.expectancyUsd),
        usd(m.avgWinUsd),
        usd(m.avgLossUsd),
        num(m.totalHoursInMarket, 0),
        usd(m.frictionUsd),
        usd(m.frictionPerTradeUsd, 3),
        usd(m.totalFeesUsd),
        usd(m.totalPositionValueChangeUsd),
      ]),
    ),
    "",
    `IN / OUT-OF-SAMPLE - window split at ${payload.splitAt.slice(0, 16)}`,
    "",
    renderTable(
      [
        { header: "Variant" },
        { header: "IN n", align: "right" },
        { header: "IN PnL", align: "right" },
        { header: "IN PF", align: "right" },
        { header: "IN payoff", align: "right" },
        { header: "OUT n", align: "right" },
        { header: "OUT PnL", align: "right" },
        { header: "OUT PF", align: "right" },
        { header: "OUT payoff", align: "right" },
        { header: "Survived?" },
      ],
      rows.map(({ metrics: m, inSample, outSample, survived }) => [
        m.label,
        inSample ? String(inSample.trades) : "-",
        inSample ? usd(inSample.netPnlUsd) : "-",
        inSample ? pf(inSample.profitFactor) : "-",
        inSample && inSample.payoff !== null ? num(inSample.payoff) : "undefined",
        outSample ? String(outSample.trades) : "-",
        outSample ? usd(outSample.netPnlUsd) : "-",
        outSample ? pf(outSample.profitFactor) : "-",
        outSample && outSample.payoff !== null ? num(outSample.payoff) : "undefined",
        survived ? "YES" : "no",
      ]),
    ),
    "",
    "COHORT COMPOSITION - a run whose trades all come from one cohort is an artefact",
    "",
  );

  for (const { metrics: m, cohorts, concentration: k } of rows) {
    const keys = Object.keys(cohorts);
    const body =
      keys.length === 0
        ? "(no trades)"
        : Object.entries(cohorts)
            .map(([c, r]) => `${c}: ${r.trades} trades ${usd(r.pnl)}`)
            .join("   ");
    out.push(
      `  ${m.label.padEnd(18)} ${body}` +
        (keys.length === 1 ? "   << SINGLE COHORT" : ""),
      `  ${"".padEnd(18)} pools: ${k.distinctPools} [${k.pairs.join(", ") || "-"}]  ` +
        `entries span ${num(k.entrySpanDays, 1)}d of ${args.days}d ` +
        `(${(k.firstEntry ?? "-").slice(0, 10)} -> ${(k.lastEntry ?? "-").slice(0, 10)})` +
        (k.distinctPools === 1 && m.trades > 0 ? "   << SINGLE POOL" : ""),
    );
  }
  out.push(
    "",
    "A run concentrated in one pool over a few days is that pool's price series chopped",
    "up by different exit rules, not evidence about the exit rules. Read every number",
    "above as conditional on that.",
    "",
  );

  console.log(out.join("\n"));
  if (args.out) console.log(`[rr] ${args.variant} written to ${args.out}`);
}

main().catch((err) => {
  console.error("[rr] failed:", err);
  process.exit(1);
});
