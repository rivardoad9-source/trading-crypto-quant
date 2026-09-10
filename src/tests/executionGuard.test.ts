import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessExecutionBreaker,
  assessTokenBench,
  benchTokenKey,
  describeExecutionGuard,
  indexExecutionHistory,
  isPoolDenied,
  parseDenylist,
  type ExecutionBreakerThresholds,
} from "../services/executionGuard.js";
import { countExecutionBlocks } from "../agents/dlmmTraderAgent.js";
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
    tokenMint: null,
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


/*
 * TOKEN-LEVEL BENCH PROPAGATION, added 10 Sep 2026.
 *
 * THE GAP, and it is proven rather than inferred. The breaker keyed on `pool_address`
 * alone — `getPoolExecutionHistory()` returns a `Map<pool_address, record>` and the
 * candidate filter asked it `.get(pool.address)` — while one token routinely has
 * several DLMM pools at different bin steps. It was observed live on 9 Sep 2026 and
 * recorded in commit `7dff605`: OTC-SOL (Muk/SOL) exists as FOUR pools, `Ekm4LYki` was
 * benched at 13:32, and `8LZK8W9P` — a sibling of the same token — was OPENED at 21:22.
 * The bench was never consulted, because it was never asked about that address. The
 * operator's same-day mitigation was to put the PAIR NAME in `POOL_DENYLIST`, which
 * `isPoolDenied` already matches across siblings; this is the automatic version.
 *
 * KEYED ON THE MINT, NOT THE PAIR NAME, and the difference matters. A pair name is
 * built from token SYMBOLS, and memecoin tickers collide constantly; a symbol-keyed
 * bench would eventually refuse an unrelated token that happened to share three
 * letters. The denylist may match on names because a human chose those names and can
 * see what they cover — an automatic gate cannot.
 *
 * THE KNOTS-SOL INCIDENT (10 Sep, 02:32 WIB) IS THE SAME MECHANISM, CONFIRMED. It was
 * first read as "a post-swap failure recorded no strike", which would have been a far
 * worse defect — the bench counter itself failing. That reading was an artifact of
 * querying a single `pool_address`. Querying by `pair_name` returns TWO rows, each with
 * `consecutive_failures 1`:
 *
 *   nBXytBBfKLhj6teXarAv8rk6WNgUFBMyybUFRkuK7ad  2026-09-09 19:02:49Z  open
 *   95NyuWzMDmWnPgLGBotT1XB2v1fQkqxhCrGLBDfxXfhn 2026-09-09 19:32:10Z  open
 *
 * Two different pools of the SAME pair. The 02:02:49 strike benched the first address
 * only, and 29 minutes later the engine spent a balancing swap on the sibling. The
 * strike was never lost; the bench simply never covered the token. That is the 7 Sep
 * repeat-loss mechanism still live, and it is what the tests below close.
 */
