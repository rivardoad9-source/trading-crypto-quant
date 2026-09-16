/**
 * Eyyyys (@Eyyyys, Meteora PH) playbook mapped onto the live V1.1 backtest harness.
 *
 *   npm run sweep:eyy -- --capital=300 --sizepct=63 --concurrent=1
 *   npm run sweep:eyy -- --capital=300 --variant=eyy-combined
 *
 * WHAT THIS IS. The user asked: take the LP formula published by @Eyyyys (Metеora DLMM
 * momentum scalping: fresh pools, volume/fee-momentum filters, one-sided SOL-side
 * Bid-Ask below spot, fast in-and-out) and re-run OUR backtest with it, at $300, to see
 * whether his rules beat ours on our own data.
 *
 * WHAT IT IS NOT. A faithful replication. His rules live on data this harness does not
 * have: 1-minute bars, pools younger than one hour, bin-shaped one-sided positions, the
 * SOL->token conversion of a Bid-Ask ladder, GMGN/Metlex pool feeds. Every arm below is
 * therefore a MAPPING of one of his rules into the parameter the harness actually owns,
 * and the mapping is named on the arm so a reader can see exactly how far it travelled.
 * Anything that could not be mapped is listed in the report instead of being faked.
 *
 * Everything except the named delta is pinned to `liveV11Config` (which reads
 * src/config/env.ts), so the arms cannot differ on anything else. One cache, one
 * universe, one window, one TVL model, one account -> the comparison is within-run.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import {
  runSimulation,
  type BacktestConfig,
  type BacktestResult,
  type ExitReason,
} from "../backtest/engine.js";
import { loadHistoricalData } from "../backtest/historicalData.js";
import { exitCostModelFromFlag } from "../backtest/exitCost.js";
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

/*
 * The SAME cache the merged $100 V1.1 run and every sweep used, FROZEN.
 *
 * `.cache/historical_data_micro.json` was written 2026-09-13T03:52Z. Its bars are hourly
 * closes for a window that ENDED then, so they cannot change — but `readCacheFile` enforces
 * a 6-hour TTL on the file's `fetchedAt`, so a run today would silently re-ingest the whole
 * universe from GeckoTerminal (hours, rate-limited) and land on a DIFFERENT pool set. That
 * would make every number below incomparable with the published figures it is being
 * compared against. The frozen copy carries the same bars with the same universe and
 * records the original fetch time in `frozenFrom`. Nothing here is refreshed.
 */
const CACHE_PATH = ".cache/historical_data_micro_frozen.json";

const usd = (n: number, d = 2): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`;
const pct = (n: number, d = 1): string => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(d)}%`;
const num = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : "inf");
const pf = (v: number | null): string => (v === null ? "undefined" : num(v));

interface Arm {
  key: string;
  label: string;
  /** Which of his published rules this arm is standing in for. */
  maps: string;
  apply: (base: BacktestConfig) => BacktestConfig;
}

/*
 * `Infinity` on maxPriceSurge1hPct / maxPriceChange24hPct is the mapping of "he buys the
 * spike": our V1.1 gate REJECTS a pool that gained >10% in the last bar, which is exactly
 * his entry condition. Those two say "allow it", and nothing else.
 */
