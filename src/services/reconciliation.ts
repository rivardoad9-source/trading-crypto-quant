import { getLivePositions } from "../database/repositories.js";
import { LAMPORTS_PER_SOL } from "../config/liveConfig.js";
import type { SimulatedPositionRow } from "../database/types.js";

/**
 * Wallet reconciliation: does the database's PnL agree with what the chain did?
 *
 * WHY THIS EXISTS. Every number the engine reports about a LIVE position is produced by
 * the same valuation model that values SIMULATED ones. `valuePosition` marks the
 * position from pool prices, `realized_pnl_usd` is `fees + positionValueChange`, and
 * `closeLivePosition` returns transaction signatures and nothing else — the chain is
 * asked to close the position and never asked what came back. So a live trade's PnL is
 * a MODEL of a real position, and it omits, in one direction only:
 *
 *  - the balancing swap's slippage and price impact, charged on every entry;
 *  - priority fees, which are recorded in `est_gas_cost_usd` and deliberately not
 *    deducted from `realized_pnl_usd` (folding them in would redefine every historical
 *    figure — a documented rule, and one this module does not break);
 *  - bin-array rent, which is never recovered at all.
 *
 * Every one of those makes the wallet poorer than the database says. The drift is
 * therefore systematic rather than noisy, and until now it was also unbounded and
 * unmeasured: nothing in the repository compared the two.
 *
 * WHAT THIS DOES NOT DO. It does not correct anything. `realized_pnl_usd` keeps its
 * definition, for exactly the reason gas is recorded and not deducted — silently
 * redefining a historical column is worse than a known, reported gap. This measures the
 * gap and names it.
 *
 * THE MEASUREMENT. `wallet_lamports_before` is read immediately before an entry spends
 * anything, `wallet_lamports_after` immediately after the close confirms. Their
 * difference is the trade's true effect on the wallet — every cost included, whether or
 * not the model knows the cost exists.
 *
 * ITS ONE HONEST CAVEAT, stated rather than hidden: the window between those two reads
 * belongs to the whole wallet, not to this position. Anything else that moved SOL in
 * that window lands in the same number. At `LIVE_MAX_CONCURRENT_POSITIONS=1` — the
 * shipped profile — nothing else is trading, so the attribution is clean; above 1 the
 * per-position figures overlap and only the aggregate is meaningful. `overlapping` says
 * which case a reading is in, so a caller can never quote an attribution the data does
 * not support.
 */

/** One closed LIVE position, model against chain. */
export interface PositionReconciliation {
  positionId: string;
  pairName: string;
  closedAt: string | null;
  /** `realized_pnl_usd` — what the valuation model says the trade made. */
  modelPnlUsd: number;
  /** (after - before) / 1e9. The chain's answer, or null when either read failed. */
  chainDeltaSol: number | null;
  /** `chainDeltaSol` priced at the position's entry SOL/USD, or null. */
  chainDeltaUsd: number | null;
  /**
   * `chainDeltaUsd - modelPnlUsd`. Negative means the wallet did WORSE than the
   * database claims, which is the direction every unmodelled cost pushes.
   */
  driftUsd: number | null;
  /**
   * Whether another live position was open during this one's window, making the chain
   * delta a property of the wallet rather than of this trade.
   */
  overlapping: boolean;
}

export interface ReconciliationReport {
  /** Closed LIVE positions considered. */
  positions: PositionReconciliation[];
  /** How many of them carry both balance reads. */
  measured: number;
  /** How many could not be measured, and so are excluded from every total below. */
  unmeasured: number;
  /** Sum of `modelPnlUsd` over MEASURED positions only, so the two totals compare. */
  modelPnlUsd: number;
  /** Sum of `chainDeltaUsd` over the same positions. */
  chainPnlUsd: number;
  /** chainPnlUsd - modelPnlUsd. Negative = the model is optimistic, as expected. */
  driftUsd: number;
  /** True when any measured window overlapped another, so attribution is aggregate-only. */
  anyOverlap: boolean;
  /**
   * Null when nothing is measured yet — never 0. An unmeasured book has no drift to
   * report, and 0 would read as "checked, and they agree".
   */
  driftPctOfModel: number | null;
  generatedAt: string;
}

const isLive = (r: SimulatedPositionRow): boolean =>
  r.execution_mode === "LIVE" && Boolean(r.position_address);

