/**
 * Micro-capital survivorship- and lookahead-controlled backtest of the LIVE V1.1 formula
 * and guardrails, on the LIVE account profile (see `liveProfile.ts`).
 *
 *   npm run backtest:micro
 *   npm run backtest:micro -- --days=91 --refresh
 *   npm run backtest:micro -- --capital=100 --sizepct=27.5 --concurrent=3   # a different account, flagged
 *
 * Distinct from `npm run backtest`, which sweeps a generic configuration. This runner
 * pins every entry gate, exit rule and friction parameter to the value the live engine
 * actually reads from `src/config/env.ts`, then answers three questions:
 *
 *   1. What would $100 have done over the window, on a universe that INCLUDES pools
 *      which died inside it?
 *   2. How much of the result is survivorship bias? (same config, survivors only)
 *   3. What does the 4h pool cooldown plus the 24h consecutive-loss lockout actually
 *      buy on an account this small? (same config, anti-churn gates disabled)
 *
 * Deploys ZERO real capital and signs nothing on-chain.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import {
  defaultBacktestConfig,
  runSimulation,
  type BacktestConfig,
  type BacktestResult,
  type ExitReason,
} from "./engine.js";
import { BACKTEST_CAVEATS, loadHistoricalData } from "./historicalData.js";
import { calibrateTvlModel, describeTvlModel, type TvlModel } from "./tvlModel.js";
import { renderTable } from "./report.js";
import {
  describeBacktestProfile,
  readProfileOverrides,
  resolveBacktestProfile,
  type BacktestAccountOptions,
  type ProfileOverrides,
} from "./liveProfile.js";
import type { DlmmPool } from "../services/meteora.js";

const CACHE_PATH = ".cache/historical_data_micro.json";
const OUTPUT_PATH = "backtest_micro_capital.json";

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const usd = (n: number, d = 2): string =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`;
const pct = (n: number, d = 2): string => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(d)}%`;
const num = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : "—");
/** Profit factor is null when there were no losing trades; that is not zero. */
const pf = (v: number | null): string => (v === null ? "undefined" : num(v));

/* ------------------------------------------------------------------ */
/* Configuration — mirrors the LIVE V1.1 engine                        */
/* ------------------------------------------------------------------ */

/** The simulated account. Defaults come from the LIVE profile — see `liveProfile.ts`. */
export type MicroCapitalOptions = BacktestAccountOptions;

/**
 * Builds the backtest configuration from the live environment.
 *
 * Every GATE here is read from `env` rather than hard-coded, so the backtest cannot
 * silently drift from the engine it claims to be measuring. The same now holds for the
 * INPUTS: the account `options` every runner passes in is resolved by
 * `resolveBacktestProfile` from LIVE_CAPITAL_SOL / LIVE_MAX_POSITION_SOL, not from the
 * $100 x 27.5% x 3 demo account the runners used to default to — which made a report
 * describe an account live never runs. A flag can still override it, and the header then
 * says so. The two deliberate differences in the gates are documented inline.
 */
export function liveV11Config(options: MicroCapitalOptions): BacktestConfig {
  return {
    ...defaultBacktestConfig(),

    /* ---- Portfolio ---- */
    startingCapitalUsd: options.capitalUsd,
    positionSizePct: options.positionSizePct,
    maxConcurrentPositions: options.maxConcurrentPositions,

    /* ---- Entry gates: the four hard rules plus the fee/TVL band ---- */
    minPoolAgeHours: env.MIN_POOL_AGE_HOURS,
    maxPriceSurge1hPct: env.MAX_PRICE_SURGE_1H_PCT,
    minTvlUsd: env.MIN_TVL_USD,
    maxTvlUsd: env.MAX_TVL_USD,
    minFeeCostCoverage: env.MIN_FEE_COST_COVERAGE,
    minFeeTvlRatio: env.MIN_FEE_TVL_RATIO,
    maxFeeTvlRatio: env.MAX_FEE_TVL_RATIO,
    maxPriceChange24hPct: env.MAX_PRICE_CHANGE_24H_PCT,
    minVolume24hUsd: env.MIN_24H_VOLUME_USD,

    /* ---- Range: the floors computeBinRange clamps to ---- */
    downsideCoverPct: env.MIN_DOWNSIDE_COVER_PCT,
    upsideCoverPct: env.MIN_UPSIDE_COVER_PCT,

    /* ---- Exits ---- */
    /*
     * takeProfitNetPct is the one that mirrors the live engine: `evaluateExit`
     * compares TAKE_PROFIT_PCT against NET PnL (fees + LP value change). The
     * fee-only take-profit has no live equivalent, so it is disabled outright —
     * leaving it on would fire an exit the live engine does not have.
     */
    takeProfitNetPct: env.TAKE_PROFIT_PCT,
    takeProfitFeePct: Number.POSITIVE_INFINITY,
    stopLossPct: env.STOP_LOSS_PCT,
    maxDurationHours: env.MAX_POSITION_AGE_HOURS,

    /* ---- Anti-churn ---- */
    poolCooldownHours: env.POOL_COOLDOWN_HOURS,
    lockoutConsecutiveFailures: env.POOL_LOCKOUT_CONSECUTIVE_FAILURES,
    lockoutHours: env.POOL_LOCKOUT_HOURS,

    /* ---- Friction ---- */
    gasSolPerTransaction: options.gasSolPerTransaction,
    forcedExitSlippagePct: env.FORCED_EXIT_SLIPPAGE_PCT,
  };
}

