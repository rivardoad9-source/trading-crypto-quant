/**
 * Tests for the Telegram control-command layer: authorization, the /status
 * report, the pause/resume flag, and the emergency force-close path.
 *
 * Runs against a throwaway SQLite file; env vars must be set before any module
 * that reads env is imported, hence the dynamic imports. TELEGRAM_BOT_TOKEN is
 * deliberately NOT set so no Telegraf instance (and no network) is created.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-tg-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";
process.env.TELEGRAM_ALLOWED_USER_IDS = "6678941282,123456";

type Db = typeof import("../database/db.js");
type Repos = typeof import("../database/repositories.js");
type Commands = typeof import("../services/telegramCommands.js");
type Agent = typeof import("../agents/dlmmTraderAgent.js");
type Control = typeof import("../services/engineControl.js");

let dbModule: Db;
let repos: Repos;
let commands: Commands;
let agent: Agent;
let control: Control;

const OWNER_ID = 6678941282;
const STRANGER_ID = 999999999;

before(async () => {
  dbModule = await import("../database/db.js");
  repos = await import("../database/repositories.js");
  commands = await import("../services/telegramCommands.js");
  agent = await import("../agents/dlmmTraderAgent.js");
  control = await import("../services/engineControl.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

const newPosition = (id: string, poolAddress: string, pairName: string, entryPrice = 100) => ({
  positionId: id,
  poolAddress,
  pairName,
  strategyType: "SPOT" as const,
  entryPrice,
  lowerBinPrice: entryPrice * 0.9,
  upperBinPrice: entryPrice * 1.1,
  virtualSolAmount: 1.0,
  entryTvl: 50_000,
  entry24hVolume: 500_000,
  confidenceScore: 72,
  reasoningLog: "test thesis",
  entrySolPriceUsd: 200,
});

describe("authorization", () => {
  it("allows only allowlisted user IDs (fail closed)", () => {
    assert.equal(commands.isCommandAuthorized(OWNER_ID), true);
    assert.equal(commands.isCommandAuthorized(123456), true);
    assert.equal(commands.isCommandAuthorized(STRANGER_ID), false);
    assert.equal(commands.isCommandAuthorized(undefined), false);
  });
});

describe("pause/resume", () => {
  it("toggles the engine scanning flag", () => {
    control.setEnginePaused(true);
    assert.equal(control.isEnginePaused(), true);
    control.setEnginePaused(false);
    assert.equal(control.isEnginePaused(), false);
  });
});

describe("status report", () => {
  it("reports balance, PnL and engine state", () => {
    repos.insertPosition(newPosition("tg-pos-1", "poolA", "AAA-SOL"));
    repos.closePosition({
      positionId: "tg-pos-1",
      status: "CLOSED_PROFIT",
      exitPrice: 108,
      realizedPnlUsd: 6.0,
      realizedPnlPct: 3.0,
      unclaimedFeeUsd: 1.0,
      impermanentLossUsd: -1.0,
      positionValueChangeUsd: 5.0,
      closeReason: "Take-profit hit.",
    });

    const text = commands.buildStatusText();
    assert.match(text, /FlowMetrix Status/);
    assert.match(text, /Balance/);
    assert.match(text, /\$1006/, "balance = 1000 + 6 realised (MarkdownV2-escaped)");
    assert.match(text, /All\\-time/, "all-time line present (hyphen MarkdownV2-escaped)");
    assert.match(text, /RUNNING/, "engine reports RUNNING by default");
    assert.equal(
      /[^\\]\(/.test(text),
      false,
      "no unescaped '(' may reach Telegram's MarkdownV2 parser",
    );
  });

  it("shows PAUSED when the engine is paused", () => {
    control.setEnginePaused(true);
    try {
      const text = commands.buildStatusText();
      assert.match(text, /PAUSED/);
    } finally {
      control.setEnginePaused(false);
    }
  });

  it("lists active positions with range status", () => {
    repos.insertPosition(newPosition("tg-pos-2", "poolB", "BBB-SOL"));
    const text = commands.buildStatusText();
    assert.match(text, /Active positions:/);
    assert.match(text, /BBB/, "pair name appears (MarkdownV2-escaped)");
    assert.match(text, /in range/);
    // Clean up so later force-close tests see only their own positions.
    repos.closePosition({
      positionId: "tg-pos-2",
      status: "CLOSED_TIMEOUT",
      exitPrice: 100,
      realizedPnlUsd: 0,
      realizedPnlPct: 0,
      unclaimedFeeUsd: 0,
      impermanentLossUsd: 0,
      positionValueChangeUsd: 0,
      closeReason: "test cleanup",
    });
  });
});

describe("force close all", () => {
  it("closes every active position at the live price", async () => {
    repos.insertPosition(newPosition("tg-pos-3", "poolC", "CCC-SOL"));
    repos.insertPosition(newPosition("tg-pos-4", "poolD", "DDD-SOL"));

    const result = await agent.forceCloseAllPositions({
      reason: "test manual close",
      fetchPool: async (poolAddress) => {
        if (poolAddress === "poolC") return { currentPrice: 110, feeTvlRatio24h: 0.01 };
        if (poolAddress === "poolD") return { currentPrice: 90, feeTvlRatio24h: 0.005 };
        return null;
      },
      reflect: async () => null, // no DeepSeek in tests
    });

    assert.equal(result.requested, 2);
    assert.equal(result.closed, 2);
    assert.equal(result.failed.length, 0);
    assert.equal(result.stalePriced.length, 0);
    assert.ok(result.totalNetPnlUsd !== 0, "net PnL reflects the price move");

    const closed = repos.getClosedPositions();
    const manual = closed.filter((p) => p.status === "CLOSED_MANUAL");
    assert.equal(manual.length, 2, "both positions must be CLOSED_MANUAL");
    assert.equal(manual.every((p) => p.close_reason === "test manual close"), true);
    assert.equal(repos.countActivePositions(), 0);
  });

  it("falls back to the last stored price and flags it as stale", async () => {
    repos.insertPosition(newPosition("tg-pos-5", "poolE", "EEE-SOL"));

    const result = await agent.forceCloseAllPositions({
      reason: "test stale close",
      fetchPool: async () => null, // live data unavailable
      reflect: async () => null,
    });

    assert.equal(result.closed, 1);
    assert.equal(result.stalePriced.length, 1);
    assert.equal(result.stalePriced[0], "EEE-SOL");
    const row = repos.getPositionById("tg-pos-5")!;
    assert.equal(row.status, "CLOSED_MANUAL");
    assert.match(row.close_reason ?? "", /stale price/);
    // At the stored entry price the net PnL is exactly the fee carry, which is 0 here.
    assert.equal(Math.round(row.realized_pnl_usd * 100) / 100, 0);
  });

  it("reports positions that cannot be closed at all", async () => {
    repos.insertPosition(newPosition("tg-pos-6", "poolF", "FFF-SOL"));
    // Simulate a row whose stored price is unknown (e.g. never marked).
    dbModule.db
      .prepare("UPDATE simulated_positions SET current_price = NULL WHERE position_id = ?")
      .run("tg-pos-6");

    const result = await agent.forceCloseAllPositions({
      fetchPool: async () => null,
      reflect: async () => null,
    });

    assert.equal(result.closed, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.pairName, "FFF-SOL");
    assert.equal(repos.countActivePositions(), 1, "unclosable position stays active");
  });
});
