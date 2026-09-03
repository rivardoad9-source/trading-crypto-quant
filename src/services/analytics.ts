/**
 * The payload behind `GET /api/analytics/live`, which drives `docs/analytics_dashboard.html`.
 *
 * Assembled here rather than in the route for the same reason `overview.ts` exists: the
 * shape is shared with the Telegram surface later, and a route handler is a bad place
 * for arithmetic nobody can unit-test.
 *
 * Two contracts this file must keep:
 *
 * - **Day keys are the API's local day**, resolved through the IANA database in
 *   `src/services/timezone.ts` and applied by `aggregateClosedTradesByDate`. That
 *   matches `/api/pnl-calendar` and the Next.js dashboard, so the two surfaces cannot
 *   disagree about which day a trade landed on. The timezone is reported in the payload
 *   (`timezone`) so the page can label it — an unlabelled date column is exactly how a
 *   7-hour offset goes unnoticed.
 * - **Undefined metrics stay null.** `topPool` is null with no closed trades and
 *   `maxDrawdownPct` is 0 on a monotonic curve; neither is padded into a fake reading.
 */
import {
  aggregateClosedTradesByDate,
  getClosedTradeLog,
  getHourlyPerformance,
  getPoolPerformance,
  getRealisedPnlSeries,
} from "../database/repositories.js";
import { computeCurrentWinStreak, computeMaxDrawdown, computeProfitFactor } from "./metrics.js";
import { getStartingBalanceUsd } from "../config/startingBalance.js";
import { env } from "../config/env.js";
import { defaultCohort, type Cohort } from "./cohort.js";
import { localDateString } from "../agents/researcherAgent.js";

/** One calendar day of closed-trade activity. */
export interface AnalyticsDay {
  /** YYYY-MM-DD in the API's timezone. */
  date: string;
  pnl: number;
  tradesCount: number;
  wins: number;
  losses: number;
}

export interface AnalyticsSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  /** Percentage, 0-100. Zero trades reports 0 rather than NaN. */
  winRate: number;
  netPnl: number;
  /** Net PnL as a percentage of the starting balance. */
  netPnlPct: number;
  startingBalanceUsd: number;
  /** Days on which at least one position closed. */
  activeDays: number;
  /** Consecutive profitable closes, counting back from the most recent. */
  currentStreak: number;
  /** Positive percentage. 0 means the realised curve never turned down. */
  maxDrawdown: number;
  maxDrawdownUsd: number;
  /** Null until at least one trade has closed. */
  topPool: { poolAddress: string; pairName: string; trades: number; netPnlUsd: number } | null;
  /** Close hour that booked the most PnL. Null until at least one trade has closed. */
  peakHour: { hour: number; trades: number; netPnlUsd: number } | null;
  /** Null when there are no losing trades — Infinity would render as a real reading. */
  profitFactor: number | null;
}

/** One closed trade, as the page consumes it. */
export interface AnalyticsTrade {
  /** Stable dedup key when the page merges this log with its frozen archive. */
  id: string;
  /** ISO-8601 with an explicit Z. Stored timestamps are UTC without a zone marker,
   *  and a client parsing a naive string would read it as local time. */
  closedAt: string;
  pnl: number;
  pool: string;
  /** Derived from opened_at against ENGINE_V11_CUTOFF, the same rule as the cohorts. */
  engineVersion: "v1.0" | "v1.1";
}

export interface LiveAnalytics {
  summary: AnalyticsSummary;
  dailyHeatmap: AnalyticsDay[];
  /** Trade-level log so the page can merge with its archive and recompute locally. */
  trades: AnalyticsTrade[];
  cohort: { id: string; label: string; filtered: boolean; cutoff: string | null };
  /** Names the zone the day keys were bucketed in, so the page can say so. */
  timezone: string;
  /** The trailing window applied, or null when the payload covers all history. */
  window: { days: number; startDate: string } | null;
  generatedAt: string;
}

/*
 * Unbounded date window. `aggregateClosedTradesByDate` is the project's only
 * closed-trades-by-day query and it takes a range; widening it here beats adding a
 * second, near-identical SQL statement that could drift from the first.
 */
const FIRST_POSSIBLE_DATE = "0001-01-01";
const LAST_POSSIBLE_DATE = "9999-12-31";

/**
 * A pool label safe to render.
 *
 * Meteora's `pair_name` is unreliable — rows exist with names like "-SOL" where a token
 * symbol was never resolved. Rather than display a half-name as though it were the
 * pair, fall back to a truncated address, which is at least unambiguous.
 */
