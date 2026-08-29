import {
  getActivePositions,
  getLifetimeStats,
  getRealisedPnlSeries,
  getStatsForDate,
  getTotalFloatingPnlUsd,
  getTotalUnclaimedFeesUsd,
} from "../database/repositories.js";
import { computeMaxDrawdown, computeProfitFactor } from "./metrics.js";
import { localDateString } from "../agents/researcherAgent.js";
import { STARTING_BALANCE_USD } from "../config/constants.js";
import { env } from "../config/env.js";

/**
 * The KPI payload served by GET /api/overview and reused verbatim by the
 * Telegram /status command, so the dashboard and the bot can never disagree.
 *
 * All figures are derived from closed-trade history; floating PnL is reported
 * separately and excluded from drawdown/profit-factor so those stay
 * reproducible from stored history.
 */
export interface Overview {
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
  serverTime: string;
  timezone: string;
}

export function computeOverview(): Overview {
  const lifetime = getLifetimeStats();
  const today = getStatsForDate(localDateString());
  const floating = getTotalFloatingPnlUsd();
  const unclaimedFees = getTotalUnclaimedFeesUsd();
  const active = getActivePositions();

  const currentBalanceUSD = STARTING_BALANCE_USD + lifetime.realizedPnlUsd;
  const currentEquityUSD = currentBalanceUSD + floating;

  const activeNotional = active.reduce(
    (sum, r) => sum + (r.entry_sol_price_usd ?? 0) * r.virtual_sol_amount,
    0,
  );

  // Both metrics run over the realised equity curve, oldest close first. Floating
  // PnL is excluded so the figures are reproducible from stored history.
  const pnlSeries = getRealisedPnlSeries();
  const drawdown = computeMaxDrawdown(pnlSeries, STARTING_BALANCE_USD);
  const profit = computeProfitFactor(pnlSeries);

  return {
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
    startingBalanceUSD: STARTING_BALANCE_USD,

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
    serverTime: new Date().toISOString(),
    timezone: env.TZ,
  };
}
