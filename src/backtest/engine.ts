import {
  assessBreakeven,
  impermanentLossFraction,
  lpValueReturnFraction,
} from "../services/meteora.js";
import { computeMaxDrawdown, computeProfitFactor } from "../services/metrics.js";
import { WSOL_MINT } from "../config/constants.js";
import { estimateTvlAt, type TvlModel } from "./tvlModel.js";
import type { Bar, PoolHistory } from "./historicalData.js";
import { exitConcessionPct, type ExitCostModel } from "./exitCost.js";

/**
 * Bar-by-bar DLMM paper-trading simulation.
 *
 * Pure: it takes already-fetched history and returns results, with no network or
 * database access, so the whole engine is unit-testable.
 */

export interface BacktestConfig {
  /**
   * Starting account balance in USD. When set, each position deploys the full
   * current equity, so results compound the way a real account would. Takes
   * precedence over virtualSol.
   */
  startingCapitalUsd: number | null;
  /**
   * Legacy SOL-denominated sizing, used only when startingCapitalUsd is null.
   * Notional is virtualSol x SOL/USD at entry.
   */
  virtualSol: number;
  /**
   * Share of current equity deployed per position, as a percentage.
   *
   * Deploying 100% means a single bad trade hits the whole account, which is why max
   * drawdown tracked the worst individual trade. Profit factor is unaffected (gross
   * profit and gross loss scale together) but drawdown scales roughly linearly, so
   * this is the direct lever on drawdown. Gas is fixed per trade, so sizing too small
   * lets fees be eaten by transaction cost.
   */
  positionSizePct: number;
  /**
   * Bin range as a fraction of entry price covered below spot.
   *
   * Wider is NOT safer. A wide band removes the effective stop and lets a position
   * ride a loss down. Measured on the 30-day unbiased set: 25% gave PF 1.36 / 39%
   * drawdown, 45% gave PF 1.20 / 66%.
   */
  downsideCoverPct: number;
  /** Bin range as a fraction of entry price covered above spot. */
  upsideCoverPct: number;
  /** Entry filter: trailing 24h volume in USD. */
  minVolume24hUsd: number;
  /** Entry filter: trailing 24h fees / TVL, as a ratio (0.008 === 0.8%). */
  minFeeTvlRatio: number;
  /** Entry filter: upper bound on fee/TVL, rejecting implausible yields. */
  maxFeeTvlRatio: number;
  /** Entry filter: minimum TVL in USD, applied to the MODELLED point-in-time TVL. */
  minTvlUsd: number;
  /**
   * Entry filter: upper TVL bound — the live MAX_TVL_USD "sweet spot" ceiling.
   *
   * Above it fee share is too thin to clear friction. Defaults to Infinity so every
   * pre-existing run and sweep is bit-for-bit unchanged; the live V1.1 value is 500k.
   */
  maxTvlUsd: number;
  /**
   * Entry filter: reject pools younger than this at the SIMULATED bar, from the
   * pool's on-chain creation time. Defaults to 0 (gate off) for backward
   * compatibility. Live V1.1 uses 48.
   *
   * Fails closed exactly like the live screener: a pool with no known creation time
   * is rejected rather than waved through, because "not measured" must not resolve
   * to "fine".
   */
  minPoolAgeHours: number;
  /**
   * Entry filter: reject a pool whose price gained more than this over the single
   * preceding bar. Defaults to Infinity (gate off). Live V1.1 uses 10.
   */
  maxPriceSurge1hPct: number;
  /**
   * Entry filter: reject a pool whose token gained more than this over the trailing
   * 24 bars. Entering at the top of a pump is how a position ends up fully converted
   * to the dumped token on the retrace.
   */
  maxPriceChange24hPct: number;
  /**
   * Entry filter: projected 24h fee income must be at least this multiple of the
   * round-trip cost (gas x2 + slippage in/out), or the pool is skipped.
   *
   * Counter-intuitively, RAISING this makes results worse. The gate is a floor on
   * fee/TVL (coverage x slippage), so a high setting selects for the highest-yield
   * pools — which are the least stable ones. Measured on the 30-day unbiased set at
   * $500: coverage 1.0 gave PF 1.55 / 20.3% drawdown, coverage 2.5 gave PF 0.62 /
   * 62.9%. Raise it only with fresh evidence.
   */
  minFeeCostCoverage: number;
  /** Exit: accumulated fees as a percentage of position notional. */
  takeProfitFeePct: number;
  /**
   * Exit: close when mark-to-market NET PnL reaches this percentage of notional.
   *
   * Distinct from takeProfitFeePct, and the one that mirrors the live engine:
   * `evaluateExit` compares TAKE_PROFIT_PCT against net PnL (fees + LP value change),
   * not against fees alone. Without this the harness could not answer what the live
   * take-profit should be, because it was measuring a different quantity.
   *
   * Defaults to Infinity, i.e. disabled, so existing backtest output is unchanged.
   */
  takeProfitNetPct: number;
  /**
   * Exit: close when net PnL falls to this percentage of notional (negative).
   *
   * The live engine has always had a stop-loss; the backtest did not, which both
   * understated the live rules and left drawdown with no direct lever. Set to a large
   * negative number (e.g. -100) to disable.
   */
  stopLossPct: number;
  /**
   * Exit: arm a profit ratchet once mark-to-market NET PnL first reaches this
   * percentage of notional. Once armed the stop moves UP to `ratchetStopNetPct` and
   * never moves back down, so a position that ran into profit cannot return a loss
   * bigger than that floor.
   *
   * Defaults to Infinity, i.e. never arms, so every pre-existing run and sweep is
   * bit-for-bit unchanged — the same inert-default rule `takeProfitNetPct`,
   * `maxTvlUsd` and the anti-churn gates already follow. The live engine has no
   * equivalent: this is a proposal being measured, not a mirror of production.
   */
  ratchetArmNetPct: number;
  /**
   * Where the stop sits once the ratchet has armed, as a percentage of notional.
   * Positive locks in a gain; 0 is a pure breakeven stop. Only read when
   * `ratchetArmNetPct` is finite.
   */
  ratchetStopNetPct: number;
  /** Exit: maximum holding period in hours. */
  maxDurationHours: number;
  /** How many positions may be open at once across all pools. */
  maxConcurrentPositions: number;

