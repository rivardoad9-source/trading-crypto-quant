import { db } from "./db.js";
import { CLOSED_STATUSES, POSITION_STATUS } from "../config/constants.js";
import type {
  ClosePositionInput,
  DailyPnlSnapshotRow,
  DailyResearchRow,
  NewPositionInput,
  PositionUpdateInput,
  SimulatedPositionRow,
} from "./types.js";

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(", ");

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

export function getActivePositions(): SimulatedPositionRow[] {
  return db
    .prepare(
      `SELECT * FROM simulated_positions
        WHERE status = '${POSITION_STATUS.ACTIVE}'
        ORDER BY opened_at DESC`,
    )
    .all() as SimulatedPositionRow[];
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

export function getClosedPositions(limit = 100, offset = 0): SimulatedPositionRow[] {
  return db
    .prepare(
      `SELECT * FROM simulated_positions
        WHERE status IN (${CLOSED_LIST})
        ORDER BY closed_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as SimulatedPositionRow[];
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

export function getLifetimeStats(): TradeStats {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS totalClosed,
         COALESCE(SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN realized_pnl_usd <= 0 THEN 1 ELSE 0 END), 0) AS losses,
         COALESCE(SUM(realized_pnl_usd), 0) AS realizedPnlUsd
       FROM simulated_positions
       WHERE status IN (${CLOSED_LIST})`,
    )
    .get() as TradeStats;
}

/** `date` must be YYYY-MM-DD in local time. */
export function getStatsForDate(date: string): TradeStats {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS totalClosed,
         COALESCE(SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN realized_pnl_usd <= 0 THEN 1 ELSE 0 END), 0) AS losses,
         COALESCE(SUM(realized_pnl_usd), 0) AS realizedPnlUsd
       FROM simulated_positions
       WHERE status IN (${CLOSED_LIST})
         AND date(closed_at, 'localtime') = ?`,
    )
    .get(date) as TradeStats;
}

export function getTotalFloatingPnlUsd(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(floating_pnl_usd), 0) AS v
         FROM simulated_positions
        WHERE status = '${POSITION_STATUS.ACTIVE}'`,
    )
    .get() as { v: number };
  return row.v;
}

/**
 * Realised PnL of every closed trade, oldest close first. This ordering is what makes
 * the drawdown curve reproducible — sorting any other way changes the answer.
 */
export function getRealisedPnlSeries(): number[] {
  const rows = db
    .prepare(
      `SELECT realized_pnl_usd AS pnl
         FROM simulated_positions
        WHERE status IN (${CLOSED_LIST})
        ORDER BY closed_at ASC, id ASC`,
    )
    .all() as Array<{ pnl: number | null }>;

  return rows.map((r) => r.pnl ?? 0);
}

export function getTotalUnclaimedFeesUsd(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(unclaimed_fee_usd), 0) AS v
         FROM simulated_positions
        WHERE status = '${POSITION_STATUS.ACTIVE}'`,
    )
    .get() as { v: number };
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
): DailyAggregateRow[] {
  return db
    .prepare(
      `SELECT
         date(closed_at, 'localtime') AS date,
         COUNT(*) AS trades,
         COALESCE(SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN realized_pnl_usd <= 0 THEN 1 ELSE 0 END), 0) AS losses,
         COALESCE(SUM(realized_pnl_usd), 0) AS netPnlUsd
       FROM simulated_positions
       WHERE status IN (${CLOSED_LIST})
         AND date(closed_at, 'localtime') BETWEEN ? AND ?
       GROUP BY date(closed_at, 'localtime')
       ORDER BY date ASC`,
    )
    .all(startDate, endDate) as DailyAggregateRow[];
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
