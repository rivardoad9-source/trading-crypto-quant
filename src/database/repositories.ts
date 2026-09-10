import { db } from "./db.js";
import {
  CLOSED_STATUSES,
  COOLDOWN_STATUSES,
  FAILURE_STATUSES,
  POSITION_STATUS,
} from "../config/constants.js";
import { summarisePoolExits, type PoolExitRecord } from "../services/meteora.js";
import {
  currentZonedDay,
  parseStoredUtc,
  toSqlUtc,
  zonedDayEndUtc,
  zonedDayKey,
  zonedDayStartUtc,
  zonedHour,
} from "../services/timezone.js";
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
    // Converted to the UTC instant the local day begins, so SQL compares instants and
    // never has to know what a timezone is. Same boundary the day keys use.
    clause += " AND closed_at >= ?";
    params.push(toSqlUtc(zonedDayStartUtc(cohort.closedOnOrAfter)));
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
       breakeven_coverage_ratio, expected_fee_24h_usd,
       execution_mode, position_address, open_signature, swap_signature,
       deposited_sol_lamports, deposited_paired_amount, wallet_lamports_before
     ) VALUES (
       @positionId, @poolAddress, @pairName, @strategyType,
       @entryPrice, @lowerBinPrice, @upperBinPrice, @virtualSolAmount,
       @entryTvl, @entry24hVolume, '${POSITION_STATUS.ACTIVE}', @confidenceScore,
       @reasoningLog, @entrySolPriceUsd, @entryPrice, CURRENT_TIMESTAMP,
       @top10HolderPct, @mintAuthorityRevoked, @freezeAuthorityRevoked,
       @safetyVerdict, @estGasCostUsd, @estPriorityMicroLamports,
       @breakevenCoverageRatio, @expectedFee24hUsd,
       @executionMode, @positionAddress, @openSignature, @swapSignature,
       @depositedSolLamports, @depositedPairedAmount, @walletLamportsBefore
     )`,
  ).run({
    ...input,
    top10HolderPct: input.top10HolderPct ?? null,
    safetyVerdict: input.safetyVerdict ?? null,
    estGasCostUsd: input.estGasCostUsd ?? null,
    estPriorityMicroLamports: input.estPriorityMicroLamports ?? null,
    breakevenCoverageRatio: input.breakevenCoverageRatio ?? null,
    expectedFee24hUsd: input.expectedFee24hUsd ?? null,
    // Paper rows carry nulls here on purpose; execution_mode is what distinguishes a
    // simulated row from one backed by a confirmed transaction.
    executionMode: input.executionMode ?? "PAPER",
    positionAddress: input.positionAddress ?? null,
    openSignature: input.openSignature ?? null,
    swapSignature: input.swapSignature ?? null,
    depositedSolLamports: input.depositedSolLamports ?? null,
    depositedPairedAmount: input.depositedPairedAmount ?? null,
    // Null, never 0: an unread balance is not an empty wallet, and a fabricated anchor
    // would produce a fabricated reconciliation.
    walletLamportsBefore: input.walletLamportsBefore ?? null,
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
            close_signature = @closeSignature,
            wallet_lamports_after = @walletLamportsAfter,
            closed_at = CURRENT_TIMESTAMP,
            last_checked_at = CURRENT_TIMESTAMP
      WHERE position_id = @positionId`,
  ).run({
    ...input,
    closeSignature: input.closeSignature ?? null,
    walletLamportsAfter: input.walletLamportsAfter ?? null,
  });
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

/**
 * Every position backed by a real on-chain account, open or closed, oldest first.
 *
 * Unfiltered by status on purpose: wallet reconciliation compares closed live trades
 * against the chain, and has to know whether ANOTHER live position was open during the
 * same window — an overlapping window makes the wallet delta a property of the account
 * rather than of one trade, and that has to be reported, not assumed away.
 */