const ARMS: Arm[] = [
  {
    key: "v11-baseline",
    label: "V1.1 baseline",
    maps: "our live rules, unchanged",
    apply: (c) => c,
  },
  {
    key: "eyy-filters",
    label: "E · his filters",
    maps: "age floor 48h->0h, surge gate OFF (buys the pump), 24h change OFF, TVL band widened 50k-500k -> 5k-inf, volume floor 10k->250k",
    apply: (c) => ({
      ...c,
      minPoolAgeHours: 0,
      maxPriceSurge1hPct: Number.POSITIVE_INFINITY,
      maxPriceChange24hPct: Number.POSITIVE_INFINITY,
      minTvlUsd: 5_000,
      maxTvlUsd: Number.POSITIVE_INFINITY,
      minVolume24hUsd: 250_000,
    }),
  },
  {
    key: "eyy-feerich",
    label: "E · fee-rich only",
    maps: "his '>=10 SOL fees, 0 dev fees, fees>volume' selection -> fee/TVL floor 0.8%->5%, coverage 2.5x->1.0x",
    apply: (c) => ({ ...c, minFeeTvlRatio: 0.05, minFeeCostCoverage: 1.0 }),
  },
  {
    key: "eyy-range",
    label: "E · one-sided wide BA",
    maps: "his SOL-side Bid-Ask placed far below spot, -85%/-90% -> range -45/+15 -> -85/+5",
    apply: (c) => ({ ...c, downsideCoverPct: 85, upsideCoverPct: 5 }),
  },
  {
    key: "eyy-cadence",
    label: "E · fast in/out",
    maps: "his minute-level monitoring + re-entry -> timeout 24h->4h, TP off (ride the pump), pool cooldown 4h->0",
    apply: (c) => ({
      ...c,
      maxDurationHours: 4,
      takeProfitNetPct: Number.POSITIVE_INFINITY,
      poolCooldownHours: 0,
      lockoutConsecutiveFailures: 0,
      lockoutHours: 0,
    }),
  },
  {
    key: "eyy-scalp-1h",
    label: "E · 1h scalp",
    maps: "the closest an hourly harness gets to 'I only react to the sound': timeout 1h, TP off, no cooldown",
    apply: (c) => ({
      ...c,
      maxDurationHours: 1,
      takeProfitNetPct: Number.POSITIVE_INFINITY,
      poolCooldownHours: 0,
      lockoutConsecutiveFailures: 0,
      lockoutHours: 0,
    }),
  },
  {
    key: "eyy-combined",
    label: "E · all four stacked",
    maps: "his filters + fee-rich selection + one-sided wide range + fast re-entry, together",
    apply: (c) => ({
      ...c,
      minPoolAgeHours: 0,
      maxPriceSurge1hPct: Number.POSITIVE_INFINITY,
      maxPriceChange24hPct: Number.POSITIVE_INFINITY,
      minTvlUsd: 5_000,
      maxTvlUsd: Number.POSITIVE_INFINITY,
      minVolume24hUsd: 250_000,
      minFeeTvlRatio: 0.05,
      minFeeCostCoverage: 1.0,
      downsideCoverPct: 85,
      upsideCoverPct: 5,
      maxDurationHours: 4,
      takeProfitNetPct: Number.POSITIVE_INFINITY,
      poolCooldownHours: 0,
      lockoutConsecutiveFailures: 0,
      lockoutHours: 0,
    }),
  },
  {
    key: "eyy-hedge-layer",
    label: "E · hedge layer",
    maps: "our V1.1 exits, his range only -- the 'first SOL-side position eats the downside' idea tested on its own",
    apply: (c) => ({ ...c, downsideCoverPct: 85, upsideCoverPct: 5, maxDurationHours: 24, poolCooldownHours: 0 }),
  },
];

/** Arms re-run with the measured (bin-step aware) exit concession instead of a flat 2%. */
const ENVELOPE_KEYS = ["v11-baseline", "eyy-combined", "eyy-scalp-1h"];

export interface ArmMetrics {
  key: string;
  label: string;
  maps: string;
  trades: number;
  winRatePct: number;
  profitFactor: number | null;
  netPnlUsd: number;
  returnPct: number;
  endingEquityUsd: number;
  maxDrawdownPct: number;
  avgHoldHours: number;
  totalFeesUsd: number;
  totalPositionValueChangeUsd: number;
  frictionUsd: number;
  frictionVsFees: number | null;
  exits: Record<ExitReason, number>;
  distinctPools: number;
  tradeRugged: number;
  tradeCatastrophic: number;
  gateRejections: Record<string, number>;
}

function measure(
  key: string,
  label: string,
  maps: string,
  result: BacktestResult,
): ArmMetrics {
  const s = result.summary;
  const friction = s.totalGasCostUsd + s.totalSlippageCostUsd;
  return {
    key,
    label,
    maps,
    trades: s.totalTrades,
    winRatePct: s.winRatePct,
    profitFactor: s.profitFactor,
    netPnlUsd: s.netPnlUsd,
    returnPct: s.returnPct,
    endingEquityUsd: s.endingEquityUsd,
    maxDrawdownPct: s.maxDrawdownPct,
    avgHoldHours: s.avgTradeDurationHours,
    totalFeesUsd: s.totalFeesUsd,
    totalPositionValueChangeUsd: s.totalPositionValueChangeUsd,
    frictionUsd: friction,
    frictionVsFees: s.totalFeesUsd > 0 ? friction / s.totalFeesUsd : null,
    exits: s.exitReasonCounts,
    distinctPools: new Set(result.trades.map((t) => t.poolAddress)).size,
    tradeRugged: s.ruggedTrades,
    tradeCatastrophic: s.catastrophicTrades,
    gateRejections: result.gateRejections,
  };
}

