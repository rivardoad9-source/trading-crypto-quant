import { getLivePositions } from "../database/repositories.js";
import { LAMPORTS_PER_SOL } from "../config/liveConfig.js";
import type { SimulatedPositionRow } from "../database/types.js";
import { parseDbTimestampMs } from "./dbTime.js";

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
 *
 * AND A SECOND ONE, learned from the first live trade that worked. A close returns SOL
 * AND the paired token, so a balance read before that token is sold back is not the
 * trade's result — it is the trade's result minus whatever is still parked in a memecoin.
 * On 11 Sep 2026 MANLET-SOL booked +$9.49 and this module reported "wallet says
 * $-117.68, drift $-127.16", because its after-balance was read with ~0.84 SOL of value
 * still unsold (and at `finalized`, ~0.42 SOL behind its own final close transaction).
 * Nothing in that row was CORRECTED here, and nothing will be: `residual_sweep` says
 * whether a row's after-balance is final, and a row where it is not — including every row
 * closed before the sweep existed — is reported as NOT SETTLED and kept out of both totals,
 * exactly like a row with a missing read. Settled means `swept` or `dust` (the engine sold
 * it, or there was nothing worth selling) or `operator` (a human sold it and wrote the
 * measured balance, via `scripts/settleResidualByHand.cjs`).
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
  /**
   * Whether the after-balance is the trade's FINAL effect (see the module note).
   *
   *  - `settled`    the residual token was swept, was dust, or was settled by an operator.
   *  - `unsettled`  the sweep failed or could not measure the balance.
   *  - `pre-sweep`  closed by a build that never sold the residual, so its after-balance
   *                 was read with the paired token still in the wallet.
   *
   * Anything but `settled` gets NO chain figure and NO drift — not a corrected one, none.
   */
  settlement: "settled" | "unsettled" | "pre-sweep";
}

const SETTLED_SWEEPS = new Set(["swept", "dust", "operator"]);

function settlementOf(row: SimulatedPositionRow): PositionReconciliation["settlement"] {
  const sweep = row.residual_sweep ?? null;
  if (sweep === null) return "pre-sweep";
  return SETTLED_SWEEPS.has(sweep) ? "settled" : "unsettled";
}

export interface ReconciliationReport {
  /** Closed LIVE positions considered. */
  positions: PositionReconciliation[];
  /** How many of them carry both balance reads. */
  measured: number;
  /** How many are settled but miss a balance read, and so are excluded from every total. */
  unmeasured: number;
  /**
   * How many have an after-balance that is NOT FINAL (residual token unsold, or closed
   * before the sweep existed). Excluded from every total, and counted apart from
   * `unmeasured` because the remedy differs: a missing read is gone for good, an unsold
   * token needs a human to sell it and record the balance.
   */
  unsettled: number;
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

/**
 * Milliseconds for a stored UTC timestamp, or null when it cannot be parsed.
 *
 * Delegates rather than reimplementing: this used to test only `includes("T")`, so a
 * zone-marked value with a space separator returned null HERE while the cooldown gate read
 * it. Null is not a parse detail in this file — it is the difference between a row being
 * compared against the chain and being excluded from both totals as unmeasured.
 */
const ms = (stamp: string | null | undefined): number | null => parseDbTimestampMs(stamp);

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
    const settlement = settlementOf(row);

