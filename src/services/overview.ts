import {
  getActivePositions,
  getLifetimeStats,
  getRealisedPnlSeries,
  getStatsForDate,
  getTotalFloatingPnlUsd,
  getTotalUnclaimedFeesUsd,
} from "../database/repositories.js";
import { computeMaxDrawdown, computeProfitFactor } from "./metrics.js";
import { defaultCohort, type Cohort } from "./cohort.js";
import { localDateString } from "../agents/researcherAgent.js";
import { getStartingBalanceUsd } from "../config/startingBalance.js";
import { env } from "../config/env.js";
import { isLiveExecutionActive } from "../config/liveConfig.js";
import { readNewsBlackout, toBlackoutStatus, type NewsBlackoutStatus } from "./newsBlackout.js";

/**
 * The KPI payload served by GET /api/overview and reused verbatim by the
 * Telegram /status command, so the dashboard and the bot can never disagree.
 *
 * All figures are derived from closed-trade history; floating PnL is reported
 * separately and excluded from drawdown/profit-factor so those stay
 * reproducible from stored history.
 */
export interface Overview {
  /**
   * Which slice of history every figure below was computed over.
   *
   * When `filtered` is true the balance and equity are REBASED on
   * startingBalanceUSD — they answer "what would this engine version have done
   * starting fresh", not "what is in the account". The UI must say so; a rebased
   * number presented as the live balance would be a fabricated figure.
   */
  cohort: {
    id: Cohort["id"];
    label: string;
    description: string;
    cutoff: string | null;
    filtered: boolean;
  };
  /** Closed trades excluded by the cohort filter. 0 when unfiltered. */
  excludedTrades: number;
  /** Realised PnL of those excluded trades, so the omission is quantified. */
  excludedRealizedPnLUSD: number;
  currentBalanceUSD: number;
  currentEquityUSD: number;
  liveFloatingPnLUSD: number;
  liveFloatingPnLPct: number;
  todayRealizedPnLUSD: number;
  todayClosedTrades: number;
  totalSimulatedTrades: number;
  winRatePct: number;
  totalWins: number;
  totalLosses: number;
  unclaimedFeesUSD: number;
  activePositionsCount: number;
  startingBalanceUSD: number;
  maxDrawdownPct: number;
  maxDrawdownUSD: number;
  currentDrawdownPct: number;
  drawdownPeakUSD: number;
  drawdownTroughUSD: number;
  /** null when undefined, i.e. no closed trades or no losing trades yet. */
  profitFactor: number | null;
  grossProfitUSD: number;
  grossLossUSD: number;
  serverStatus: "ONLINE";
  isDryRun: boolean;
  /**
   * The macro-news window currently holding NEW entries back, or null.
   *
   * Null means nothing is holding entries back, and in PAPER mode it is always null:
   * the gate is inert there by construction, so reporting a window would advertise a
   * restriction the engine is not applying — the same "advertised bound, unenforced"
   * defect the coverage gate and the bin-array rent ceiling were each fixed for.
   *
   * It says nothing about OPEN positions, which are monitored, accrued and closed
   * through a blackout exactly as at any other time.
   */
  newsBlackout: NewsBlackoutStatus | null;
  serverTime: string;
  timezone: string;
}

export function computeOverview(cohort: Cohort = defaultCohort()): Overview {
  const filter = { openedAtFrom: cohort.openedAtFrom };

  const lifetime = getLifetimeStats(filter);
  const today = getStatsForDate(localDateString(), filter);
  const floating = getTotalFloatingPnlUsd(filter);
  const unclaimedFees = getTotalUnclaimedFeesUsd(filter);
  const active = getActivePositions(filter);

  /*
   * What the filter removed, reported rather than hidden. A reader comparing a clean
   * cohort against the archive needs to see the size of the gap without switching
   * modes and doing the subtraction by hand.
   */
  const allTime = cohort.filtered ? getLifetimeStats() : lifetime;
  const excludedTrades = allTime.totalClosed - lifetime.totalClosed;
  const excludedRealizedPnLUSD = allTime.realizedPnlUsd - lifetime.realizedPnlUsd;

  const startingBalanceUsd = getStartingBalanceUsd();
  const currentBalanceUSD = startingBalanceUsd + lifetime.realizedPnlUsd;
  const currentEquityUSD = currentBalanceUSD + floating;

  const activeNotional = active.reduce(
    (sum, r) => sum + (r.entry_sol_price_usd ?? 0) * r.virtual_sol_amount,
    0,
  );

  // Both metrics run over the realised equity curve, oldest close first. Floating
  // PnL is excluded so the figures are reproducible from stored history.
  //
  // In a filtered cohort the curve starts again at STARTING_BALANCE_USD, so the
  // drawdown is the drawdown THIS engine version produced from a standing start —
  // not the account's real peak-to-trough, which the archive cohort still reports.
  const pnlSeries = getRealisedPnlSeries(filter);
  const drawdown = computeMaxDrawdown(pnlSeries, startingBalanceUsd);
  const profit = computeProfitFactor(pnlSeries);

  return {
    cohort: {
      id: cohort.id,
      label: cohort.label,
      description: cohort.description,
      cutoff: cohort.openedAtFrom,
      filtered: cohort.filtered,
    },
    excludedTrades,
    excludedRealizedPnLUSD,
    currentBalanceUSD,
    currentEquityUSD,
    liveFloatingPnLUSD: floating,
    liveFloatingPnLPct: activeNotional > 0 ? (floating / activeNotional) * 100 : 0,
    todayRealizedPnLUSD: today.realizedPnlUsd,
    todayClosedTrades: today.totalClosed,
    totalSimulatedTrades: lifetime.totalClosed,
    winRatePct: lifetime.totalClosed > 0 ? (lifetime.wins / lifetime.totalClosed) * 100 : 0,
    totalWins: lifetime.wins,
    totalLosses: lifetime.losses,
    unclaimedFeesUSD: unclaimedFees,
    activePositionsCount: active.length,
    startingBalanceUSD: startingBalanceUsd,

    // Risk metrics over closed trades.
    maxDrawdownPct: drawdown.maxDrawdownPct,
    maxDrawdownUSD: drawdown.maxDrawdownUsd,
    currentDrawdownPct: drawdown.currentDrawdownPct,
    drawdownPeakUSD: drawdown.peakEquityUsd,
    drawdownTroughUSD: drawdown.troughEquityUsd,
    /** null when undefined, i.e. no closed trades or no losing trades yet. */
    profitFactor: profit.profitFactor,
    grossProfitUSD: profit.grossProfitUsd,
    grossLossUSD: profit.grossLossUsd,
    serverStatus: "ONLINE" as const,
    isDryRun: env.DRY_RUN,
    /*
     * Read live, not cached, and gated on the same predicate the trading cycle uses.
     * The warnings the read returns are deliberately dropped here: the cycle logs them
     * once per cycle, and this route is polled once a minute per open dashboard tab.
     */
    newsBlackout: isLiveExecutionActive() ? toBlackoutStatus(readNewsBlackout().active) : null,
    serverTime: new Date().toISOString(),
    timezone: env.TZ,
  };
}
