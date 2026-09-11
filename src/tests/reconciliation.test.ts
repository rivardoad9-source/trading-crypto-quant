/**
 * Wallet reconciliation.
 *
 * The gap this closes: every figure the engine reports about a LIVE position comes from
 * the same valuation model that values simulated ones, and `closeLivePosition` returns
 * signatures rather than amounts — so the chain is asked to close a position and never
 * asked what came back. The model cannot see swap slippage, priority fees or
 * unrecoverable bin-array rent, and all three push the same way, so the database is
 * systematically optimistic about real money. Nothing compared it against the wallet.
 *
 * What is tested here is mostly about REFUSING TO CLAIM. A reconciliation that quietly
 * skips the rows it could not measure and reports the rest as agreement is worse than
 * no reconciliation, in exactly the way an unlabelled rebased equity figure is worse
 * than no figure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeReconciliation, reconcilePositions } from "../services/reconciliation.js";
import type { SimulatedPositionRow } from "../database/types.js";

const LAMPORTS = 1_000_000_000;

let nextId = 1;

/** A closed LIVE row. Amounts in SOL for legibility; the row stores lamports. */
function liveRow(over: Partial<SimulatedPositionRow> = {}): SimulatedPositionRow {
  return {
    id: nextId++,
    execution_mode: "LIVE",
    position_address: "Pos1111111111111111111111111111111111111111",
    position_id: `p-${nextId}`,
    pool_address: "Pool111111111111111111111111111111111111111",
    pair_name: "AAA-SOL",
    strategy_type: "SPOT",
    entry_price: 100,
    lower_bin_price: 90,
    upper_bin_price: 110,
    virtual_sol_amount: 0.8,
    entry_tvl: 50_000,
    entry_24h_volume: 500_000,
    entry_sol_price_usd: 100,
    status: "CLOSED_PROFIT",
    opened_at: "2026-09-01 10:00:00",
    closed_at: "2026-09-01 18:00:00",
    realized_pnl_usd: 2.0,
    // A row closed by a build with the residual sweep, whose after-balance is final.
    residual_sweep: "swept",
    ...over,
  } as SimulatedPositionRow;
}

describe("wallet reconciliation — the drift is measured, not assumed", () => {
  it("reports the wallet doing worse than the database, which is the expected direction", () => {
    /*
     * The model says +$2.00. The wallet gained 0.005 SOL = +$0.50 at the entry price.
     * The $1.50 gap is what the model structurally cannot see: the swap's slippage, the
     * priority fees, and any bin-array rent that never comes back.
     */
    const report = reconcilePositions([
      liveRow({
        realized_pnl_usd: 2.0,
        wallet_lamports_before: 3.0 * LAMPORTS,
        wallet_lamports_after: 3.005 * LAMPORTS,
      }),
    ]);

    assert.equal(report.measured, 1);
    assert.equal(report.unmeasured, 0);
    assert.ok(Math.abs(report.modelPnlUsd - 2.0) < 1e-9);
    assert.ok(Math.abs(report.chainPnlUsd - 0.5) < 1e-6, `chain ${report.chainPnlUsd}`);
    assert.ok(Math.abs(report.driftUsd + 1.5) < 1e-6, `drift ${report.driftUsd}`);
    assert.ok(report.driftUsd < 0, "the drift did not point at an optimistic model");
  });

  it("prices the chain delta at ENTRY SOL/USD, so a price move is not read as drift", () => {
    /*
     * The model figure is denominated at entry — notional is fixed there and
     * `realized_pnl_usd` follows from it. Converting the chain delta at any later price
     * would fold a SOL move into a number that is supposed to measure a disagreement
     * between two accountings.
     */
    const cheap = reconcilePositions([
      liveRow({
        entry_sol_price_usd: 50,
        realized_pnl_usd: 0,
        wallet_lamports_before: 1 * LAMPORTS,
        wallet_lamports_after: 1.1 * LAMPORTS,
      }),
    ]);
    assert.ok(Math.abs(cheap.chainPnlUsd - 5) < 1e-6, `expected 0.1 SOL x $50, got ${cheap.chainPnlUsd}`);
  });

  it("excludes an unmeasured row from every total rather than treating it as zero", () => {
    const report = reconcilePositions([
      liveRow({
        realized_pnl_usd: 5.0,
        wallet_lamports_before: null,
        wallet_lamports_after: 3 * LAMPORTS,
      }),
      liveRow({
        realized_pnl_usd: 1.0,
        wallet_lamports_before: 3 * LAMPORTS,
        wallet_lamports_after: 3.01 * LAMPORTS,
      }),
    ]);

    assert.equal(report.measured, 1);
    assert.equal(report.unmeasured, 1);
    /*
     * The $5.00 row is absent from BOTH sides. Including its model PnL while having no
     * chain figure for it would manufacture a $5 drift out of a missing measurement —
     * the totals only compare if they cover the same rows.
     */
    assert.ok(Math.abs(report.modelPnlUsd - 1.0) < 1e-9, `model ${report.modelPnlUsd}`);
    assert.equal(report.positions.length, 2, "the unmeasured row was dropped from the detail");
    assert.equal(report.positions[0]?.chainDeltaUsd, null);
    assert.equal(report.positions[0]?.driftUsd, null, "an unmeasured row was given a drift");
  });

  it("says so plainly when nothing can be reconciled, instead of reporting agreement", () => {
    const none = reconcilePositions([
      liveRow({ wallet_lamports_before: null, wallet_lamports_after: null }),
    ]);
    assert.equal(none.measured, 0);
    // Null, never 0: "no basis to compare" and "compared, and they agree" are different
    // facts and would render identically as 0%.
    assert.equal(none.driftPctOfModel, null);
    assert.match(describeReconciliation(none), /NONE measurable/);
  });

  it("ignores paper rows entirely — they have no wallet to reconcile against", () => {
    const report = reconcilePositions([
      liveRow({ execution_mode: "PAPER", position_address: null, realized_pnl_usd: 99 }),
    ]);
    assert.equal(report.positions.length, 0);
    assert.match(describeReconciliation(report), /nothing to reconcile/);
  });

  it("ignores a live position that is still open", () => {
    const report = reconcilePositions([liveRow({ status: "ACTIVE", closed_at: null })]);
    assert.equal(report.positions.length, 0);
  });
});