export function getLivePositions(): SimulatedPositionRow[] {
  return db
    .prepare(
      `SELECT * FROM simulated_positions
        WHERE execution_mode = 'LIVE' AND position_address IS NOT NULL
        ORDER BY opened_at ASC`,
    )
    .all() as SimulatedPositionRow[];
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
         AND closed_at >= ? AND closed_at < ?`,
    )
    .get(...params, toSqlUtc(zonedDayStartUtc(date)), toSqlUtc(zonedDayEndUtc(date))) as TradeStats;
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

  /*
   * Bucketed in JS, not by `date(closed_at,'localtime')`.
   *
   * SQL selects a UTC half-open window and the day key is resolved per row through the
   * IANA database, so the result no longer depends on whether the host's C runtime can
   * read a zone name — see src/services/timezone.ts. On a host where it can, this
   * returns exactly what the old query returned.
   */
  const rows = db
    .prepare(
      `SELECT closed_at AS closedAt, realized_pnl_usd AS pnl
         FROM simulated_positions
        WHERE status IN (${CLOSED_LIST})${clause}
          AND closed_at >= ? AND closed_at < ?
        ORDER BY closed_at ASC`,
    )
    .all(
      ...params,
      toSqlUtc(zonedDayStartUtc(startDate)),
      toSqlUtc(zonedDayEndUtc(endDate)),
    ) as Array<{ closedAt: string; pnl: number | null }>;

  const buckets = new Map<string, DailyAggregateRow>();
  for (const row of rows) {
    const instant = parseStoredUtc(row.closedAt);
    if (!instant) continue;
    const date = zonedDayKey(instant);
    const bucket = buckets.get(date) ?? { date, trades: 0, wins: 0, losses: 0, netPnlUsd: 0 };
    bucket.trades += 1;
    /*
     * A null PnL is counted as neither a win nor a loss, matching the CASE expressions
     * in getStatsForDate and getLifetimeStats — `CASE WHEN x > 0` and `CASE WHEN x <= 0`
     * are both false for NULL. Folding it into losses (which `pnl ?? 0` would do) makes
     * this function disagree with the two it is routinely summed against. Unreachable
     * today, since the column is REAL DEFAULT 0.0 and closePosition always binds a
     * number, but the two paths must not drift on a case either of them can meet.
     */
    if (row.pnl !== null && row.pnl !== undefined) {
      if (row.pnl > 0) bucket.wins += 1;
      else bucket.losses += 1;
    }
    // SUM() skips nulls; so does this.
    bucket.netPnlUsd += row.pnl ?? 0;
    buckets.set(date, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Today, in the same frame `aggregateClosedTradesByDate` buckets by.
 *
 * Resolved through the IANA database rather than the C runtime, so a caller lining a
 * date range up with the day keys this file produces gets the same answer on every
 * host — see src/services/timezone.ts.
 */
export function currentLocalDate(): string {
  return currentZonedDay();
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
  /** 00-23, in the API timezone, resolved through the IANA database. */
  hour: string;
  trades: number;
  netPnlUsd: number;
}

export function getHourlyPerformance(cohort: CohortFilter = ALL_TIME): HourlyPerformanceRow[] {
  const { clause, params } = cohortSql(cohort);

  // Same reason as the daily buckets: the hour is resolved through the IANA database
  // rather than through SQLite's 'localtime'.
  const rows = db
    .prepare(
      `SELECT closed_at AS closedAt, realized_pnl_usd AS pnl
         FROM simulated_positions
        WHERE status IN (${CLOSED_LIST})${clause}`,
    )
    .all(...params) as Array<{ closedAt: string; pnl: number | null }>;

  const buckets = new Map<string, HourlyPerformanceRow>();
  for (const row of rows) {
    const instant = parseStoredUtc(row.closedAt);
    if (!instant) continue;
    const hour = zonedHour(instant);
    const bucket = buckets.get(hour) ?? { hour, trades: 0, netPnlUsd: 0 };
    bucket.trades += 1;
    bucket.netPnlUsd += row.pnl ?? 0;
    buckets.set(hour, bucket);
  }

  return [...buckets.values()].sort((a, b) => b.netPnlUsd - a.netPnlUsd);
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

/* ------------------------------------------------------------------ */
/* Scan funnel                                                         */
/* ------------------------------------------------------------------ */

export interface ScanFunnelRecord {
  /** Pools fetched from Meteora, or null when the cycle never reached the screener. */
  scanned: number | null;
  /** `ScreenResult.rejected` bucket map, stored as JSON. */
  screenRejections: Record<string, number>;
  /**
   * Survivors of the quantitative screen alone, or null when the screener never ran.
   *
   * Null rather than 0 for the same reason `scanned` is: "not measured" and "measured
   * zero" are different facts, and a row written before this column existed must not
   * claim the screener produced nothing.
   */
  screenerCandidates: number | null;
  /** Screener survivors dropped for already holding an open position on that pool. */
  heldExcluded: number;
  /**
   * Survivors of EVERY local filter — the last step of the narrowing, not the first.
   * `screenerCandidates - heldExcluded - cooldownRejected - executionRejected`.
   */
  candidates: number;
  cooldownRejected: number;
  executionRejected: number;
  /**
   * `executionRejected` split by gate. The bin cap is the operator's own setting and
   * the others are facts about the pool, so a single total cannot answer either
   * "is a pool broken" or "what is my width cap costing me".
   */
  execDenylistRejected: number;
  execBreakerRejected: number;
  execBinCapRejected: number;
  execNoWsolRejected: number;
  /**
   * Refused because a SIBLING pool of the same token is benched, not this pool.
   *
   * Counted apart from `execBreakerRejected` because the two lead to different
   * actions: that one says this pool failed, this one says a pool with a clean record
   * of its own is being held out because another pool of the same token failed. A
   * single bucket for both makes "why was this skipped" unanswerable from the row —
   * the failure the funnel ordering fix of 8 Sep 2026 was about.
   */
  execTokenBenchRejected: number;
  antirugPassed: number;
  antirugRejected: number;
  volatilityRejected: number;
  coverageRejected: number;
  microRejected: number;
  reachedDecision: boolean;
  opened: boolean;
  skipReason: string | null;
  positionsChecked: number;
  positionsClosed: number;
  durationMs: number;
}

export interface ScanFunnelRow extends ScanFunnelRecord {
  id: number;
  cycleAt: string;
}

/**
 * Records one screener cycle's funnel.
 *
 * Diagnostic, so it must never be able to fail a trading cycle: the caller wraps it,
 * and this function keeps no state a later cycle depends on. `scanned` stays null
 * rather than 0 when the screener never ran, for the same reason `est_gas_cost_usd`
 * does — "not measured" and "measured zero" are different facts.
 */
export function recordScanFunnel(record: ScanFunnelRecord): void {
  db.prepare(
    `INSERT INTO scan_funnel_cycles (
       scanned, screen_rejections, screener_candidates, held_excluded,
       candidates, cooldown_rejected, execution_rejected,
       exec_denylist_rejected, exec_breaker_rejected, exec_bincap_rejected,
       exec_no_wsol_rejected, exec_token_bench_rejected,
       antirug_passed, antirug_rejected, volatility_rejected,
       coverage_rejected, micro_rejected, reached_decision, opened,
       skip_reason, positions_checked, positions_closed, duration_ms
     ) VALUES (
       @scanned, @screenRejections, @screenerCandidates, @heldExcluded,
       @candidates, @cooldownRejected, @executionRejected,
       @execDenylistRejected, @execBreakerRejected, @execBinCapRejected,
       @execNoWsolRejected, @execTokenBenchRejected,
       @antirugPassed, @antirugRejected, @volatilityRejected,
       @coverageRejected, @microRejected, @reachedDecision, @opened,
       @skipReason, @positionsChecked, @positionsClosed, @durationMs
     )`,
  ).run({
    ...record,
    screenRejections: JSON.stringify(record.screenRejections),
    reachedDecision: record.reachedDecision ? 1 : 0,
    opened: record.opened ? 1 : 0,
  });
}

interface RawFunnelRow {
  id: number;
  cycle_at: string;
  scanned: number | null;
  screen_rejections: string | null;
  screener_candidates: number | null;
  held_excluded: number | null;
  candidates: number;
  cooldown_rejected: number;
  execution_rejected: number | null;
  exec_denylist_rejected: number | null;
  exec_breaker_rejected: number | null;
  exec_bincap_rejected: number | null;
  exec_no_wsol_rejected: number | null;
  exec_token_bench_rejected: number | null;
  antirug_passed: number;
  antirug_rejected: number;
  volatility_rejected: number;
  coverage_rejected: number;
  micro_rejected: number;
  reached_decision: number;
  opened: number;
  skip_reason: string | null;
  positions_checked: number;
  positions_closed: number;
  duration_ms: number | null;
}

/** Most recent cycles first. `limit` goes through intParam at the API boundary. */
export function getScanFunnel(limit = 100): ScanFunnelRow[] {
  const rows = db
    .prepare(`SELECT * FROM scan_funnel_cycles ORDER BY id DESC LIMIT ?`)
    .all(limit) as RawFunnelRow[];

  return rows.map((r) => ({
    id: r.id,
    cycleAt: r.cycle_at,
    scanned: r.scanned,
    // A row written before this column existed, or by a failed write, reads as {} —
    // never as a fabricated bucket map.
    screenRejections: parseRejections(r.screen_rejections),
    // Null on a row written before the column existed. NOT coerced to 0: that would
    // assert the screener produced nothing, which is a measurement this row never made.
    screenerCandidates: r.screener_candidates,
    heldExcluded: r.held_excluded ?? 0,
    candidates: r.candidates,
    cooldownRejected: r.cooldown_rejected,
    executionRejected: r.execution_rejected ?? 0,
    execDenylistRejected: r.exec_denylist_rejected ?? 0,
    execBreakerRejected: r.exec_breaker_rejected ?? 0,
    execBinCapRejected: r.exec_bincap_rejected ?? 0,
    execNoWsolRejected: r.exec_no_wsol_rejected ?? 0,
    execTokenBenchRejected: r.exec_token_bench_rejected ?? 0,
    antirugPassed: r.antirug_passed,
    antirugRejected: r.antirug_rejected,
    volatilityRejected: r.volatility_rejected,
    coverageRejected: r.coverage_rejected,
    microRejected: r.micro_rejected,
    reachedDecision: r.reached_decision === 1,
    opened: r.opened === 1,
    skipReason: r.skip_reason,
    positionsChecked: r.positions_checked,
    positionsClosed: r.positions_closed,
    durationMs: r.duration_ms ?? 0,
  }));
}

function parseRejections(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Execution-failure breaker                                           */
/* ------------------------------------------------------------------ */

/**
 * One pool's on-chain EXECUTION history, which is a different fact from its trading
 * history.
 *
 * `getPoolExitHistory` above answers "how did the last trades on this pool turn out",
 * reconstructed from closed position rows. This answers "can the engine open this pool
 * at all". Nothing links the two, and nothing should: a failed open writes no position
 * row by design, so the V1.1 lockout cannot see it, and a pool that trades badly is a
 * different problem from a pool that cannot be entered.
 */
export interface PoolExecutionRecord {
  poolAddress: string;
  pairName: string | null;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastStage: string | null;
  lastReason: string | null;
  totalFailures: number;
  lastSuccessAt: string | null;
  /**
   * The NON-SOL mint of the pair this pool trades, or null when it was not recorded.
   *
   * What makes a bench cover the TOKEN rather than only the pool address it happened
   * on. Null on rows written before the column existed and on any pool whose non-SOL
   * side could not be identified — and a null never propagates a bench, so an
   * unidentified token benches nothing beyond its own pool.
   */
  tokenMint: string | null;
}

interface RawExecutionRow {
  pool_address: string;
  pair_name: string | null;
  token_mint: string | null;
  consecutive_failures: number;
  last_failure_at: string | null;
  last_stage: string | null;
  last_reason: string | null;
  total_failures: number;
  last_success_at: string | null;
}

function toExecutionRecord(r: RawExecutionRow): PoolExecutionRecord {
  return {
    poolAddress: r.pool_address,
    pairName: r.pair_name,
    consecutiveFailures: r.consecutive_failures,
    lastFailureAt: r.last_failure_at,
    lastStage: r.last_stage,
    lastReason: r.last_reason,
    totalFailures: r.total_failures,
    lastSuccessAt: r.last_success_at,
    tokenMint: r.token_mint ?? null,
  };
}

/** Every pool with an execution history, keyed by address. */
export function getPoolExecutionHistory(): Map<string, PoolExecutionRecord> {
  return new Map(getPoolExecutionRecords().map((r) => [r.poolAddress, r]));
}

/**
 * The same rows, unindexed.
 *
 * The execution guard needs a SECOND index — by token — and building both from one
 * read keeps them describing the same instant. Indexing lives in `executionGuard.ts`
 * so the SQL stays here, per the one-place-for-queries rule.
 */
export function getPoolExecutionRecords(): PoolExecutionRecord[] {
  const rows = db
    .prepare(`SELECT * FROM pool_execution_failures`)
    .all() as RawExecutionRow[];

  return rows.map(toExecutionRecord);
}

export function getPoolExecutionRecord(poolAddress: string): PoolExecutionRecord | undefined {
  const row = db
    .prepare(`SELECT * FROM pool_execution_failures WHERE pool_address = ?`)
    .get(poolAddress) as RawExecutionRow | undefined;
  return row ? toExecutionRecord(row) : undefined;
}

/**
 * Counts one execution failure against a pool.
 *
 * `last_failure_at` is written with SQLite's `CURRENT_TIMESTAMP`, which is UTC with no
 * zone marker — read it back through `parseDbTimestamp`, never `new Date()`, or the
 * bench expires seven hours early on an Asia/Jakarta box. Same rule the cooldown gate
 * already follows.
 */
export function recordPoolExecutionFailure(input: {
  poolAddress: string;
  pairName: string | null;
  stage: string;
  reason: string;
  /**
   * The pair's NON-SOL mint, when the caller knows it. Optional because the callers
   * that do not know it must still be able to record a strike — a missing token is a
   * narrower bench, never a lost one.
   */
  tokenMint?: string | null;
}): void {
  db.prepare(
    `INSERT INTO pool_execution_failures (
       pool_address, pair_name, consecutive_failures, last_failure_at,
       last_stage, last_reason, total_failures, token_mint
     ) VALUES (@poolAddress, @pairName, 1, CURRENT_TIMESTAMP, @stage, @reason, 1, @tokenMint)
     ON CONFLICT(pool_address) DO UPDATE SET
       pair_name            = COALESCE(excluded.pair_name, pool_execution_failures.pair_name),
       consecutive_failures = pool_execution_failures.consecutive_failures + 1,
       last_failure_at      = CURRENT_TIMESTAMP,
       last_stage           = excluded.last_stage,
       last_reason          = excluded.last_reason,
       total_failures       = pool_execution_failures.total_failures + 1,
       -- COALESCE keeps a token already learned when a later strike does not carry one:
       -- forgetting it would silently narrow an existing bench back to one pool.
       token_mint           = COALESCE(excluded.token_mint, pool_execution_failures.token_mint)`,
  ).run({ ...input, tokenMint: input.tokenMint ?? null });
}

/**
 * Clears a pool's consecutive-failure run after a confirmed open.
 *
 * `total_failures` is deliberately NOT reset: it is the lifetime count an operator
 * reads to tell "flaky once" from "fails most of the time", and a gate that erases its
 * own evidence on every success cannot support that judgement.
 */
export function recordPoolExecutionSuccess(poolAddress: string, pairName: string | null): void {
  db.prepare(
    `INSERT INTO pool_execution_failures (
       pool_address, pair_name, consecutive_failures, last_success_at, total_failures
     ) VALUES (@poolAddress, @pairName, 0, CURRENT_TIMESTAMP, 0)
     ON CONFLICT(pool_address) DO UPDATE SET
       pair_name            = COALESCE(excluded.pair_name, pool_execution_failures.pair_name),
       consecutive_failures = 0,
       last_success_at      = CURRENT_TIMESTAMP`,
  ).run({ poolAddress, pairName });
}