export function displayPoolLabel(pairName: string | null, poolAddress: string): string {
  const name = (pairName ?? "").trim();
  if (name && !name.startsWith("-") && !name.endsWith("-")) return name;
  return `${poolAddress.slice(0, 4)}…${poolAddress.slice(-4)}`;
}

/**
 * Start of a trailing window of `days` calendar days ending today, as YYYY-MM-DD in the
 * API's timezone. `days = 7` therefore includes today and the six days before it.
 */
export function trailingWindowStart(days: number, today = localDateString()): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  // Built from UTC components on a date-only value, so no zone shift can slide the
  // boundary a day — the same rule the annual curve uses for its day keys.
  const start = new Date(Date.UTC(y, m - 1, d - (days - 1)));
  return start.toISOString().slice(0, 10);
}

/**
 * @param windowDays Trailing window in calendar days, or null for the whole history.
 *   The summary and the heatmap are computed over the SAME window — a summary covering
 *   all time beside a windowed heatmap is the kind of quiet mismatch that makes a
 *   dashboard lie.
 */
export function computeLiveAnalytics(
  cohort: Cohort = defaultCohort(),
  windowDays: number | null = null,
): LiveAnalytics {
  const windowStart = windowDays === null ? null : trailingWindowStart(windowDays);
  const filter = { openedAtFrom: cohort.openedAtFrom, closedOnOrAfter: windowStart };

  const rows = aggregateClosedTradesByDate(
    windowStart ?? FIRST_POSSIBLE_DATE,
    LAST_POSSIBLE_DATE,
    filter,
  );
  const dailyHeatmap: AnalyticsDay[] = rows.map((r) => ({
    date: r.date,
    pnl: r.netPnlUsd,
    tradesCount: r.trades,
    wins: r.wins,
    losses: r.losses,
  }));

  // Ordered oldest close first, which is what both the drawdown walk and the streak
  // count assume.
  const pnlSeries = getRealisedPnlSeries(filter);
  const startingBalanceUsd = getStartingBalanceUsd();
  const drawdown = computeMaxDrawdown(pnlSeries, startingBalanceUsd);

  const totalTrades = pnlSeries.length;
  const wins = pnlSeries.filter((p) => p > 0).length;
  const losses = totalTrades - wins;
  const netPnl = pnlSeries.reduce((sum, p) => sum + p, 0);

  const cutoffMs = Date.parse(env.ENGINE_V11_CUTOFF);
  const trades: AnalyticsTrade[] = getClosedTradeLog(filter).map((r) => ({
    id: r.positionId,
    // Stamp the zone the stored value always meant, so no client can misread it.
    closedAt: r.closedAt.trim().replace(" ", "T") + "Z",
    pnl: r.realizedPnlUsd ?? 0,
    pool: displayPoolLabel(r.pairName, r.poolAddress),
    engineVersion:
      Date.parse(r.openedAt.trim().replace(" ", "T") + "Z") >= cutoffMs ? "v1.1" : "v1.0",
  }));

  const pools = getPoolPerformance(filter);
  const best = pools[0];
  // Both queries order by netPnlUsd DESC, so the first row is the best bucket.
  const bestHour = getHourlyPerformance(filter)[0];

  return {
    summary: {
      totalTrades,
      wins,
      losses,
      winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
      netPnl,
      netPnlPct: (netPnl / startingBalanceUsd) * 100,
      startingBalanceUsd,
      activeDays: dailyHeatmap.filter((d) => d.tradesCount > 0).length,
      currentStreak: computeCurrentWinStreak(pnlSeries),
      maxDrawdown: drawdown.maxDrawdownPct,
      maxDrawdownUsd: drawdown.maxDrawdownUsd,
      topPool: best
        ? {
            poolAddress: best.poolAddress,
            pairName: displayPoolLabel(best.pairName, best.poolAddress),
            trades: best.trades,
            netPnlUsd: best.netPnlUsd,
          }
        : null,
      peakHour: bestHour
        ? { hour: Number(bestHour.hour), trades: bestHour.trades, netPnlUsd: bestHour.netPnlUsd }
        : null,
      profitFactor: computeProfitFactor(pnlSeries).profitFactor,
    },
    dailyHeatmap,
    trades,
    cohort: {
      id: cohort.id,
      label: cohort.label,
      filtered: cohort.filtered,
      cutoff: cohort.openedAtFrom,
    },
    timezone: env.TZ,
    window: windowDays === null ? null : { days: windowDays, startDate: windowStart as string },
    generatedAt: new Date().toISOString(),
  };
}