describe("wallet reconciliation — an after-balance read before the token was sold is not a result", () => {
  /*
   * 11 Sep 2026, MANLET-SOL, the engine's first successful live trade. Model +$9.49. The
   * close returned SOL and ~0.84 SOL worth of MANLET; nothing sold the token, the after
   * read happened with it still in the wallet, and this module printed
   * "wallet says $-117.68, drift $-127.16". The row below is that row's shape: before
   * 2.880993680 SOL, after 1.700338862 SOL, closed before the sweep existed.
   */
  const manlet = (over: Partial<SimulatedPositionRow> = {}) =>
    liveRow({
      pair_name: "MANLET-SOL",
      realized_pnl_usd: 9.49,
      entry_sol_price_usd: 99.67,
      wallet_lamports_before: 2_880_993_680,
      wallet_lamports_after: 1_700_338_862,
      residual_sweep: null,
      ...over,
    });

  it("reports a pre-sweep row as NOT SETTLED, with no chain figure and no drift", () => {
    const report = reconcilePositions([manlet()]);

    assert.equal(report.measured, 0);
    assert.equal(report.unsettled, 1);
    assert.equal(report.unmeasured, 0, "an unsettled row was filed as a missing read");
    assert.equal(report.positions[0]?.settlement, "pre-sweep");
    // Not a corrected number — no number.
    assert.equal(report.positions[0]?.chainDeltaSol, null);
    assert.equal(report.positions[0]?.chainDeltaUsd, null);
    assert.equal(report.positions[0]?.driftUsd, null);
    assert.equal(report.chainPnlUsd, 0);
    assert.equal(report.driftPctOfModel, null, "an unsettled book was given a drift percentage");

    const line = describeReconciliation(report);
    assert.match(line, /NOT SETTLED/);
    assert.doesNotMatch(line, /-117|-127|wallet says/, "the unsettled figure leaked into the report");
  });

  it("treats a failed or unmeasured sweep as unsettled even if an after-balance is present", () => {
    for (const state of ["failed", "unmeasured"]) {
      const report = reconcilePositions([manlet({ residual_sweep: state })]);
      assert.equal(report.positions[0]?.settlement, "unsettled", state);
      assert.equal(report.positions[0]?.driftUsd, null, state);
      assert.equal(report.measured, 0, state);
    }
  });

  it("keeps an unsettled row out of the totals of the settled rows beside it", () => {
    const report = reconcilePositions([
      manlet({ opened_at: "2026-09-01 00:00:00", closed_at: "2026-09-01 02:00:00" }),
      liveRow({
        opened_at: "2026-09-02 00:00:00",
        closed_at: "2026-09-02 02:00:00",
        realized_pnl_usd: 1.0,
        wallet_lamports_before: 3 * LAMPORTS,
        wallet_lamports_after: 3.01 * LAMPORTS,
        residual_sweep: "dust",
      }),
    ]);

    assert.equal(report.measured, 1);
    assert.equal(report.unsettled, 1);
    assert.ok(Math.abs(report.modelPnlUsd - 1.0) < 1e-9, "the unsettled row's $9.49 was summed");
    assert.ok(Math.abs(report.chainPnlUsd - 1.0) < 1e-6, `chain ${report.chainPnlUsd}`);
    assert.match(describeReconciliation(report), /1 NOT SETTLED and excluded/);
  });

  it("reconciles a row an operator settled by hand, as settled", () => {
    // The hand-settled MANLET row: after = the balance once the operator's sell landed.
    const report = reconcilePositions([
      manlet({ residual_sweep: "operator", wallet_lamports_after: 2_961_019_706 }),
    ]);
    assert.equal(report.positions[0]?.settlement, "settled");
    assert.equal(report.measured, 1);
    assert.ok((report.positions[0]?.chainDeltaSol ?? 0) > 0, "a profitable trade read as a loss");
  });
});

