import { getStatsForDate, upsertDailySnapshot } from "../database/repositories.js";
import { fetchSolPriceUsd } from "../services/marketData.js";
import { localDateString } from "./researcherAgent.js";

/**
 * Rolls the day's closed trades into daily_pnl_snapshots, which backs the calendar
 * heatmap. Idempotent — re-running for the same date overwrites that row.
 *
 * net_pnl_sol is derived from the day's closing SOL price. When that price is
 * unavailable the SOL column is left at 0 rather than converted at a guessed rate;
 * net_pnl_usd stays authoritative either way.
 */
export async function runDailySnapshot(date = localDateString()): Promise<void> {
  const stats = getStatsForDate(date);
  const solPriceUsd = await fetchSolPriceUsd();

  upsertDailySnapshot({
    date,
    totalTradesClosed: stats.totalClosed,
    winningTrades: stats.wins,
    losingTrades: stats.losses,
    netPnlUsd: stats.realizedPnlUsd,
    netPnlSol: solPriceUsd && solPriceUsd > 0 ? stats.realizedPnlUsd / solPriceUsd : 0,
  });

  console.log(
    `[snapshot] ${date}: ${stats.totalClosed} closed, ` +
      `${stats.wins}W/${stats.losses}L, net $${stats.realizedPnlUsd.toFixed(2)}`,
  );
}