describe("execution guard - the bench covers the TOKEN, not one pool address", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC = resolve(HERE, "..");

  const WSOL = "So11111111111111111111111111111111111111112";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const KNOTS = "KNoTs1111111111111111111111111111111111111111";

  describe("benchTokenKey", () => {
    it("is the NON-SOL side, whichever way round the pair is", () => {
      assert.equal(benchTokenKey(WSOL, KNOTS), KNOTS);
      assert.equal(benchTokenKey(KNOTS, WSOL), KNOTS);
    });

    it("is null when neither side is wSOL", () => {
      /*
       * The live path refuses such a pool anyway — the engine funds in SOL — so there
       * is no token to key on and nothing to propagate. Null narrows the bench to the
       * pool itself; it never widens it.
       */
      assert.equal(benchTokenKey(KNOTS, USDC), null);
    });

    it("REFUSES to key on a major quote asset, and that is the anti-outage rule", () => {
      /*
       * The other side of a SOL-USDC pool is USDC. Keying a bench on it would bench
       * EVERY USDC-quoted SOL pool over one pool's bad afternoon — one fact that is
       * not about the token benching the universe a pool at a time, which is exactly
       * what `isPoolAttributable` withholds a strike to prevent for wallet-level
       * refusals. These pools keep their own per-pool bench; only propagation is
       * withheld.
       */
      assert.equal(benchTokenKey(WSOL, USDC), null);
      assert.equal(benchTokenKey(USDT, WSOL), null);
      assert.equal(benchTokenKey(WSOL, WSOL), null);
    });

    it("is null on missing or blank mints rather than keying on an empty string", () => {
      // An empty key would collide every unidentified pool into one bench.
      assert.equal(benchTokenKey(WSOL, null), null);
      assert.equal(benchTokenKey(WSOL, undefined), null);
      assert.equal(benchTokenKey(WSOL, "   "), null);
    });
  });

  describe("indexExecutionHistory", () => {
    it("builds both indexes from ONE pass, so they describe the same instant", () => {
      const a = record({ poolAddress: "PoolA", tokenMint: KNOTS });
      const b = record({ poolAddress: "PoolB", tokenMint: KNOTS });
      const idx = indexExecutionHistory([a, b]);

      assert.equal(idx.byPool.size, 2);
      assert.deepEqual(
        idx.byToken.get(KNOTS)?.map((r) => r.poolAddress),
        ["PoolA", "PoolB"],
      );
    });

    it("propagates NOTHING for a record with no token", () => {
      /*
       * Null is every row written before the column existed, and any pool whose
       * non-SOL side could not be identified. It must stay in `byPool` — the pool's own
       * bench is unaffected — and out of `byToken`, which is the fail-open direction
       * this gate takes everywhere else.
       */
      const idx = indexExecutionHistory([record({ poolAddress: "PoolA", tokenMint: null })]);

      assert.ok(idx.byPool.has("PoolA"), "the pool keeps its own bench");
      assert.equal(idx.byToken.size, 0, "an unidentified token must bench nothing else");
    });
  });

  describe("assessTokenBench", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const hoursAgo = (h: number) =>
      new Date(now.getTime() - h * 3_600_000).toISOString().replace("T", " ").slice(0, 19);

    it("does not block when the token has no history", () => {
      assert.equal(assessTokenBench(undefined, "PoolA", now, THRESHOLDS).blocked, false);
      assert.equal(assessTokenBench([], "PoolA", now, THRESHOLDS).blocked, false);
    });

    it("blocks when ANY sibling blocks, not merely the most recent one", () => {
      /*
       * THE CASE A "LATEST WINS" INDEX WOULD MISS, and the reason this iterates.
       *
       * PoolA took an EXPENSIVE post-swap strike two hours ago — one is enough to
       * bench, for 24h. PoolB then took a FREE rehearsal refusal ten minutes ago, which
       * at a limit of two does not bench anything. Picking the freshest record would
       * read PoolB, find it clear, and let a sibling straight through a bench that is
       * still 22 hours from expiring.
       */
      const expensive = record({
        poolAddress: "PoolA",
        pairName: "KNOTS-SOL",
        tokenMint: KNOTS,
        consecutiveFailures: 1,
        lastStage: "open",
        lastFailureAt: hoursAgo(2),
      });
      const fresherButHarmless = record({
        poolAddress: "PoolB",
        tokenMint: KNOTS,
        consecutiveFailures: 1,
        lastStage: "rehearsal/init bin array 1/2",
        lastFailureAt: hoursAgo(0.17),
      });

      const verdict = assessTokenBench(
        [fresherButHarmless, expensive],
        "PoolC",
        now,
        THRESHOLDS,
      );

      assert.equal(verdict.blocked, true);
      assert.ok(verdict.hoursRemaining > 21, String(verdict.hoursRemaining));
    });

    it("says a SIBLING is benched, and names it", () => {
      // The wording is the point: a pool with a clean record of its own is being held
      // out, and an operator reading "this pool is benched" would go looking for a
      // failure that never happened on it.
      const verdict = assessTokenBench(
        [
          record({
            poolAddress: "PoolAaaaaaaa",
            pairName: "KNOTS-SOL",
            tokenMint: KNOTS,
            consecutiveFailures: 1,
            lastStage: "open",
            lastFailureAt: hoursAgo(1),
          }),
        ],
        "PoolC",
        now,
        THRESHOLDS,
      );

      assert.equal(verdict.blocked, true);
      assert.match(verdict.reason ?? "", /SIBLING pool of the same token/);
      assert.match(verdict.reason ?? "", /KNOTS-SOL/);
    });

    it("EXCLUDES the pool being assessed, so the sibling wording stays true", () => {
      /*
       * The pool's own bench is assessed separately and reported separately. If this
       * counted the pool itself, every per-pool bench would ALSO be reported as a
       * sibling bench and the funnel could no longer tell the two apart.
       */
      const own = record({
        poolAddress: "PoolA",
        tokenMint: KNOTS,
        consecutiveFailures: 1,
        lastStage: "open",
        lastFailureAt: hoursAgo(1),
      });

      assert.equal(assessTokenBench([own], "PoolA", now, THRESHOLDS).blocked, false);
      assert.equal(assessTokenBench([own], "PoolB", now, THRESHOLDS).blocked, true);
    });

    it("releases the token bench once the sibling's window has passed", () => {
      const stale = record({
        poolAddress: "PoolA",
        tokenMint: KNOTS,
        consecutiveFailures: 1,
        lastStage: "open",
        lastFailureAt: hoursAgo(25),
      });

      assert.equal(assessTokenBench([stale], "PoolB", now, THRESHOLDS).blocked, false);
    });

    it("does not bench a token over a sibling that is below the FREE limit", () => {
      // A single rehearsal refusal costs nothing and may be transient cluster state.
      // Propagating it would let one bad simulation bench a whole token.
      const oneFreeRefusal = record({
        poolAddress: "PoolA",
        tokenMint: KNOTS,
        consecutiveFailures: 1,
        lastStage: "rehearsal/init bin array 1/2",
        lastFailureAt: hoursAgo(1),
      });

      assert.equal(assessTokenBench([oneFreeRefusal], "PoolB", now, THRESHOLDS).blocked, false);
    });
  });

  describe("placement and reporting", () => {
    const agent = readFileSync(join(SRC, "agents/dlmmTraderAgent.ts"), "utf8");

    it("is counted APART from this pool's own bench in the funnel", () => {
      /*
       * A gate that removes candidates and does not appear in the funnel puts the
       * funnel back in the state it was built to fix. And folding it into `breaker`
       * would leave a count that can answer neither "is this pool broken" nor "is this
       * TOKEN broken".
       */
      const counts = countExecutionBlocks([
        { kind: "breaker" },
        { kind: "tokenBench" },
        { kind: "tokenBench" },
      ]);

      assert.equal(counts.breaker, 1);
      assert.equal(counts.tokenBench, 2);
    });

    it("reports every kind, zero included, so an absent gate is a stated zero", () => {
      const counts = countExecutionBlocks([]);
      assert.deepEqual(counts, {
        denylist: 0,
        breaker: 0,
        tokenBench: 0,
        noWsol: 0,
        binCap: 0,
      });
    });

    it("is consulted by the candidate filter, after the pool's own bench", () => {
      const own = agent.indexOf("assessExecutionBreaker(executionHistory.byPool.get(pool.address))");
      const token = agent.indexOf("assessTokenBench(executionHistory.byToken.get(tokenKey)");

      assert.ok(own > 0, "the per-pool bench check is gone");
      assert.ok(token > own, "the token bench must be consulted after the pool's own");
    });

    it("is consulted only behind isLiveExecutionActive, so paper mode is unchanged", () => {
      /*
       * The same inert-default discipline the rest of this gate follows. A filter that
       * ran in paper mode would silently rewrite every dry run and every cached sweep.
       */
      const token = agent.indexOf("assessTokenBench(executionHistory.byToken.get(tokenKey)");
      assert.ok(token > 0);

      const before = agent.slice(0, token);
      const gate = before.lastIndexOf("if (isLiveExecutionActive())");
      assert.ok(
        gate > 0 && gate > before.lastIndexOf("summary.cooldownRejected ="),
        "the token-bench filter must sit inside an isLiveExecutionActive() block",
      );
    });

    it("is enforced again at execution time, before the balancing swap", () => {
      /*
       * The candidate filter is the first line; this is the second, for the window
       * between a cycle building its candidate list and acting on one. It must land
       * BEFORE the balancing swap, or the refusal costs a swap round trip instead of
       * nothing.
       */
      const bridge = readFileSync(join(SRC, "services/liveExecution.ts"), "utf8");
      const check = bridge.indexOf("new TokenBenchedError(");
      const swap = bridge.indexOf("const { result: swap } = await executeJupiterSwap(");

      assert.ok(check > 0, "openLivePosition must refuse a token-benched pool");
      assert.ok(swap > 0, "the balancing swap is gone");
      assert.ok(check < swap, "the token-bench refusal must come before the swap spends");
    });

    it("is a routine skip, not an operator page", () => {
      // Every pre-swap refusal is a `LiveEntryRefusedError` so `seekNewEntry` catches
      // the base class; a new subclass that missed it would page for a pool the engine
      // merely declined to enter.
      const bridge = readFileSync(join(SRC, "services/liveExecution.ts"), "utf8");
      assert.match(bridge, /class TokenBenchedError extends LiveEntryRefusedError/);
    });

    it("records the token on EVERY strike, from the SDK's own answer", () => {
      /*
       * A bench can only cover a token it was stored under. All three strike sites use
       * `pairedMint`, which `describePair` takes from the SDK, so the key written can
       * never drift from the key the filter looks up.
       *
       * Counted per STRIKE CALL rather than by grepping the whole file for the
       * assignment: `live_execution_attempts` also records the same mint, and a raw
       * count would then be asserting how many unrelated rows the bridge writes. This
       * asserts what the sentence above actually says.
       */
      const bridge = readFileSync(join(SRC, "services/liveExecution.ts"), "utf8");
      const strikes = [
        ...bridge.matchAll(/recordPoolExecutionFailure\(\{[\s\S]*?\n\s*\}\)/g),
      ].map((m) => m[0]);
      assert.equal(
        strikes.length,
        3,
        "rehearsal, bin-array-prep and post-swap are the three strike sites",
      );
      for (const strike of strikes) {
        assert.match(
          strike,
          /tokenMint: pairedMint\.toBase58\(\)/,
          `every strike must record the SDK's own mint:\n${strike}`,
        );
      }
    });

    /*
     * THE BACKFILL, which is what made the token-level bench real rather than merely
     * implemented. Every strike site above passed `tokenMint` from 10 Sep 2026 onward
     * and every stored row was still NULL on 11 Sep, because a row written before the
     * column existed keeps its NULL until the pool fails AGAIN — the event the bench
     * exists to prevent. The mint therefore has to be learned on the way IN.
     */
    it("backfills the mint when the pair is resolved, before the swap", () => {
      const bridge = readFileSync(join(SRC, "services/liveExecution.ts"), "utf8");
      const backfill = bridge.indexOf("learnPoolExecutionToken(params.poolAddress");
      const swap = bridge.indexOf("await executeJupiterSwap(auth, {");
      assert.ok(backfill > 0, "openLivePosition must backfill the bench token");
      assert.ok(backfill < swap, "the backfill must not depend on the entry succeeding");
    });
  });
});
