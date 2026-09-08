import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessExecutionBreaker,
  describeExecutionGuard,
  isPoolDenied,
  parseDenylist,
  type ExecutionBreakerThresholds,
} from "../services/executionGuard.js";
import {
  isLivePositionBinCapActive,
  maxLivePositionBins,
} from "../services/liveExecution.js";
import { env } from "../config/env.js";
import type { PoolExecutionRecord } from "../database/repositories.js";

/**
 * The guards that answer "can the engine OPEN this pool", as opposed to the V1.1
 * anti-churn gate that answers "how did its last trades go".
 *
 * Every test here traces to 7 Sep 2026, when one pool was re-elected every 30 minutes
 * and spent real money twice while every existing gate reported it as a fine candidate.
 */

const THRESHOLDS: ExecutionBreakerThresholds = { consecutiveFailures: 2, hours: 24 };

function record(over: Partial<PoolExecutionRecord> = {}): PoolExecutionRecord {
  return {
    poolAddress: "PooL1111111111111111111111111111111111111111",
    pairName: "STONK-SOL",
    consecutiveFailures: 2,
    lastFailureAt: new Date().toISOString(),
    lastStage: "rehearsal/init bin array 1/2",
    lastReason: "exceeded CUs meter",
    totalFailures: 2,
    lastSuccessAt: null,
    ...over,
  };
}

describe("execution guard - operator denylist", () => {
  it("parses a comma-separated list, trimming and lower-casing", () => {
    assert.deepEqual(parseDenylist(" Abc , STONK-SOL ,xyz "), ["abc", "stonk-sol", "xyz"]);
  });

  it("treats unset, empty and all-whitespace alike, and drops empty entries", () => {
    for (const raw of [undefined, null, "", "   ", ",,,", " , , "]) {
      assert.deepEqual(parseDenylist(raw), [], `input ${JSON.stringify(raw)}`);
    }
  });

  it("de-duplicates, so the boot line counts pools and not keystrokes", () => {
    assert.deepEqual(parseDenylist("a,A, a ,b"), ["a", "b"]);
  });

  it("drops .env.example placeholders PER ENTRY, keeping real addresses beside them", () => {
    /*
     * The check cannot live in the Zod schema the way `optionalString` does, because
     * this setting is a LIST: one real address beside one copied `<pool-address>` must
     * keep the real one. None of these shapes can collide with a Solana address, which
     * is base58 and contains no underscore or angle bracket.
     */
    const real = "zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX";
    assert.deepEqual(parseDenylist(`<pool-address>, ${real} , changeme`), [real.toLowerCase()]);
    assert.deepEqual(parseDenylist("your_pool_here,TODO,xxxx,pool_address"), []);
  });

  it("never matches anything when the list is empty", () => {
    /*
     * The failure this guards against: an empty entry surviving the parse would match
     * a pool whose pair name resolved to "", silently benching it. A denylist that
     * blocks something nobody named is as bad as one that blocks nothing.
     */
    assert.equal(isPoolDenied([], "any-pool", "ANY-PAIR"), false);
    assert.equal(isPoolDenied(parseDenylist(",, ,"), "", ""), false);
  });

  it("matches on address or pair name, case-insensitively", () => {
    const list = parseDenylist("zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX");
    assert.equal(
      isPoolDenied(list, "ZXTPI4BTAWX3MGDAPOEZKMD1HXX8CDECFRQXMWVSCLX", "STONK-SOL"),
      true,
    );
    assert.equal(isPoolDenied(list, "some-other-pool", "STONK-SOL"), false);

    const byName = parseDenylist("stonk-sol");
    assert.equal(isPoolDenied(byName, "some-other-pool", "STONK-SOL"), true);
  });
});

