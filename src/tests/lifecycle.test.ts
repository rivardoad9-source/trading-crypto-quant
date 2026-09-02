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
  /*
   * The day key comes from the same helper the query buckets by.
   *
   * This test used to build "today" with `Intl` over `process.env.TZ` while the query
   * grouped by SQLite's `'localtime'` — an assertion that the two agree. They did on
   * Linux and did not on Windows, where the CRT cannot read an IANA name, so the test
   * passed only while UTC and local happened to share a calendar date and broke the
   * moment they diverged near midnight.
   *
   * Both sides now resolve the zone through the IANA database (src/services/timezone.ts),
   * so `currentLocalDate()` and the aggregation cannot disagree by construction. What
   * this test is left asserting is the GROUPING — three closes collapsing into one dated
   * row with the right counts — which is what it was always for.
   */
  it("groups closed trades by local date", () => {
    const today = repos.currentLocalDate();

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

describe("pool exit history (cooldown & lockout source data)", () => {
  /*
   * The gate's arithmetic is tested in cooldown.test.ts against a fixed clock. What
   * matters here is that the repository hands it the right rows: newest close first,
   * per pool, with the consecutive-failure run counted from the front.
   */
  const closeAs = (
    positionId: string,
    poolAddress: string,
    status: "CLOSED_PROFIT" | "CLOSED_LOSS" | "CLOSED_OUT_OF_RANGE" | "CLOSED_TIMEOUT",
    closedHoursAgo: number,
  ): void => {
    repos.insertPosition(newPosition(positionId, poolAddress));
    repos.closePosition({
      positionId,
      status,
      exitPrice: 100,
      realizedPnlUsd: status === "CLOSED_PROFIT" ? 1 : -1,
      realizedPnlPct: status === "CLOSED_PROFIT" ? 1 : -1,
      unclaimedFeeUsd: 0,
      impermanentLossUsd: 0,
      positionValueChangeUsd: 0,
      closeReason: `test ${status}`,
    });

    // closePosition stamps CURRENT_TIMESTAMP; back-date it so ordering is explicit
    // rather than dependent on how fast the test runs.
    const stamp = new Date(Date.now() - closedHoursAgo * 3_600_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    dbModule.db
      .prepare(`UPDATE simulated_positions SET closed_at = ? WHERE position_id = ?`)
      .run(stamp, positionId);
  };

  it("counts a run of two failing exits on one pool", () => {
    closeAs("exit-1", "poolChurn", "CLOSED_OUT_OF_RANGE", 5);
    closeAs("exit-2", "poolChurn", "CLOSED_LOSS", 1);

    const record = repos.getPoolExitRecord("poolChurn");
    assert.equal(record.consecutiveFailures, 2);
    assert.ok(record.lastFailureAt);
    assert.equal(record.lastClosedAt, record.lastFailureAt, "newest close is the newest failure");
  });

  it("resets the run when a later trade closes in profit", () => {
    closeAs("exit-3", "poolMixed", "CLOSED_OUT_OF_RANGE", 6);
    closeAs("exit-4", "poolMixed", "CLOSED_OUT_OF_RANGE", 4);
    closeAs("exit-5", "poolMixed", "CLOSED_PROFIT", 2);

    const record = repos.getPoolExitRecord("poolMixed");
    assert.equal(record.consecutiveFailures, 0);
    assert.equal(record.lastFailureAt, null);
    assert.ok(record.lastClosedAt, "the profitable close still starts a cooldown");
  });

  it("keys the history map by pool and excludes still-open positions", () => {
    const history = repos.getPoolExitHistory();

    assert.equal(history.get("poolChurn")?.consecutiveFailures, 2);
    assert.equal(history.get("poolMixed")?.consecutiveFailures, 0);
    assert.equal(
      history.has("poolCCC"),
      false,
      "poolCCC's only position is still ACTIVE and must not gate anything",
    );
  });

  it("reports an untraded pool as absent rather than as a blank record", () => {
    assert.equal(repos.getPoolExitHistory().has("poolNeverTraded"), false);
    assert.equal(repos.getPoolExitRecord("poolNeverTraded").lastClosedAt, null);
  });

  it("drops closes older than the lookback window", () => {
    closeAs("exit-6", "poolAncient", "CLOSED_LOSS", 100);
    assert.equal(repos.getPoolExitHistory(24).has("poolAncient"), false);
    assert.equal(repos.getPoolExitHistory(24 * 30).has("poolAncient"), true);
  });
});


describe("getRecentFailurePostMortems — loss context for the entry prompt", () => {
  const closeWithMortem = (
    positionId: string,
    status: "CLOSED_PROFIT" | "CLOSED_LOSS" | "CLOSED_OUT_OF_RANGE" | "CLOSED_TIMEOUT",
    closedHoursAgo: number,
    postMortem: string | null,
  ): void => {
    repos.insertPosition(newPosition(positionId, `pool-${positionId}`));
    repos.closePosition({
      positionId,
      status,
      exitPrice: 100,
      realizedPnlUsd: -1,
      realizedPnlPct: -1,
      unclaimedFeeUsd: 0,
      impermanentLossUsd: 0,
      positionValueChangeUsd: 0,
      closeReason: `test ${status}`,
    });

    dbModule.db
      .prepare(
        `UPDATE simulated_positions
            SET closed_at = datetime('now', ?)
          WHERE position_id = ?`,
      )
      .run(`-${closedHoursAgo} hours`, positionId);

    if (postMortem !== null) repos.setPostMortem(positionId, postMortem);
  };

  before(() => {
    closeWithMortem("pm-loss-old", "CLOSED_LOSS", 9, "oldest lesson");
    closeWithMortem("pm-range", "CLOSED_OUT_OF_RANGE", 6, "wicked out of a tight range");
    closeWithMortem("pm-loss-new", "CLOSED_LOSS", 3, "newest lesson");
    closeWithMortem("pm-profit", "CLOSED_PROFIT", 2, "a win, not a lesson in failure");
    closeWithMortem("pm-timeout", "CLOSED_TIMEOUT", 1, "aged out while still in range");
    closeWithMortem("pm-nomortem", "CLOSED_LOSS", 1, null);
  });

  it("returns only failing closes", () => {
    const ids = repos.getRecentFailurePostMortems(10).map((r) => r.position_id);

    assert.ok(ids.includes("pm-loss-new"));
    assert.ok(ids.includes("pm-range"));
    assert.equal(ids.includes("pm-profit"), false, "a win is not a failure lesson");
    assert.equal(
      ids.includes("pm-timeout"),
      false,
      "a timeout is a neutral outcome, same rule as the lockout",
    );
  });

  it("skips failures that carry no written post-mortem", () => {
    // An empty lesson is not evidence; padding it would teach the model from nothing.
    const ids = repos.getRecentFailurePostMortems(10).map((r) => r.position_id);
    assert.equal(ids.includes("pm-nomortem"), false);
  });

  it("orders newest first so the freshest regime leads the prompt", () => {
    const ids = repos.getRecentFailurePostMortems(10).map((r) => r.position_id);
    assert.deepEqual(ids, ["pm-loss-new", "pm-range", "pm-loss-old"]);
  });

  it("honours the limit", () => {
    assert.equal(repos.getRecentFailurePostMortems(2).length, 2);
    assert.equal(repos.getRecentFailurePostMortems(0).length, 0);
  });
});

describe("cohort filtering — v1.0 legacy vs v1.1 clean engine", () => {
  const CUTOFF = "2026-08-29T00:00:00Z";
  const V11 = { openedAtFrom: CUTOFF };

  /** Opens and closes a position with both timestamps forced, so the split is exact. */
  const tradeAt = (
    positionId: string,
    openedAt: string,
    closedAt: string,
    pnlUsd: number,
  ): void => {
    repos.insertPosition(newPosition(positionId, `cohort-${positionId}`));
    repos.closePosition({
      positionId,
      status: pnlUsd > 0 ? "CLOSED_PROFIT" : "CLOSED_LOSS",
      exitPrice: 100,
      realizedPnlUsd: pnlUsd,
      realizedPnlPct: pnlUsd,
      unclaimedFeeUsd: 0,
      impermanentLossUsd: 0,
      positionValueChangeUsd: 0,
      closeReason: "cohort fixture",
    });

    dbModule.db
      .prepare(
        `UPDATE simulated_positions
            SET opened_at = datetime(?), closed_at = datetime(?)
          WHERE position_id = ?`,
      )
      .run(openedAt, closedAt, positionId);
  };

  before(() => {
    // Legacy: opened and closed before the cutoff.
    tradeAt("v10-a", "2026-08-27T10:00:00Z", "2026-08-27T14:00:00Z", -10);
    tradeAt("v10-b", "2026-08-28T10:00:00Z", "2026-08-28T14:00:00Z", -5);
    // Straddler: chosen by the OLD engine, closed after the cutoff.
    tradeAt("v10-straddle", "2026-08-28T23:00:00Z", "2026-08-29T02:00:00Z", -20);
    // Clean run.
    tradeAt("v11-a", "2026-08-29T09:00:00Z", "2026-08-29T11:00:00Z", 8);
  });

  it("splits on opened_at, not closed_at", () => {
    const ids = repos.getClosedPositions(50, 0, V11).map((r) => r.position_id);

    assert.ok(ids.includes("v11-a"));
    assert.equal(
      ids.includes("v10-straddle"),
      false,
      "a position the old screener opened stays v1.0 however late it closed",
    );
  });

  it("excludes every pre-cutoff trade from the clean cohort", () => {
    const ids = repos.getClosedPositions(50, 0, V11).map((r) => r.position_id);
    assert.equal(ids.includes("v10-a"), false);
    assert.equal(ids.includes("v10-b"), false);
  });

  it("recomputes lifetime stats over the filtered set", () => {
    const all = repos.getLifetimeStats();
    const clean = repos.getLifetimeStats(V11);

    assert.ok(all.totalClosed > clean.totalClosed, "the archive must be the larger set");
    // The clean cohort's fixtures are one winner; the legacy ones are all losers.
    assert.equal(clean.wins >= 1, true);
    assert.ok(
      all.realizedPnlUsd < clean.realizedPnlUsd,
      "dropping the legacy losses must raise the cohort's realised PnL",
    );
  });

  it("filters the PnL series the drawdown and profit factor run over", () => {
    const all = repos.getRealisedPnlSeries();
    const clean = repos.getRealisedPnlSeries(V11);

    assert.ok(clean.length < all.length);
    assert.equal(
      clean.includes(-20),
      false,
      "the straddling legacy loss must not appear in the clean curve",
    );
  });

  it("compares an ISO cutoff against SQLite's zone-less timestamps", () => {
    /*
     * opened_at is 'YYYY-MM-DD HH:MM:SS'; the cutoff carries 'T' and 'Z'. A raw string
     * comparison would silently match nothing, so the clause goes through datetime().
     */
    const viaIso = repos.getClosedPositions(50, 0, { openedAtFrom: CUTOFF });
    const viaSqliteShape = repos.getClosedPositions(50, 0, {
      openedAtFrom: "2026-08-29 00:00:00",
    });

    assert.ok(viaIso.length > 0, "the ISO cutoff matched nothing — datetime() is not applied");
    assert.deepEqual(
      viaIso.map((r) => r.position_id),
      viaSqliteShape.map((r) => r.position_id),
    );
  });

  it("treats a null cutoff as the unfiltered archive", () => {
    assert.equal(
      repos.getLifetimeStats({ openedAtFrom: null }).totalClosed,
      repos.getLifetimeStats().totalClosed,
    );
  });
});

describe("CLOSED_MANUAL is invisible to the anti-churn gates", () => {
  const close = (
    positionId: string,
    poolAddress: string,
    status: "CLOSED_PROFIT" | "CLOSED_LOSS" | "CLOSED_OUT_OF_RANGE" | "CLOSED_MANUAL",
    hoursAgo: number,
  ): void => {
    repos.insertPosition(newPosition(positionId, poolAddress));
    repos.closePosition({
      positionId,
      status,
      exitPrice: 100,
      realizedPnlUsd: status === "CLOSED_PROFIT" ? 1 : -1,
      realizedPnlPct: status === "CLOSED_PROFIT" ? 1 : -1,
      unclaimedFeeUsd: 0,
      impermanentLossUsd: 0,
      positionValueChangeUsd: 0,
      closeReason: `test ${status}`,
    });
    dbModule.db
      .prepare(`UPDATE simulated_positions SET closed_at = datetime('now', ?) WHERE position_id = ?`)
      .run(`-${hoursAgo} hours`, positionId);
  };

  it("does not start a cooldown", () => {
    // A /close_all must not bench every pool it touched for POOL_COOLDOWN_HOURS —
    // that would silently disable trading right after an operator intervention.
    close("man-only", "poolManualOnly", "CLOSED_MANUAL", 0.1);

    const record = repos.getPoolExitRecord("poolManualOnly");
    assert.equal(record.lastClosedAt, null);
    assert.equal(record.consecutiveFailures, 0);
    assert.equal(repos.getPoolExitHistory().has("poolManualOnly"), false);
  });

  it("does not trip the lockout", () => {
    close("man-a", "poolManualRun", "CLOSED_MANUAL", 3);
    close("man-b", "poolManualRun", "CLOSED_MANUAL", 2);
    close("man-c", "poolManualRun", "CLOSED_MANUAL", 1);

    assert.equal(repos.getPoolExitRecord("poolManualRun").consecutiveFailures, 0);
  });

  it("does not clear a failure run either", () => {
    /*
     * The breaker measures what the POOL did. If a manual close reset the run, an
     * operator flattening the book would silently un-arm a circuit breaker that two
     * genuine failures had earned.
     */
    close("mix-a", "poolManualMix", "CLOSED_OUT_OF_RANGE", 5);
    close("mix-b", "poolManualMix", "CLOSED_MANUAL", 4);
    close("mix-c", "poolManualMix", "CLOSED_LOSS", 3);

    assert.equal(repos.getPoolExitRecord("poolManualMix").consecutiveFailures, 2);
  });

  it("still lets a genuine win clear the run", () => {
    close("win-a", "poolManualWin", "CLOSED_LOSS", 5);
    close("win-b", "poolManualWin", "CLOSED_LOSS", 4);
    close("win-c", "poolManualWin", "CLOSED_PROFIT", 3);

    assert.equal(repos.getPoolExitRecord("poolManualWin").consecutiveFailures, 0);
    assert.ok(repos.getPoolExitRecord("poolManualWin").lastClosedAt, "a real close still benches");
  });
});


describe("fee accrual is capped to observed time", () => {
  /*
   * Restart safety. Fees are rate x (now - last_checked_at); after downtime that span
   * is however long the engine was off. A 52h gap once would have credited two days of
   * fees on the first tick, justified by a single in-range check of a period nothing
   * watched. Total realised PnL across the whole dry run was -$25, so a few dollars of
   * phantom fees per position is not a rounding error.
   */
  it("credits at most MAX_FEE_ACCRUAL_GAP_HOURS, not the whole downtime", async () => {
    const meteora = await import("../services/meteora.js");
    const notional = 104.94;
    const ratio = 0.01;

    const uncapped = meteora.estimateFeeYieldUsd(notional, ratio, 52.6, true);
    const capped = meteora.estimateFeeYieldUsd(notional, ratio, Math.min(52.6, 1), true);

    assert.ok(uncapped > 2, `the bug was worth real money: $${uncapped.toFixed(2)}`);
    assert.ok(capped < uncapped / 10, "capping must remove most of the phantom accrual");
    assert.equal(capped, meteora.estimateFeeYieldUsd(notional, ratio, 1, true));
  });

  it("still accrues nothing while out of range, however long the gap", async () => {
    const meteora = await import("../services/meteora.js");
    // The cap shortens the interval; it must not turn an out-of-range position into an
    // earning one, and zero stays zero at every interval length.
    for (const hours of [0.5, 1, 52.6]) {
      assert.equal(meteora.estimateFeeYieldUsd(104.94, 0.01, hours, false), 0);
    }
  });

  it("accrues nothing for a non-positive interval", async () => {
    const meteora = await import("../services/meteora.js");
    // hoursSince() floors negatives at 0; a clock skew must never pay fees.
    assert.equal(meteora.estimateFeeYieldUsd(104.94, 0.01, 0, true), 0);
    assert.equal(meteora.estimateFeeYieldUsd(104.94, 0.01, -5, true), 0);
  });
});
