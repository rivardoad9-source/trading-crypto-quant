/**
 * `/close_all` — the emergency command, and the one place the "chain decides, the
 * database records" rule was not applied at all.
 *
 * The monitor already closes a live position in two phases: decide under the lock, send
 * the transactions with the lock released, and mark the row closed ONLY once the chain
 * confirms. `forceCloseAllPositions` did none of that. It called `closePosition(...)`
 * straight into SQLite for every active row, live ones included — no `closeLivePosition`,
 * no signature, nothing sent.
 *
 * So an operator flattening the book got a report saying the book was flat while the
 * DLMM positions were untouched on-chain, and because the rows were no longer ACTIVE the
 * fast monitor stopped watching them — real capital left in a position with nothing
 * enforcing its stop-loss, discoverable only by reading the chain by hand. That is the
 * failure the rule exists to prevent, reached through the command an operator uses when
 * something has already gone wrong.
 *
 * These tests run with execution UNARMED, so the on-chain close is guaranteed to fail.
 * That is the point: the question is what the database does when the chain does not
 * confirm, and the answer must be "nothing".
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-manualclose-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Repos = typeof import("../database/repositories.js");
type Db = typeof import("../database/db.js");
type Agent = typeof import("../agents/dlmmTraderAgent.js");

let repos: Repos;
let dbModule: Db;
let agent: Agent;

before(async () => {
  dbModule = await import("../database/db.js");
  repos = await import("../database/repositories.js");
  agent = await import("../agents/dlmmTraderAgent.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const row of repos.getActivePositions()) {
    repos.closePosition({
      positionId: row.position_id,
      status: "CLOSED_MANUAL",
      exitPrice: 1,
      realizedPnlUsd: 0,
      realizedPnlPct: 0,
      unclaimedFeeUsd: 0,
      impermanentLossUsd: 0,
      positionValueChangeUsd: 0,
      closeReason: "test reset",
    });
  }
});

const basePosition = (id: string) => ({
  positionId: id,
  poolAddress: `pool-${id}`,
  pairName: `${id.toUpperCase()}-SOL`,
  strategyType: "SPOT" as const,
  entryPrice: 100,
  lowerBinPrice: 90,
  upperBinPrice: 110,
  virtualSolAmount: 0.8,
  entryTvl: 50_000,
  entry24hVolume: 500_000,
  confidenceScore: 70,
  reasoningLog: "t",
  entrySolPriceUsd: 100,
});

/** Live pool data for anything asked for. */
const pool = async () => ({ currentPrice: 105, feeTvlRatio24h: 0.01 });

describe("/close_all — a LIVE row is never closed without the chain", () => {
  it("leaves a live position ACTIVE when the on-chain close cannot happen", async () => {
    repos.insertPosition({
      ...basePosition("live1"),
      executionMode: "LIVE",
      positionAddress: "Pos1111111111111111111111111111111111111111",
      openSignature: "sig-open",
    });

    // Execution is unarmed in the test environment, so `closeLivePosition` throws.
    const result = await agent.forceCloseAllPositions({
      fetchPool: pool,
      reflect: async () => null,
    });

    assert.equal(result.requested, 1);
    assert.equal(result.closed, 0, "a live position was reported closed with nothing sent");

    const row = repos.getPositionById("live1");
    assert.equal(row?.status, "ACTIVE", "the row was marked closed while the position still exists");
    assert.equal(row?.closed_at, null);
    assert.equal(row?.close_signature ?? null, null);

    /*
     * And the operator is told, in those words. "0 closed" alone would read as "nothing
     * needed closing" — the opposite of the truth, which is that a real position is
     * still open and still held.
     */
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]?.reason ?? "", /STILL OPEN|on-chain close failed/i);
  });

  it("still closes PAPER rows immediately, which need no chain at all", async () => {
    repos.insertPosition(basePosition("paper1"));

    const result = await agent.forceCloseAllPositions({
      fetchPool: pool,
      reflect: async () => null,
    });

    assert.equal(result.closed, 1);
    const row = repos.getPositionById("paper1");
    assert.equal(row?.status, "CLOSED_MANUAL");
    assert.ok(row?.closed_at, "a paper close did not record a timestamp");
  });

  it("closes the paper half of a mixed book and leaves the live half alone", async () => {
    /*
     * The realistic emergency: some rows are real and some are not. Flattening must not
     * be all-or-nothing in either direction — refusing the paper closes because a live
     * one failed would leave the operator with a book they cannot clear, and closing the
     * live row to keep the report tidy is the original bug.
     */
    repos.insertPosition(basePosition("paper2"));
    repos.insertPosition({
      ...basePosition("live2"),
      executionMode: "LIVE",
      positionAddress: "Pos2222222222222222222222222222222222222222",
      openSignature: "sig-open-2",
    });

    const result = await agent.forceCloseAllPositions({
      fetchPool: pool,
      reflect: async () => null,
    });

    assert.equal(result.requested, 2);
    assert.equal(result.closed, 1, "exactly the paper row should have closed");
    assert.equal(repos.getPositionById("paper2")?.status, "CLOSED_MANUAL");
    assert.equal(repos.getPositionById("live2")?.status, "ACTIVE");
  });

  it("says the on-chain position was not touched when there is no price to value it at", async () => {
    /*
     * No live pool data and no stored price. The row cannot be valued, so it is reported
     * failed — but on a LIVE row "failed" has to say that the POSITION is still open,
     * not merely that a database write did not happen.
     */
    repos.insertPosition({
      ...basePosition("live3"),
      executionMode: "LIVE",
      positionAddress: "Pos3333333333333333333333333333333333333333",
      openSignature: "sig-open-3",
    });
    // insertPosition seeds current_price from entry_price, so blank it to reach the
    // no-price branch.
    dbModule.db
      .prepare(`UPDATE simulated_positions SET current_price = NULL WHERE position_id = 'live3'`)
      .run();

    const result = await agent.forceCloseAllPositions({
      fetchPool: async () => null,
      reflect: async () => null,
    });

    assert.equal(result.closed, 0);
    assert.match(result.failed[0]?.reason ?? "", /ON-CHAIN POSITION IS STILL OPEN/);
    assert.equal(repos.getPositionById("live3")?.status, "ACTIVE");
  });
});