/**
 * Trade-level detail, so a reader can see WHICH pools and WHICH days a headline came
 * from instead of trusting a total. Capped: a 300-trade scalp arm does not need 300 rows
 * of JSON to make its point, and an uncapped dump would make the payload unreadable.
 */
interface TradeRow {
  pool: string;
  pair: string;
  cohort: string;
  entry: string;
  exit: string;
  hours: number;
  reason: ExitReason;
  netPnlUsd: number;
}

function tradeRows(result: BacktestResult, cap: number): { rows: TradeRow[]; truncated: number } {
  const rows = result.trades.map((t) => ({
    pool: t.poolAddress,
    pair: t.pairName,
    cohort: t.cohort,
    entry: t.entryTime,
    exit: t.exitTime,
    hours: t.durationHours,
    reason: t.exitReason,
    netPnlUsd: t.netPnlUsd,
  }));
  return { rows: rows.slice(0, cap), truncated: Math.max(0, rows.length - cap) };
}

/** Where a headline actually came from: which pools, which dates, how concentrated. */
function concentrationOf(result: BacktestResult): {
  distinctPools: number;
  pairs: string[];
  cohorts: Record<string, number>;
  firstEntry: string | null;
  lastEntry: string | null;
  entrySpanDays: number;
} {
  const byPool = new Map<string, number>();
  for (const t of result.trades) byPool.set(t.poolAddress, (byPool.get(t.poolAddress) ?? 0) + 1);
  const top = [...byPool.entries()].sort((a, b) => b[1] - a[1]);
  const first = result.trades[0]?.entryTime ?? null;
  const last = result.trades[result.trades.length - 1]?.entryTime ?? null;
  return {
    distinctPools: byPool.size,
    pairs: [...new Set(result.trades.map((t) => `${t.pairName} (${top.find(([a]) => a === t.poolAddress)?.[1] ?? 0}x)`))],
    cohorts: result.trades.reduce<Record<string, number>>((acc, t) => {
      acc[t.cohort] = (acc[t.cohort] ?? 0) + 1;
      return acc;
    }, {}),
    firstEntry: first,
    lastEntry: last,
    entrySpanDays: first && last ? (Date.parse(last) - Date.parse(first)) / 86_400_000 : 0,
  };
}

function parseArgs(argv: string[]): {
  days: number;
  pools: number;
  deadPools: number;
  refresh: boolean;
  variant: string;
  out: string | null;
  exitCost: string | undefined;
  overrides: ProfileOverrides;
  flags: Map<string, string>;
} {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(arg);
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
    out: flags.get("out") ?? "backtest_eyyyys_vs_v11.json",
    exitCost: flags.get("exitcost"),
    overrides: readProfileOverrides(flags),
    flags,
  };
}

