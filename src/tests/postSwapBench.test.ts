/**
 * The bench, after 11 Sep 2026: how long a POST-SWAP failure holds, and whether it
 * holds the TOKEN or only one pool address.
 *
 * Two facts from that night drive everything here. First, three attempts on one token
 * burned 0.0639 SOL inside thirty minutes — a bench measured against a window sized for
 * refused SIMULATIONS is the wrong shape of answer for a failure measured in spent
 * capital. Second, the token-level bench was fully implemented, fully tested and
 * propagating NOTHING, because every stored row carried a NULL `token_mint`: rows
 * written before the column existed keep their NULL until the pool fails AGAIN, which
 * is the exact event the bench exists to prevent.
 *
 * So the mint cannot only be learned from failures. `learnPoolExecutionToken` backfills
 * it on the way IN, the first time the engine resolves a pair, and
 * `describeUnkeyedBenches` says out loud how many benches are still narrower than they
 * read. A gate that silently does nothing is the "all bin arrays exist" line again.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-bench-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Repos = typeof import("../database/repositories.js");
type Db = typeof import("../database/db.js");
type Guard = typeof import("../services/executionGuard.js");
type ExecRecord = import("../database/repositories.js").PoolExecutionRecord;

let repos: Repos;
let dbModule: Db;
let guard: Guard;

const KNOTS = "8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS";
const OTHER = "So22222222222222222222222222222222222222222";

/** 2 pre-swap refusals -> 24h; ONE post-swap failure -> 168h. The shipped defaults. */
const THRESHOLDS = { consecutiveFailures: 2, hours: 24, postSwapHours: 168 };