describe("execution guard - failure breaker", () => {
  it("does not block a pool with no execution history", () => {
    assert.equal(assessExecutionBreaker(undefined, new Date(), THRESHOLDS).blocked, false);
  });

  it("does not block below the failure limit", () => {
    const verdict = assessExecutionBreaker(
      record({ consecutiveFailures: 1 }),
      new Date(),
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, false);
  });

  it("blocks at the limit and names the stage and reason", () => {
    const verdict = assessExecutionBreaker(record(), new Date(), THRESHOLDS);
    assert.equal(verdict.blocked, true);
    assert.ok(verdict.hoursRemaining > 23 && verdict.hoursRemaining <= 24);
    assert.match(verdict.reason ?? "", /rehearsal refusals/);
    assert.match(verdict.reason ?? "", /exceeded CUs meter/);
  });

  it("benches after ONE failure that already spent — the 7 Sep case", () => {
    /*
     * The founding case, and the one the first version of this gate MISSED. On
     * 7 Sep 2026 a single pool cost money exactly TWICE. At a flat limit of two, the
     * first loss does not bench, so the second loss still happens and the gate only
     * prevents a third — which is not what it was built for.
     *
     * A post-swap failure means the balancing swap confirmed and the SOL is gone. That
     * is not a data point waiting for confirmation; it is the outcome being prevented.
     */
    const verdict = assessExecutionBreaker(
      record({ consecutiveFailures: 1, lastStage: "open", lastReason: "exceeded CUs meter" }),
      new Date(),
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, true, "one post-swap failure must bench the pool");
    assert.match(verdict.reason ?? "", /AFTER the balancing swap spent/);
  });

  it("still spends the full count on FREE rehearsal refusals", () => {
    /*
     * The asymmetry is the point. A rehearsal refusal costs nothing, and one cluster
     * refusal can be transient state rather than a broken pool, so it is worth a second
     * look before writing the pool off for a day.
     */
    const once = assessExecutionBreaker(
      record({ consecutiveFailures: 1, lastStage: "rehearsal/init bin array 1/2" }),
      new Date(),
      THRESHOLDS,
    );
    assert.equal(once.blocked, false, "one free refusal must not bench");

    const twice = assessExecutionBreaker(
      record({ consecutiveFailures: 2, lastStage: "rehearsal/init bin array 1/2" }),
      new Date(),
      THRESHOLDS,
    );
    assert.equal(twice.blocked, true);
  });

  it("treats an UNRECOGNISED stage as the expensive one", () => {
    /*
     * Fail towards over-benching. An unknown failure is likelier to be a new post-swap
     * path than a new free one, and the cost of benching a good pool for a day is a
     * missed entry — against a repeated loss on the other side.
     */
    for (const stage of [null, "", "unknown", "fund", "swap"]) {
      const verdict = assessExecutionBreaker(
        record({ consecutiveFailures: 1, lastStage: stage }),
        new Date(),
        THRESHOLDS,
      );
      assert.equal(verdict.blocked, true, `stage ${JSON.stringify(stage)} must bench on one`);
    }
  });

  it("releases the bench once the window has passed", () => {
    const failedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const verdict = assessExecutionBreaker(
      record({ lastFailureAt: failedAt }),
      new Date(),
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, false);
  });

  it("reads a zone-less SQLite timestamp as UTC, not as local time", () => {
    /*
     * `CURRENT_TIMESTAMP` writes "YYYY-MM-DD HH:MM:SS" with no zone marker, which
     * `new Date()` reads as LOCAL time - seven hours out on the Asia/Jakarta box this
     * runs on. A bench set 20 hours ago would read as 13 hours ago, and the pool would
     * come back seven hours late or early depending on the sign. The gate shares
     * `parseDbTimestamp` with the cooldown so the two cannot drift on the reading.
     */
    const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    const verdict = assessExecutionBreaker(
      record({ lastFailureAt: twentyHoursAgo }),
      new Date(),
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, true);
    assert.ok(
      verdict.hoursRemaining > 3.5 && verdict.hoursRemaining < 4.5,
      `expected ~4h remaining, got ${verdict.hoursRemaining} - the timestamp was read in the wrong zone`,
    );
  });

  it("FAILS OPEN on an unparseable timestamp, unlike the capital-protecting gates", () => {
    /*
     * Deliberately the opposite of `screenTokenSafety`. This gate protects returns and
     * gas; the capital itself is protected by the anti-rug screen, the spend ceiling
     * and the pre-swap rehearsal, all of which fail closed. A broken clock must not be
     * able to freeze the whole engine - the same reasoning `assessPoolCooldown` uses.
     */
    for (const bad of [null, "", "   ", "not-a-date"]) {
      const verdict = assessExecutionBreaker(
        record({ lastFailureAt: bad }),
        new Date(),
        THRESHOLDS,
      );
      assert.equal(
        verdict.blocked,
        false,
        `timestamp ${JSON.stringify(bad)} must not bench the pool forever`,
      );
    }
  });

  it("treats a zero in either threshold as DISABLED, never as 'block immediately'", () => {
    /*
     * The trap CLAUDE.md documents for POOL_COOLDOWN_HOURS=0: a zero is not a neutral
     * value. Read as a limit, "0 consecutive failures" would bench every pool that has
     * ever been touched.
     */
    for (const thresholds of [
      { consecutiveFailures: 0, hours: 24 },
      { consecutiveFailures: 2, hours: 0 },
      { consecutiveFailures: 0, hours: 0 },
    ]) {
      const verdict = assessExecutionBreaker(
        record({ consecutiveFailures: 99 }),
        new Date(),
        thresholds,
      );
      assert.equal(verdict.blocked, false, `thresholds ${JSON.stringify(thresholds)}`);
    }
  });
});