/** The friction assumption every published micro-capital figure uses. */
const DEFAULT_GAS_SOL_PER_TX = 0.0005;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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
    throw new Error("[eyy] TVL model could not be calibrated: no usable survivor pools");
  }

  const selected = args.variant === "all" ? ARMS : ARMS.filter((a) => a.key === args.variant);
  if (selected.length === 0) {
    throw new Error(`[eyy] unknown --variant=${args.variant}`);
  }

  const split = splitWindow(dataset.pools, dataset.solUsdBars);

  const rows = selected.map((arm) => {
    const config = arm.apply(base);
    const result = runSimulation({
      label: arm.key,
      pools: dataset.pools,
      solUsdBars: dataset.solUsdBars,
      tvlModel,
      config,
    });
    const inS = scoreConfig(split.inPools, split.inSol, tvlModel, config, `${arm.key}-in`);
    const outS = scoreConfig(split.outPools, split.outSol, tvlModel, config, `${arm.key}-out`);
    return {
      metrics: measure(arm.key, arm.label, arm.maps, result),
      survived: inS !== null && outS !== null ? survivedOutOfSample(inS, outS, 5) : false,
      inSample: inS,
      outSample: outS,
      concentration: concentrationOf(result),
      trades: tradeRows(result, 400),
    };
  });

  const envelopeRows = ENVELOPE_KEYS.filter((k) => selected.some((a) => a.key === k)).map((key) => {
    const arm = ARMS.find((a) => a.key === key)!;
    const config: BacktestConfig = {
      ...arm.apply(base),
      exitCostModel: exitCostModelFromFlag(args.exitCost ?? "envelope", base.forcedExitSlippagePct),
    };
    const result = runSimulation({
      label: `${arm.key}-envelope`,
      pools: dataset.pools,
      solUsdBars: dataset.solUsdBars,
      tvlModel,
      config,
    });
    const m = measure(`${arm.key}-envelope`, `${arm.label} (measured exits)`, arm.maps, result);
    const inS = scoreConfig(split.inPools, split.inSol, tvlModel, config, `${arm.key}-env-in`);
    const outS = scoreConfig(split.outPools, split.outSol, tvlModel, config, `${arm.key}-env-out`);
    return {
      metrics: m,
      survived: inS !== null && outS !== null ? survivedOutOfSample(inS, outS, 5) : false,
      inSample: inS,
      outSample: outS,
      concentration: concentrationOf(result),
      trades: tradeRows(result, 400),
    };
  });

  const allRows = [...rows, ...envelopeRows];

  const payload = {
    generatedAt: new Date().toISOString(),
    dataFetchedAt: dataset.fetchedAt,
    window: { days: args.days, bars: dataset.solUsdBars.length, start: dataset.solUsdBars[0]?.t ?? null, end: dataset.solUsdBars.at(-1)?.t ?? null },
    universe: { pools: dataset.pools.length, survivors: survivors.length, dead: dataset.pools.length - survivors.length },
    account: { ...options, profile },
    baseConfig: base,
    tvlModel: { medianK: tvlModel.medianK, p25K: tvlModel.p25K, p75K: tvlModel.p75K, samples: tvlModel.samples },
    arms: allRows,
  };
  if (args.out) {
    writeFileSync(resolve(process.cwd(), args.out), JSON.stringify(payload, null, 2), "utf8");
  }

  const out: string[] = [];
  out.push(
    "",
    "=".repeat(118),
    `EYYYYS (@Eyyyys, Meteora PH) PLAYBOOK vs LIVE V1.1 — $${options.capitalUsd.toFixed(0)} ACCOUNT`,
    "=".repeat(118),
    "",
    ...describeBacktestProfile(profile),
    `Window     : ${args.days} days, ${dataset.pools.length} pools ` +
      `(${survivors.length} survivors + ${payload.universe.dead} dead), ${dataset.solUsdBars.length} hourly bars`,
    `TVL model  : ${describeTvlModel(tvlModel)}`,
    `Fixed      : ${options.positionSizePct}% per position, max ${options.maxConcurrentPositions} concurrent, ` +
      `${options.gasSolPerTransaction} SOL/tx, ${base.forcedExitSlippagePct}% forced-exit slippage`,
    "",
    "HEADLINE — every arm on the SAME universe, window and $ account",
    "",
  );

  const headline = (label: string, m: ArmMetrics, survived: boolean): string[] => [
    label,
    String(m.trades),
    pct(m.winRatePct),
    pf(m.profitFactor),
    usd(m.netPnlUsd),
    usd(m.endingEquityUsd),
    pct(m.returnPct),
    pct(m.maxDrawdownPct, 2),
    `${num(m.avgHoldHours, 2)}h`,
    String(m.distinctPools),
    survived ? "yes" : "NO",
  ];

  out.push(
    renderTable(
      [
        { header: "Arm" },
        { header: "Trades", align: "right" },
        { header: "Win %", align: "right" },
        { header: "PF", align: "right" },
        { header: "Net PnL", align: "right" },
        { header: "Equity", align: "right" },
        { header: "Return", align: "right" },
        { header: "Max DD", align: "right" },
        { header: "Avg hold", align: "right" },
        { header: "Pools", align: "right" },
        { header: "OOS", align: "right" },
      ],
      allRows.map((r) => headline(r.metrics.label, r.metrics, r.survived)),
    ),
    "",
    "WHAT EACH ARM CHANGED (the mapping, stated so a reader can reject it if it is wrong)",
    "",
    ...allRows.map((r) => `· ${r.metrics.label}: ${r.metrics.maps}`),
    "",
    "EXIT MIX AND FRICTION",
    "",
    renderTable(
      [
        { header: "Arm" },
        { header: "TP", align: "right" },
        { header: "SL", align: "right" },
        { header: "OOR", align: "right" },
        { header: "TMO", align: "right" },
        { header: "RUG", align: "right" },
        { header: "Gross fees", align: "right" },
        { header: "LP value", align: "right" },
        { header: "Friction", align: "right" },
        { header: "Fric/fees", align: "right" },
      ],
      allRows.map(({ metrics: m }) => [
        m.label,
        String(m.exits.TAKE_PROFIT),
        String(m.exits.STOP_LOSS),
        String(m.exits.OUT_OF_RANGE),
        String(m.exits.TIMEOUT),
        String(m.tradeRugged),
        usd(m.totalFeesUsd),
        usd(m.totalPositionValueChangeUsd),
        usd(m.frictionUsd),
        m.frictionVsFees === null ? "—" : `${num(m.frictionVsFees)}x`,
      ]),
    ),
    "",
  );

  /* Net PnL delta against the arm everything else is measured from. */
  const baseline = allRows.find((r) => r.metrics.key === "v11-baseline")!.metrics;
  out.push(
    "DELTA VS OUR V1.1 BASELINE",
    "",
    renderTable(
      [{ header: "Arm" }, { header: "Net PnL delta", align: "right" }, { header: "Return delta", align: "right" }, { header: "Trades delta", align: "right" }, { header: "Max DD delta", align: "right" }],
      allRows.map(({ metrics: m }) => [
        m.label,
        usd(m.netPnlUsd - baseline.netPnlUsd),
        `${m.returnPct - baseline.returnPct >= 0 ? "+" : ""}${(m.returnPct - baseline.returnPct).toFixed(2)}pp`,
        `${m.trades - baseline.trades >= 0 ? "+" : ""}${m.trades - baseline.trades}`,
        `${m.maxDrawdownPct - baseline.maxDrawdownPct >= 0 ? "+" : ""}${(m.maxDrawdownPct - baseline.maxDrawdownPct).toFixed(2)}pp`,
      ]),
    ),
    "",
    "WHY ENTRIES WERE REFUSED — baseline vs his stacked rules",
    "",
  );

  const combined = allRows.find((r) => r.metrics.key === "eyy-combined");
  if (combined) {
    const keys = new Set([...Object.keys(baseline.gateRejections), ...Object.keys(combined.metrics.gateRejections)]);
    out.push(
      renderTable(
        [{ header: "Gate" }, { header: "V1.1", align: "right" }, { header: "E·stacked", align: "right" }, { header: "Delta", align: "right" }],
        [...keys]
          .map((k) => [k, baseline.gateRejections[k] ?? 0, combined.metrics.gateRejections[k] ?? 0] as [string, number, number])
          .sort((a, b) => b[1] + b[2] - (a[1] + a[2]))
          .map(([k, a, b]) => [k, String(a), String(b), `${b - a >= 0 ? "+" : ""}${b - a}`]),
      ),
      "",
    );
  }

  out.push(
    "WHERE THE TRADES ACTUALLY CAME FROM (a headline from 2 pools in one week is not a strategy)",
    "",
    renderTable(
      [
        { header: "Arm" },
        { header: "Pools", align: "right" },
        { header: "Pairs (trades)" },
        { header: "Cohort mix" },
        { header: "First entry" },
        { header: "Last entry" },
      ],
      allRows.map(({ metrics: m, concentration: c }) => [
        m.label,
        String(c.distinctPools),
        c.pairs.join(", "),
        Object.entries(c.cohorts)
          .map(([k, v]) => `${k}:${v}`)
          .join(" "),
        c.firstEntry ? c.firstEntry.slice(0, 16).replace("T", " ") : "—",
        c.lastEntry ? c.lastEntry.slice(0, 16).replace("T", " ") : "—",
      ]),
    ),
    "",
    "NOT TESTABLE ON THIS HARNESS (stated so the gap is not mistaken for a result)",
    "",
    "· 1-minute bars: his entries gate on >100K volume PER MINUTE. These bars are hourly,",
    "  so his trigger cannot be expressed, only approximated with a 24h volume floor.",
    "· pools younger than 1 hour: the dataset's hourly bars put the earliest possible entry",
    "  up to 60 minutes after creation — the exact window his edge is claimed to live in.",
    "· bin-shaped one-sided Bid-Ask: the harness credits a pro-rata fee share over a price",
    "  range. It does not model the SOL->token conversion of a ladder sitting 85-90% below spot.",
    "· his pool feed (GMGN trending + Metlex fresh-pool alerts, age <1h, MCAP >=100k, dev",
    "  fees 0, 'good lore'): not reproducible offline, and 'good lore' is not a parameter.",
    "· his own numbers (1 SOL -> 3.5 SOL in a month): he publishes no wallet, so nothing in",
    "  this report corroborates or contradicts them.",
    "",
  );

  console.log(out.join("\n"));
  console.log(`[eyy] full results written to ${args.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[eyy] failed:", err);
    process.exit(1);
  });
}
