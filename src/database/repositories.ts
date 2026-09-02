import { db } from "./db.js";
import {
  CLOSED_STATUSES,
  COOLDOWN_STATUSES,
  FAILURE_STATUSES,
  POSITION_STATUS,
} from "../config/constants.js";
import { summarisePoolExits, type PoolExitRecord } from "../services/meteora.js";
import type {
  ClosePositionInput,
  DailyPnlSnapshotRow,
  DailyResearchRow,
  NewPositionInput,
  PositionUpdateInput,
  SimulatedPositionRow,
} from "./types.js";

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(", ");
const FAILURE_LIST = FAILURE_STATUSES.map((s) => `'${s}'`).join(", ");
/** Excludes CLOSED_MANUAL — see COOLDOWN_STATUSES for why the operator is invisible here. */
const COOLDOWN_LIST = COOLDOWN_STATUSES.map((s) => `'${s}'`).join(", ");

/* ------------------------------------------------------------------ */
/* Engine version cohorts                                              */
/* ------------------------------------------------------------------ */

/**
 * Restricts a query to one engine cohort.
 *
 * `openedAtFrom` is compared through SQLite's `datetime()` rather than as a raw string:
 * timestamps are stored as 'YYYY-MM-DD HH:MM:SS' with no zone marker, so an ISO cutoff
 * carrying 'T' and 'Z' would never compare correctly lexicographically. `datetime()`
 * normalises both sides to the stored shape.
 *
 * Filtering on opened_at is deliberate — see services/cohort.ts. Ordering still runs on
 * closed_at where the caller needs chronological closes.
 */
export interface CohortFilter {
  openedAtFrom: string | null;
  /**
   * Optional trailing window on the CLOSE date (YYYY-MM-DD, API-local like every other
   * date in this file). Independent of `openedAtFrom`: cohort membership is decided by
   * the entry, a trailing window by the exit, and the analytics view needs both at once
   * ("the last 30 days of the v1.1 engine"). Undefined means no window at all.
   */
  closedOnOrAfter?: string | null;
}

export const ALL_TIME: CohortFilter = { openedAtFrom: null };

/** SQL fragment plus its bound parameters, in the order they must be appended. */
function cohortSql(cohort: CohortFilter): { clause: string; params: string[] } {
  let clause = "";
  const params: string[] = [];
  if (cohort.openedAtFrom) {
    clause += " AND opened_at >= datetime(?)";
    params.push(cohort.openedAtFrom);
  }
  if (cohort.closedOnOrAfter) {
    // Same 'localtime' bucketing as aggregateClosedTradesByDate, so a trailing window
    // and the heatmap can never disagree about which day a close belongs to.
    clause += " AND date(closed_at, 'localtime') >= ?";
    params.push(cohort.closedOnOrAfter);
  }
  return { clause, params };
}
/* ------------------------------------------------------------------ */
/* Positions                                                           */
/* ------------------------------------------------------------------ */

export function insertPosition(input: NewPositionInput): void {
  db.prepare(
    `INSERT INTO simulated_positions (
       position_id, pool_address, pair_name, strategy_type,
       entry_price, lower_bin_price, upper_bin_price, virtual_sol_amount,
       entry_tvl, entry_24h_volume, status, confidence_score,
       reasoning_log, entry_sol_price_usd, current_price, last_checked_at,
       top10_holder_pct, mint_authority_revoked, freeze_authority_revoked,
       safety_verdict, est_gas_cost_usd, est_priority_micro_lamports,
       breakeven_coverage_ratio, expected_fee_24h_usd
     ) VALUES (
       @positionId, @poolAddress, @pairName, @strategyType,
       @entryPrice, @lowerBinPrice, @upperBinPrice, @virtualSolAmount,
       @entryTvl, @entry24hVolume, '${POSITION_STATUS.ACTIVE}', @confidenceScore,
       @reasoningLog, @entrySolPriceUsd, @entryPrice, CURRENT_TIMESTAMP,
       @top10HolderPct, @mintAuthorityRevoked, @freezeAuthorityRevoked,
       @safetyVerdict, @estGasCostUsd, @estPriorityMicroLamports,
       @breakevenCoverageRatio, @expectedFee24hUsd
     )`,
  ).run({
    ...input,
    top10HolderPct: input.top10HolderPct ?? null,
    safetyVerdict: input.safetyVerdict ?? null,
    estGasCostUsd: input.estGasCostUsd ?? null,
    estPriorityMicroLamports: input.estPriorityMicroLamports ?? null,
    breakevenCoverageRatio: input.breakevenCoverageRatio ?? null,
    expectedFee24hUsd: input.expectedFee24hUsd ?? null,
    // SQLite has no boolean type; store 1 / 0 / null so "unknown" stays distinct
    // from "checked and still live".
    mintAuthorityRevoked:
      input.mintAuthorityRevoked === null || input.mintAuthorityRevoked === undefined
        ? null
        : input.mintAuthorityRevoked
          ? 1
          : 0,
    freezeAuthorityRevoked:
      input.freezeAuthorityRevoked === null || input.freezeAuthorityRevoked === undefined
        ? null
        : input.freezeAuthorityRevoked
          ? 1
          : 0,
  });
}