before(async () => {
  dbModule = await import("../database/db.js");
  repos = await import("../database/repositories.js");
  guard = await import("../services/executionGuard.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

function record(over: Partial<ExecRecord> = {}): ExecRecord {
  return {
    poolAddress: "PoolA",
    pairName: "KNOTS-SOL",
    consecutiveFailures: 1,
    lastFailureAt: "2026-09-11 02:31:19",
    lastStage: "open",
    lastReason: "TransferChecked: insufficient funds",
    totalFailures: 1,
    lastSuccessAt: null,
    tokenMint: KNOTS,
    ...over,
  };
}

describe("the post-swap bench window", () => {
  /*
   * The incident's own arithmetic: three attempts at 02:0x, 02:1x and 02:31. Under the
   * OLD single 24h window the pool would have been free again 24 hours later; under the
   * post-swap window it is held for a week. The point of the test is the SEPARATION —
   * a spent failure is not measured against the free failure's clock.
   */
  it("holds a post-swap failure for postSwapHours, not for hours", () => {
    const now = new Date("2026-09-12T02:31:19Z"); // 24h later exactly
    const v = guard.assessExecutionBreaker(record(), now, THRESHOLDS);
    assert.equal(v.blocked, true, "24h after a post-swap failure the pool is still benched");
    assert.match(v.reason ?? "", /of 168h/);
  });

  it("releases it once postSwapHours have passed", () => {
    const v = guard.assessExecutionBreaker(record(), new Date("2026-09-18T03:00:00Z"), THRESHOLDS);
    assert.equal(v.blocked, false);
  });

  it("leaves the PRE-SWAP window alone — a refused rehearsal still clears in hours", () => {
    const rehearsal = record({ lastStage: "rehearsal/create", consecutiveFailures: 2 });
    const stillHeld = guard.assessExecutionBreaker(
      rehearsal,
      new Date("2026-09-11T20:00:00Z"),
      THRESHOLDS,
    );
    assert.equal(stillHeld.blocked, true);
    assert.match(stillHeld.reason ?? "", /of 24h/);

    const released = guard.assessExecutionBreaker(
      rehearsal,
      new Date("2026-09-12T03:00:00Z"),
      THRESHOLDS,
    );
    assert.equal(released.blocked, false);
  });

  /*
   * Omission must not turn the EXPENSIVE case into the shortest bench in the system.
   * A caller built by hand, or a threshold object from before this field existed, falls
   * back to `hours` — never to zero.
   */
  it("falls back to hours when postSwapHours is absent, never to zero", () => {
    const v = guard.assessExecutionBreaker(record(), new Date("2026-09-11T10:00:00Z"), {
      consecutiveFailures: 2,
      hours: 24,
    });
    assert.equal(v.blocked, true);
    assert.equal(guard.postSwapWindow({ consecutiveFailures: 2, hours: 24 }), 24);
  });

  it("never returns a post-swap window shorter than the ordinary one", () => {
    assert.equal(guard.postSwapWindow({ consecutiveFailures: 2, hours: 48, postSwapHours: 24 }), 48);
  });
});

describe("a NULL token_mint must not read as a cleared bench", () => {
  it("still benches its OWN pool", () => {
    const v = guard.assessExecutionBreaker(
      record({ tokenMint: null }),
      new Date("2026-09-11T10:00:00Z"),
      THRESHOLDS,
    );
    assert.equal(v.blocked, true);
  });

  it("propagates to no sibling — and is REPORTED rather than silently skipped", () => {
    const index = guard.indexExecutionHistory([record({ tokenMint: null })]);
    assert.equal(index.byToken.size, 0);
    assert.equal(index.unkeyed.length, 1);

    const line = guard.describeUnkeyedBenches(index);
    assert.ok(line, "an unkeyed bench must produce a warning line");
    assert.match(line ?? "", /NO token mint/);
    assert.match(line ?? "", /KNOTS-SOL/);
    assert.match(line ?? "", /sibling pool of the same token is NOT blocked/);
  });

  it("a CLEARED record with no token is not counted — no bench, nothing to warn about", () => {
    const index = guard.indexExecutionHistory([record({ tokenMint: null, consecutiveFailures: 0 })]);
    assert.equal(index.unkeyed.length, 0);
    assert.equal(guard.describeUnkeyedBenches(index), null);
  });

  it("says nothing when every bench carries a token", () => {
    const index = guard.indexExecutionHistory([record()]);
    assert.equal(index.unkeyed.length, 0);
    assert.equal(guard.describeUnkeyedBenches(index), null);
  });
});

describe("learnPoolExecutionToken — the backfill that makes the token bench real", () => {
  it("teaches an existing NULL row its mint, and the sibling bench then works", () => {
    repos.recordPoolExecutionFailure({
      poolAddress: "PoolBackfill",
      pairName: "KNOTS-SOL",
      stage: "open",
      reason: "insufficient funds",
      // The 11 Sep shape: written with no token, exactly as the six stored rows were.
      tokenMint: null,
    });

    const beforeIndex = guard.indexExecutionHistory(repos.getPoolExecutionRecords());
    assert.equal(
      (beforeIndex.byToken.get(KNOTS) ?? []).some((r) => r.poolAddress === "PoolBackfill"),
      false,
      "no propagation before the backfill",
    );

    repos.learnPoolExecutionToken("PoolBackfill", KNOTS);

    const afterIndex = guard.indexExecutionHistory(repos.getPoolExecutionRecords());
    const siblings = (afterIndex.byToken.get(KNOTS) ?? []).filter(
      (r) => r.poolAddress === "PoolBackfill",
    );
    assert.equal(siblings.length, 1);

    // A different address, same token. This is the 9 Sep OTC-SOL gap.
    const verdict = guard.assessTokenBench(siblings, "PoolSibling", new Date(), THRESHOLDS);
    assert.equal(verdict.blocked, true);
    assert.match(verdict.reason ?? "", /SIBLING pool of the same token/);
  });

  it("never OVERWRITES a key already learned", () => {
    repos.recordPoolExecutionFailure({
      poolAddress: "PoolKeyed",
      pairName: "KNOTS-SOL",
      stage: "open",
      reason: "x",
      tokenMint: KNOTS,
    });
    repos.learnPoolExecutionToken("PoolKeyed", OTHER);
    assert.equal(repos.getPoolExecutionRecord("PoolKeyed")?.tokenMint, KNOTS);
  });

  /*
   * A pool with no history stays with no history. Creating a zero-failure row here
   * would put every pool the engine has ever resolved into the breaker's table and make
   * "has this pool ever failed" unanswerable from its own storage.
   */
  it("never CREATES a row for a pool that has no history", () => {
    repos.learnPoolExecutionToken("PoolNeverSeen", KNOTS);
    assert.equal(repos.getPoolExecutionRecord("PoolNeverSeen"), undefined);
  });
});
