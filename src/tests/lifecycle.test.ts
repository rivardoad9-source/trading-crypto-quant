/**
 * End-to-end persistence test for the paper-trading lifecycle.
 *
 * Runs against a throwaway SQLite file. DATABASE_PATH must be set before any module
 * that reads env is imported, so every import below is dynamic. The node test runner
 * gives each test file its own process, so this does not leak into other suites.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Repos = typeof import("../database/repositories.js");
type Db = typeof import("../database/db.js");

let repos: Repos;
let dbModule: Db;

before(async () => {
  dbModule = await import("../database/db.js");
  repos = await import("../database/repositories.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

const newPosition = (id: string, poolAddress = "poolAAA") => ({
  positionId: id,
  poolAddress,
  pairName: "AAA-SOL",
  strategyType: "SPOT" as const,
  entryPrice: 100,
  lowerBinPrice: 90,
  upperBinPrice: 110,
  virtualSolAmount: 1.0,
  entryTvl: 50_000,
  entry24hVolume: 500_000,
  confidenceScore: 72,
  reasoningLog: "test thesis",
  entrySolPriceUsd: 200,
});

describe("position lifecycle", () => {
  it("opens a position as ACTIVE with the entry price mirrored to current", () => {
    repos.insertPosition(newPosition("pos-1"));

    const row = repos.getPositionById("pos-1");
    assert.ok(row);
    assert.equal(row.status, "ACTIVE");
    assert.equal(row.entry_price, 100);
    assert.equal(row.current_price, 100);
    assert.equal(row.virtual_sol_amount, 1.0);
    assert.equal(row.entry_sol_price_usd, 200);
    assert.equal(repos.countActivePositions(), 1);
  });

  it("reports an existing active position for its pool", () => {
    assert.equal(repos.hasActivePositionForPool("poolAAA"), true);
    assert.equal(repos.hasActivePositionForPool("poolZZZ"), false);
  });

  it("accumulates floating metrics without closing", () => {
    repos.updatePositionMetrics({
      positionId: "pos-1",
      currentPrice: 105,
      unclaimedFeeUsd: 4.5,
      impermanentLossUsd: -1.2,
      positionValueChangeUsd: -1.2,
      floatingPnlUsd: 3.3,
    });

    const row = repos.getPositionById("pos-1")!;
    assert.equal(row.status, "ACTIVE");
    assert.equal(row.current_price, 105);
    assert.equal(row.unclaimed_fee_usd, 4.5);
    assert.equal(row.floating_pnl_usd, 3.3);
    assert.equal(repos.getTotalFloatingPnlUsd(), 3.3);
    assert.equal(repos.getTotalUnclaimedFeesUsd(), 4.5);
  });

  it("closes a position and moves it out of the active set", () => {
    repos.closePosition({
      positionId: "pos-1",
      status: "CLOSED_PROFIT",
      exitPrice: 108,
      realizedPnlUsd: 6.0,
      realizedPnlPct: 3.0,
      unclaimedFeeUsd: 7.1,
      impermanentLossUsd: -1.1,
      positionValueChangeUsd: -1.1,
      closeReason: "Take-profit hit.",
    });

    const row = repos.getPositionById("pos-1")!;
    assert.equal(row.status, "CLOSED_PROFIT");
    assert.equal(row.exit_price, 108);
    assert.equal(row.realized_pnl_usd, 6.0);
    assert.ok(row.closed_at, "closed_at must be stamped");

    assert.equal(repos.countActivePositions(), 0);
    assert.equal(
      repos.getTotalFloatingPnlUsd(),
      0,
      "a closed position must not contribute floating PnL",
    );
    assert.equal(repos.getClosedPositions().length, 1);
  });

  it("computes lifetime win rate over closed trades only", () => {
    repos.insertPosition(newPosition("pos-2", "poolBBB"));
    repos.closePosition({
      positionId: "pos-2",
      status: "CLOSED_LOSS",
      exitPrice: 92,
      realizedPnlUsd: -4.0,
      realizedPnlPct: -2.0,
      unclaimedFeeUsd: 1.0,
      impermanentLossUsd: -5.0,
      positionValueChangeUsd: -5.0,
      closeReason: "Stop-loss hit.",
    });

    repos.insertPosition(newPosition("pos-3", "poolCCC")); // stays open

    const stats = repos.getLifetimeStats();
    assert.equal(stats.totalClosed, 2, "the open position must be excluded");
    assert.equal(stats.wins, 1);
    assert.equal(stats.losses, 1);
    assert.equal(Math.round(stats.realizedPnlUsd * 100) / 100, 2.0);
  });

  it("treats a break-even trade as a loss, not a win", () => {
    repos.insertPosition(newPosition("pos-4", "poolDDD"));
    repos.closePosition({
      positionId: "pos-4",
      status: "CLOSED_TIMEOUT",
      exitPrice: 100,
      realizedPnlUsd: 0,
      realizedPnlPct: 0,
      unclaimedFeeUsd: 0,
      impermanentLossUsd: 0,
      positionValueChangeUsd: 0,
      closeReason: "Max age reached.",
    });

    const stats = repos.getLifetimeStats();
    assert.equal(stats.totalClosed, 3);
    assert.equal(stats.wins, 1);
    assert.equal(stats.losses, 2);
  });
});

describe("daily aggregation", () => {
  it("groups closed trades by local date", () => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.TZ || "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const rows = repos.aggregateClosedTradesByDate(today, today);
    assert.equal(rows.length, 1, "all test trades closed today");
    assert.equal(rows[0]!.trades, 3);
    assert.equal(rows[0]!.wins, 1);
  });

  it("upserts a snapshot idempotently", () => {
    const date = "2026-01-15";

    repos.upsertDailySnapshot({
      date,
      totalTradesClosed: 5,
      winningTrades: 3,
      losingTrades: 2,
      netPnlUsd: 12.5,
      netPnlSol: 0.0625,
    });
    repos.upsertDailySnapshot({
      date,
      totalTradesClosed: 6,
      winningTrades: 4,
      losingTrades: 2,
      netPnlUsd: 18.0,
      netPnlSol: 0.09,
    });

    const rows = repos.getSnapshotsInRange(date, date);
    assert.equal(rows.length, 1, "the second write must update, not duplicate");
    assert.equal(rows[0]!.total_trades_closed, 6);
    assert.equal(rows[0]!.net_pnl_usd, 18.0);
  });
});

describe("research log", () => {
  it("upserts by report date and returns the latest", () => {
    repos.upsertResearchLog({
      reportDate: "2026-01-14",
      rawMacroJson: "{}",
      markdownOutput: "old report",
      sentimentBias: "RISK-OFF",
    });
    repos.upsertResearchLog({
      reportDate: "2026-01-15",
      rawMacroJson: "{}",
      markdownOutput: "new report",
      sentimentBias: "RISK-ON",
    });
    repos.upsertResearchLog({
      reportDate: "2026-01-15",
      rawMacroJson: "{}",
      markdownOutput: "revised report",
      sentimentBias: "SIDEWAYS",
    });

    const latest = repos.getLatestResearch();
    assert.equal(latest?.report_date, "2026-01-15");
    assert.equal(latest?.markdown_output, "revised report");
    assert.equal(latest?.sentiment_bias, "SIDEWAYS");
    assert.equal(repos.getResearchHistory(10).length, 2, "same-date write must not duplicate");
  });
});