/** The anti-churn gates switched off, for the A/B. Nothing else changes. */
export const withoutAntiChurn = (config: BacktestConfig): BacktestConfig => ({
  ...config,
  poolCooldownHours: 0,
  lockoutConsecutiveFailures: 0,
  lockoutHours: 0,
});

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
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

function portfolioTable(result: BacktestResult): string {
  const s = result.summary;
  const frictionUsd = s.totalGasCostUsd + s.totalSlippageCostUsd;

  return renderTable(
    [{ header: "Metric" }, { header: "Value", align: "right" }],
    [
      ["Initial balance", usd(s.startingEquityUsd)],
      ["Final equity", usd(s.endingEquityUsd)],
      ["Net realized PnL ($)", usd(s.netPnlUsd)],
      ["Net realized PnL (%)", pct(s.returnPct)],
      ["", ""],
      ["Total trades", String(s.totalTrades)],
      ["Wins / losses", `${s.wins} / ${s.losses}`],
      ["Win rate", pct(s.winRatePct)],
      ["Profit factor", pf(s.profitFactor)],
      ["", ""],
      ["Max drawdown ($)", usd(s.maxDrawdownUsd)],
      ["Max drawdown (%)", pct(s.maxDrawdownPct)],
      ["", ""],
      ["Gross fees earned", usd(s.totalFeesUsd)],
      ["LP value change", usd(s.totalPositionValueChangeUsd)],
      ["Gas paid", usd(s.totalGasCostUsd)],
      ["Slippage paid", usd(s.totalSlippageCostUsd)],
      ["TOTAL FRICTION PAID", usd(frictionUsd)],
      [
        "Friction as % of capital",
        s.startingEquityUsd > 0 ? pct((frictionUsd / s.startingEquityUsd) * 100) : "—",
      ],
      [
        "Friction vs gross fees",
        s.totalFeesUsd > 0 ? `${num(frictionUsd / s.totalFeesUsd)}x` : "—",
      ],
      ["", ""],
      ["Trades on dead pools", String(s.tradesOnDeadPools)],
      ["Rugged exits", String(s.ruggedTrades)],
      ["Catastrophic (<= -80%)", String(s.catastrophicTrades)],
      ["Account wiped out", s.accountWipedOut ? "YES" : "no"],
    ],
  );
}

function exitDistributionTable(result: BacktestResult): string {
  const counts = result.summary.exitReasonCounts;
  const total = result.summary.totalTrades;

  const rows = EXIT_ORDER.filter((r) => counts[r] > 0).map((reason) => {
    const hits = result.trades.filter((t) => t.exitReason === reason);
    const pnl = hits.reduce((s, t) => s + t.netPnlUsd, 0);
    return [
      reason,
      String(counts[reason]),
      total > 0 ? pct((counts[reason] / total) * 100, 1) : "—",
      usd(pnl),
      hits.length > 0 ? usd(pnl / hits.length) : "—",
    ];
  });

  if (rows.length === 0) rows.push(["(no trades)", "0", "—", "—", "—"]);

  return renderTable(
    [
      { header: "Exit trigger" },
      { header: "Count", align: "right" },
      { header: "Share", align: "right" },
      { header: "Net PnL", align: "right" },
      { header: "Avg/trade", align: "right" },
    ],
    rows,
  );
}