describe("execution guard - stays out of the V1.1 anti-churn gate", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC = resolve(HERE, "..");

  it("never redeclares a V1.1 guardrail", () => {
    /*
     * Same rule `liveConfig.test.ts` enforces, for the same reason: two copies of a
     * guardrail means "V1.1" names two different configurations depending on which one
     * a call site read. The execution breaker has its OWN thresholds precisely so it
     * cannot be mistaken for the cooldown/lockout it sits beside.
     */
    const text = readFileSync(join(SRC, "services/executionGuard.ts"), "utf8");
    for (const guardrail of [
      "POOL_COOLDOWN_HOURS",
      "POOL_LOCKOUT_CONSECUTIVE_FAILURES",
      "POOL_LOCKOUT_HOURS",
      "MIN_FEE_COST_COVERAGE",
      "REASONER_MAX_TOKENS",
    ]) {
      assert.ok(
        !text.includes(`env.${guardrail}`),
        `executionGuard.ts reads ${guardrail}: the execution breaker must not share a ` +
          `knob with the V1.1 anti-churn gate`,
      );
    }
  });

  it("keeps the execution breaker out of assessPoolCooldown's inputs", () => {
    /*
     * `PoolExitRecord` is reconstructed from CLOSED POSITION ROWS. A failed open writes
     * no row, which is why the breaker exists at all - but it also means the two must
     * stay separate data paths. If meteora.ts ever read the execution history, the V1.1
     * lockout's meaning would change silently and its baseline test would still pass,
     * because none of the six numbers would have moved.
     */
    const meteora = readFileSync(join(SRC, "services/meteora.ts"), "utf8");
    assert.ok(!meteora.includes("PoolExecutionRecord"));
    assert.ok(!meteora.includes("assessExecutionBreaker"));
    assert.ok(!meteora.includes("pool_execution_failures"));
  });

  it("is consulted only behind isLiveExecutionActive, so paper mode is unchanged", () => {
    /*
     * The inert-default discipline `defaultBacktestConfig()` and `liveConfig.ts` use.
     * A gate that filtered candidates in paper mode would silently rewrite every dry
     * run and every cached sweep result, and the comparison against the live engine
     * would quietly stop meaning anything.
     */
    const agent = readFileSync(join(SRC, "agents/dlmmTraderAgent.ts"), "utf8");
    const guardCall = agent.indexOf("assessExecutionBreaker(executionHistory");
    assert.ok(guardCall > 0, "the candidate filter is gone");

    const before = agent.slice(0, guardCall);
    const gate = before.lastIndexOf("if (isLiveExecutionActive())");
    assert.ok(
      gate > 0 && gate > before.lastIndexOf("summary.cooldownRejected ="),
      "the execution filter must sit inside an isLiveExecutionActive() block",
    );
  });
});