/** Stores the DeepSeek post-mortem for a closed position. */
export function setPostMortem(positionId: string, text: string): void {
  db.prepare(
    `UPDATE simulated_positions
        SET post_mortem = ?, post_mortem_at = CURRENT_TIMESTAMP
      WHERE position_id = ?`,
  ).run(text, positionId);
}

/**
 * Closed positions that still have no post-mortem. Lets a failed or skipped
 * reflection be retried on a later cycle instead of being lost.
 */
export function getPositionsAwaitingPostMortem(limit = 5): SimulatedPositionRow[] {
  return db
    .prepare(
      `SELECT * FROM simulated_positions
        WHERE status IN (${CLOSED_LIST})
          AND (post_mortem IS NULL OR post_mortem = '')
        ORDER BY closed_at DESC
        LIMIT ?`,
    )
    .all(limit) as SimulatedPositionRow[];
}

/**
 * The most recent losing closes that carry a written post-mortem.
 *
 * Feeds the entry prompt's loss-history block, so the model sees how its last few
 * choices actually played out instead of judging each candidate from scratch. Rows
 * without a post-mortem are excluded rather than padded with a placeholder: an empty
 * lesson is not evidence, and the prompt contract elsewhere in this project is that
 * missing data is stated as missing, never invented.
 *
 * Restricted to FAILURE_STATUSES for the same reason the lockout is — a timeout or a
 * manual close says nothing about the range having been wrong.
 */
export function getRecentFailurePostMortems(limit = 5): SimulatedPositionRow[] {
  return db
    .prepare(
      `SELECT * FROM simulated_positions
        WHERE status IN (${FAILURE_LIST})
          AND post_mortem IS NOT NULL
          AND TRIM(post_mortem) <> ''
        ORDER BY closed_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as SimulatedPositionRow[];
}

export function getActivePositions(cohort: CohortFilter = ALL_TIME): SimulatedPositionRow[] {
  const { clause, params } = cohortSql(cohort);
  return db
    .prepare(
      `SELECT * FROM simulated_positions
        WHERE status = '${POSITION_STATUS.ACTIVE}'${clause}
        ORDER BY opened_at DESC`,
    )
    .all(...params) as SimulatedPositionRow[];
}

export function countActivePositions(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM simulated_positions WHERE status = '${POSITION_STATUS.ACTIVE}'`,
    )
    .get() as { n: number };
  return row.n;
}

