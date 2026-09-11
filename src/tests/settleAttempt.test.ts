/**
 * The attempt ledger agrees with the position book once a trade has settled.
 *
 * 11 Sep 2026: after `scripts/settleResidualByHand.cjs --id 4 ... --execute`, the MANLET-SOL
 * position row was right and its `live_execution_attempts` row (outcome `opened`) still said
 * `wallet_lamports_after = NULL`, `cost_lamports = NULL` — two books disagreeing about the
 * only trade that had actually closed. Both the operator script and the engine now fill it,
 * and neither guesses: no confident match, no write.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-settle-"));
const DB_PATH = join(tempDir, "test.db");
process.env.DATABASE_PATH = DB_PATH;
process.env.DRY_RUN = "true";

type Repos = typeof import("../database/repositories.js");
type Db = typeof import("../database/db.js");
interface Settler {
  findAttempt(
    db: unknown,
    position: Record<string, unknown>,
  ): { attempt: Record<string, unknown> | null; via: string; reason: string | null };
  planAttemptUpdate(
    attempt: Record<string, unknown>,
    afterLamports: number,
  ): { walletLamportsAfter: number; costLamports: number | null; unwind: string; unchanged: boolean };
}

let repos: Repos;
let dbModule: Db;
const settler = createRequire(import.meta.url)("../../scripts/settleResidualByHand.cjs") as Settler;

before(async () => {
  dbModule = await import("../database/db.js");
  repos = await import("../database/repositories.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM live_execution_attempts").run();
  dbModule.db.prepare("DELETE FROM simulated_positions").run();
});

const POSITION = "EDUquTp5ypXH7bY5BSMmNWsWmW1hFtMXJDcwcfw8uLhr";
const POOL = "ManletPool111111111111111111111111111111111";
const BEFORE = 2_880_993_680;
const AFTER = 2_961_019_685;

function opened(over: Partial<Parameters<Repos["recordLiveExecutionAttempt"]>[0]> = {}) {
  repos.recordLiveExecutionAttempt({
    poolAddress: POOL,
    pairName: "MANLET-SOL",
    tokenMint: "MANLETmint",
    outcome: "opened",
    stage: null,
    walletLamportsBefore: BEFORE,
    walletLamportsAfter: null,
    unwind: "none",
    swapSignature: "swap",
    rescueSignature: null,
    positionAddress: POSITION,
    reason: null,
    ...over,
  });
}

function manletRow(positionAddress: string | null = POSITION) {
  repos.insertPosition({
    positionId: "manlet",
    poolAddress: POOL,
    pairName: "MANLET-SOL",
    strategyType: "SPOT",
    entryPrice: 1,
    lowerBinPrice: 0.5,
    upperBinPrice: 2,
    virtualSolAmount: 0.9,
    entryTvl: 1,
    entry24hVolume: 1,
    confidenceScore: 1,
    reasoningLog: "t",
    entrySolPriceUsd: 100,
    executionMode: "LIVE",
    positionAddress: positionAddress ?? undefined,
    openSignature: "open",
  });
  return dbModule.db.prepare("SELECT * FROM simulated_positions WHERE position_id = 'manlet'").get() as Record<
    string,
    unknown
  >;
}

describe("operator settler — matching the attempt row", () => {
  it("matches by position_address, exactly", () => {
    opened();
    opened({ positionAddress: "SomeOtherPosition1111111111111111111111111" });
    const m = settler.findAttempt(dbModule.db, manletRow());
    assert.equal(m.via, "position_address");
    assert.equal(m.attempt?.position_address, POSITION);
  });

  it("falls back to pool + pair + a 15-minute window when the position has no address", () => {
    opened({ positionAddress: null });
    const m = settler.findAttempt(dbModule.db, manletRow(null));
    assert.equal(m.via, "pool+pair+window");
    assert.ok(m.attempt, m.reason ?? "");
  });

  it("refuses to guess: two candidates in the window, or none, is NO match", () => {
    opened({ positionAddress: null });
    opened({ positionAddress: null });
    const two = settler.findAttempt(dbModule.db, manletRow(null));
    assert.equal(two.attempt, null);
    assert.match(two.reason ?? "", /2 'opened' attempts/);

    dbModule.db.prepare("DELETE FROM live_execution_attempts").run();
    opened({ positionAddress: null });
    dbModule.db
      .prepare("UPDATE live_execution_attempts SET attempted_at = datetime('now', '-2 hours')")
      .run();
    const none = settler.findAttempt(dbModule.db, dbModule.db
      .prepare("SELECT * FROM simulated_positions WHERE position_id = 'manlet'")
      .get() as Record<string, unknown>);
    assert.equal(none.attempt, null, "an attempt two hours away was matched");
  });

  it("a failed attempt on the same position is never the match", () => {
    opened({ outcome: "failed", stage: "open" });
    assert.equal(settler.findAttempt(dbModule.db, manletRow()).attempt, null);
  });

  it("plans the cost from the attempt's own before-balance, negative when the trade made SOL", () => {
    const plan = settler.planAttemptUpdate(
      { wallet_lamports_before: BEFORE, wallet_lamports_after: null, cost_lamports: null, unwind: "none" },
      AFTER,
    );
    assert.equal(plan.costLamports, BEFORE - AFTER);
    assert.ok((plan.costLamports ?? 0) < 0);
    assert.equal(plan.unwind, "clean");
    assert.equal(plan.unchanged, false);

    const again = settler.planAttemptUpdate(
      { wallet_lamports_before: BEFORE, wallet_lamports_after: AFTER, cost_lamports: BEFORE - AFTER, unwind: "clean" },
      AFTER,
    );
    assert.equal(again.unchanged, true, "a re-run would rewrite an identical row");

    const noBefore = settler.planAttemptUpdate(
      { wallet_lamports_before: null, wallet_lamports_after: null, cost_lamports: null, unwind: "none" },
      AFTER,
    );
    assert.equal(noBefore.costLamports, null, "an unmeasured cost was written as a number");
  });
});

describe("operator settler — the script end to end", () => {
  async function runScript(args: string[]) {
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync(
      process.execPath,
      ["scripts/settleResidualByHand.cjs", "--db", DB_PATH, ...args],
      { encoding: "utf8", timeout: 60_000 },
    );
    return `${run.stdout}${run.stderr}`;
  }

  function closeManlet() {
    repos.closePosition({
      positionId: "manlet",
      status: "CLOSED_PROFIT",
      exitPrice: 1,
      realizedPnlUsd: 9.49,
      realizedPnlPct: 5.29,
      unclaimedFeeUsd: 0,
      impermanentLossUsd: 0,
      positionValueChangeUsd: 0,
      closeReason: "t",
      closeSignature: "close",
      walletLamportsAfter: 1_700_338_862,
    });
    dbModule.db.prepare("UPDATE simulated_positions SET wallet_lamports_before = ?").run(BEFORE);
  }

  it("dry run shows BOTH tables and writes neither; --execute writes both; a re-run changes nothing", async () => {
    opened();
    manletRow();
    closeManlet();

    const dry = await runScript(["--id", String((dbModule.db.prepare("SELECT id FROM simulated_positions").get() as { id: number }).id), "--after-lamports", String(AFTER)]);
    assert.match(dry, /simulated_positions/);
    assert.match(dry, /live_execution_attempts \d+ \(matched by position_address\)/);
    assert.match(dry, /DRY RUN/);
    const untouched = dbModule.db.prepare("SELECT * FROM live_execution_attempts").get() as Record<string, unknown>;
    assert.equal(untouched.wallet_lamports_after, null, "the dry run wrote");

    const id = String((dbModule.db.prepare("SELECT id FROM simulated_positions").get() as { id: number }).id);
    const wet = await runScript(["--id", id, "--after-lamports", String(AFTER), "--execute"]);
    assert.match(wet, /WRITTEN: simulated_positions 1 row\(s\), live_execution_attempts 1 row\(s\)/);
    const attempt = dbModule.db.prepare("SELECT * FROM live_execution_attempts").get() as Record<string, unknown>;
    assert.equal(attempt.wallet_lamports_after, AFTER);
    assert.equal(attempt.cost_lamports, BEFORE - AFTER);
    assert.equal(attempt.unwind, "clean");

    const rerun = await runScript(["--id", id, "--after-lamports", String(AFTER), "--execute"]);
    assert.match(rerun, /live_execution_attempts 0 row\(s\)/);
    assert.match(rerun, /unchanged/);
  });

  it("with no confident match it says so and writes only the position row", async () => {
    manletRow(null);
    closeManlet();
    const id = String((dbModule.db.prepare("SELECT id FROM simulated_positions").get() as { id: number }).id);
    const out = await runScript(["--id", id, "--after-lamports", String(AFTER), "--execute"]);
    assert.match(out, /NO CONFIDENT MATCH/);
    assert.match(out, /live_execution_attempts 0 row\(s\)/);
  });
});

describe("engine — a settled close completes its opened attempt", () => {
  it("fills after, cost and unwind once, and never touches a failed row", () => {
    opened();
    opened({ outcome: "failed", stage: "open", walletLamportsAfter: BEFORE - 1_000_000 });

    assert.equal(repos.settleOpenedLiveAttempt(POSITION, AFTER), 1);
    const rows = dbModule.db
      .prepare("SELECT outcome, wallet_lamports_after, cost_lamports, unwind FROM live_execution_attempts ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows[0], {
      outcome: "opened",
      wallet_lamports_after: AFTER,
      cost_lamports: BEFORE - AFTER,
      unwind: "clean",
    });
    assert.equal(rows[1]?.cost_lamports, 1_000_000, "a failed attempt's cost was rewritten");

    // Idempotent: a filled row is never overwritten.
    assert.equal(repos.settleOpenedLiveAttempt(POSITION, AFTER + 5), 0);
  });

  it("settleLiveCloses writes it only with a SETTLED after-balance, after the position row", () => {
    const agent = readFileSync("src/agents/dlmmTraderAgent.ts", "utf8");
    const close = agent.indexOf("ataCloseSignature: tokenAccount.signature,");
    const settle = agent.indexOf("settleOpenedLiveAttempt(row.position_address, walletLamportsAfter)");
    assert.ok(close > 0 && settle > close, "the attempt row is not settled after the position row");
    const guard = agent.slice(agent.lastIndexOf("if (", settle), settle);
    assert.match(guard, /walletLamportsAfter !== null/);
  });
});
