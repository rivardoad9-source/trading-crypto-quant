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

/* ------------------------------------------------------------------ */
/* Wallet drift — the book's LEVEL against the chain                   */
/* ------------------------------------------------------------------ */

/**
 * Does the accounting baseline still describe the wallet it claims to?
 *
 * A DIFFERENT QUESTION from `reconcilePositions` above, and they must not be merged.
 * That one asks, per closed trade, whether the model's PnL matched what the chain did —
 * a question about individual trades, answerable only from rows that carry both balance
 * reads. This asks whether the whole book's LEVEL still matches the wallet, which is
 * answerable at any moment and from a wallet that has never traded.
 *
 * WHY IT EXISTS. On 11 Sep 2026 `STARTING_BALANCE_USD` was pinned at 298.02 while the
 * wallet held about $285.5 — roughly $12 apart — and nothing told anyone. The gap had
 * two sources at once, and only the second is a defect: the pin double-counts trades
 * already booked (`impliedStartingBalanceUsd` in `startingBalance.ts` is the arithmetic
 * for that), and real SOL had left the wallet on failed attempts that produced no rows
 * at all. Either way the number an operator reaches for first was wrong in a way that
 * did not announce itself.
 *
 * TWO UNITS, EITHER OF WHICH FIRES. A percentage alone never fires on a large book that
 * has quietly lost real SOL; an absolute alone fires constantly on a small one. Both are
 * reported whichever triggered, so the alert can be read without re-deriving the other.
 *
 * IT CORRECTS NOTHING, exactly like the reconciliation above. It measures and names.
 * Re-pinning the baseline is an operator decision recorded in `.env`, for the reason
 * `seedStartingBalanceFromWallet` already refuses to do it under existing trades:
 * rebasing re-scales every percentage already reported.
 *
 * UNMEASURED IS NOT ZERO. A balance or a price that could not be read yields
 * `status: "unmeasured"` and no alert — never a drift of 0, which would render
 * identically to "compared, and they agree".
 */
export interface WalletDriftReading {
  status: "ok" | "drifted" | "unmeasured";
  /** The book: `STARTING_BALANCE_USD + realised PnL`. Null when unavailable. */
  bookUsd: number | null;
  /** The chain, priced in USD. Null when the balance or the price could not be read. */
  walletUsd: number | null;
  walletSol: number | null;
  /** `walletUsd - bookUsd`. Negative means the wallet is poorer than the book claims. */
  driftUsd: number | null;
  /** The same gap in SOL, which is the unit the thresholds and the losses are in. */
  driftSol: number | null;
  /** `|driftUsd| / bookUsd x 100`, or null when the book is zero or unmeasured. */
  driftPct: number | null;
  /** Which threshold(s) the reading breached. Empty when it breached none. */
  breached: ("pct" | "sol")[];
  /** Operator-readable. Null when nothing is wrong or nothing could be measured. */
  reason: string | null;
}

export interface WalletDriftThresholds {
  maxPct: number;
  maxSol: number;
}

/**
 * Pure: no RPC, no database, no clock. Every input is passed in, so the whole rule is
 * unit-testable offline — the same reason `assessLiveSizing` is shaped this way.
 */
export function assessWalletDrift(input: {
  /** `STARTING_BALANCE_USD + realised PnL`, or null when it could not be computed. */
  bookUsd: number | null;
  /** The chain's balance in SOL, or null when the read failed. */
  walletSol: number | null;
  solPriceUsd: number | null;
  thresholds: WalletDriftThresholds;
}): WalletDriftReading {
  const { bookUsd, walletSol, solPriceUsd, thresholds } = input;

  const measurable =
    bookUsd !== null &&
    Number.isFinite(bookUsd) &&
    walletSol !== null &&
    Number.isFinite(walletSol) &&
    solPriceUsd !== null &&
    Number.isFinite(solPriceUsd) &&
    solPriceUsd > 0;

  if (!measurable) {
    return {
      status: "unmeasured",
      bookUsd: bookUsd ?? null,
      walletUsd: null,
      walletSol: walletSol ?? null,
      driftUsd: null,
      driftSol: null,
      driftPct: null,
      breached: [],
      reason: null,
    };
  }

  const walletUsd = walletSol * solPriceUsd;
  const driftUsd = walletUsd - bookUsd;
  const driftSol = driftUsd / solPriceUsd;
  // Null rather than Infinity on a zero book: an undefined ratio must not render as a
  // real measurement. Same rule `profitFactor` follows.
  const driftPct = bookUsd === 0 ? null : (Math.abs(driftUsd) / Math.abs(bookUsd)) * 100;

  const breached: ("pct" | "sol")[] = [];
  if (driftPct !== null && driftPct > thresholds.maxPct) breached.push("pct");
  if (Math.abs(driftSol) > thresholds.maxSol) breached.push("sol");

  if (breached.length === 0) {
    return {
      status: "ok",
      bookUsd,
      walletUsd,
      walletSol,
      driftUsd,
      driftSol,
      driftPct,
      breached,
      reason: null,
    };
  }

  return {
    status: "drifted",
    bookUsd,
    walletUsd,
    walletSol,
    driftUsd,
    driftSol,
    driftPct,
    breached,
    reason:
      `the book says $${bookUsd.toFixed(2)} and the wallet holds ` +
      `${walletSol.toFixed(6)} SOL (~$${walletUsd.toFixed(2)}) — a drift of ` +
      `$${driftUsd.toFixed(2)} (${driftSol.toFixed(6)} SOL` +
      (driftPct === null ? `` : `, ${driftPct.toFixed(2)}% of the book`) + `), over the ` +
      `${breached.includes("pct") ? `${thresholds.maxPct}% ` : ``}` +
      `${breached.length === 2 ? `and ` : ``}` +
      `${breached.includes("sol") ? `${thresholds.maxSol} SOL ` : ``}threshold. ` +
      `Nothing has been corrected: STARTING_BALANCE_USD keeps its value and ` +
      `realized_pnl_usd keeps its definition. Two causes look identical here and both ` +
      `need a human — a baseline pinned above what the wallet ever held (see the ` +
      `preflight's suggested STARTING_BALANCE_USD line), and real SOL spent on live ` +
      `attempts that produced no position (see live_execution_attempts).`,
  };
}

/** One line for the boot log and the periodic check. Always says which way it went. */
export function describeWalletDrift(reading: WalletDriftReading): string {
  switch (reading.status) {
    case "unmeasured":
      return "[drift] wallet vs book NOT MEASURED (balance or SOL/USD unavailable)";
    case "ok":
      return (
        `[drift] wallet vs book: $${(reading.driftUsd ?? 0).toFixed(2)} ` +
        `(${(reading.driftSol ?? 0).toFixed(6)} SOL` +
        (reading.driftPct === null ? `` : `, ${reading.driftPct.toFixed(2)}%`) +
        `) — within thresholds`
      );
    case "drifted":
      return `[drift] WALLET/BOOK DRIFT: ${reading.reason}`;
  }
}