  /* ---- Anti-churn gates (mirror of assessPoolCooldown) ---- */
  /**
   * Hours a pool is benched after ANY of its positions closes, win or lose.
   * 0 disables, which is the default so existing runs are unchanged. Live V1.1: 4.
   */
  poolCooldownHours: number;
  /**
   * Consecutive failing closes on one pool that trip the circuit breaker. A failing
   * close is a stop-loss, an out-of-range exit, or a rug — mirroring the live
   * FAILURE_STATUSES set. Any other outcome resets the run. 0 disables. Live: 2.
   */
  lockoutConsecutiveFailures: number;
  /** Hours a tripped pool stays locked, measured from its last failure. Live: 24. */
  lockoutHours: number;

  /* ---- Realistic execution costs ---- */
  /** SOL burnt per transaction (priority + base fee). A position costs two. */
  gasSolPerTransaction: number;
  /** Price concession taken on a forced exit, as a percentage. */
  forcedExitSlippagePct: number;
  /**
   * Price concession on ONE balancing swap leg, as a percentage of the amount swapped.
   *
   * Every live entry swaps part of the deposit into the pool's other token, and the
   * exit swaps it back — `liveExecution.ts` calls that the balancing swap, and until
   * now NOTHING in this harness charged for it. Gas was charged for two transactions
   * and slippage only on a forced exit, so the swap that runs on every single entry
   * was modelled as free.
   *
   * Defaults to 0, which reproduces that omission exactly, so every existing backtest,
   * sweep and cached result stays byte-identical — the same inert-default rule the
   * V1.1 guardrails follow. A runner that wants the cost priced sets it explicitly and
   * says what it assumed.
   */
  swapSlippagePct: number;
  /**
   * Gas for ONE balancing swap transaction, in SOL. Defaults to 0 for the same reason.
   *
   * Separate from `gasSolPerTransaction` because a Jupiter swap and a DLMM open are
   * not the same transaction: they carry different compute budgets and land at
   * different priority fees. Collapsing them into one number would make the swap's
   * cost unnameable, which is how it went unpriced in the first place.
   */
  swapGasSolPerLeg: number;
  /**
   * Price concession charged on EVERY exit, as a function of the pool (see `exitCost.ts`).
   *
   * `null` — the default — is the legacy accounting exactly: `forcedExitSlippagePct` on
   * OUT_OF_RANGE / STOP_LOSS / RATCHET_STOP / rugged exits and NOTHING on a TAKE_PROFIT or
   * TIMEOUT. Live does not work that way: EMBER's take-profit sold 3.95% below the pool
   * price. Set, every exit pays the modelled concession, and a forced exit pays the WORSE
   * of the model and `forcedExitSlippagePct`, so turning the model on can never make a
   * forced exit cheaper than it was.
   *
   * With a model set, the balancing swap's EXIT leg on the paired token is no longer
   * charged at `swapSlippagePct` — the model prices that sale, and charging both would
   * count the same leg twice.
   */
  exitCostModel: ExitCostModel | null;
  /**
   * Whether the entry friction gate prices the exit with `exitCostModel` instead of the
   * flat `forcedExitSlippagePct`.
   *
   * Separate from the model on purpose. The model changes what a close COSTS (accounting);
   * this changes what the gate ADMITS (strategy). Rerunning the V1.1 baseline with honest
   * costs must not silently also move the V1.1 gate, or the two effects cannot be told
   * apart. Defaults to false; ignored while `exitCostModel` is null.
   */
  gateUsesExitCostModel: boolean;
  /**
   * Bars examined after an exit to decide whether the position could actually have
   * been liquidated at the exit price.
   */
  rugLookaheadBars: number;
  /**
   * Forward volume below this fraction of the entry-time 24h volume counts as
   * liquidity having dried up.
   */
  rugVolumeCollapseRatio: number;
}

export const defaultBacktestConfig = (): BacktestConfig => ({
  startingCapitalUsd: 100,
  virtualSol: 10,
  positionSizePct: 50,
  downsideCoverPct: 25,
  upsideCoverPct: 15,
  minVolume24hUsd: 10_000,
  minFeeTvlRatio: 0.008,
  maxFeeTvlRatio: 0.25,
  minTvlUsd: 50_000,
  maxTvlUsd: Number.POSITIVE_INFINITY,
  minPoolAgeHours: 0,
  maxPriceSurge1hPct: Number.POSITIVE_INFINITY,
  maxPriceChange24hPct: 150,
  minFeeCostCoverage: 1.0,
  takeProfitFeePct: 5,
  takeProfitNetPct: Number.POSITIVE_INFINITY,
  stopLossPct: -15,
  ratchetArmNetPct: Number.POSITIVE_INFINITY,
  ratchetStopNetPct: 0,
  maxDurationHours: 24,
  maxConcurrentPositions: 1,
  poolCooldownHours: 0,
  lockoutConsecutiveFailures: 0,
  lockoutHours: 0,
  gasSolPerTransaction: 0.0035,
  forcedExitSlippagePct: 1.0,
  // Zero: the balancing swap has never been priced here, and a default that started
  // charging for it would silently rewrite every cached sweep and historical result.
  swapSlippagePct: 0,
  swapGasSolPerLeg: 0,
  exitCostModel: null,
  gateUsesExitCostModel: false,
  rugLookaheadBars: 24,
  rugVolumeCollapseRatio: 0.01,
});

export type ExitReason =
  | "OUT_OF_RANGE"
  | "FEE_TAKE_PROFIT"
  | "TAKE_PROFIT"
  | "TIMEOUT"
  | "END_OF_DATA"
  | "STOP_LOSS"
  | "RATCHET_STOP"
  | "RUGGED";