function comparisonTable(
  labelled: Array<{ label: string; result: BacktestResult }>,
): string {
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

/**
 * Why a run made few or no trades. Without this a zero-trade result is unreadable and
 * indistinguishable from a broken harness.
 */
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

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

function parseArgs(argv: string[]): {
  days: number;
  pools: number;
  deadPools: number;
  refresh: boolean;
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
    // Account inputs are NOT defaulted here: absent flags mean "the live profile",
    // resolved once the SOL/USD at the window start is known.
    overrides: readProfileOverrides(flags),
  };
}

/** The runner's gas assumption per transaction when `--gas` is not given. */
const DEFAULT_GAS_SOL_PER_TX = 0.0035;

async function main(): Promise<void> {
  const { days, pools, deadPools, refresh, overrides } = parseArgs(process.argv.slice(2));

  console.log(`\n[micro] ${days}-day window · account from the live profile unless overridden`);

  const dataset = await loadHistoricalData({
    poolCount: pools,
    deadPoolCount: deadPools,
    windowDays: days,
    cachePath: CACHE_PATH,
    force: refresh,
    /*
     * Survivors are drawn from the strategy's own TVL band, not from the raw volume
     * leaderboard. Without this the survivor arm is made of SOL-USDC-scale pools that
     * MAX_TVL_USD rejects outright, it makes zero trades, and the survivorship
     * comparison degenerates into "one side never traded".
     */
    survivorTvlBand: { minUsd: env.MIN_TVL_USD, maxUsd: env.MAX_TVL_USD },
  });

  const profile = resolveBacktestProfile({
    overrides,
    windowStartSolUsd: dataset.solUsdBars[0]?.c ?? null,
    defaultGasSolPerTransaction: DEFAULT_GAS_SOL_PER_TX,
  });
  const options = profile.options;
  const config = liveV11Config(options);
  for (const line of describeBacktestProfile(profile)) console.log(`[micro] ${line}`);

  const survivors = dataset.pools.filter((p) => p.cohort === "survivor");
  const dead = dataset.pools.filter((p) => p.cohort === "dead-or-dormant");

  /*
   * The TVL model is calibrated on the SURVIVOR cross-section only, because those are
   * the pools where TVL and volume are both observable today. Applying it to the dead
   * cohort is the whole point: their current TVL is ~0 and useless as an anchor.
   */
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
    throw new Error("[micro] TVL model could not be calibrated: no usable survivor pools");
  }

  const run = (label: string, poolSet: typeof dataset.pools, cfg: BacktestConfig) =>
    runSimulation({ label, pools: poolSet, solUsdBars: dataset.solUsdBars, tvlModel, config: cfg });

  console.log("[micro] simulating…\n");

  const unbiased = run("unbiased-v11", dataset.pools, config);
  const unbiasedNoChurn = run("unbiased-v11-no-cooldown", dataset.pools, withoutAntiChurn(config));
  const biased = run("biased-survivors-only", survivors, config);

  /*
   * Gas sensitivity.
   *
   * Gas is the single assumption this account size is most exposed to, and it is NOT
   * a measurement: no free provider serves a historical Solana priority-fee series
   * for the window, and a p75 sampled today describes today only. The band spans the
   * base fee alone (0.000005 SOL, what the live p75 estimator returns on an
   * uncongested network) up to a heavily congested multi-transaction round trip.
   */
  const gasBand = [0.000005, 0.0001, 0.0005, 0.001, 0.002, 0.0035, 0.01].map((gas) => ({
    gasSol: gas,
    result: run(`gas-${gas}`, dataset.pools, { ...config, gasSolPerTransaction: gas }),
  }));

  /*
   * Friction feasibility.
   *
   * `assessBreakeven` passes when notional x feeTvl >= coverage x (gasRoundTrip +
   * notional x slippage). Rearranged, that is a FLOOR on fee/TVL:
   *
   *   feeTvl >= coverage x (gasRoundTrip / notional + slippage)
   *
   * MAX_FEE_TVL_RATIO is a ceiling on the same quantity, so the two together define
   * the admissible window. On a small account the gas term is large, the floor rises
   * above the ceiling, and the window closes entirely — which is a structural fact
   * about the account size, not an artefact of any particular pool.
   */
  const medianSolUsd = (() => {
    const closes = dataset.solUsdBars.map((b) => b.c).sort((a, b) => a - b);
    return closes[Math.floor(closes.length / 2)] ?? 0;
  })();
  const notionalUsd = options.capitalUsd * (options.positionSizePct / 100);
  const feasibility = gasBand.map(({ gasSol, result }) => {
    const gasRoundTripUsd = gasSol * 2 * medianSolUsd;
    const floor =
      config.minFeeCostCoverage * (gasRoundTripUsd / notionalUsd + config.forcedExitSlippagePct / 100);
    return {
      gasSol,
      gasRoundTripUsd,
      requiredFeeTvl: floor,
      windowOpen: floor < config.maxFeeTvlRatio,
      trades: result.summary.totalTrades,
    };
  });

  /* ---- Report ---- */
  const out: string[] = [];
  const h = (title: string): void => {
    out.push("", "═".repeat(78), title, "═".repeat(78), "");
  };

  // The account size follows the flag. A hard-coded $100 in the header of a report run
  // with --capital=300 is the same defect class as a paper label over a live trade: the
  // number below it is right and the sentence above it is not.
  h(
    `MICRO-CAPITAL BACKTEST — LIVE V1.1 FORMULA, ${usd(options.capitalUsd, 0)} ACCOUNT` +
      (profile.matchesLive ? " (LIVE PROFILE)" : " — NOT THE LIVE PROFILE"),
  );
  out.push(
    ...describeBacktestProfile(profile),
    `Window          : ${unbiased.windowStart.slice(0, 16)} → ${unbiased.windowEnd.slice(0, 16)} ` +
      `(${unbiased.barsSimulated} hourly bars)`,
    `Universe        : ${dataset.pools.length} pools — ${survivors.length} survivors + ${dead.length} dead/dormant`,
    `TVL model       : ${describeTvlModel(tvlModel)}`,
    `Sizing          : ${options.positionSizePct}% of equity per position, ` +
      `max ${options.maxConcurrentPositions} concurrent, capped at free capital`,
    `Friction        : ${options.gasSolPerTransaction} SOL/tx x2 per position, ` +
      `${config.forcedExitSlippagePct}% forced-exit slippage`,
    `Gates           : age>=${config.minPoolAgeHours}h · surge1h<=${config.maxPriceSurge1hPct}% · ` +
      `TVL $${(config.minTvlUsd / 1000).toFixed(0)}k-$${(config.maxTvlUsd / 1000).toFixed(0)}k · ` +
      `fee coverage>=${config.minFeeCostCoverage}x`,
    `Exits           : TP +${config.takeProfitNetPct}% net · SL ${config.stopLossPct}% net · ` +
      `timeout ${config.maxDurationHours}h · range -${config.downsideCoverPct}%/+${config.upsideCoverPct}%`,
    `Anti-churn      : ${config.poolCooldownHours}h cooldown · ` +
      `${config.lockoutConsecutiveFailures} consecutive failures → ${config.lockoutHours}h lockout`,
  );

  h("1. HEADLINE — UNBIASED UNIVERSE, FULL V1.1 RULES");
  out.push(portfolioTable(unbiased));

  h("2. EXIT TRIGGER DISTRIBUTION (unbiased, full rules)");
  out.push(exitDistributionTable(unbiased));

  h("3. COOLDOWN IMPACT — 4h pool cooldown + 24h lockout, ON vs OFF");
  out.push(
    comparisonTable([
      { label: "WITH cooldown (V1.1)", result: unbiased },
      { label: "WITHOUT cooldown", result: unbiasedNoChurn },
    ]),
    "",
    `Cooldown blocked ${unbiased.gateRejections.cooldown ?? 0} candidate entries; ` +
      `the lockout blocked ${unbiased.gateRejections.lockout ?? 0}.`,
  );

  h("4. SURVIVORSHIP BIAS — same rules, survivors only vs full universe");
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

  h("5. GAS SENSITIVITY — the friction assumption is not a measurement");
  out.push(
    comparisonTable(
      gasBand.map(({ gasSol, result }) => ({ label: `${gasSol} SOL/tx`, result })),
    ),
  );

  h("6. TVL-MODEL SENSITIVITY — the load-bearing assumption, stressed");
  {
    /*
     * Modelled TVL is TVL_t = k x volume24h_t, and the position's fee share is
     * notional / modelledTVL. Fee income therefore scales as 1/k: halving k doubles
     * the modelled fee income. The fitted k has an IQR spanning roughly a factor of
     * five, so re-running at the quartiles is not a refinement — it is the honest
     * error bar on the headline number.
     */
    const scaled = (targetK: number): TvlModel => {
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
      { label: `k = p25 (${num(tvlModel.p25K, 3)}) — fees richer`, model: scaled(tvlModel.p25K) },
      { label: `k = median (${num(tvlModel.medianK, 3)}) — headline`, model: tvlModel },
      { label: `k = p75 (${num(tvlModel.p75K, 3)}) — fees thinner`, model: scaled(tvlModel.p75K) },
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

    out.push(comparisonTable(kBand));
  }

  h("7. COHORT COMPOSITION — which cohort did the trades actually come from?");
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

    /*
     * A run whose trades all come from one cohort is a selection artefact, not a
     * result. It happened once already: the survivor cohort was sampled from the raw
     * volume leaderboard, every survivor modelled above MAX_TVL_USD, and 100% of
     * trades landed on dying pools. Naming it here stops that recurring silently.
     */
    if (unbiased.summary.totalTrades > 0 && byCohort.size === 1) {
      out.push(
        "",
        `WARNING: every trade came from the "${[...byCohort.keys()][0]}" cohort. That is a`,
        "selection artefact of the universe or the TVL model, not a property of the",
        "strategy. Treat the headline PnL as describing that cohort only.",
      );
    }
  }

  h(
    `8. FRICTION FEASIBILITY — the fee/TVL window a ${usd(options.capitalUsd, 0)} account must hit`,
  );
  out.push(
    `Position notional ${usd(notionalUsd)} · median SOL/USD over the window ${usd(medianSolUsd)} · ` +
      `coverage ${config.minFeeCostCoverage}x · slippage ${config.forcedExitSlippagePct}%`,
    `The breakeven gate demands fee/TVL >= coverage x (gasRoundTrip/notional + slippage).`,
    `MAX_FEE_TVL_RATIO caps the same quantity at ${pct(config.maxFeeTvlRatio * 100, 1)}.`,
    "",
    renderTable(
      [
        { header: "Gas SOL/tx", align: "right" },
        { header: "Round-trip gas", align: "right" },
        { header: "Gas as % of notional", align: "right" },
        { header: "Required fee/TVL", align: "right" },
        { header: "Window", align: "right" },
        { header: "Trades", align: "right" },
      ],
      feasibility.map((f) => [
        String(f.gasSol),
        usd(f.gasRoundTripUsd, 3),
        pct((f.gasRoundTripUsd / notionalUsd) * 100, 2),
        pct(f.requiredFeeTvl * 100, 1),
        f.windowOpen ? "open" : "CLOSED",
        String(f.trades),
      ]),
    ),
  );

  h("9. WHY ENTRIES WERE REFUSED (unbiased, full rules)");
  out.push(
    gateTable(unbiased),
    "",
    `Bars with no eligible candidate: ${unbiased.barsWithNoCandidate} of ${unbiased.barsSimulated}.`,
  );

  h("CAVEATS — READ BEFORE QUOTING ANY NUMBER ABOVE");
  BACKTEST_CAVEATS.forEach((c, i) => out.push(`${i + 1}. ${c}`, ""));

  const report = out.join("\n");
  console.log(report);

  writeFileSync(
    resolve(process.cwd(), OUTPUT_PATH),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataSource: "GeckoTerminal hourly OHLCV + Meteora point-in-time pool universe",
        dataFetchedAt: dataset.fetchedAt,
        windowDays: days,
        caveats: BACKTEST_CAVEATS,
        profile,
        config,
        tvlModel: {
          medianK: tvlModel.medianK,
          p25K: tvlModel.p25K,
          p75K: tvlModel.p75K,
          samples: tvlModel.samples,
        },
        universe: { survivors: survivors.length, dead: dead.length },
        scenarios: {
          unbiased,
          unbiasedNoChurn,
          biased,
          gasBand: gasBand.map(({ gasSol, result }) => ({
            gasSol,
            summary: result.summary,
            trades: result.trades,
          })),
        feasibility,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[micro] full results written to ${OUTPUT_PATH}`);
}

/*
 * Run only when invoked directly. `sweepRiskReward.ts` imports `liveV11Config` from
 * here so that "the live V1.1 configuration" has exactly one definition; without this
 * guard that import would silently execute the whole micro-capital backtest.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[micro] failed:", err);
    process.exit(1);
  });
}