export function hasActivePositionForPool(poolAddress: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM simulated_positions
        WHERE pool_address = ? AND status = '${POSITION_STATUS.ACTIVE}' LIMIT 1`,
    )
    .get(poolAddress) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * Per-pool exit history for the cooldown and lockout gates.
 *
 * Reads every closed trade newest-first and folds each pool's run of outcomes into a
 * single record. Ordering is `closed_at DESC, id DESC`: the consecutive-failure count
 * is taken from the front of each pool's list, so a different order would change the
 * verdict rather than just the presentation.
 *
 * `lookbackHours` bounds the scan — a trade far older than the longest lockout window
 * can no longer block anything, but it CAN still be the non-failing close that breaks
 * a run, so the default window is generously wider than POOL_LOCKOUT_HOURS.
 */
export function getPoolExitHistory(lookbackHours = 24 * 30): Map<string, PoolExitRecord> {
  const rows = db
    .prepare(
      `SELECT pool_address, status, closed_at
         FROM simulated_positions
        WHERE status IN (${COOLDOWN_LIST})
          AND closed_at IS NOT NULL
          AND closed_at >= datetime('now', ?)
        ORDER BY closed_at DESC, id DESC`,
    )
    .all(`-${lookbackHours} hours`) as Array<{
    pool_address: string;
    status: string;
    closed_at: string | null;
  }>;

  const byPool = new Map<string, Array<{ status: string; closed_at: string | null }>>();
  for (const row of rows) {
    const list = byPool.get(row.pool_address);
    if (list) list.push(row);
    else byPool.set(row.pool_address, [row]);
  }

  const history = new Map<string, PoolExitRecord>();
  for (const [poolAddress, poolRows] of byPool) {
    history.set(poolAddress, summarisePoolExits(poolAddress, poolRows));
  }
  return history;
}

/** The exit history of a single pool, for logging a lockout as it is triggered. */
export function getPoolExitRecord(poolAddress: string, limit = 20): PoolExitRecord {
  const rows = db
    .prepare(
      `SELECT status, closed_at
         FROM simulated_positions
        WHERE pool_address = ?
          AND status IN (${COOLDOWN_LIST})
          AND closed_at IS NOT NULL
        ORDER BY closed_at DESC, id DESC
        LIMIT ?`,
    )
    .all(poolAddress, limit) as Array<{ status: string; closed_at: string | null }>;

  return summarisePoolExits(poolAddress, rows);
}

export function updatePositionMetrics(input: PositionUpdateInput): void {
  db.prepare(
    `UPDATE simulated_positions
        SET current_price = @currentPrice,
            unclaimed_fee_usd = @unclaimedFeeUsd,
            impermanent_loss_usd = @impermanentLossUsd,
            position_value_change_usd = @positionValueChangeUsd,
            floating_pnl_usd = @floatingPnlUsd,
            last_checked_at = CURRENT_TIMESTAMP
      WHERE position_id = @positionId`,
  ).run(input);
}

export function closePosition(input: ClosePositionInput): void {
  db.prepare(
    `UPDATE simulated_positions
        SET status = @status,
            exit_price = @exitPrice,
            current_price = @exitPrice,
            realized_pnl_usd = @realizedPnlUsd,
            realized_pnl_pct = @realizedPnlPct,
            unclaimed_fee_usd = @unclaimedFeeUsd,
            impermanent_loss_usd = @impermanentLossUsd,
            position_value_change_usd = @positionValueChangeUsd,
            floating_pnl_usd = 0,
            close_reason = @closeReason,
            closed_at = CURRENT_TIMESTAMP,
            last_checked_at = CURRENT_TIMESTAMP
      WHERE position_id = @positionId`,
  ).run(input);
}

export function getClosedPositions(
  limit = 100,
  offset = 0,
  cohort: CohortFilter = ALL_TIME,
): SimulatedPositionRow[] {
  const { clause, params } = cohortSql(cohort);
  return db
    .prepare(
      `SELECT * FROM simulated_positions
        WHERE status IN (${CLOSED_LIST})${clause}
        ORDER BY closed_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as SimulatedPositionRow[];
}

export function getPositionById(positionId: string): SimulatedPositionRow | undefined {
  return db.prepare(`SELECT * FROM simulated_positions WHERE position_id = ?`).get(positionId) as
    | SimulatedPositionRow
    | undefined;
}

/* ------------------------------------------------------------------ */
/* Aggregates                                                          */
/* ------------------------------------------------------------------ */

export interface TradeStats {
  totalClosed: number;
  wins: number;
  losses: number;
  realizedPnlUsd: number;
}

export function getLifetimeStats(cohort: CohortFilter = ALL_TIME): TradeStats {
  const { clause, params } = cohortSql(cohort);
  return db
    .prepare(
      `SELECT
         COUNT(*) AS totalClosed,
         COALESCE(SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN realized_pnl_usd <= 0 THEN 1 ELSE 0 END), 0) AS losses,
         COALESCE(SUM(realized_pnl_usd), 0) AS realizedPnlUsd
       FROM simulated_positions
       WHERE status IN (${CLOSED_LIST})${clause}`,
    )
    .get(...params) as TradeStats;
}

/** `date` must be YYYY-MM-DD in local time. */
export function getStatsForDate(date: string, cohort: CohortFilter = ALL_TIME): TradeStats {
  const { clause, params } = cohortSql(cohort);
  return db
    .prepare(
      `SELECT
         COUNT(*) AS totalClosed,
         COALESCE(SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN realized_pnl_usd <= 0 THEN 1 ELSE 0 END), 0) AS losses,
         COALESCE(SUM(realized_pnl_usd), 0) AS realizedPnlUsd
       FROM simulated_positions
       WHERE status IN (${CLOSED_LIST})${clause}
         AND date(closed_at, 'localtime') = ?`,
    )
    .get(...params, date) as TradeStats;
}

