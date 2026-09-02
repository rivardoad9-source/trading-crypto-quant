/**
 * 365-day backtest of the LIVE V1.1 formula on a $100 account, with a daily returns
 * export for the QuantStats-style tear sheet.
 *
 *   npm run backtest:annual
 *   npm run backtest:annual -- --days=365 --capital=100 --refresh
 *   npm run report:quant                     # renders the tear sheet from the export
 *
 * Relationship to the other runners:
 *
 *   npm run backtest        generic configuration sweep, guardrails OFF by default
 *   npm run backtest:micro  91-day window, live V1.1 guardrails, sensitivity battery
 *   npm run backtest:annual THIS — same guardrails, 365-day window, + daily curve
 *
 * The configuration is `liveV11Config()` from `runMicroCapital.ts`, imported rather
 * than re-declared, so "the live V1.1 configuration" keeps exactly one definition and
 * this runner cannot drift from the engine it claims to measure.
 *
 * Deploys ZERO real capital and signs nothing on-chain.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { runSimulation, type BacktestConfig, type BacktestResult } from "./engine.js";
import {
  BACKTEST_CAVEATS,
  FREE_TIER_HISTORY_DAYS,
  historyDepthLimitHit,
  loadHistoricalData,
} from "./historicalData.js";
import { calibrateTvlModel, describeTvlModel, type TvlModel } from "./tvlModel.js";
import { renderTable } from "./report.js";
import { liveV11Config, withoutAntiChurn, type MicroCapitalOptions } from "./runMicroCapital.js";
import { activeDays, buildDailyCurve, curveToCsv, type DailyPoint } from "./annualCurve.js";
import type { DlmmPool } from "../services/meteora.js";

const CACHE_PATH = ".cache/historical_data_annual.json";
const OUT_DIR = "reports/annual";

/**
 * Absolute bar floor for the annual window.
 *
 * The default proportional floor (15% of the window) would demand 54 days of history
 * on a 365-day run and so reject exactly the short-lived pools the dead cohort exists
 * to capture — silently reinstating the survivorship bias the harness controls for.
 * Seven days is enough to evaluate a 24-bar trailing window and still hold a position.
 */
const MIN_BARS_ANNUAL = 24 * 7;

const usd = (n: number, d = 2): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`;
const pct = (n: number, d = 2): string => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(d)}%`;
const num = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : "—");
const pf = (v: number | null): string => (v === null ? "undefined" : num(v));

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

const TRADE_COLUMNS = [
  "entry_time",
  "exit_time",
  "pair_name",
  "pool_address",
  "cohort",
  "duration_hours",
  "notional_usd",
  "modelled_tvl_at_entry_usd",
  "fees_earned_usd",
  "position_value_change_usd",
  "divergence_vs_hold_usd",
  "gas_cost_usd",
  "slippage_cost_usd",
  "net_pnl_usd",
  "net_pnl_pct",
  "exit_reason",
  "rugged",
  "catastrophic",
  "bars_held",
  "bars_out_of_range",
] as const;

