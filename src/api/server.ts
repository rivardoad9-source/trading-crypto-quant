import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env } from "../config/env.js";
import { initDatabase } from "../database/db.js";
import {
  aggregateClosedTradesByDate,
  getActivePositions,
  getClosedPositions,
  getLatestResearch,
  getLifetimeStats,
  getPositionById,
  getRealisedPnlSeries,
  getResearchHistory,
  getStatsForDate,
  getTotalFloatingPnlUsd,
  getTotalUnclaimedFeesUsd,
} from "../database/repositories.js";
import { computeMaxDrawdown, computeProfitFactor } from "../services/metrics.js";
import { localDateString } from "../agents/researcherAgent.js";
import type { SimulatedPositionRow } from "../database/types.js";

/**
 * The dashboard's notional starting balance. The engine deploys zero capital, so
 * "balance" is a simulation baseline plus realised PnL, not a custodial figure.
 */
const STARTING_BALANCE_USD = 1000;

const serverStartedAt = Date.now();

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

function toPositionDto(row: SimulatedPositionRow) {
  return {
    positionId: row.position_id,
    poolAddress: row.pool_address,
    pairName: row.pair_name,
    strategyType: row.strategy_type,
    status: row.status,
    entryPrice: row.entry_price,
    currentPrice: row.current_price ?? row.entry_price,
    exitPrice: row.exit_price,
    lowerBinPrice: row.lower_bin_price,
    upperBinPrice: row.upper_bin_price,
    virtualSolAmount: row.virtual_sol_amount,
    entrySolPriceUsd: row.entry_sol_price_usd,
    notionalUsd: (row.entry_sol_price_usd ?? 0) * row.virtual_sol_amount,
    entryTvl: row.entry_tvl,
    entry24hVolume: row.entry_24h_volume,
    unclaimedFeeUsd: row.unclaimed_fee_usd ?? 0,
    /** LP value vs capital — the account-moving figure. */
    positionValueChangeUsd: row.position_value_change_usd ?? 0,
    /** Divergence vs holding. Diagnostic only, never part of PnL. */
    divergenceVsHoldUsd: row.impermanent_loss_usd ?? 0,
    floatingPnlUsd: row.floating_pnl_usd ?? 0,
    realizedPnlUsd: row.realized_pnl_usd ?? 0,
    realizedPnlPct: row.realized_pnl_pct ?? 0,
    confidenceScore: row.confidence_score ?? 0,
    thesis: row.reasoning_log ?? "",
    closeReason: row.close_reason ?? "",
    postMortem: row.post_mortem ?? null,
    postMortemAt: row.post_mortem_at ?? null,
    safety: {
      verdict: row.safety_verdict ?? null,
      top10HolderPct: row.top10_holder_pct ?? null,
      // Stored as 1 / 0 / null, so null stays "not checked" rather than becoming false.
      mintAuthorityRevoked:
        row.mint_authority_revoked === null ? null : row.mint_authority_revoked === 1,
      freezeAuthorityRevoked:
        row.freeze_authority_revoked === null ? null : row.freeze_authority_revoked === 1,
    },
    estGasCostUsd: row.est_gas_cost_usd ?? null,
    estPriorityMicroLamports: row.est_priority_micro_lamports ?? null,
    breakevenCoverageRatio: row.breakeven_coverage_ratio ?? null,
    expectedFee24hUsd: row.expected_fee_24h_usd ?? null,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    lastCheckedAt: row.last_checked_at,
    inRange:
      row.current_price === null
        ? true
        : row.current_price >= row.lower_bin_price && row.current_price <= row.upper_bin_price,
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  void app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
    isDryRun: env.DRY_RUN,
  }));

  app.get("/api/overview", async () => {
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
  });

  app.get("/api/positions/active", async () => ({
    positions: getActivePositions().map(toPositionDto),
  }));

  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/api/positions/history",
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
      return { positions: getClosedPositions(limit, offset).map(toPositionDto), limit, offset };
    },
  );

  app.get<{ Params: { id: string } }>("/api/positions/:id", async (req, reply) => {
    const row = getPositionById(req.params.id);
    if (!row) return reply.code(404).send({ error: "position not found" });
    return toPositionDto(row);
  });

  app.get<{ Querystring: { month?: string } }>("/api/pnl-calendar", async (req, reply) => {
    // month = 'YYYY-MM', defaults to the current month in env.TZ.
    const month = req.query.month ?? localDateString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return reply.code(400).send({ error: "month must be formatted as YYYY-MM" });
    }

    const [yearStr, monthStr] = month.split("-") as [string, string];
    const year = Number(yearStr);
    const monthIndex = Number(monthStr) - 1;
    // Day 0 of the next month is the last day of this one.
    const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

    const startDate = `${month}-01`;
    const endDate = `${month}-${String(daysInMonth).padStart(2, "0")}`;

    // Aggregated live from closed trades so today's PnL appears before the
    // nightly snapshot job writes its row.
    const rows = aggregateClosedTradesByDate(startDate, endDate);
    const byDate = new Map(rows.map((r) => [r.date, r]));

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const date = `${month}-${String(i + 1).padStart(2, "0")}`;
      const row = byDate.get(date);
      return {
        date,
        day: i + 1,
        trades: row?.trades ?? 0,
        wins: row?.wins ?? 0,
        losses: row?.losses ?? 0,
        netPnlUsd: row?.netPnlUsd ?? 0,
      };
    });

    const monthNetPnlUsd = days.reduce((sum, d) => sum + d.netPnlUsd, 0);
    const monthTrades = days.reduce((sum, d) => sum + d.trades, 0);
    const monthWins = days.reduce((sum, d) => sum + d.wins, 0);

    return {
      month,
      daysInMonth,
      // 0 = Sunday. Lets the client pad the leading calendar cells.
      firstWeekday: new Date(Date.UTC(year, monthIndex, 1)).getUTCDay(),
      days,
      monthNetPnlUsd,
      monthTrades,
      monthWinRatePct: monthTrades > 0 ? (monthWins / monthTrades) * 100 : 0,
    };
  });

  app.get("/api/research/latest", async () => {
    const row = getLatestResearch();
    if (!row) return { report: null };
    return {
      report: {
        reportDate: row.report_date,
        markdown: row.markdown_output,
        bias: row.sentiment_bias,
        createdAt: row.created_at,
      },
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/research/history", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 30) || 30, 1), 200);
    return {
      reports: getResearchHistory(limit).map((r) => ({
        reportDate: r.report_date,
        markdown: r.markdown_output,
        bias: r.sentiment_bias,
        createdAt: r.created_at,
      })),
    };
  });

  return app;
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let instance: FastifyInstance | null = null;

export async function startApiServer(): Promise<FastifyInstance> {
  if (instance) return instance;

  initDatabase();
  const app = buildServer();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  instance = app;

  console.log(`[api] listening on http://localhost:${env.PORT}/api`);
  return app;
}

export async function stopApiServer(): Promise<void> {
  if (!instance) return;
  await instance.close();
  instance = null;
}

// Allow `npm run api` to boot the REST layer on its own, without the schedulers.
const isDirectRun =
  process.argv[1] !== undefined && /server\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
  startApiServer().catch((err) => {
    console.error("[api] failed to start:", err);
    process.exit(1);
  });
}