export function getTotalFloatingPnlUsd(cohort: CohortFilter = ALL_TIME): number {
  const { clause, params } = cohortSql(cohort);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(floating_pnl_usd), 0) AS v
         FROM simulated_positions
        WHERE status = '${POSITION_STATUS.ACTIVE}'${clause}`,
    )
    .get(...params) as { v: number };
  return row.v;
}

/**
 * Realised PnL of every closed trade, oldest close first. This ordering is what makes
 * the drawdown curve reproducible — sorting any other way changes the answer.
 */
export function getRealisedPnlSeries(cohort: CohortFilter = ALL_TIME): number[] {
  const { clause, params } = cohortSql(cohort);
  const rows = db
    .prepare(
      `SELECT realized_pnl_usd AS pnl
         FROM simulated_positions
        WHERE status IN (${CLOSED_LIST})${clause}
        ORDER BY closed_at ASC, id ASC`,
    )
    .all(...params) as Array<{ pnl: number | null }>;

  return rows.map((r) => r.pnl ?? 0);
}

export function getTotalUnclaimedFeesUsd(cohort: CohortFilter = ALL_TIME): number {
  const { clause, params } = cohortSql(cohort);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(unclaimed_fee_usd), 0) AS v
         FROM simulated_positions
        WHERE status = '${POSITION_STATUS.ACTIVE}'${clause}`,
    )
    .get(...params) as { v: number };
  return row.v;
}

/* ------------------------------------------------------------------ */
/* Daily PnL snapshots                                                 */
/* ------------------------------------------------------------------ */

export function upsertDailySnapshot(row: {
  date: string;
  totalTradesClosed: number;
  winningTrades: number;
  losingTrades: number;
  netPnlUsd: number;
  netPnlSol: number;
}): void {
  db.prepare(
    `INSERT INTO daily_pnl_snapshots
       (date, total_trades_closed, winning_trades, losing_trades, net_pnl_usd, net_pnl_sol, updated_at)
     VALUES (@date, @totalTradesClosed, @winningTrades, @losingTrades, @netPnlUsd, @netPnlSol, CURRENT_TIMESTAMP)
     ON CONFLICT(date) DO UPDATE SET
       total_trades_closed = excluded.total_trades_closed,
       winning_trades      = excluded.winning_trades,
       losing_trades       = excluded.losing_trades,
       net_pnl_usd         = excluded.net_pnl_usd,
       net_pnl_sol         = excluded.net_pnl_sol,
       updated_at          = CURRENT_TIMESTAMP`,
  ).run(row);
}

/** Snapshots within [startDate, endDate] inclusive, both YYYY-MM-DD. */
export function getSnapshotsInRange(startDate: string, endDate: string): DailyPnlSnapshotRow[] {
  return db
    .prepare(
      `SELECT * FROM daily_pnl_snapshots
        WHERE date >= ? AND date <= ?
        ORDER BY date ASC`,
    )
    .all(startDate, endDate) as DailyPnlSnapshotRow[];
}

export interface DailyAggregateRow {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  netPnlUsd: number;
}

/**
 * Live aggregation straight from closed trades. The calendar endpoint prefers this
 * over daily_pnl_snapshots so today's still-accumulating PnL is visible before the
 * nightly snapshot job runs.
 */
export function aggregateClosedTradesByDate(
  startDate: string,
  endDate: string,
  cohort: CohortFilter = ALL_TIME,
): DailyAggregateRow[] {
  const { clause, params } = cohortSql(cohort);
  return db
    .prepare(
      `SELECT
         date(closed_at, 'localtime') AS date,
         COUNT(*) AS trades,
         COALESCE(SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN realized_pnl_usd <= 0 THEN 1 ELSE 0 END), 0) AS losses,
         COALESCE(SUM(realized_pnl_usd), 0) AS netPnlUsd
       FROM simulated_positions
       WHERE status IN (${CLOSED_LIST})${clause}
         AND date(closed_at, 'localtime') BETWEEN ? AND ?
       GROUP BY date(closed_at, 'localtime')
       ORDER BY date ASC`,
    )
    .all(...params, startDate, endDate) as DailyAggregateRow[];
}

/**
 * Today's date in the same frame `aggregateClosedTradesByDate` buckets by.
 *
 * Callers that need to line a date range up with the day keys this file produces must
 * ask SQLite rather than compute one in JS: `'localtime'` resolves against the C
 * runtime's timezone, which is not always the same thing as `process.env.TZ` (a Windows
 * host cannot read an IANA name and silently lands on a different offset).
 */
export function currentLocalDate(): string {
  const row = db.prepare("SELECT date('now', 'localtime') AS d").get() as { d: string };
  return row.d;
}

/** One pool's realised contribution, for the analytics "top pool" figure. */
export interface PoolPerformanceRow {
  poolAddress: string;
  pairName: string;
  trades: number;
  netPnlUsd: number;
}