/** Quotes any field containing a comma or quote, so a pair name cannot break the file. */
const csvCell = (value: string | number | boolean): string => {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function tradesToCsv(result: BacktestResult): string {
  const lines = [TRADE_COLUMNS.join(",")];
  for (const t of result.trades) {
    lines.push(
      [
        t.entryTime,
        t.exitTime,
        t.pairName,
        t.poolAddress,
        t.cohort,
        t.durationHours.toFixed(3),
        t.notionalUsd.toFixed(6),
        t.modelledTvlAtEntryUsd.toFixed(2),
        t.feesEarnedUsd.toFixed(6),
        t.positionValueChangeUsd.toFixed(6),
        t.divergenceVsHoldUsd.toFixed(6),
        t.gasCostUsd.toFixed(6),
        t.slippageCostUsd.toFixed(6),
        t.netPnlUsd.toFixed(6),
        t.netPnlPct.toFixed(4),
        t.exitReason,
        t.rugged,
        t.catastrophic,
        t.barsHeld,
        t.barsOutOfRange,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

const write = (relativePath: string, contents: string): string => {
  const full = resolve(process.cwd(), relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
  return full;
};

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

function portfolioTable(result: BacktestResult, curve: DailyPoint[]): string {
  const s = result.summary;
  const friction = s.totalGasCostUsd + s.totalSlippageCostUsd;
  const days = curve.length;
  const active = activeDays(curve);

  return renderTable(
    [{ header: "Metric" }, { header: "Value", align: "right" }],
    [
      ["Initial balance", usd(s.startingEquityUsd)],
      ["Final equity", usd(s.endingEquityUsd)],
      ["Net realized PnL ($)", usd(s.netPnlUsd)],
      ["Net realized PnL (%)", pct(s.returnPct)],
      ["", ""],
      ["Calendar days", String(days)],
      ["Days with a close", `${active} (${pct((active / Math.max(days, 1)) * 100, 1)})`],
      ["Total trades", String(s.totalTrades)],
      ["Trades per month", days > 0 ? num((s.totalTrades / days) * 30.44, 1) : "—"],
      ["Wins / losses", `${s.wins} / ${s.losses}`],
      ["Win rate", pct(s.winRatePct)],
      ["Profit factor", pf(s.profitFactor)],
      ["Avg trade duration", `${num(s.avgTradeDurationHours, 1)} h`],
      ["", ""],
      ["Max drawdown ($)", usd(s.maxDrawdownUsd)],
      ["Max drawdown (%)", pct(s.maxDrawdownPct)],
      ["", ""],
      ["Gross fees earned", usd(s.totalFeesUsd)],
      ["LP value change", usd(s.totalPositionValueChangeUsd)],
      ["Gas paid", usd(s.totalGasCostUsd)],
      ["Slippage paid", usd(s.totalSlippageCostUsd)],
      ["TOTAL FRICTION PAID", usd(friction)],
      ["Friction vs gross fees", s.totalFeesUsd > 0 ? `${num(friction / s.totalFeesUsd)}x` : "—"],
      ["", ""],
      ["Trades on dead pools", String(s.tradesOnDeadPools)],
      ["Rugged exits", String(s.ruggedTrades)],
      ["Catastrophic (<= -80%)", String(s.catastrophicTrades)],
      ["Account wiped out", s.accountWipedOut ? "YES" : "no"],
    ],
  );
}

function comparisonTable(labelled: Array<{ label: string; result: BacktestResult }>): string {
  return renderTable(
    [
      { header: "Scenario" },
      { header: "Trades", align: "right" },
      { header: "Win rate", align: "right" },
      { header: "Profit factor", align: "right" },
      { header: "Net PnL", align: "right" },
      { header: "Final equity", align: "right" },
      { header: "Max DD", align: "right" },
      { header: "Friction", align: "right" },
    ],
    labelled.map(({ label, result }) => {
      const s = result.summary;
      return [
        label,
        String(s.totalTrades),
        pct(s.winRatePct, 1),
        pf(s.profitFactor),
        usd(s.netPnlUsd),
        usd(s.endingEquityUsd),
        pct(s.maxDrawdownPct, 1),
        usd(s.totalGasCostUsd + s.totalSlippageCostUsd),
      ];
    }),
  );
}

function gateTable(result: BacktestResult): string {
  const entries = Object.entries(result.gateRejections).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "(no entry was ever rejected)";
  const total = entries.reduce((s, [, n]) => s + n, 0);
  return renderTable(
    [
      { header: "Gate" },
      { header: "Rejections", align: "right" },
      { header: "Share", align: "right" },
    ],
    entries.map(([gate, n]) => [gate, String(n), pct((n / total) * 100, 1)]),
  );
}

/**
 * Per-pool data coverage.
 *
 * GeckoTerminal's free hourly OHLCV does not necessarily reach back a full year for
 * every pool. A pool with 90 days of bars contributes nothing to the first nine
 * months of the window, so "365-day backtest" would overstate what was simulated.
 * This table is how that shortfall stays visible.
 */
function coverageTable(
  pools: Array<{ pairName: string; cohort: string; bars: number }>,
  requestedDays: number,
): string {
  const wanted = requestedDays * 24;
  const sorted = [...pools].sort((a, b) => b.bars - a.bars);
  return renderTable(
    [
      { header: "Pool" },
      { header: "Cohort" },
      { header: "Bars", align: "right" },
      { header: "Days", align: "right" },
      { header: "Coverage", align: "right" },
    ],
    sorted.map((p) => [
      p.pairName.slice(0, 24),
      p.cohort,
      String(p.bars),
      num(p.bars / 24, 1),
      pct((p.bars / wanted) * 100, 1),
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

function parseArgs(argv: string[]): {
  days: number;
  pools: number;
  deadPools: number;
  refresh: boolean;
  options: MicroCapitalOptions;
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
    days: n("days", 365),
    pools: n("pools", 14),
    deadPools: n("deadpools", 20),
    refresh: flags.has("refresh"),
    options: {
      capitalUsd: n("capital", 100),
      positionSizePct: n("sizepct", 27.5),
      maxConcurrentPositions: n("concurrent", env.MAX_CONCURRENT_POSITIONS),
      gasSolPerTransaction: n("gas", 0.0035),
    },
  };
}

async function main(): Promise<void> {
  const { days, pools, deadPools, refresh, options } = parseArgs(process.argv.slice(2));
  const config = liveV11Config(options);

  console.log(
    `\n[annual] ${days}-day window · $${options.capitalUsd} account · ` +
      `${options.positionSizePct}% per position · max ${options.maxConcurrentPositions} concurrent`,
  );
  console.log(
    `[annual] a cold fetch of ${pools + deadPools} pools x ${days * 24} hourly bars takes ` +
      `15-30 minutes against GeckoTerminal's free tier; results are cached at ${CACHE_PATH}.`,
  );

  const dataset = await loadHistoricalData({
    poolCount: pools,
    deadPoolCount: deadPools,
    windowDays: days,
    cachePath: CACHE_PATH,
    force: refresh,
    minBars: MIN_BARS_ANNUAL,
    // Survivors are drawn from the strategy's own TVL band. Without this the survivor
    // arm is SOL-USDC-scale pools that MAX_TVL_USD rejects outright, it makes zero
    // trades, and the survivorship comparison degenerates into "one side never traded".
    survivorTvlBand: { minUsd: env.MIN_TVL_USD, maxUsd: env.MAX_TVL_USD },
  });

  const survivors = dataset.pools.filter((p) => p.cohort === "survivor");
  const dead = dataset.pools.filter((p) => p.cohort === "dead-or-dormant");

  /*
   * How much of the requested window the data source actually supplied.
   *
   * GeckoTerminal's keyless tier serves roughly FREE_TIER_HISTORY_DAYS of hourly
   * OHLCV and answers 401 beyond it. A 365-day request therefore comes back as a
   * ~6-month series, and reporting it as "the 365-day backtest" would be a false
   * claim about the evidence. The shortfall is surfaced here, in the header, and in
   * the caveats, so the number the user quotes carries its own window with it.
   */
  const referenceSeriesDays =
    dataset.solUsdBars.length > 1
      ? (dataset.solUsdBars.at(-1)!.t - dataset.solUsdBars[0]!.t) / 86_400
      : 0;

  if (referenceSeriesDays < days - 1) {
    console.warn(
      `
[annual] WARNING: requested ${days} days, the SOL/USD reference series spans ` +
        `${referenceSeriesDays.toFixed(1)}. GeckoTerminal's keyless tier caps hourly OHLCV at ` +
        `roughly ${FREE_TIER_HISTORY_DAYS} days` +
        (historyDepthLimitHit() ? " (HTTP 401 on the deeper pages)" : "") +
        `. Set COINGECKO_PRO_API_KEY for the full year; without it this is not an ` +
        `annual backtest. The simulated window is reported below.
`,
    );
  }

  // Calibrated on survivors only: they are the pools where TVL and volume are both
  // observable today. Applying the fit to the dead cohort is the point — their current
  // TVL is ~0 and useless as an anchor.
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
    throw new Error("[annual] TVL model could not be calibrated: no usable survivor pools");
  }

  const run = (label: string, poolSet: typeof dataset.pools, cfg: BacktestConfig) =>
    runSimulation({ label, pools: poolSet, solUsdBars: dataset.solUsdBars, tvlModel, config: cfg });

  console.log("[annual] simulating…\n");
  const unbiased = run("annual-unbiased-v11", dataset.pools, config);
  const noChurn = run("annual-no-anti-churn", dataset.pools, withoutAntiChurn(config));
  const biased = run("annual-survivors-only", survivors, config);

  // The honest error bar on the headline. Fee income scales as 1/k, and the fitted k
  // has an IQR spanning roughly a factor of five, so the quartile runs are not a
  // refinement — they are the uncertainty.
  const scaleK = (targetK: number): TvlModel => {
    const factor = tvlModel.medianK > 0 ? targetK / tvlModel.medianK : 1;
    return {
      ...tvlModel,
      medianK: targetK,
      perPoolK: Object.fromEntries(
        Object.entries(tvlModel.perPoolK).map(([a, k]) => [a, k * factor]),
      ),
    };
  };
  const kBand = [
    { label: `k = p25 (${num(tvlModel.p25K, 3)}) — fees richer`, model: scaleK(tvlModel.p25K) },
    { label: `k = median (${num(tvlModel.medianK, 3)}) — headline`, model: tvlModel },
    { label: `k = p75 (${num(tvlModel.p75K, 3)}) — fees thinner`, model: scaleK(tvlModel.p75K) },
  ].map(({ label, model }) => ({
    label,
    result: runSimulation({
      label,
      pools: dataset.pools,
      solUsdBars: dataset.solUsdBars,
      tvlModel: model,
      config,
    }),
  }));

  /* ---- Daily curve ---- */
  const curve = buildDailyCurve(
    unbiased.trades,
    unbiased.summary.startingEquityUsd,
    Date.parse(unbiased.windowStart),
    Date.parse(unbiased.windowEnd),
  );

  /*
   * The authoritative coverage figure is the window actually SIMULATED — the span of
   * pool bars the engine walked — not the reference series, which can differ. Every
   * other number in this report describes that window, so the shortfall must be
   * measured against the same thing.
   */
  const achievedDays = curve.length;
  const shortfall = achievedDays < days - 1;

  const dailyCsvPath = write(`${OUT_DIR}/daily_returns.csv`, curveToCsv(curve));
  const tradesCsvPath = write(`${OUT_DIR}/trades.csv`, tradesToCsv(unbiased));

  /* ---- Report ---- */
  const out: string[] = [];
  const h = (title: string): void => {
    out.push("", "═".repeat(78), title, "═".repeat(78), "");
  };

  h(`ANNUAL BACKTEST — LIVE V1.1 FORMULA, $${options.capitalUsd} ACCOUNT`);
  out.push(
    `Window          : ${unbiased.windowStart.slice(0, 10)} → ${unbiased.windowEnd.slice(0, 10)} ` +
      `(${unbiased.barsSimulated} hourly bars, ${curve.length} calendar days)`,
    `Data coverage   : ${achievedDays} of ${days} days requested` +
      (shortfall
        ? `  ** SHORT — upstream caps hourly OHLCV at ~${FREE_TIER_HISTORY_DAYS} days without a paid key **`
        : "  (full)"),
    `Universe        : ${dataset.pools.length} pools — ${survivors.length} survivors + ${dead.length} dead/dormant`,
    `TVL model       : ${describeTvlModel(tvlModel)}`,
    `Sizing          : ${options.positionSizePct}% of equity per position, ` +
      `max ${options.maxConcurrentPositions} concurrent, capped at free capital`,
    `Friction        : ${options.gasSolPerTransaction} SOL/tx x2 per position, ` +
      `${config.forcedExitSlippagePct}% forced-exit slippage`,
    `Gates           : age>=${config.minPoolAgeHours}h · surge1h<=${config.maxPriceSurge1hPct}% · ` +
      `TVL $${(config.minTvlUsd / 1000).toFixed(0)}k-$${(config.maxTvlUsd / 1000).toFixed(0)}k · ` +
      `fee coverage>=${config.minFeeCostCoverage}x · 24h move<=${config.maxPriceChange24hPct}%`,
    `Exits           : TP +${config.takeProfitNetPct}% net · SL ${config.stopLossPct}% net · ` +
      `timeout ${config.maxDurationHours}h · range -${config.downsideCoverPct}%/+${config.upsideCoverPct}%`,
    `Anti-churn      : ${config.poolCooldownHours}h cooldown · ` +
      `${config.lockoutConsecutiveFailures} consecutive failures → ${config.lockoutHours}h lockout`,
  );

  h("1. HEADLINE — UNBIASED UNIVERSE, FULL V1.1 GUARDRAILS");
  out.push(portfolioTable(unbiased, curve));

  h("2. GUARDRAIL A/B — anti-churn gates ON vs OFF");
  out.push(
    comparisonTable([
      { label: "WITH cooldown+lockout (V1.1)", result: unbiased },
      { label: "WITHOUT anti-churn", result: noChurn },
    ]),
    "",
    `Cooldown blocked ${unbiased.gateRejections.cooldown ?? 0} candidate entries; ` +
      `the lockout blocked ${unbiased.gateRejections.lockout ?? 0}.`,
  );

  h("3. SURVIVORSHIP BIAS — same rules, survivors only vs full universe");
  out.push(
    comparisonTable([
      { label: "BIASED (survivors only)", result: biased },
      { label: "UNBIASED (incl. dead)", result: unbiased },
    ]),
  );
  if (dead.length === 0) {
    out.push(
      "",
      "WARNING: the dead cohort is EMPTY, so these two runs are identical and this",
      "comparison proves nothing. Re-run with --refresh.",
    );
  }

  h("4. TVL-MODEL SENSITIVITY — the load-bearing assumption, stressed");
  out.push(comparisonTable(kBand));

  h("5. COHORT COMPOSITION — which cohort did the trades actually come from?");
  {
    const byCohort = new Map<string, { trades: number; pnl: number }>();
    for (const t of unbiased.trades) {
      const row = byCohort.get(t.cohort) ?? { trades: 0, pnl: 0 };
      row.trades++;
      row.pnl += t.netPnlUsd;
      byCohort.set(t.cohort, row);
    }
    const poolsByCohort = new Map<string, number>();
    for (const p of dataset.pools) {
      poolsByCohort.set(p.cohort, (poolsByCohort.get(p.cohort) ?? 0) + 1);
    }
    out.push(
      renderTable(
        [
          { header: "Cohort" },
          { header: "Pools offered", align: "right" },
          { header: "Trades", align: "right" },
          { header: "Share of trades", align: "right" },
          { header: "Net PnL", align: "right" },
        ],
        [...poolsByCohort.entries()].map(([cohort, poolCount]) => {
          const row = byCohort.get(cohort) ?? { trades: 0, pnl: 0 };
          return [
            cohort,
            String(poolCount),
            String(row.trades),
            unbiased.summary.totalTrades > 0
              ? pct((row.trades / unbiased.summary.totalTrades) * 100, 1)
              : "—",
            usd(row.pnl),
          ];
        }),
      ),
    );
    if (unbiased.summary.totalTrades > 0 && byCohort.size === 1) {
      out.push(
        "",
        `WARNING: every trade came from the "${[...byCohort.keys()][0]}" cohort. That is a`,
        "selection artefact of the universe or the TVL model, not a property of the",
        "strategy. Treat the headline PnL as describing that cohort only.",
      );
    }
  }

  h("6. DATA COVERAGE — how much of the year each pool actually supplied");
  out.push(
    coverageTable(unbiased.poolsSimulated, days),
    "",
    "GeckoTerminal's free hourly OHLCV does not reach back a full year for every pool.",
    "A pool with partial coverage contributes nothing to the months it does not span,",
    "so the effective universe is thinner early in the window than the pool count suggests.",
  );

  h("7. WHY ENTRIES WERE REFUSED");
  out.push(
    gateTable(unbiased),
    "",
    `Bars with no eligible candidate: ${unbiased.barsWithNoCandidate} of ${unbiased.barsSimulated}.`,
  );

  const caveats = [
    ...BACKTEST_CAVEATS,
    ...(shortfall
      ? [
          `WINDOW SHORTFALL: ${days} days were requested but only ${achievedDays} were simulated. ` +
            `GeckoTerminal's keyless tier serves roughly ${FREE_TIER_HISTORY_DAYS} days of hourly OHLCV and ` +
            `answers HTTP 401 beyond it; daily aggregation is capped at the same depth, so a coarser ` +
            `timeframe buys no history. Every figure in this report describes the ` +
            `${achievedDays}-day window actually simulated. Set COINGECKO_PRO_API_KEY to obtain ` +
            `the full year.`,
        ]
      : []),
    "The daily returns series is REALISED-ONLY: equity steps when a position closes, never on open floating PnL. Days with no close read 0.00%, which understates daily volatility and therefore FLATTERS every daily-sampled ratio (Sharpe, Sortino, Ulcer). The share of active days is reported above so the distortion is visible; read the trade-level statistics as primary and the daily ratios as indicative.",
    "Monthly and yearly figures are calendar aggregates of that realised curve. With a small trade count a single month can be one trade, so a 'best month' is often one position rather than a rate of return.",
    `Every calendar year in the EOY table is PARTIAL: the simulated window runs ` +
      `${unbiased.windowStart.slice(0, 10)} to ${unbiased.windowEnd.slice(0, 10)}, so a year's row ` +
      `is the cumulative return over the months it covers, not an annual rate. Partial years of ` +
      `different lengths are not comparable with each other.`,
  ];

  h("CAVEATS — READ BEFORE QUOTING ANY NUMBER ABOVE");
  caveats.forEach((c, i) => out.push(`${i + 1}. ${c}`, ""));

  const report = out.join("\n");
  console.log(report);

  const jsonPath = write(
    `${OUT_DIR}/backtest_annual.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataSource: "GeckoTerminal hourly OHLCV + Meteora point-in-time pool universe",
        dataFetchedAt: dataset.fetchedAt,
        windowDaysRequested: days,
        windowDaysAchieved: achievedDays,
        referenceSeriesDays: Number(referenceSeriesDays.toFixed(2)),
        windowShortfall: shortfall,
        freeTierHistoryDays: FREE_TIER_HISTORY_DAYS,
        windowStart: unbiased.windowStart,
        windowEnd: unbiased.windowEnd,
        caveats,
        config,
        sizing: options,
        tvlModel: {
          medianK: tvlModel.medianK,
          p25K: tvlModel.p25K,
          p75K: tvlModel.p75K,
          samples: tvlModel.samples,
        },
        universe: {
          survivors: survivors.length,
          dead: dead.length,
          pools: unbiased.poolsSimulated,
        },
        activeDays: activeDays(curve),
        dailyCurve: curve,
        scenarios: {
          unbiased,
          noChurn: { summary: noChurn.summary },
          biased: { summary: biased.summary },
          kBand: kBand.map(({ label, result }) => ({ label, summary: result.summary })),
        },
      },
      null,
      2,
    ),
  );

  console.log(`\n[annual] daily returns  → ${dailyCsvPath}`);
  console.log(`[annual] trade log      → ${tradesCsvPath}`);
  console.log(`[annual] full results   → ${jsonPath}`);
  console.log(`[annual] next step      → npm run report:quant`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[annual] failed:", err);
    process.exit(1);
  });
}
