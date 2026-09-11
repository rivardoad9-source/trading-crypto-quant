/**
 * SOL-quoted versus USDC-quoted pools, same window, same V1.1 rules.
 *
 *   npm run backtest:quote
 *   npm run backtest:quote -- --days=91 --pools=12 --deadpools=12 --refresh
 *
 * The engine funds every entry in SOL and `describePair()` REFUSES a pool with no
 * wSOL leg, so a third of the pools that clear the screening band today are
 * unreachable (measured 9 Sep 2026: 16 of 48). Supporting them is a real change to
 * the execution path — a SOL->USDC leg on entry and back on exit — so the question
 * this runner answers first is whether those pools are worth reaching at all.
 *
 * Three arms, one dataset, one TVL model:
 *
 *   SOL   — pools with a wSOL leg. What the engine trades today.
 *   USDC  — pools with NO wSOL leg but a USD stablecoin leg. What it refuses.
 *   BOTH  — the union, with the SAME capital and concurrency, so the two compete
 *           for the same position slots exactly as they would live.
 *
 * Each arm is ingested to the SAME pool count rather than filtered out of a shared
 * dataset afterwards, because a volume-ranked sample would hand the arms whatever
 * counts fell out of the sort and the comparison would be against sample size.
 *
 * Deploys ZERO real capital and signs nothing on-chain.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { WSOL_MINT } from "../config/constants.js";
import { estimateBinWidth } from "../services/meteora.js";
import {
  runSimulation,
  solPriceAt,
  type BacktestConfig,
  type BacktestResult,
  type BacktestTrade,
  type ExitReason,
} from "./engine.js";
import {
  BACKTEST_CAVEATS,
  loadHistoricalData,
  type Bar,
  type PoolHistory,
} from "./historicalData.js";
import { calibrateTvlModel, describeTvlModel, type TvlModel } from "./tvlModel.js";
import { renderTable } from "./report.js";
import { liveV11Config, type MicroCapitalOptions } from "./runMicroCapital.js";
import {
  describeBacktestProfile,
  readProfileOverrides,
  resolveBacktestProfile,
  type ProfileOverrides,
} from "./liveProfile.js";
import type { DlmmPool } from "../services/meteora.js";
import type { UniversePool } from "./universe.js";

const SOL_CACHE = ".cache/historical_data_quote_sol.json";
const USD_CACHE = ".cache/historical_data_quote_usd.json";
const OUTPUT_PATH = "backtest_quote_comparison.json";

/** The stablecoins `historicalData.ts` already recognises as a USD quote leg. */
const USD_SYMBOLS = new Set(["USDC", "USDT", "USDH", "PYUSD", "FDUSD", "DAI"]);

const usd = (n: number, d = 2): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`;
const pct = (n: number, d = 2): string => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(d)}%`;
const num = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : "—");
/** Profit factor is null when there were no losing trades; that is not zero. */
const pf = (v: number | null): string => (v === null ? "undefined" : num(v));

/* ------------------------------------------------------------------ */
/* Arm membership — the same test `describePair()` applies live        */
/* ------------------------------------------------------------------ */

const hasWsolLeg = (p: { baseMint: string; quoteMint: string }): boolean =>
  p.baseMint === WSOL_MINT || p.quoteMint === WSOL_MINT;

const hasUsdLeg = (p: { baseSymbol: string; quoteSymbol: string }): boolean =>
  USD_SYMBOLS.has((p.baseSymbol || "").toUpperCase()) ||
  USD_SYMBOLS.has((p.quoteSymbol || "").toUpperCase());

/**
 * A pool the engine can fund today. Membership is the wSOL leg and NOTHING else, so
 * a SOL-USDC pool counts as fundable — which it is. It is the absence of a wSOL leg
 * that stops an entry, not the presence of a stablecoin.
 */
export const isSolArm = (p: UniversePool): boolean => hasWsolLeg(p);

/** A pool the engine refuses today: no wSOL leg to size against, but a USD one. */
export const isUsdArm = (p: UniversePool): boolean => !hasWsolLeg(p) && hasUsdLeg(p);