    const measurable =
      settlement === "settled" &&
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
      settlement,
    };
  });

  const measured = results.filter((r) => r.chainDeltaUsd !== null);
  const unsettled = results.filter((r) => r.settlement !== "settled").length;

  const modelPnlUsd = measured.reduce((sum, r) => sum + r.modelPnlUsd, 0);
  const chainPnlUsd = measured.reduce((sum, r) => sum + (r.chainDeltaUsd ?? 0), 0);
  const driftUsd = chainPnlUsd - modelPnlUsd;

  return {
    positions: results,
    measured: measured.length,
    unmeasured: results.length - measured.length - unsettled,
    unsettled,
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
  const unsettledNote =
    report.unsettled > 0
      ? `${report.unsettled} NOT SETTLED and excluded (the after-balance was read before ` +
        `the paired token was sold back to SOL, so it is not the trade's result)`
      : "";

  if (report.measured === 0) {
    if (report.unmeasured === 0 && report.unsettled === 0) {
      return `[reconcile] no closed live positions yet — nothing to reconcile`;
    }
    return (
      `[reconcile] ${report.unmeasured + report.unsettled} closed live position(s), NONE ` +
      `measurable; model PnL cannot be checked` +
      (report.unmeasured > 0
        ? `; ${report.unmeasured} missing a wallet balance read at open or close`
        : "") +
      (unsettledNote ? `; ${unsettledNote}` : "")
    );
  }

  const pct =
    report.driftPctOfModel === null ? "n/a" : `${report.driftPctOfModel.toFixed(1)}%`;

  return (
    `[reconcile] ${report.measured} live position(s): database says ` +
    `$${report.modelPnlUsd.toFixed(2)}, wallet says $${report.chainPnlUsd.toFixed(2)}, ` +
    `drift $${report.driftUsd.toFixed(2)} (${pct} of model)` +
    (report.unmeasured > 0 ? `; ${report.unmeasured} unmeasured and excluded` : "") +
    (unsettledNote ? `; ${unsettledNote}` : "") +
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
 * MEASURED IN SOL, AND THAT IS THE WHOLE POINT OF THE SECOND VERSION. The first compared
 * the USD book against `walletSol x spot`, so the ENTIRE gap moved with SOL/USD. Later on
 * 11 Sep the baseline was re-pinned at $288.27 (= 2.880994 SOL x $100.06); the wallet then
 * stayed at exactly 2.880994 SOL, no attempt ran and no position existed, SOL/USD slipped
 * ~1.15%, and the check paged "a drift of $-3.31 (-0.033474 SOL)". That SOL figure was not
 * a measurement: it was the USD gap divided by the spot price, so a "0.02 SOL" threshold
 * was really ~0.7% of SOL/USD — tighter than the percentage threshold beside it, and pure
 * noise. It could not tell "the price moved" from "SOL left the wallet", which are the one
 * distinction an operator needs from it.
 *
 * So the book is converted ONCE, at the price it was pinned at —
 * `bookSol = bookUsd / baselineSolPriceUsd` — and `driftSol = walletSol - bookSol` is the
 * measurement. Both thresholds apply to it: `maxPct` relative to `bookSol`, `maxSol` as an
 * absolute SOL difference. The spot price is used for DISPLAY only, to say in dollars what
 * the SOL drift is worth and how much of the USD gap is just price.
 *
 * What this cannot see, stated so it is not mistaken for more: realised PnL is booked in
 * USD at each close's own prices and converted at the baseline price here, so a book whose
 * PnL is large relative to its size carries a small conversion error. At micro capital
 * that error is cents; the SOL that leaves on a failed attempt is not.
 *
 * EQUALITY PASSES, compared in whole LAMPORTS. A drift exactly at `maxSol` (or exactly
 * `maxPct`) is within threshold — the same direction `assessLiveSizing` takes at
 * `deployable === balance`: the bound is what the operator allowed, so reaching it is
 * allowed. Lamports because balances are integers there, and floating-point residue in
 * `walletSol - bookUsd / price` must not decide which side of the line a reading falls.
 *
 * IT CORRECTS NOTHING, exactly like the reconciliation above. Re-pinning the baseline is
 * an operator decision recorded in `.env`.
 *
 * UNMEASURED IS NOT ZERO. No wallet balance, no book, or no usable baseline price yields
 * `status: "unmeasured"` and no alert — never a drift of 0, which would render identically
 * to "compared, and they agree". A missing SPOT price does not make the reading unmeasured,
 * because nothing is decided from it; it only blanks the dollar figures.
 */
export interface WalletDriftReading {
  status: "ok" | "drifted" | "unmeasured";
  /** The book: `STARTING_BALANCE_USD + realised PnL`. Null when unavailable. */
  bookUsd: number | null;
  /** The book in SOL at the price it was pinned at. Null when unmeasured. */
  bookSol: number | null;
  walletSol: number | null;
  /** `BASELINE_SOL_PRICE_USD`, or null when not configured / not positive. */
  baselineSolPriceUsd: number | null;
  /** SOL/USD now. DISPLAY ONLY — no decision reads it. */
  solPriceUsd: number | null;
  /**
   * `walletSol - bookSol`: THE measurement. Positive means the wallet holds MORE SOL than
   * the book claims. Never derived from a USD difference.
   */
  driftSol: number | null;
  /** `|driftSol| / bookSol x 100`. Null when unmeasured or when `bookSol` is 0. */
  driftPct: number | null;
  /** `driftSol` valued at SPOT, for display. Null without a spot price. */
  driftUsd: number | null;
  /** The wallet valued at spot, for display. Null without a spot price. */
  walletUsd: number | null;
  /**
   * `(spot - baseline) / baseline x 100`, for display: the part of any USD gap that is
   * SOL/USD moving rather than SOL moving. Null without both prices.
   */
  priceMovePct: number | null;
  /** Which threshold(s) the SOL drift breached. Empty when it breached none. */
  breached: ("pct" | "sol")[];
  /** Operator-readable. Null unless `drifted`. */
  reason: string | null;
}

export interface WalletDriftThresholds {
  /** Percent of `bookSol`. */
  maxPct: number;
  /** Absolute SOL. */
  maxSol: number;
}

const LAMPORTS = 1_000_000_000;
const toLamports = (sol: number): number => Math.round(sol * LAMPORTS);

const positiveFinite = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Pure: no RPC, no database, no clock. Every input is passed in, so the whole rule is
 * unit-testable offline — the same reason `assessLiveSizing` is shaped this way.
 */
export function assessWalletDrift(input: {
  /** `STARTING_BALANCE_USD + realised PnL`, or null when it could not be computed. */
  bookUsd: number | null;
  /** The chain's balance in SOL, or null when the read failed. */
  walletSol: number | null;
  /** SOL/USD now. Display only; may be null. */
  solPriceUsd: number | null;
  /** SOL/USD at which `STARTING_BALANCE_USD` was pinned (`BASELINE_SOL_PRICE_USD`). */
  baselineSolPriceUsd: number | null;
  thresholds: WalletDriftThresholds;
}): WalletDriftReading {
  const { bookUsd, walletSol, thresholds } = input;
  const baselineSolPriceUsd = positiveFinite(input.baselineSolPriceUsd)
    ? input.baselineSolPriceUsd
    : null;
  const solPriceUsd = positiveFinite(input.solPriceUsd) ? input.solPriceUsd : null;

  const measurable =
    bookUsd !== null &&
    Number.isFinite(bookUsd) &&
    walletSol !== null &&
    Number.isFinite(walletSol) &&
    baselineSolPriceUsd !== null;

  if (!measurable) {
    return {
      status: "unmeasured",
      bookUsd: bookUsd !== null && Number.isFinite(bookUsd) ? bookUsd : null,
      bookSol: null,
      walletSol: walletSol !== null && Number.isFinite(walletSol) ? walletSol : null,
      baselineSolPriceUsd,
      solPriceUsd,
      driftSol: null,
      driftPct: null,
      driftUsd: null,
      walletUsd: null,
      priceMovePct: null,
      breached: [],
      reason: null,
    };
  }

  const bookSol = bookUsd / baselineSolPriceUsd;
  const driftLamports = toLamports(walletSol) - toLamports(bookSol);
  const driftSol = driftLamports / LAMPORTS;
  // Null rather than Infinity on a zero book: an undefined ratio must not render as a
  // real measurement. Same rule `profitFactor` follows.
  const bookLamports = toLamports(bookSol);
  const driftPct = bookLamports === 0 ? null : (Math.abs(driftLamports) / Math.abs(bookLamports)) * 100;

  const breached: ("pct" | "sol")[] = [];
  if (driftPct !== null && driftPct > thresholds.maxPct) breached.push("pct");
  if (Math.abs(driftLamports) > toLamports(thresholds.maxSol)) breached.push("sol");

  const reading: WalletDriftReading = {
    status: breached.length === 0 ? "ok" : "drifted",
    bookUsd,
    bookSol,
    walletSol,
    baselineSolPriceUsd,
    solPriceUsd,
    driftSol,
    driftPct,
    driftUsd: solPriceUsd === null ? null : driftSol * solPriceUsd,
    walletUsd: solPriceUsd === null ? null : walletSol * solPriceUsd,
    priceMovePct:
      solPriceUsd === null ? null : ((solPriceUsd - baselineSolPriceUsd) / baselineSolPriceUsd) * 100,
    breached,
    reason: null,
  };

  if (reading.status === "drifted") {
    const direction =
      driftSol < 0
        ? `${Math.abs(driftSol).toFixed(6)} SOL LESS than the book claims — SOL has LEFT the wallet`
        : `${driftSol.toFixed(6)} SOL MORE than the book claims — SOL has ARRIVED in the wallet`;
    reading.reason =
      `the wallet holds ${walletSol.toFixed(6)} SOL against a book of ${bookSol.toFixed(6)} SOL ` +
      `($${bookUsd.toFixed(2)} at the pinned BASELINE_SOL_PRICE_USD=${baselineSolPriceUsd}): ` +
      `${direction}` +
      (driftPct === null ? `` : ` (${driftPct.toFixed(2)}% of the book)`) +
      `, over the ` +
      `${breached.includes("pct") ? `${thresholds.maxPct}% ` : ``}` +
      `${breached.length === 2 ? `and ` : ``}` +
      `${breached.includes("sol") ? `${thresholds.maxSol} SOL ` : ``}threshold. ` +
      `Measured in SOL, so this is NOT a SOL/USD move` +
      (reading.driftUsd === null
        ? `.`
        : ` (worth ~$${reading.driftUsd.toFixed(2)} at spot $${solPriceUsd}).`) +
      ` Nothing has been corrected. ` +
      (driftSol < 0
        ? `Look in live_execution_attempts for attempts that spent it; if there are none, ` +
          `STARTING_BALANCE_USD or BASELINE_SOL_PRICE_USD is pinned above what the wallet held.`
        : `A deposit or a manual trade would do this; otherwise STARTING_BALANCE_USD or ` +
          `BASELINE_SOL_PRICE_USD is pinned below what the wallet held.`);
  }

  return reading;
}

/** One line for the boot log and the periodic check. Always says which way it went. */
export function describeWalletDrift(reading: WalletDriftReading): string {
  switch (reading.status) {
    case "unmeasured":
      return reading.baselineSolPriceUsd === null
        ? "[drift] wallet vs book NOT MEASURED (BASELINE_SOL_PRICE_USD is not set: the " +
            "book cannot be put in SOL without the price it was pinned at)"
        : "[drift] wallet vs book NOT MEASURED (wallet balance or book unavailable)";
    case "ok": {
      const sol =
        `[drift] wallet vs book: ${(reading.driftSol ?? 0).toFixed(6)} SOL` +
        (reading.driftPct === null ? `` : ` (${reading.driftPct.toFixed(2)}%)`) +
        ` — within thresholds`;
      /*
       * The case that paged an operator on 11 Sep for nothing: the SOL balance agrees and
       * only the dollar value moved. Said in so many words, and never as a SOL drift.
       */
      if (reading.priceMovePct === null || reading.walletUsd === null || reading.bookUsd === null) {
        return sol;
      }
      return (
        `${sol}; the USD value differs by $${(reading.walletUsd - reading.bookUsd).toFixed(2)} ` +
        `because SOL/USD moved ${reading.priceMovePct >= 0 ? "+" : ""}` +
        `${reading.priceMovePct.toFixed(2)}% (baseline $${reading.baselineSolPriceUsd} -> ` +
        `now $${reading.solPriceUsd}) — that is PRICE; the SOL balance agrees with the book`
      );
    }
    case "drifted":
      return `[drift] WALLET/BOOK DRIFT: ${reading.reason}`;
  }
}