/*
 * The operator width cap, `LIVE_MAX_POSITION_BINS`.
 *
 * A circuit breaker on the wide (create-then-fund) execution path, added 8 Sep 2026
 * after it had never completed a live open in three real-money attempts. It is NOT a
 * V1.1 guardrail and NOT a program limit; the properties below are what keep it from
 * being mistaken for either.
 */
describe("execution guard - the operator width cap", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC = resolve(HERE, "..");

  it("defaults to the narrow-only path, which is the one with a success rate", () => {
    assert.equal(env.LIVE_MAX_POSITION_BINS, 70);
  });

  it("is checked separately from the program limit, so the log says which refused", () => {
    /*
     * The two refusals mean different things to an operator: one is a setting they can
     * change, the other is a constant they cannot. Collapsing them into a single
     * comparison is how 70 came to look like a hard maximum until 7 Sep 2026 — the
     * mistake this file exists to avoid repeating.
     */
    const text = readFileSync(join(SRC, "services/liveExecution.ts"), "utf8");
    assert.ok(
      text.includes("the DLMM one-position maximum of"),
      "the program-limit refusal must keep naming the program",
    );
    assert.ok(
      text.includes("the operator cap LIVE_MAX_POSITION_BINS="),
      "the operator-cap refusal must name the setting an operator can change",
    );
  });

  it("never widens past the program limit, however it is configured", () => {
    /*
     * `maxLivePositionBins` mins against the program constant, so even a misconfigured
     * value above 1400 cannot make the engine attempt a position the chain rejects.
     * `env.ts` refuses such a value at boot as well; this is the second line.
     */
    assert.ok(maxLivePositionBins() <= 1400);
    assert.equal(maxLivePositionBins(), Math.min(env.LIVE_MAX_POSITION_BINS, 1400));
  });

  it("reports itself inert only when it is not stricter than the program limit", () => {
    // At the default of 70 it is doing real work and must say so.
    assert.equal(isLivePositionBinCapActive(), env.LIVE_MAX_POSITION_BINS < 1400);
    assert.equal(isLivePositionBinCapActive(), true);
  });

  it("is announced at boot, because that line is the authority on what is armed", () => {
    const line = describeExecutionGuard();
    assert.match(line, /live width cap: 70 bins \(NARROW ONLY/);
  });

  it("filters candidates only while live execution is active", () => {
    /*
     * INERT IN PAPER MODE, the same discipline `defaultBacktestConfig()` and the
     * execution breaker follow. The cap's candidate filter sits inside the
     * `isLiveExecutionActive()` block in `seekNewEntry`, so a dry run's candidate list
     * is byte-identical to what it was before the cap existed. A live-only rule that
     * leaked into paper mode would silently rewrite every dry run.
     */
    const text = readFileSync(join(SRC, "agents/dlmmTraderAgent.ts"), "utf8");
    const liveBlock = text.indexOf("if (isLiveExecutionActive()) {");
    const capFilter = text.indexOf("if (isLivePositionBinCapActive()) {");
    assert.ok(liveBlock > -1 && capFilter > liveBlock, "the cap filter must sit inside the live block");

    // And the only other reader is the live path itself, never the screener.
    const meteora = readFileSync(join(SRC, "services/meteora.ts"), "utf8");
    assert.ok(
      !meteora.includes("LIVE_MAX_POSITION_BINS"),
      "the screener must not read the live width cap: screening is shared with paper mode",
    );
  });

  it("is not a V1.1 guardrail and must not be counted as one", () => {
    /*
     * Stated as a test so the claim is checked rather than asserted in a comment. The
     * six V1.1 values are fixed by `v11Baseline.test.ts`; this is an execution-path
     * setting that sits beside them, exactly as the execution breaker's thresholds do.
     */
    const baseline = readFileSync(join(SRC, "tests/v11Baseline.test.ts"), "utf8");
    assert.ok(
      !baseline.includes("LIVE_MAX_POSITION_BINS"),
      "LIVE_MAX_POSITION_BINS must not be pinned as part of the V1.1 baseline",
    );
  });
});