/* ------------------------------------------------------------------ */
/* The SOL-beta correction                                             */
/* ------------------------------------------------------------------ */

interface SolAdjustedTrade {
  trade: BacktestTrade;
  /** SOL/USD at the exit bar, or null when the series did not reach it. */
  solPriceAtExit: number | null;
  /** netPnlUsd restated with the SOL move folded in. Equals netPnlUsd for USD quotes. */
  adjustedNetPnlUsd: number;
  /** adjustedNetPnlUsd - netPnlUsd. Zero for USD quotes and for unmeasurable rows. */
  solBetaUsd: number;
  measured: boolean;
}

/**
 * Restates a trade's PnL in USD including the move in SOL/USD over the hold.
 *
 * The engine values a position in its QUOTE asset: `positionValueChangeUsd` is
 * `notional x (sqrt(r) - 1)` where r is the base priced in the quote. For a
 * USD-quoted pool that already IS a USD figure. For a SOL-quoted pool it is a SOL
 * figure multiplied by a USD notional, which silently assumes SOL/USD was flat for
 * the whole hold.
 *
 * That assumption is the one asymmetry between the arms, and it is not small: an LP
 * in TOKEN/SOL holds SOL, so its dollar value carries SOL's move in full. Left
 * uncorrected the comparison would credit or charge the SOL arm for something it
 * never measured, and the direction depends entirely on which way SOL ran in the
 * window — i.e. the answer would be a property of the window presented as a
 * property of the quote asset.
 *
 * This is a DIAGNOSTIC and is never written back into the engine. Changing `closeAt`
 * would silently redefine every historical backtest figure in the repo, the same
 * defect class as redefining `realized_pnl_usd`.
 */
export function adjustTradeForSolMove(
  trade: BacktestTrade,
  solUsdBars: Bar[],
): SolAdjustedTrade {
  const quoteIsUsd = trade.quoteDenominatedIn === "USD";
  const exitT = Math.floor(new Date(trade.exitTime).getTime() / 1000);
  const solPriceAtExit = Number.isFinite(exitT) ? solPriceAt(solUsdBars, exitT) : null;

  if (quoteIsUsd) {
    return {
      trade,
      solPriceAtExit,
      adjustedNetPnlUsd: trade.netPnlUsd,
      solBetaUsd: 0,
      measured: true,
    };
  }

  const entry = trade.solPriceAtEntry;
  if (!(entry > 0) || solPriceAtExit === null || !(solPriceAtExit > 0)) {
    // Unmeasured is excluded from the correction, never counted as zero drift — the
    // same rule the reconciliation service follows.
    return {
      trade,
      solPriceAtExit,
      adjustedNetPnlUsd: trade.netPnlUsd,
      solBetaUsd: 0,
      measured: false,
    };
  }

  const solMove = solPriceAtExit / entry;
  // The LP's value in SOL at exit, expressed against the deployed notional.
  const lpValueInQuote = trade.notionalUsd + trade.positionValueChangeUsd;
  const adjustedValueChange = lpValueInQuote * solMove - trade.notionalUsd;
  /*
   * Every cost term the engine already charged is carried through unscaled: they were
   * paid in dollars at the time, and re-scaling them by SOL's later move would charge
   * the trade for a price change that happened after the money was spent. Only the
   * position's VALUE moves with SOL. Dropping `swapCostUsd` here would be the quieter
   * version of the same mistake — the correction would silently refund it.
   */
  const adjustedNetPnlUsd =
    trade.feesEarnedUsd +
    adjustedValueChange -
    trade.gasCostUsd -
    trade.slippageCostUsd -
    trade.swapCostUsd;

  return {
    trade,
    solPriceAtExit,
    adjustedNetPnlUsd,
    solBetaUsd: adjustedNetPnlUsd - trade.netPnlUsd,
    measured: true,
  };
}

interface AdjustedSummary {
  trades: number;
  measured: number;
  unmeasured: number;
  netPnlUsd: number;
  adjustedNetPnlUsd: number;
  solBetaUsd: number;
  winRatePct: number | null;
  adjustedWinRatePct: number | null;
}