/**
 * Realised PnL grouped by pool, best first.
 *
 * Grouped by `pool_address`, not by `pair_name`: the upstream name is unreliable — a
 * number of rows carry a broken label such as "-SOL" — so grouping by name would merge
 * unrelated pools into one bogus row. The name is carried along for display only, and
 * the caller is expected to fall back to the address when it is empty or malformed.
 */
export function getPoolPerformance(cohort: CohortFilter = ALL_TIME): PoolPerformanceRow[] {
  const { clause, params } = cohortSql(cohort);
  return db
    .prepare(
      `SELECT
         pool_address AS poolAddress,
         MAX(pair_name) AS pairName,
         COUNT(*) AS trades,
         COALESCE(SUM(realized_pnl_usd), 0) AS netPnlUsd
       FROM simulated_positions
       WHERE status IN (${CLOSED_LIST})${clause}
       GROUP BY pool_address
       ORDER BY netPnlUsd DESC`,
    )
    .all(...params) as PoolPerformanceRow[];
}

/** Realised PnL bucketed by close hour, for the analytics "peak trading hour" figure. */
export interface HourlyPerformanceRow {
  /** 00-23, in the API's timezone — the same 'localtime' bucketing as the day keys. */
  hour: string;
  trades: number;
  netPnlUsd: number;
}

export function getHourlyPerformance(cohort: CohortFilter = ALL_TIME): HourlyPerformanceRow[] {
  const { clause, params } = cohortSql(cohort);
  return db
    .prepare(
      `SELECT
         strftime('%H', closed_at, 'localtime') AS hour,
         COUNT(*) AS trades,
         COALESCE(SUM(realized_pnl_usd), 0) AS netPnlUsd
       FROM simulated_positions
       WHERE status IN (${CLOSED_LIST})${clause}
       GROUP BY hour
       ORDER BY netPnlUsd DESC`,
    )
    .all(...params) as HourlyPerformanceRow[];
}

/** One closed trade, reduced to what the analytics page needs to merge and recompute. */
export interface ClosedTradeLogRow {
  positionId: string;
  poolAddress: string;
  pairName: string | null;
  openedAt: string;
  closedAt: string;
  realizedPnlUsd: number | null;
}

/**
 * The closed-trade log, oldest close first.
 *
 * Lean on purpose: the analytics page merges this with a frozen archive and recomputes
 * every figure client-side, so it needs identity, timing and PnL — not the forty other
 * columns `getClosedPositions` carries for the position table.
 *
 * `position_id` is included because it is the only stable dedup key. Merging on
 * (date, pnl) would silently drop two genuinely different trades that happened to
 * close on the same day for the same amount.
 */
export function getClosedTradeLog(cohort: CohortFilter = ALL_TIME): ClosedTradeLogRow[] {
  const { clause, params } = cohortSql(cohort);
  return db
    .prepare(
      `SELECT
         position_id      AS positionId,
         pool_address     AS poolAddress,
         pair_name        AS pairName,
         opened_at        AS openedAt,
         closed_at        AS closedAt,
         realized_pnl_usd AS realizedPnlUsd
       FROM simulated_positions
       WHERE status IN (${CLOSED_LIST})${clause}
       ORDER BY closed_at ASC, id ASC`,
    )
    .all(...params) as ClosedTradeLogRow[];
}

/* ------------------------------------------------------------------ */
/* Research logs                                                       */
/* ------------------------------------------------------------------ */

export function upsertResearchLog(row: {
  reportDate: string;
  rawMacroJson: string;
  markdownOutput: string;
  sentimentBias: string | null;
}): void {
  db.prepare(
    `INSERT INTO daily_research_logs (report_date, raw_macro_json, markdown_output, sentiment_bias)
     VALUES (@reportDate, @rawMacroJson, @markdownOutput, @sentimentBias)
     ON CONFLICT(report_date) DO UPDATE SET
       raw_macro_json  = excluded.raw_macro_json,
       markdown_output = excluded.markdown_output,
       sentiment_bias  = excluded.sentiment_bias,
       created_at      = CURRENT_TIMESTAMP`,
  ).run(row);
}

export function getLatestResearch(): DailyResearchRow | undefined {
  return db.prepare(`SELECT * FROM daily_research_logs ORDER BY report_date DESC LIMIT 1`).get() as
    | DailyResearchRow
    | undefined;
}

export function getResearchHistory(limit = 30): DailyResearchRow[] {
  return db
    .prepare(`SELECT * FROM daily_research_logs ORDER BY report_date DESC LIMIT ?`)
    .all(limit) as DailyResearchRow[];
}