describe("wallet reconciliation — attribution is only claimed when it holds", () => {
  it("flags overlapping windows, because the delta is then the wallet's, not the trade's", () => {
    /*
     * The measurement is a balance either side of one trade, so anything ELSE that moved
     * SOL in between lands in the same number. At the shipped
     * LIVE_MAX_CONCURRENT_POSITIONS=1 that cannot happen; above 1 it always does, and
     * the per-position figures stop meaning what their name says.
     */
    const report = reconcilePositions([
      liveRow({
        opened_at: "2026-09-01 10:00:00",
        closed_at: "2026-09-01 18:00:00",
        wallet_lamports_before: 3 * LAMPORTS,
        wallet_lamports_after: 3.01 * LAMPORTS,
      }),
      liveRow({
        opened_at: "2026-09-01 12:00:00",
        closed_at: "2026-09-01 20:00:00",
        wallet_lamports_before: 3.01 * LAMPORTS,
        wallet_lamports_after: 3.02 * LAMPORTS,
      }),
    ]);

    assert.equal(report.anyOverlap, true, "overlapping windows were reported as clean");
    assert.match(describeReconciliation(report), /OVERLAPPED/);
  });

  it("does not flag sequential positions", () => {
    const report = reconcilePositions([
      liveRow({
        opened_at: "2026-09-01 10:00:00",
        closed_at: "2026-09-01 12:00:00",
        wallet_lamports_before: 3 * LAMPORTS,
        wallet_lamports_after: 3.01 * LAMPORTS,
      }),
      liveRow({
        opened_at: "2026-09-01 13:00:00",
        closed_at: "2026-09-01 15:00:00",
        wallet_lamports_before: 3.01 * LAMPORTS,
        wallet_lamports_after: 3.02 * LAMPORTS,
      }),
    ]);
    assert.equal(report.anyOverlap, false);
    assert.equal(report.measured, 2);
  });

  it("reads stored timestamps as UTC, not as local time", () => {
    /*
     * SQLite's CURRENT_TIMESTAMP writes "YYYY-MM-DD HH:MM:SS" with no zone marker, which
     * `new Date()` reads as LOCAL. On an Asia/Jakarta box that is a 7-hour shift — enough
     * to make two adjacent positions look overlapping, or an overlapping pair look
     * sequential, depending on which way the boundary falls.
     */
    const report = reconcilePositions([
      liveRow({
        opened_at: "2026-09-01 00:00:00",
        closed_at: "2026-09-01 06:00:00",
        wallet_lamports_before: 3 * LAMPORTS,
        wallet_lamports_after: 3.01 * LAMPORTS,
      }),
      liveRow({
        opened_at: "2026-09-01 07:00:00",
        closed_at: "2026-09-01 09:00:00",
        wallet_lamports_before: 3.01 * LAMPORTS,
        wallet_lamports_after: 3.02 * LAMPORTS,
      }),
    ]);
    assert.equal(report.anyOverlap, false, "a timezone shift turned two trades into one window");
  });
});