/** Milliseconds for a stored UTC timestamp, or null when it cannot be parsed. */
function ms(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  // Stored timestamps are UTC without a zone marker (SQLite CURRENT_TIMESTAMP), which
  // `new Date()` would read as local. Same rule `parseDbTimestamp` follows.
  const parsed = Date.parse(stamp.includes("T") ? stamp : `${stamp.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when [aOpen, aClose] and [bOpen, bClose] intersect. Unknown bounds never match. */
function overlaps(a: SimulatedPositionRow, b: SimulatedPositionRow): boolean {
  const aStart = ms(a.opened_at);
  const aEnd = ms(a.closed_at);
  const bStart = ms(b.opened_at);
  const bEnd = ms(b.closed_at);
  if (aStart === null || aEnd === null || bStart === null) return false;
  // A still-open position has no end; treat it as running to now.
  const bStop = bEnd ?? Date.now();
  return aStart < bStop && bStart < aEnd;
}

/**
 * Reconciles every closed LIVE position against the wallet.
 *
 * Pure over the rows it is given — `positions` is injectable so this is testable
 * without a database, and so a caller that has already read them does not read twice.
 */
export function reconcilePositions(
  positions: SimulatedPositionRow[] = getLivePositions(),
): ReconciliationReport {
  const live = positions.filter(isLive);
  const closed = live.filter((r) => r.closed_at !== null && r.closed_at !== undefined);

  const results: PositionReconciliation[] = closed.map((row) => {
    const before = row.wallet_lamports_before;
    const after = row.wallet_lamports_after;

    const measurable =
      typeof before === "number" &&
      Number.isFinite(before) &&
      typeof after === "number" &&
      Number.isFinite(after);

    const chainDeltaSol = measurable ? (after - before) / LAMPORTS_PER_SOL : null;

    /*
     * Priced at the position's ENTRY SOL/USD, not today's.
     *
     * The model figure it is compared against is denominated the same way — notional is
     * fixed at entry and `realized_pnl_usd` follows from it — so converting the chain
     * delta at a later price would make the difference partly a SOL price move rather
     * than a discrepancy between the two accountings.
     */
    const price = row.entry_sol_price_usd;
    const chainDeltaUsd =
      chainDeltaSol !== null && typeof price === "number" && price > 0
        ? chainDeltaSol * price
        : null;

    const modelPnlUsd = row.realized_pnl_usd ?? 0;

    return {
      positionId: row.position_id,
      pairName: row.pair_name,
      closedAt: row.closed_at ?? null,
      modelPnlUsd,
      chainDeltaSol,
      chainDeltaUsd,
      driftUsd: chainDeltaUsd === null ? null : chainDeltaUsd - modelPnlUsd,
      overlapping: live.some((other) => other.id !== row.id && overlaps(row, other)),
    };
  });

  const measured = results.filter((r) => r.chainDeltaUsd !== null);

  const modelPnlUsd = measured.reduce((sum, r) => sum + r.modelPnlUsd, 0);
  const chainPnlUsd = measured.reduce((sum, r) => sum + (r.chainDeltaUsd ?? 0), 0);
  const driftUsd = chainPnlUsd - modelPnlUsd;

  return {
    positions: results,
    measured: measured.length,
    unmeasured: results.length - measured.length,
    modelPnlUsd,
    chainPnlUsd,
    driftUsd,
    anyOverlap: measured.some((r) => r.overlapping),
    // Null rather than 0 when there is nothing to divide by, and when the model total
    // is itself zero: "no basis to compare" is not "they agree".
    driftPctOfModel:
      measured.length > 0 && Math.abs(modelPnlUsd) > 1e-9
        ? (driftUsd / Math.abs(modelPnlUsd)) * 100
        : null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * One operator-readable line per report, for the boot log and Telegram `/status`.
 *
 * States the unmeasured count out loud. A reconciliation that quietly summed only the
 * rows it could measure, and printed that as agreement, would be the same class of
 * claim as an unlabelled rebased equity figure.
 */
export function describeReconciliation(report: ReconciliationReport): string {
  if (report.measured === 0) {
    return report.unmeasured === 0
      ? `[reconcile] no closed live positions yet — nothing to reconcile`
      : `[reconcile] ${report.unmeasured} closed live position(s), NONE measurable ` +
          `(missing a wallet balance read at open or close); model PnL cannot be checked`;
  }

  const pct =
    report.driftPctOfModel === null ? "n/a" : `${report.driftPctOfModel.toFixed(1)}%`;

  return (
    `[reconcile] ${report.measured} live position(s): database says ` +
    `$${report.modelPnlUsd.toFixed(2)}, wallet says $${report.chainPnlUsd.toFixed(2)}, ` +
    `drift $${report.driftUsd.toFixed(2)} (${pct} of model)` +
    (report.unmeasured > 0 ? `; ${report.unmeasured} unmeasured and excluded` : "") +
    (report.anyOverlap
      ? `; positions OVERLAPPED, so per-position attribution is not meaningful — read ` +
        `the total only`
      : "")
  );
}