export interface BacktestTrade {
  poolAddress: string;
  pairName: string;
  /** Which cohort the pool came from — the survivorship-bias control. */
  cohort: string;
  entryTime: string;
  exitTime: string;
  durationHours: number;
  /** USD close at entry/exit. */
  entryPrice: number;
  exitPrice: number;
  /** Price actually realised after slippage on a forced exit. */
  effectiveExitPrice: number;
  /**
   * Base priced in the quote asset. For a USD-quoted pool this equals the USD price;
   * for a SOL-quoted pool it is the USD price divided by SOL/USD. The bin bounds below
   * are in THIS unit, not USD.
   */
  entryRatio: number;
  exitRatio: number;
  lowerBinPrice: number;
  upperBinPrice: number;
  quoteDenominatedIn: string;
  notionalUsd: number;
  /** Modelled point-in-time TVL used to size the fee share. */
  modelledTvlAtEntryUsd: number;
  solPriceAtEntry: number;
  feesEarnedUsd: number;
  feesEarnedPct: number;
  /**
   * Change in the LP position's value against the capital deployed, excluding fees:
   * notional x (sqrt(r) - 1). This is the number that moves the account balance.
   */
  positionValueChangeUsd: number;
  /**
   * How far the LP trailed simply holding the two tokens. Reported for diagnosis
   * only — it is NOT part of net PnL, because it measures a different thing.
   */
  divergenceVsHoldUsd: number;
  gasCostUsd: number;
  slippageCostUsd: number;
  /**
   * Round-trip balancing-swap cost: the price concession on each leg plus the legs'
   * own gas. Zero unless the runner priced it, and roughly double on a pool with no
   * wSOL leg, which has to convert BOTH halves of the deposit instead of one.
   */
  swapCostUsd: number;
  /**
   * The exit price concession actually applied, in percent. 0 on a chosen exit under the
   * legacy accounting. Optional only so trade fixtures written before it keep compiling.
   */
  exitConcessionPct?: number;
  /** fees + positionValueChange - gas - slippage - swap. */
  netPnlUsd: number;
  netPnlPct: number;
  netPnlSol: number;
  exitReason: ExitReason;
  /** True when liquidity vanished and the exit price was not actually obtainable. */
  rugged: boolean;
  /** Loss of 80% or more of the deployed notional. */
  catastrophic: boolean;
  barsHeld: number;
  barsOutOfRange: number;
}

export interface BacktestSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRatePct: number;
  netPnlUsd: number;
  netPnlSol: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  avgTradeDurationHours: number;
  avgFeesUsd: number;
  totalFeesUsd: number;
  totalPositionValueChangeUsd: number;
  totalGasCostUsd: number;
  totalSlippageCostUsd: number;
  /** Balancing-swap cost across every trade. Zero unless the runner priced it. */
  totalSwapCostUsd: number;
  ruggedTrades: number;
  catastrophicTrades: number;
  ruggedLossUsd: number;
  tradesOnDeadPools: number;
  exitReasonCounts: Record<ExitReason, number>;
  startingEquityUsd: number;
  endingEquityUsd: number;
  returnPct: number;
  accountWipedOut: boolean;
}

