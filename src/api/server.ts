import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env } from "../config/env.js";
import { initDatabase } from "../database/db.js";
import {
  aggregateClosedTradesByDate,
  getActivePositions,
  getClosedPositions,
  getLatestResearch,
  getPositionById,
  getResearchHistory,
} from "../database/repositories.js";
import { computeOverview } from "../services/overview.js";
import { computeLiveAnalytics } from "../services/analytics.js";
import { DEFAULT_COHORT_ID, isCohortId, resolveCohort } from "../services/cohort.js";
import { localDateString } from "../agents/researcherAgent.js";
import type { SimulatedPositionRow } from "../database/types.js";

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


/**
 * Reads ?cohort= off a request.
 *
 * Absent means all-time: an unparameterised call must never return a silent subset.
 * An unrecognised value is rejected rather than defaulted, because quietly serving
 * the archive to a client that asked for the clean run would mislabel the numbers.
 */
function readCohort(raw: string | undefined) {
  const id = raw ?? DEFAULT_COHORT_ID;
  if (!isCohortId(id)) return null;
  return resolveCohort(id);
}

const COHORT_ERROR = { error: "cohort must be one of: current, all" };

/**
 * Parses a query-string integer, refusing anything SQLite cannot bind.
 *
 * `Number("1e999")` is Infinity and `Number("1.5")` is a float; better-sqlite3 rejects
 * both, and the resulting throw surfaced as a bare HTTP 500. Found by fuzzing the
 * numeric parameters during the pre-flight audit — the route looked safe because
 * `Math.max(Number(x) || d, 0)` only guards NaN, not Infinity and not fractions.
 */
function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}


export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  void app.register(cors, { origin: true });

  /*
   * With `logger: false` Fastify's default error handler answers 500 and writes
   * NOTHING — a route that throws on the VPS would show as a broken dashboard with no
   * trace in the logs at all. Log it ourselves, and return a generic body rather than
   * the raw message so an internal error string never reaches the browser.
   */
  app.setErrorHandler((err: unknown, req, reply) => {
    const fastifyErr = err as { statusCode?: number; message?: string };
    const raw = fastifyErr.statusCode;
    const status = typeof raw === "number" && raw >= 400 && raw <= 599 ? raw : 500;

    if (status >= 500) {
      console.error(`[api] ${req.method} ${req.url} failed:`, err);
    }
    void reply.code(status).send({
      // 4xx messages are validation text and safe to echo; 5xx are not.
      error: status >= 500 ? "internal error" : (fastifyErr.message ?? "bad request"),
      statusCode: status,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: `no route for ${req.method} ${req.url}`, statusCode: 404 });
  });

  app.get("/api/health", async () => ({
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
    isDryRun: env.DRY_RUN,
  }));

  app.get<{ Querystring: { cohort?: string } }>("/api/overview", async (req, reply) => {
    const cohort = readCohort(req.query.cohort);
    if (!cohort) return reply.code(400).send(COHORT_ERROR);
    return computeOverview(cohort);
  });

  app.get<{ Querystring: { cohort?: string } }>("/api/positions/active", async (req, reply) => {
    const cohort = readCohort(req.query.cohort);
    if (!cohort) return reply.code(400).send(COHORT_ERROR);
    return {
      positions: getActivePositions({ openedAtFrom: cohort.openedAtFrom }).map(toPositionDto),
      cohort: cohort.id,
    };
  });

  app.get<{ Querystring: { limit?: string; offset?: string; cohort?: string } }>(
    "/api/positions/history",
    async (req, reply) => {
      const cohort = readCohort(req.query.cohort);
      if (!cohort) return reply.code(400).send(COHORT_ERROR);

      const limit = intParam(req.query.limit, 100, 1, 500);
      const offset = intParam(req.query.offset, 0, 0, 1_000_000);
      return {
        positions: getClosedPositions(limit, offset, {
          openedAtFrom: cohort.openedAtFrom,
        }).map(toPositionDto),
        limit,
        offset,
        cohort: cohort.id,
      };
    },
  );

  app.get<{ Params: { id: string } }>("/api/positions/:id", async (req, reply) => {
    const row = getPositionById(req.params.id);
    if (!row) return reply.code(404).send({ error: "position not found" });
    return toPositionDto(row);
  });

  app.get<{ Querystring: { month?: string; cohort?: string } }>(
    "/api/pnl-calendar",
    async (req, reply) => {
    const cohort = readCohort(req.query.cohort);
    if (!cohort) return reply.code(400).send(COHORT_ERROR);

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
    const rows = aggregateClosedTradesByDate(startDate, endDate, {
      openedAtFrom: cohort.openedAtFrom,
    });
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
      cohort: cohort.id,
    };
    },
  );

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
    const limit = intParam(req.query.limit, 30, 1, 200);
    return {
      reports: getResearchHistory(limit).map((r) => ({
        reportDate: r.report_date,
        markdown: r.markdown_output,
        bias: r.sentiment_bias,
        createdAt: r.created_at,
      })),
    };
  });

  /*
   * Feeds docs/analytics_dashboard.html.
   *
   * Cohort defaults to `all`, like every other route here: an unparameterised caller
   * must never silently receive a subset. The page asks for what it wants explicitly.
   */
  app.get<{ Querystring: { cohort?: string; days?: string } }>(
    "/api/analytics/live",
    async (req, reply) => {
      const cohort = readCohort(req.query.cohort);
      if (!cohort) return reply.code(400).send(COHORT_ERROR);

      // Absent `days` means the whole history. Present, it goes through intParam like
      // every other numeric query string here — Number("1e999") is Infinity and
      // better-sqlite3 rejects it as a bare 500.
      const days = req.query.days === undefined ? null : intParam(req.query.days, 30, 1, 3650);

      // No caching: the page polls this to see a close the fast monitor booked seconds ago.
      void reply.header("cache-control", "no-store");
      return computeLiveAnalytics(cohort, days);
    },
  );

  /*
   * Serves the analytics page from the API's own origin.
   *
   * Opened straight off disk the page is a `file://` document, where a relative
   * fetch("/api/...") resolves to file:///api/... and never reaches the engine. Serving
   * it here makes the fetch same-origin. The file is read per request rather than at
   * boot so editing it does not require restarting the engine; it is a handful of KB
   * and this route is hit by a human, not by the schedulers.
   */
  app.get("/analytics", async (_req, reply) => {
    // Resolves from this module, so it works both as src/api (tsx) and dist/api (built).
    const page = new URL("../../docs/analytics_dashboard.html", import.meta.url);
    try {
      const html = await readFile(page, "utf8");
      return await reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(html);
    } catch {
      // A missing page is a deployment problem, not a server fault worth a 500 stack.
      return reply.code(404).send({ error: "analytics dashboard is not present in this build" });
    }
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
