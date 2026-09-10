/**
 * The entry funnel's REPORTING, which had no test at all and was wrong.
 *
 * Nothing here checks whether the engine trades well. It checks that the record of why
 * it did not trade describes something that could have happened. The bug this suite
 * exists for produced lines like:
 *
 *     scanned 600 -> candidates 4 -> cooldown -0 -> exec-guard -26
 *
 * — a funnel losing 26 of 4. Every count in it was correct; `candidates` is the
 * survivor total from AFTER both gates and was printed in the slot before them. Read
 * months later that is indistinguishable from corrupt data, and it sends the reader
 * after a bug that is not there. A diagnostic that cannot be trusted is worse than none,
 * because it is still believed.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-funnel-"));
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

/** The 7-8 Sep shape: 30 screened, 26 refused by the operator's width cap, 4 left. */
const hermesCycle = {
  scanned: 600,
  screenRejections: { lowTvl: 412, highTvl: 9, lowFeeRatio: 149 },
  screenerCandidates: 30,
  heldExcluded: 0,
  candidates: 4,
  cooldownRejected: 0,
  executionRejected: 26,
  execDenylistRejected: 0,
  execBreakerRejected: 0,
  execBinCapRejected: 26,
  execNoWsolRejected: 0,
  execTokenBenchRejected: 0,
  antirugPassed: 0,
  antirugRejected: 4,
  volatilityRejected: 0,
  coverageRejected: 0,
  microRejected: 0,
  reachedDecision: false,
  opened: false,
  skipReason: "all 4 candidates failed the anti-rug screen",
  positionsChecked: 0,
  positionsClosed: 0,
  durationMs: 4210,
};

describe("entry funnel — the stages have to add up", () => {
  it("records and reads back a cycle whose narrowing reconciles", () => {
    repos.recordScanFunnel(hermesCycle);

    const [row] = repos.getScanFunnel(1);
    assert.ok(row, "the cycle was not stored");

    /*
     * THE INVARIANT THE OLD SHAPE COULD NOT EXPRESS.
     *
     * `candidates` is what is left after every local gate, so it must equal the
     * screener's output minus what each gate took. When this failed to hold there was
     * no way to notice, because the row had nowhere to record the screener's output in
     * the first place — `candidates` was doing both jobs.
     */
    assert.equal(
      row.candidates,
      (row.screenerCandidates ?? 0) -
        row.heldExcluded -
        row.cooldownRejected -
        row.executionRejected,
      "the funnel loses more pools than it ever had",
    );
  });

  it("splits the execution refusals by gate, and they sum to the total", () => {
    const [row] = repos.getScanFunnel(1);
    assert.ok(row);
    assert.equal(
      row.execDenylistRejected +
        row.execBreakerRejected +
        row.execBinCapRejected +
        row.execNoWsolRejected +
        row.execTokenBenchRejected,
      row.executionRejected,
      "the per-gate counts disagree with the total",
    );
    /*
     * The distinction is the point, not the arithmetic. A denylist entry and a benched
     * pool are facts about a POOL; the bin cap is the operator's own setting refusing
     * most of the universe on purpose while the wide path is unvalidated. One column
     * cannot answer both "is something broken" and "what is my cap costing me".
     */
    assert.equal(row.execBinCapRejected, 26);
    assert.equal(row.execBreakerRejected, 0);
  });

  it("counts a SIBLING-token bench apart from this pool's own bench", () => {
    /*
     * Added 10 Sep 2026 with token-level bench propagation. `execBreakerRejected` says
     * THIS pool failed; `execTokenBenchRejected` says a pool with a clean record of its
     * own was held out because a SIBLING pool of the same token failed. Folding the
     * second into the first would leave an operator unable to tell a broken pool from a
     * broken token, and — because the sum above must still hold — a new gate that did
     * not get its own column would silently make the row unreconcilable.
     */
    repos.recordScanFunnel({
      ...hermesCycle,
      candidates: 2,
      executionRejected: 28,
      execBinCapRejected: 26,
      execTokenBenchRejected: 2,
    });

    const [row] = repos.getScanFunnel(1);
    assert.ok(row);
    assert.equal(row.execTokenBenchRejected, 2);
    assert.equal(row.execBreakerRejected, 0, "a sibling bench is not this pool's bench");
    assert.equal(
      row.execDenylistRejected +
        row.execBreakerRejected +
        row.execBinCapRejected +
        row.execNoWsolRejected +
        row.execTokenBenchRejected,
      row.executionRejected,
      "the per-gate counts disagree with the total",
    );
  });

  it("keeps an unmeasured screener null, never zero", () => {
    // A cycle that never reached the screener: paused, or already at capacity. Zero
    // would assert the screener ran and found nothing, which is a different fact — the
    // same rule `scanned` and `est_gas_cost_usd` follow.
    repos.recordScanFunnel({
      ...hermesCycle,
      scanned: null,
      screenRejections: {},
      screenerCandidates: null,
      heldExcluded: 0,
      candidates: 0,
      executionRejected: 0,
      execBinCapRejected: 0,
      skipReason: "at capacity",
    });

    const [row] = repos.getScanFunnel(1);
    assert.ok(row);
    assert.equal(row.scanned, null);
    assert.equal(row.screenerCandidates, null, "an unmeasured screen was recorded as zero");
  });

  it("counts execution refusals per gate, defaulting every kind to zero", () => {
    const counted = agent.countExecutionBlocks([
      { kind: "binCap" as const },
      { kind: "binCap" as const },
      { kind: "breaker" as const },
      { kind: "noWsol" as const },
    ]);
    assert.deepEqual(counted, {
      denylist: 0,
      breaker: 1,
      // A SIBLING pool of the same token being benched is counted apart from this
      // pool's own bench: the two lead to different actions, so one bucket for both
      // could answer neither.
      tokenBench: 0,
      noWsol: 1,
      binCap: 2,
    });

    // Empty input still names every gate: a missing key would render as "undefined" in
    // the log line rather than as the zero it is.
    assert.deepEqual(agent.countExecutionBlocks([]), {
      denylist: 0,
      breaker: 0,
      tokenBench: 0,
      noWsol: 0,
      binCap: 0,
    });
  });
});

describe("entry funnel — the log line reads in the order the gates run", () => {
  it("prints candidates AFTER the gates that produce it", async () => {
    /*
     * Asserted against the source rather than by capturing stdout: `recordFunnel` is
     * private to the agent module and reaching it needs a whole cycle, network included.
     * The defect was purely one of ORDER in a template literal, so order in the source
     * is exactly the right thing to pin.
     */
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../agents/dlmmTraderAgent.ts", import.meta.url)),
      "utf8",
    );

    const line = src.slice(src.indexOf("`[funnel] scanned "));
    const at = (needle: string) => line.indexOf(needle);

    assert.ok(at("screened ${entry.screenerCandidates}") > 0, "the screener stage is not printed");
    assert.ok(
      at("cooldown -") < at("candidates ${entry.candidates}"),
      "candidates is still printed before the cooldown gate that narrows it",
    );
    assert.ok(
      at("exec-guard -") < at("candidates ${entry.candidates}"),
      "candidates is still printed before the execution gate that narrows it",
    );
  });
});