export interface BacktestResult {
  label: string;
  config: BacktestConfig;
  windowStart: string;
  windowEnd: string;
  barsSimulated: number;
  poolsSimulated: Array<{
    pairName: string;
    address: string;
    cohort: string;
    tvlTodayUsd: number;
    feeRatePct: number;
    bars: number;
  }>;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  barsWithNoCandidate: number;
  /** How often each entry gate fired, so a zero-trade run is explainable. */
  gateRejections: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

function indexBars(bars: Bar[]): Map<number, number> {
  const map = new Map<number, number>();
  bars.forEach((b, i) => map.set(b.t, i));
  return map;
}

/**
 * Trailing 24-bar volume ending at (and including) `index`.
 * Returns null until a full 24-bar window exists, so the entry filter is never
 * evaluated against a partial window that would understate volume.
 */
export function trailing24hVolume(bars: Bar[], index: number): number | null {
  if (index < 23) return null;
  let sum = 0;
  for (let i = index - 23; i <= index; i++) sum += bars[i]?.v ?? 0;
  return sum;
}

/** Nearest SOL/USD price at or before `t`. */
export function solPriceAt(solBars: Bar[], t: number): number | null {
  let best: number | null = null;
  for (const bar of solBars) {
    if (bar.t > t) break;
    best = bar.c;
  }
  return best;
}

/**
 * Price of the base asset denominated in the quote asset.
 *
 * OHLCV closes are USD. For a USD-quoted pool that is already the pair ratio. For a
 * SOL-quoted pool the USD price also carries SOL's own move, so it is divided by
 * SOL/USD — otherwise the position return would be measured against the wrong pair.
 */
export function pairRatio(
  closeUsd: number,
  quoteIsUsd: boolean,
  solUsd: number | null,
): number | null {
  if (quoteIsUsd) return closeUsd;
  if (solUsd === null || !(solUsd > 0)) return null;
  return closeUsd / solUsd;
}

/** Whether either leg of the pair is wrapped SOL — the test `describePair()` applies live. */
export function hasWsolLeg(pool: Pick<PoolHistory, "baseMint" | "quoteMint">): boolean {
  return pool.baseMint === WSOL_MINT || pool.quoteMint === WSOL_MINT;
}

export interface BalancingSwapCost {
  /** Jupiter swap transactions over the whole round trip. */
  legs: number;
  /** Notional swapped over the whole round trip, as a multiple of the position. */
  turnover: number;
}

/**
 * The swap legs a round trip needs, given how the wallet is funded.
 *
 * The wallet holds SOL and the range brackets the active bin, so both sides of the
 * pair have to be supplied:
 *
 *   wSOL leg present — half the deposit is swapped into the other token and half
 *     stays SOL. Reversed on exit. TWO legs, 1.0x the position swapped in total.
 *
 *   no wSOL leg (a USDC-quoted pool) — NEITHER side is the asset held, so both
 *     halves must be converted: half SOL->USDC and half SOL->token, reversed on exit.
 *     FOUR legs, 2.0x the position swapped in total.
 *
 * So a USDC-quoted pool pays roughly DOUBLE the swap friction of a SOL-quoted one,
 * plus two extra transactions of gas — and it pays it on every entry, not only on the
 * exits that go wrong.
 *
 * The `SOL->token` leg is counted at the same per-leg rate as any other even though
 * Jupiter would route it through USDC, because the routing does not remove the hop:
 * the price impact of the thin token pool is paid either way. This is the assumption
 * most worth disagreeing with, which is why the runner sweeps a band over it rather
 * than publishing one number.
 */
export function balancingSwapCost(pool: Pick<PoolHistory, "baseMint" | "quoteMint">): BalancingSwapCost {
  return hasWsolLeg(pool) ? { legs: 2, turnover: 1 } : { legs: 4, turnover: 2 };
}

/** Round-trip swap friction in USD: price concession plus the legs' own gas. */
export function balancingSwapFrictionUsd(
  pool: Pick<PoolHistory, "baseMint" | "quoteMint">,
  notionalUsd: number,
  config: Pick<BacktestConfig, "swapSlippagePct" | "swapGasSolPerLeg"> &
    Partial<Pick<BacktestConfig, "exitCostModel">>,
  solUsd: number,
): number {
  const { legs, turnover } = balancingSwapCost(pool);
  /*
   * With an exit-cost model, the sale of the paired TOKEN half at exit is priced by the
   * model in `closeAt`, so it is removed here: 0.5x of notional off the round trip. What
   * remains is every entry leg, plus — on a pool with no wSOL leg — the USDC half's way
   * back to SOL, which the model does not see. Gas stays per leg either way: the
   * transactions still happen.
   */
  const concessionTurnover = config.exitCostModel ? turnover - 0.5 : turnover;
  const concession = notionalUsd * concessionTurnover * (config.swapSlippagePct / 100);
  const gas = legs * config.swapGasSolPerLeg * solUsd;
  return concession + gas;
}

/**
 * Trailing 24-bar price change as a percentage. Returns null before a full window
 * exists — callers must treat that as unknown, not as flat.
 */
export function priceChange24hPct(bars: Bar[], index: number): number | null {
  if (index < 24) return null;
  const now = bars[index]?.c;
  const then = bars[index - 24]?.c;
  if (!now || !then || then <= 0) return null;
  return (now / then - 1) * 100;
}

/**
 * Single-bar price change as a percentage, i.e. the 1h surge the live
 * MAX_PRICE_SURGE_1H_PCT gate measures. Returns null when there is no prior bar —
 * callers must treat that as unknown and reject, not as flat.
 */
export function priceSurge1hPct(bars: Bar[], index: number): number | null {
  if (index < 1) return null;
  const now = bars[index]?.c;
  const prev = bars[index - 1]?.c;
  if (!now || !prev || prev <= 0) return null;
  return (now / prev - 1) * 100;
}

/**
 * Per-pool close history, the backtest's stand-in for `getPoolExitHistory()`.
 * Mirrors PoolExitRecord: unix seconds instead of DB timestamp strings.
 */
interface PoolExitState {
  lastClosedAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
}

/**
 * Does this exit count as a FAILURE for the circuit breaker?
 *
 * Mirrors the live mapping. `evaluateExit` picks the status from the exit REASON, not
 * from the PnL sign, so a range exit is a failure even if it happened to close green,
 * and a timeout is neutral even if it closed red. FAILURE_STATUSES is
 * CLOSED_LOSS + CLOSED_OUT_OF_RANGE, i.e. stop-loss and out-of-range here. A rug is a
 * forced liquidation out of the range, so it counts too.
 */
export function isFailureExit(reason: ExitReason): boolean {
  return reason === "STOP_LOSS" || reason === "OUT_OF_RANGE" || reason === "RUGGED";
}

/*
 * RATCHET_STOP is deliberately absent from the list above. The ratchet only fires on a
 * position that already reached `ratchetArmNetPct`, and it fires at a floor set at or
 * above breakeven, so it is a profit-taking exit that live would book as CLOSED_PROFIT
 * — not a CLOSED_LOSS. This engine maps failures from the exit REASON rather than the
 * PnL sign (a range exit counts even when it closes green), so classifying the ratchet
 * by reason is the consistent choice; a run of successful ratchets must not arm the
 * circuit breaker.
 */

/**
 * Backtest mirror of `assessPoolCooldown`, on unix seconds.
 *
 * Lockout is checked first because it is the longer and more serious of the two, and
 * a pool with no closed history is never blocked — both exactly as live. The live
 * function's unparseable-timestamp branch has no analogue here: these timestamps are
 * generated by the simulation, so they cannot fail to parse.
 */
export function assessCooldownAt(
  state: PoolExitState | undefined,
  nowSeconds: number,
  config: Pick<
    BacktestConfig,
    "poolCooldownHours" | "lockoutConsecutiveFailures" | "lockoutHours"
  >,
): { blocked: boolean; kind: "cooldown" | "lockout" | null } {
  if (!state) return { blocked: false, kind: null };

  if (
    config.lockoutConsecutiveFailures > 0 &&
    config.lockoutHours > 0 &&
    state.consecutiveFailures >= config.lockoutConsecutiveFailures &&
    state.lastFailureAt !== null
  ) {
    const elapsedHours = (nowSeconds - state.lastFailureAt) / 3600;
    if (elapsedHours < config.lockoutHours) return { blocked: true, kind: "lockout" };
  }

  if (config.poolCooldownHours > 0 && state.lastClosedAt !== null) {
    const elapsedHours = (nowSeconds - state.lastClosedAt) / 3600;
    if (elapsedHours < config.poolCooldownHours) return { blocked: true, kind: "cooldown" };
  }

  return { blocked: false, kind: null };
}

export interface LiquidationCheck {
  rugged: boolean;
  /** Ratio the position could actually be liquidated at. */
  realisableRatio: number;
  forwardVolumeUsd: number;
}

/**
 * Decides whether a position could genuinely have been closed at the exit bar.
 *
 * Forward bars are consulted only to establish a market-microstructure fact — was
 * there anyone to sell to — never to inform the entry or exit decision itself. The
 * exit had already triggered on its own bar; this only determines the fill.
 *
 * When volume collapses and price never re-enters the range, the position is stuck
 * in a token nobody is buying, so it is marked to the worst forward price rather
 * than the (unobtainable) exit-bar price.
 */
export function assessLiquidation(params: {
  bars: Bar[];
  exitIndex: number;
  exitRatio: number;
  lower: number;
  upper: number;
  entryVolume24hUsd: number;
  quoteIsUsd: boolean;
  solBars: Bar[];
  lookaheadBars: number;
  volumeCollapseRatio: number;
}): LiquidationCheck {
  const {
    bars,
    exitIndex,
    exitRatio,
    lower,
    upper,
    entryVolume24hUsd,
    quoteIsUsd,
    solBars,
    lookaheadBars,
    volumeCollapseRatio,
  } = params;

  const end = Math.min(bars.length - 1, exitIndex + lookaheadBars);

  let forwardVolumeUsd = 0;
  let recovered = false;
  let worstRatio = exitRatio;

  for (let i = exitIndex + 1; i <= end; i++) {
    const bar = bars[i];
    if (!bar) continue;

    forwardVolumeUsd += bar.v;

    const solUsd = solPriceAt(solBars, bar.t);
    const ratio = pairRatio(bar.c, quoteIsUsd, solUsd);
    if (ratio === null) continue;

    if (ratio >= lower && ratio <= upper) recovered = true;
    if (ratio < worstRatio) worstRatio = ratio;
  }

  // Scale the entry-time 24h volume to the length of the look-ahead window.
  const expectedVolume = (entryVolume24hUsd / 24) * Math.max(1, end - exitIndex);
  const collapsed = expectedVolume > 0 && forwardVolumeUsd < expectedVolume * volumeCollapseRatio;

  const rugged = collapsed && !recovered && exitRatio < lower;

  return {
    rugged,
    realisableRatio: rugged ? worstRatio : exitRatio,
    forwardVolumeUsd,
  };
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

interface OpenPosition {
  pool: PoolHistory;
  entryIndex: number;
  entryTime: number;
  entryRatio: number;
  entryPriceUsd: number;
  lower: number;
  upper: number;
  notionalUsd: number;
  modelledTvlUsd: number;
  entryVolume24hUsd: number;
  solPriceAtEntry: number;
  feesUsd: number;
  barsHeld: number;
  barsOutOfRange: number;
  /** True once mark-to-market net PnL has touched `ratchetArmNetPct`. Never unset. */
  ratchetArmed: boolean;
}

export interface SimulationInput {
  label: string;
  pools: PoolHistory[];
  solUsdBars: Bar[];
  tvlModel: TvlModel;
  config?: BacktestConfig;
}

export function runSimulation(input: SimulationInput): BacktestResult {
  const config = input.config ?? defaultBacktestConfig();
  const { pools, solUsdBars, tvlModel } = input;

  const usablePools = pools.filter((p) => p.bars.length > 24);
  if (usablePools.length === 0) {
    throw new Error("[backtest] no pool has enough bars to simulate");
  }

  const timeline = [...new Set(usablePools.flatMap((p) => p.bars.map((b) => b.t)))].sort(
    (a, b) => a - b,
  );
  const poolIndexes = new Map(usablePools.map((p) => [p.address, indexBars(p.bars)]));

  const trades: BacktestTrade[] = [];
  const open: OpenPosition[] = [];
  let barsWithNoCandidate = 0;
  const gateRejections: Record<string, number> = {};

  /** Per-pool close history driving the cooldown and lockout gates. */
  const exitState = new Map<string, PoolExitState>();

  const firstSolPrice = solUsdBars[0]?.c ?? 0;
  const startingEquityUsd =
    config.startingCapitalUsd !== null
      ? config.startingCapitalUsd
      : config.virtualSol * firstSolPrice;

  let equityUsd = startingEquityUsd;

  const closeAt = (pos: OpenPosition, t: number, exitIndex: number, reason: ExitReason): void => {
    const bar = pos.pool.bars[exitIndex];
    const exitPriceUsd = bar?.c ?? pos.entryPriceUsd;
    const solUsd = solPriceAt(solUsdBars, t) ?? pos.solPriceAtEntry;
    const exitRatio = pairRatio(exitPriceUsd, pos.pool.quoteIsUsd, solUsd) ?? pos.entryRatio;

    const liquidation = assessLiquidation({
      bars: pos.pool.bars,
      exitIndex,
      exitRatio,
      lower: pos.lower,
      upper: pos.upper,
      entryVolume24hUsd: pos.entryVolume24hUsd,
      quoteIsUsd: pos.pool.quoteIsUsd,
      solBars: solUsdBars,
      lookaheadBars: config.rugLookaheadBars,
      volumeCollapseRatio: config.rugVolumeCollapseRatio,
    });

    // Slippage applies whenever the exit was forced by the market rather than chosen.
    /*
     * The ratchet is a market-triggered exit like the stop: the position moved against
     * a level and the engine had to hit the book, so it pays the same concession. Only
     * TAKE_PROFIT / FEE_TAKE_PROFIT / TIMEOUT are chosen exits.
     */
    const forced =
      reason === "OUT_OF_RANGE" ||
      reason === "STOP_LOSS" ||
      reason === "RATCHET_STOP" ||
      liquidation.rugged;
    /*
     * Legacy (no model): forced exits pay the flat concession, chosen exits pay nothing.
     * With a model, every exit pays it, and a forced exit never pays LESS than before.
     */
    let concessionPct = forced ? config.forcedExitSlippagePct : 0;
    if (config.exitCostModel) {
      const modelled = exitConcessionPct(
        config.exitCostModel,
        pos.pool.binStep,
        pos.notionalUsd,
        pos.modelledTvlUsd,
      );
      concessionPct = forced ? Math.max(modelled, config.forcedExitSlippagePct) : modelled;
    }
    const slippageFactor = 1 - concessionPct / 100;
    const realisedRatio = Math.max(0, liquidation.realisableRatio * slippageFactor);

    const r = pos.entryRatio > 0 ? realisedRatio / pos.entryRatio : 1;
    const grossRatio = pos.entryRatio > 0 ? liquidation.realisableRatio / pos.entryRatio : 1;

    /*
     * KNOWN DEFECT, KEPT ON THE LEGACY PATH ON PURPOSE (found 13 Sep 2026). Without a
     * model, the position value is taken at the HAIRCUT ratio `r` and the same haircut is
     * then subtracted again as `slippageCostUsd` — so every forced exit was charged its
     * slippage TWICE. That made published figures PESSIMISTIC on forced exits, by exactly
     * `totalSlippageCostUsd`. It stays here because fixing it would move every cached
     * sweep and every quoted figure with no flag to reproduce them; the model path below
     * counts the concession once (value at the GROSS ratio, concession charged separately),
     * and the integrity report prints the legacy over-charge beside the new numbers.
     */
    const valueRatio = config.exitCostModel ? grossRatio : r;

    // The number that actually moves the balance. NOT the divergence-vs-hold figure.
    const positionValueChangeUsd = pos.notionalUsd * lpValueReturnFraction(valueRatio);
    const divergenceVsHoldUsd = pos.notionalUsd * impermanentLossFraction(valueRatio);

    const slippageCostUsd = concessionPct > 0
      ? Math.abs(
          pos.notionalUsd * (lpValueReturnFraction(grossRatio) - lpValueReturnFraction(r)),
        )
      : 0;

    // Open + close are two transactions.
    const gasCostUsd = config.gasSolPerTransaction * 2 * solUsd;

    /*
     * The balancing swap, charged on EVERY round trip rather than only on forced
     * exits. A USDC-quoted pool pays it twice over, because neither side of the pair
     * is the asset the wallet holds. Zero unless the runner priced it.
     */
    const swapCostUsd = balancingSwapFrictionUsd(pos.pool, pos.notionalUsd, config, solUsd);

    const netPnlUsd =
      pos.feesUsd + positionValueChangeUsd - gasCostUsd - slippageCostUsd - swapCostUsd;
    const durationHours = (t - pos.entryTime) / 3600;

    equityUsd += netPnlUsd;

    const netPnlPct = pos.notionalUsd > 0 ? (netPnlUsd / pos.notionalUsd) * 100 : 0;

    trades.push({
      poolAddress: pos.pool.address,
      pairName: pos.pool.pairName,
      cohort: pos.pool.cohort,
      entryTime: iso(pos.entryTime),
      exitTime: iso(t),
      durationHours,
      entryPrice: pos.entryPriceUsd,
      exitPrice: exitPriceUsd,
      effectiveExitPrice:
        pos.pool.quoteIsUsd || solUsd <= 0 ? realisedRatio : realisedRatio * solUsd,
      entryRatio: pos.entryRatio,
      exitRatio,
      lowerBinPrice: pos.lower,
      upperBinPrice: pos.upper,
      quoteDenominatedIn: pos.pool.quoteIsUsd ? "USD" : pos.pool.quoteSymbol || "quote",
      notionalUsd: pos.notionalUsd,
      modelledTvlAtEntryUsd: pos.modelledTvlUsd,
      solPriceAtEntry: pos.solPriceAtEntry,
      feesEarnedUsd: pos.feesUsd,
      feesEarnedPct: pos.notionalUsd > 0 ? (pos.feesUsd / pos.notionalUsd) * 100 : 0,
      positionValueChangeUsd,
      divergenceVsHoldUsd,
      gasCostUsd,
      slippageCostUsd,
      swapCostUsd,
      exitConcessionPct: concessionPct,
      netPnlUsd,
      netPnlPct,
      netPnlSol: solUsd > 0 ? netPnlUsd / solUsd : 0,
      exitReason: liquidation.rugged ? "RUGGED" : reason,
      rugged: liquidation.rugged,
      catastrophic: netPnlPct <= -80,
      barsHeld: pos.barsHeld,
      barsOutOfRange: pos.barsOutOfRange,
    });

    /*
     * Fold the close into the pool's anti-churn record. The run of consecutive
     * failures is incremented by a failing exit and reset by anything else, which is
     * what `summarisePoolExits` does when it walks the rows newest-first.
     */
    const effectiveReason: ExitReason = liquidation.rugged ? "RUGGED" : reason;
    const state = exitState.get(pos.pool.address) ?? {
      lastClosedAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
    };
    state.lastClosedAt = t;
    if (isFailureExit(effectiveReason)) {
      state.consecutiveFailures++;
      state.lastFailureAt = t;
    } else {
      state.consecutiveFailures = 0;
    }
    exitState.set(pos.pool.address, state);
  };

  for (const t of timeline) {
    /* ---- 1. mark and possibly close open positions ---- */
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!;
      const idx = poolIndexes.get(pos.pool.address)?.get(t);
      if (idx === undefined) continue;

      const bar = pos.pool.bars[idx]!;
      const solUsd = solPriceAt(solUsdBars, t) ?? pos.solPriceAtEntry;
      const ratio = pairRatio(bar.c, pos.pool.quoteIsUsd, solUsd);
      if (ratio === null) continue;

      pos.barsHeld++;

      const inRange = ratio >= pos.lower && ratio <= pos.upper;

      if (inRange && pos.modelledTvlUsd > 0) {
        const share = pos.notionalUsd / pos.modelledTvlUsd;
        pos.feesUsd += pos.pool.feeRate * bar.v * share;
      } else if (!inRange) {
        pos.barsOutOfRange++;
      }

      const durationHours = (t - pos.entryTime) / 3600;
      const feePct = pos.notionalUsd > 0 ? (pos.feesUsd / pos.notionalUsd) * 100 : 0;

      /*
       * Mark-to-market net PnL for the stop, using LP value vs capital plus accrued
       * fees. Costs are charged at close, so the stop is measured gross of them.
       */
      const markRatio = pos.entryRatio > 0 ? ratio / pos.entryRatio : 1;
      const markNetPct =
        pos.notionalUsd > 0
          ? ((pos.feesUsd + pos.notionalUsd * lpValueReturnFraction(markRatio)) /
              pos.notionalUsd) *
            100
          : 0;

      /*
       * Arm the ratchet BEFORE the exit ladder is evaluated, so the bar that reaches
       * the trigger is already protected. It is a one-way latch: `ratchetArmed` is
       * never cleared, which is what makes the floor a ratchet rather than a level the
       * position can slip back under unnoticed.
       */
      if (markNetPct >= config.ratchetArmNetPct) pos.ratchetArmed = true;

      let reason: ExitReason | null = null;
      if (!inRange) reason = "OUT_OF_RANGE";
      /*
       * The armed floor sits above `stopLossPct` by construction, so it is tested
       * first; a gap straight through both still books the ratchet, which is the
       * level that was actually live at the time.
       */
      else if (pos.ratchetArmed && markNetPct <= config.ratchetStopNetPct)
        reason = "RATCHET_STOP";
      else if (markNetPct <= config.stopLossPct) reason = "STOP_LOSS";
      else if (markNetPct >= config.takeProfitNetPct) reason = "TAKE_PROFIT";
      else if (feePct >= config.takeProfitFeePct) reason = "FEE_TAKE_PROFIT";
      else if (durationHours >= config.maxDurationHours) reason = "TIMEOUT";

      if (reason) {
        closeAt(pos, t, idx, reason);
        open.splice(i, 1);
      }
    }

    /* ---- 2. look for a new entry ---- */
    if (open.length >= config.maxConcurrentPositions) continue;

    const held = new Set(open.map((p) => p.pool.address));
    let best: {
      pool: PoolHistory;
      idx: number;
      score: number;
      tvl: number;
      vol24h: number;
    } | null = null;

    // Position size is needed by the breakeven gate, so resolve it before screening.
    const solUsdForSizing = solPriceAt(solUsdBars, t);

    /*
     * Capital already tied up in open positions cannot be deployed again.
     *
     * `equityUsd` only steps on a close, so with more than one concurrent position
     * sizing off equity alone would let the account deploy the same dollars two or
     * three times over — invisible leverage that flatters every result. Subtracting
     * the open notional caps total exposure at the account. With
     * maxConcurrentPositions = 1 nothing is ever open at this point, so the figure is
     * identical to before and prior runs are unaffected.
     */
    const deployedUsd = open.reduce((sum, p) => sum + p.notionalUsd, 0);
    const freeCapitalUsd = Math.max(0, equityUsd - deployedUsd);

    const prospectiveNotional =
      config.startingCapitalUsd !== null
        ? Math.min(equityUsd * (config.positionSizePct / 100), freeCapitalUsd)
        : config.virtualSol * (solUsdForSizing ?? 0);
    const gasRoundTripUsd =
      config.gasSolPerTransaction * 2 * (solUsdForSizing ?? 0);

    if (!(prospectiveNotional > 0)) {
      gateRejections.noFreeCapital = (gateRejections.noFreeCapital ?? 0) + 1;
      barsWithNoCandidate++;
      continue;
    }

    for (const pool of usablePools) {
      if (held.has(pool.address)) continue;

      const idx = poolIndexes.get(pool.address)?.get(t);
      if (idx === undefined) continue;

      // Anti-churn gates first: they are the cheapest and the most decisive.
      const cooldown = assessCooldownAt(exitState.get(pool.address), t, config);
      if (cooldown.blocked) {
        const key = cooldown.kind === "lockout" ? "lockout" : "cooldown";
        gateRejections[key] = (gateRejections[key] ?? 0) + 1;
        continue;
      }

      /*
       * Pool-age gate, evaluated at the SIMULATED bar rather than against the pool's
       * age today — a pool that is 200 days old now was 3 hours old in June, and
       * using today's age would wave through exactly the launches this gate exists
       * to refuse. Fails closed on an unknown creation time, as live does.
       */
      if (config.minPoolAgeHours > 0) {
        if (!(pool.createdAtMs > 0)) {
          gateRejections.ageUnknown = (gateRejections.ageUnknown ?? 0) + 1;
          continue;
        }
        const ageHours = (t * 1000 - pool.createdAtMs) / 3_600_000;
        if (ageHours < config.minPoolAgeHours) {
          gateRejections.tooYoung = (gateRejections.tooYoung ?? 0) + 1;
          continue;
        }
      }

      const vol24h = trailing24hVolume(pool.bars, idx);
      if (vol24h === null) continue;
      if (vol24h < config.minVolume24hUsd) {
        gateRejections.lowVolume = (gateRejections.lowVolume ?? 0) + 1;
        continue;
      }

      // Modelled, not the current snapshot — a snapshot would reject every dead pool
      // and reinstate the survivorship bias this harness exists to remove.
      const tvl = estimateTvlAt(tvlModel, pool.address, vol24h).tvlUsd;
      if (tvl < config.minTvlUsd) {
        gateRejections.lowTvl = (gateRejections.lowTvl ?? 0) + 1;
        continue;
      }
      // Sweet-spot ceiling: above it the position's share of the pool is too small
      // for fees to clear friction. Mirrors the live MAX_TVL_USD gate.
      if (tvl > config.maxTvlUsd) {
        gateRejections.highTvl = (gateRejections.highTvl ?? 0) + 1;
        continue;
      }

      const feeTvl = (pool.feeRate * vol24h) / tvl;
      if (feeTvl < config.minFeeTvlRatio) {
        gateRejections.lowFeeTvl = (gateRejections.lowFeeTvl ?? 0) + 1;
        continue;
      }
      if (feeTvl > config.maxFeeTvlRatio) {
        gateRejections.feeTvlOutlier = (gateRejections.feeTvlOutlier ?? 0) + 1;
        continue;
      }

      // Volatility gate: never provide liquidity into the top of a pump.
      const change24h = priceChange24hPct(pool.bars, idx);
      if (change24h === null) {
        gateRejections.volatilityUnknown = (gateRejections.volatilityUnknown ?? 0) + 1;
        continue;
      }
      if (change24h > config.maxPriceChange24hPct) {
        gateRejections.pumped = (gateRejections.pumped ?? 0) + 1;
        continue;
      }

      // 1h surge gate. Unknown is rejected, same fail-closed rule as the 24h gate.
      if (Number.isFinite(config.maxPriceSurge1hPct)) {
        const surge1h = priceSurge1hPct(pool.bars, idx);
        if (surge1h === null) {
          gateRejections.surgeUnknown = (gateRejections.surgeUnknown ?? 0) + 1;
          continue;
        }
        if (surge1h > config.maxPriceSurge1hPct) {
          gateRejections.surged = (gateRejections.surged ?? 0) + 1;
          continue;
        }
      }

      // Breakeven gate: fees must clear the cost of getting in and out.
      /*
       * The entry gate is charged the SAME friction the close will book, which is why
       * the swap cost is added here and not only in `closeAt`. A gate that admits a
       * pool on a cost basis the exit then exceeds advertises a bar it does not
       * enforce — the defect `chargeEntryFrictionUsd` exists to prevent live. It is
       * per-pool because a pool with no wSOL leg pays roughly double.
       */
      const entryFrictionUsd =
        gasRoundTripUsd +
        balancingSwapFrictionUsd(pool, prospectiveNotional, config, solUsdForSizing ?? 0);

      // The V1.1 gate prices the exit flat; the model reaches it only when asked to.
      const gateExitSlippagePct =
        config.exitCostModel && config.gateUsesExitCostModel
          ? exitConcessionPct(config.exitCostModel, pool.binStep, prospectiveNotional, tvl)
          : config.forcedExitSlippagePct;

      const breakeven = assessBreakeven({
        notionalUsd: prospectiveNotional,
        feeTvlRatio24h: feeTvl,
        gasCostRoundTripUsd: entryFrictionUsd,
        slippagePct: gateExitSlippagePct,
        minCoverageRatio: config.minFeeCostCoverage,
      });
      if (!breakeven.passes) {
        gateRejections.belowBreakeven = (gateRejections.belowBreakeven ?? 0) + 1;
        continue;
      }

      const score = feeTvl * vol24h;
      if (!best || score > best.score) best = { pool, idx, score, tvl, vol24h };
    }

    if (!best) {
      barsWithNoCandidate++;
      continue;
    }

    const solUsd = solPriceAt(solUsdBars, t);
    if (solUsd === null || !(solUsd > 0)) continue;

    const bar = best.pool.bars[best.idx]!;
    const entryRatio = pairRatio(bar.c, best.pool.quoteIsUsd, solUsd);
    if (entryRatio === null || !(entryRatio > 0)) continue;

    const notionalUsd =
      config.startingCapitalUsd !== null
        ? Math.min(equityUsd * (config.positionSizePct / 100), freeCapitalUsd)
        : config.virtualSol * solUsd;
    if (!(notionalUsd > 0)) {
      barsWithNoCandidate++;
      continue;
    }

    open.push({
      pool: best.pool,
      entryIndex: best.idx,
      entryTime: t,
      entryRatio,
      entryPriceUsd: bar.c,
      lower: entryRatio * (1 - config.downsideCoverPct / 100),
      upper: entryRatio * (1 + config.upsideCoverPct / 100),
      notionalUsd,
      modelledTvlUsd: best.tvl,
      entryVolume24hUsd: best.vol24h,
      solPriceAtEntry: solUsd,
      feesUsd: 0,
      barsHeld: 0,
      barsOutOfRange: 0,
      ratchetArmed: false,
    });
  }

  /* ---- 3. force-close anything still open ---- */
  const lastT = timeline[timeline.length - 1] ?? 0;
  for (const pos of open) {
    const idx = poolIndexes.get(pos.pool.address)?.get(lastT) ?? pos.pool.bars.length - 1;
    closeAt(pos, lastT, idx, "END_OF_DATA");
  }

  trades.sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));

  return {
    label: input.label,
    config,
    windowStart: iso(timeline[0] ?? 0),
    windowEnd: iso(lastT),
    barsSimulated: timeline.length,
    poolsSimulated: usablePools.map((p) => ({
      pairName: p.pairName,
      address: p.address,
      cohort: p.cohort,
      tvlTodayUsd: p.tvlTodayUsd,
      feeRatePct: p.feeRate * 100,
      bars: p.bars.length,
    })),
    trades,
    summary: summarise(trades, startingEquityUsd),
    barsWithNoCandidate,
    gateRejections,
  };
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