function summariseAdjusted(trades: BacktestTrade[], solUsdBars: Bar[]): AdjustedSummary {
  const rows = trades.map((t) => adjustTradeForSolMove(t, solUsdBars));
  const measured = rows.filter((r) => r.measured);
  const wins = rows.filter((r) => r.trade.netPnlUsd > 0).length;
  const adjWins = rows.filter((r) => r.adjustedNetPnlUsd > 0).length;

  return {
    trades: rows.length,
    measured: measured.length,
    unmeasured: rows.length - measured.length,
    netPnlUsd: rows.reduce((s, r) => s + r.trade.netPnlUsd, 0),
    adjustedNetPnlUsd: rows.reduce((s, r) => s + r.adjustedNetPnlUsd, 0),
    solBetaUsd: rows.reduce((s, r) => s + r.solBetaUsd, 0),
    winRatePct: rows.length ? (wins / rows.length) * 100 : null,
    adjustedWinRatePct: rows.length ? (adjWins / rows.length) * 100 : null,
  };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

interface Arm {
  label: string;
  pools: PoolHistory[];
  result: BacktestResult;
}

function armTable(arms: Arm[]): string {
  const rows = arms.map(({ label, result }) => {
    const s = result.summary;
    const avgWin = s.wins > 0 ? s.grossProfitUsd / s.wins : 0;
    const avgLoss = s.losses > 0 ? s.grossLossUsd / s.losses : 0;
    return [
      label,
      String(s.totalTrades),
      pct(s.winRatePct, 1),
      usd(s.netPnlUsd),
      pct(s.returnPct, 1),
      usd(avgWin),
      usd(avgLoss),
      pf(s.profitFactor),
      pct(s.maxDrawdownPct, 1),
      usd(s.totalGasCostUsd + s.totalSlippageCostUsd + s.totalSwapCostUsd),
      usd(s.totalSwapCostUsd),
    ];
  });

  return renderTable(
    [
      { header: "Arm" },
      { header: "Trades", align: "right" },
      { header: "Win rate", align: "right" },
      { header: "Net PnL", align: "right" },
      { header: "Return", align: "right" },
      { header: "Avg win", align: "right" },
      { header: "Avg loss", align: "right" },
      { header: "PF", align: "right" },
      { header: "Max DD", align: "right" },
      { header: "Friction", align: "right" },
      { header: "of which swap", align: "right" },
    ],
    rows,
  );
}

/** The headline restated across the band of per-leg swap concessions. */
function swapBandTable(
  band: Array<{ slippagePct: number; arms: Array<{ label: string; result: BacktestResult }> }>,
): string {
  const labels = band[0]?.arms.map((a) => a.label) ?? [];

  return renderTable(
    [
      { header: "Per-leg swap" },
      ...labels.flatMap((l) => [
        { header: `${l} PnL`, align: "right" as const },
        { header: `${l} trades`, align: "right" as const },
      ]),
    ],
    band.map(({ slippagePct, arms }) => [
      `${slippagePct.toFixed(2)}%${slippagePct === 0.5 ? " (on-chain cap)" : ""}`,
      ...arms.flatMap((a) => [usd(a.result.summary.netPnlUsd), String(a.result.summary.totalTrades)]),
    ]),
  );
}

function compositionTable(arms: Arm[]): string {
  const median = (xs: number[]): number => {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] as number;
  };

  const rows = arms.map(({ label, pools }) => {
    const survivors = pools.filter((p) => p.cohort === "survivor").length;
    const widths = pools.map((p) =>
      estimateBinWidth(p.binStep, env.MIN_DOWNSIDE_COVER_PCT, env.MIN_UPSIDE_COVER_PCT),
    );
    const underCap = widths.filter((w) => w <= env.LIVE_MAX_POSITION_BINS).length;
    const underProgram = widths.filter((w) => w <= 1400).length;

    return [
      label,
      String(pools.length),
      `${survivors}/${pools.length - survivors}`,
      num(median(pools.map((p) => p.binStep)), 0),
      usd(median(pools.map((p) => p.tvlTodayUsd)), 0),
      `${underCap}/${pools.length}`,
      `${underProgram}/${pools.length}`,
    ];
  });

  return renderTable(
    [
      { header: "Arm" },
      { header: "Pools", align: "right" },
      { header: "Surv/Dead", align: "right" },
      { header: "Med binStep", align: "right" },
      { header: "Med TVL now", align: "right" },
      { header: `Fits <=${env.LIVE_MAX_POSITION_BINS} bins`, align: "right" },
      { header: "Fits <=1400 bins", align: "right" },
    ],
    rows,
  );
}