export function summarise(trades: BacktestTrade[], startingEquityUsd: number): BacktestSummary {
  const pnls = trades.map((t) => t.netPnlUsd);

  const drawdown = computeMaxDrawdown(pnls, startingEquityUsd);
  const profit = computeProfitFactor(pnls);

  const wins = trades.filter((t) => t.netPnlUsd > 0).length;
  const losses = trades.filter((t) => t.netPnlUsd < 0).length;
  const breakEven = trades.length - wins - losses;

  const sum = (fn: (t: BacktestTrade) => number): number => trades.reduce((s, t) => s + fn(t), 0);
  const avg = (fn: (t: BacktestTrade) => number): number =>
    trades.length === 0 ? 0 : sum(fn) / trades.length;

  const netPnlUsd = sum((t) => t.netPnlUsd);

  const exitReasonCounts: Record<ExitReason, number> = {
    OUT_OF_RANGE: 0,
    FEE_TAKE_PROFIT: 0,
    TAKE_PROFIT: 0,
    TIMEOUT: 0,
    END_OF_DATA: 0,
    STOP_LOSS: 0,
    RATCHET_STOP: 0,
    RUGGED: 0,
  };
  for (const t of trades) exitReasonCounts[t.exitReason]++;

  const endingEquityUsd = startingEquityUsd + netPnlUsd;

  return {
    totalTrades: trades.length,
    wins,
    losses,
    breakEven,
    winRatePct: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    netPnlUsd,
    netPnlSol: sum((t) => t.netPnlSol),
    grossProfitUsd: profit.grossProfitUsd,
    grossLossUsd: profit.grossLossUsd,
    profitFactor: profit.profitFactor,
    maxDrawdownPct: drawdown.maxDrawdownPct,
    maxDrawdownUsd: drawdown.maxDrawdownUsd,
    avgTradeDurationHours: avg((t) => t.durationHours),
    avgFeesUsd: avg((t) => t.feesEarnedUsd),
    totalFeesUsd: sum((t) => t.feesEarnedUsd),
    totalPositionValueChangeUsd: sum((t) => t.positionValueChangeUsd),
    totalGasCostUsd: sum((t) => t.gasCostUsd),
    totalSlippageCostUsd: sum((t) => t.slippageCostUsd),
    totalSwapCostUsd: sum((t) => t.swapCostUsd),
    ruggedTrades: trades.filter((t) => t.rugged).length,
    catastrophicTrades: trades.filter((t) => t.catastrophic).length,
    ruggedLossUsd: trades.filter((t) => t.rugged).reduce((s, t) => s + t.netPnlUsd, 0),
    tradesOnDeadPools: trades.filter((t) => t.cohort === "dead-or-dormant").length,
    exitReasonCounts,
    startingEquityUsd,
    endingEquityUsd,
    returnPct: startingEquityUsd > 0 ? (netPnlUsd / startingEquityUsd) * 100 : 0,
    accountWipedOut: endingEquityUsd <= 0,
  };
}