function adjustedTable(entries: Array<{ label: string; summary: AdjustedSummary }>): string {
  const rows = entries.map(({ label, summary }) => [
    label,
    String(summary.trades),
    usd(summary.netPnlUsd),
    usd(summary.solBetaUsd),
    usd(summary.adjustedNetPnlUsd),
    summary.winRatePct === null ? "—" : pct(summary.winRatePct),
    summary.adjustedWinRatePct === null ? "—" : pct(summary.adjustedWinRatePct),
    summary.unmeasured === 0 ? "—" : String(summary.unmeasured),
  ]);

  return renderTable(
    [
      { header: "Arm" },
      { header: "Trades", align: "right" },
      { header: "Net PnL (engine)", align: "right" },
      { header: "SOL beta", align: "right" },
      { header: "Net PnL (USD)", align: "right" },
      { header: "Win", align: "right" },
      { header: "Win (USD)", align: "right" },
      { header: "Unmeasured", align: "right" },
    ],
    rows,
  );
}

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

function exitTable(arms: Arm[]): string {
  const rows = EXIT_ORDER.map((reason) => {
    const cells = arms.map(({ result }) => {
      if (result.trades.length === 0) return "—";
      const hits = result.trades.filter((t) => t.exitReason === reason).length;
      return `${hits} (${((hits / result.trades.length) * 100).toFixed(0)}%)`;
    });
    return [reason as string, ...cells];
  }).filter((row) => row.slice(1).some((c) => c !== "—" && !c.startsWith("0 ")));

  return renderTable(
    [
      { header: "Exit reason" },
      ...arms.map((a) => ({ header: a.label, align: "right" as const })),
    ],
    rows,
  );
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

interface Args {
  days: number;
  poolsPerArm: number;
  deadPoolsPerArm: number;
  refresh: boolean;
  /**
   * Fetches ONE arm's history into its own cache and exits without simulating.
   *
   * The ingest is ~150 sequential upstream requests and is the whole cost of a run;
   * the simulation itself is milliseconds. Warming the two caches as separate
   * processes halves the wall clock. It changes no result: a full run reads exactly
   * the caches it would otherwise have written.
   */
  ingestOnly: "sol" | "usdc" | null;
  /** Per-leg balancing-swap concession, as a percentage of the amount swapped. */
  swapSlippagePct: number;
  /** Gas for one balancing-swap transaction, in SOL. */
  swapGasSolPerLeg: number;
  /** Account flags. Absent = the live profile, resolved once SOL/USD is known. */
  overrides: ProfileOverrides;
}

/**
 * The band swept over the per-leg swap concession.
 *
 * It is an ASSUMPTION, not a measurement — no free provider serves historical
 * Jupiter fill quality for these pools, and impact depends on the size and the route
 * at the moment of the swap. What IS known is the ceiling: `HARD_MAX_SLIPPAGE_BPS` is
 * 50 bps and Jupiter's `otherAmountThreshold` enforces it on-chain, so a leg that
 * would cost more than 0.50% does not fill at all. The band therefore spans "free" to
 * the worst fill the live path can legally take, and the conclusion is only worth
 * stating where it holds across the whole of it.
 */
const SWAP_SLIPPAGE_BAND = [0, 0.1, 0.25, 0.5];

export function parseArgs(argv: string[]): Args {
  const flags = new Set(
    argv.filter((a) => a.startsWith("--") && !a.includes("=")).map((a) => a.slice(2)),
  );
  const values = new Map(
    argv
      .filter((a) => a.startsWith("--") && a.includes("="))
      .map((a) => {
        const [k, ...rest] = a.slice(2).split("=");
        return [k as string, rest.join("=")];
      }),
  );

  const n = (key: string, fallback: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const rawArm = (values.get("ingest-only") ?? "").toLowerCase();
  if (rawArm !== "" && rawArm !== "sol" && rawArm !== "usdc") {
    throw new Error(`--ingest-only must be "sol" or "usdc", got "${rawArm}"`);
  }

  return {
    days: n("days", 91),
    poolsPerArm: n("pools", 12),
    deadPoolsPerArm: n("deadpools", 12),
    refresh: flags.has("refresh"),
    ingestOnly: rawArm === "" ? null : (rawArm as "sol" | "usdc"),
    // Half the on-chain hard cap: the central estimate, with the band around it.
    swapSlippagePct: n("swapslip", 0.25),
    swapGasSolPerLeg: n("swapgas", n("gas", 0.0035)),
    overrides: readProfileOverrides(values),
  };
}

async function main(): Promise<void> {
  const { days, poolsPerArm, deadPoolsPerArm, refresh, ingestOnly, swapSlippagePct, swapGasSolPerLeg, overrides } =
    parseArgs(process.argv.slice(2));

  const ingestArm = (arm: "sol" | "usdc") =>
    loadHistoricalData({
      poolCount: poolsPerArm,
      deadPoolCount: deadPoolsPerArm,
      windowDays: days,
      cachePath: arm === "sol" ? SOL_CACHE : USD_CACHE,
      force: refresh,
      survivorTvlBand: { minUsd: env.MIN_TVL_USD, maxUsd: env.MAX_TVL_USD },
      poolFilter: arm === "sol" ? isSolArm : isUsdArm,
    });

  if (ingestOnly !== null) {
    console.log(`\n[quote] ingest-only: ${ingestOnly} arm, ${days}-day window\n`);
    const data = await ingestArm(ingestOnly);
    const survivors = data.pools.filter((p) => p.cohort === "survivor").length;
    console.log(
      `\n[quote] ${ingestOnly} arm cached: ${data.pools.length} pools ` +
        `(${survivors} survivors, ${data.pools.length - survivors} dead/dormant)\n`,
    );
    return;
  }

  console.log(`\n[quote] ${days}-day window · account from the live profile unless overridden`);
  console.log("[quote] arm 1/2: SOL-quoted (pools with a wSOL leg)…");

  const solData = await ingestArm("sol");

  console.log("\n[quote] arm 2/2: USDC-quoted (no wSOL leg)…");

  const usdData = await ingestArm("usdc");

  /*
   * The SOL/USD reference series is the same fetch in both datasets; taking the
   * longer of the two keeps the correction measurable for every trade in both arms.
   */
  const solUsdBars: Bar[] =
    solData.solUsdBars.length >= usdData.solUsdBars.length
      ? solData.solUsdBars
      : usdData.solUsdBars;

  const profile = resolveBacktestProfile({
    overrides,
    windowStartSolUsd: solUsdBars[0]?.c ?? null,
    defaultGasSolPerTransaction: 0.0035,
  });
  const options: MicroCapitalOptions = profile.options;
  for (const line of describeBacktestProfile(profile)) console.log(`[quote] ${line}`);

  /*
   * The live V1.1 config, PLUS the balancing swap that the harness has never charged
   * for. It is set here rather than in `liveV11Config` because turning it on inside
   * the shared config would change `npm run backtest:micro` too, and every figure
   * quoted from a previous micro run would stop reconciling with the code that
   * produced it.
   */
  const config: BacktestConfig = {
    ...liveV11Config(options),
    swapSlippagePct,
    swapGasSolPerLeg,
  };

  const solPools = solData.pools;
  const usdPools = usdData.pools;
  const bothPools = [...solPools, ...usdPools];

  if (usdPools.length === 0) {
    throw new Error(
      "[quote] the USDC arm is EMPTY — nothing to compare. Re-run with --refresh.",
    );
  }

  /*
   * ONE TVL model, calibrated on the survivors of BOTH arms.
   *
   * Calibrating per arm would give each a different k, and every entry gate runs
   * against k x volume — so a difference in the fitted constant would read as a
   * difference between quote assets. The confound has to be removed, not reported.
   */
  const calibrationSet: DlmmPool[] = bothPools
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
  if (tvlModel.samples === 0) {
    throw new Error("[quote] TVL model could not be calibrated: no usable survivor pools");
  }

  const run = (label: string, pools: PoolHistory[]): BacktestResult =>
    runSimulation({ label, pools, solUsdBars, tvlModel, config });

  console.log("\n[quote] simulating…\n");

  const arms: Arm[] = [
    { label: "SOL-quoted", pools: solPools, result: run("sol-quoted", solPools) },
    { label: "USDC-quoted", pools: usdPools, result: run("usdc-quoted", usdPools) },
    { label: "BOTH", pools: bothPools, result: run("both", bothPools) },
  ];

  const adjusted = arms.map((a) => ({
    label: a.label,
    summary: summariseAdjusted(a.result.trades, solUsdBars),
  }));

  /*
   * The swap concession is the assumption the USDC arm is most exposed to, because it
   * pays it twice over. One number would be a guess presented as a result; the band
   * shows whether the ranking survives the whole plausible range.
   */
  const swapBand = SWAP_SLIPPAGE_BAND.map((slippagePct) => ({
    slippagePct,
    arms: [
      { label: "SOL", pools: solPools },
      { label: "USDC", pools: usdPools },
      { label: "BOTH", pools: bothPools },
    ].map(({ label, pools }) => ({
      label,
      result: runSimulation({
        label: `swap-${slippagePct}-${label}`,
        pools,
        solUsdBars,
        tvlModel,
        config: { ...config, swapSlippagePct: slippagePct },
      }),
    })),
  }));

  const solStart = solUsdBars[0]?.c ?? 0;
  const solEnd = solUsdBars[solUsdBars.length - 1]?.c ?? 0;
  const solMovePct = solStart > 0 ? (solEnd / solStart - 1) * 100 : NaN;

  /* ---- Report ---- */
  const out: string[] = [];
  const h = (title: string): void => {
    out.push("", "═".repeat(84), title, "═".repeat(84), "");
  };

  const head = arms[0] as Arm;

  h("QUOTE-ASSET COMPARISON — SOL-QUOTED vs USDC-QUOTED, LIVE V1.1 RULES");
  out.push(
    `Window          : ${head.result.windowStart.slice(0, 16)} → ${head.result.windowEnd.slice(0, 16)} ` +
      `(${head.result.barsSimulated} hourly bars)`,
    `SOL/USD         : ${usd(solStart)} → ${usd(solEnd)} (${pct(solMovePct)} over the window)`,
    `Universe        : ${solPools.length} SOL-quoted + ${usdPools.length} USDC-quoted pools`,
    `TVL model       : ${describeTvlModel(tvlModel)} (calibrated on BOTH arms)`,
    ...describeBacktestProfile(profile),
    `Account         : ${usd(options.capitalUsd, 0)}, ${options.positionSizePct.toFixed(2)}% per position, ` +
      `max ${options.maxConcurrentPositions} concurrent — identical in every arm`,
    `Gates           : age>=${config.minPoolAgeHours}h · surge1h<=${config.maxPriceSurge1hPct}% · ` +
      `TVL $${(config.minTvlUsd / 1000).toFixed(0)}k-$${(config.maxTvlUsd / 1000).toFixed(0)}k · ` +
      `fee coverage>=${config.minFeeCostCoverage}x`,
    `Exits           : TP +${config.takeProfitNetPct}% net · SL ${config.stopLossPct}% net · ` +
      `timeout ${config.maxDurationHours}h · range -${config.downsideCoverPct}%/+${config.upsideCoverPct}%`,
    `Balancing swap  : ${config.swapSlippagePct}% per leg + ${config.swapGasSolPerLeg} SOL gas per leg — ` +
      "2 legs for a SOL-quoted pool, 4 for a USDC-quoted one",
  );

  h("1. HEADLINE — same rules, same capital, different quote asset");
  out.push(armTable(arms));
  out.push(
    "",
    "BOTH is not the sum of the two arms: it runs one account over the union, so the",
    "arms compete for the same position slots. A BOTH result below the better single",
    "arm means the extra candidates displaced better ones.",
  );

  h("2. THE SOL-BETA CORRECTION — the one asymmetry between the arms");
  out.push(adjustedTable(adjusted));
  out.push(
    "",
    "The engine values a position in its QUOTE asset. For a USDC pool that is already",
    "a USD figure. For a SOL pool it is a SOL figure carried on a USD notional, so the",
    `engine's PnL silently assumes SOL/USD was flat; it moved ${pct(solMovePct)} here.`,
    "'Net PnL (USD)' folds that move back in. It is a DIAGNOSTIC — the engine is not",
    "changed, because redefining a historical PnL column is worse than reporting a gap.",
  );

  h("3. POOL COMPOSITION — is the USDC universe even the same shape?");
  out.push(compositionTable(arms));
  out.push(
    "",
    "The two bin columns are the live execution cap, not a screening result:",
    `LIVE_MAX_POSITION_BINS=${env.LIVE_MAX_POSITION_BINS} is the interim breaker while the wide path is`,
    "unvalidated, and 1400 is the program limit. A pool over the cap is refused before",
    "the model sees it, so an arm that wins on PnL but sits above the cap is not",
    "tradeable today no matter what this table says about its economics.",
  );

  h("4. THE SWAP LEGS — the cost USDC support actually buys");
  out.push(swapBandTable(swapBand));
  out.push(
    "",
    "A SOL-quoted entry swaps HALF the deposit into the other token and swaps it back:",
    "two legs, 1.0x the position through the book per round trip. A USDC-quoted pool",
    "holds neither asset the wallet has, so BOTH halves convert — four legs, 2.0x.",
    "",
    "This cost was not modelled here before at all: gas covered two transactions and",
    "slippage only forced exits, so the swap that runs on EVERY entry was free. It is",
    "charged at the entry gate as well as at the close, so the bar the screener",
    "advertises is the bar it enforces.",
    "",
    "0.50% is the on-chain ceiling, not a pessimistic guess: HARD_MAX_SLIPPAGE_BPS is",
    "50 bps and Jupiter's otherAmountThreshold rejects a worse fill. Read the ranking,",
    "and trust it only where it holds across the whole band.",
  );

  h("5. EXIT TRIGGER DISTRIBUTION");
  out.push(exitTable(arms));

  h("6. CAVEATS");
  out.push(
    ...BACKTEST_CAVEATS.map((c, i) => `${i + 1}. ${c}`),
    `${BACKTEST_CAVEATS.length + 1}. Each arm is a SAMPLE of its sub-universe, ingested to the same pool ` +
      "count. Pool-level dispersion at this sample size is large relative to the difference between " +
      "the arms; read the direction and the composition table, not the third decimal.",
    `${BACKTEST_CAVEATS.length + 2}. This measures the ECONOMICS of the two sub-universes only. It does ` +
      "not model the extra SOL->USDC swap leg a USDC entry would need, nor its slippage, nor the " +
      "second unwind on exit — all of which make the USDC arm strictly more expensive than shown.",
  );

  const report = out.join("\n");
  console.log(report);

  writeFileSync(
    resolve(process.cwd(), OUTPUT_PATH),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        windowDays: days,
        solUsdStart: solStart,
        solUsdEnd: solEnd,
        solMovePct,
        config,
        arms: arms.map((a) => ({
          label: a.label,
          pools: a.pools.map((p) => ({
            address: p.address,
            pairName: p.pairName,
            cohort: p.cohort,
            binStep: p.binStep,
            tvlTodayUsd: p.tvlTodayUsd,
            quoteIsUsd: p.quoteIsUsd,
          })),
          summary: a.result.summary,
          trades: a.result.trades,
        })),
        solAdjusted: adjusted,
        swapSlippageBand: swapBand.map((b) => ({
          slippagePct: b.slippagePct,
          arms: b.arms.map((a) => ({ label: a.label, summary: a.result.summary })),
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[quote] wrote ${OUTPUT_PATH}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
