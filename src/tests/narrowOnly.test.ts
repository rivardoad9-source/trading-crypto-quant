/**
 * What `LIVE_MAX_POSITION_BINS=70` actually does to the rest of the engine.
 *
 * The cap is the interim breaker after the wide path's three real-money failures, and it
 * is the right call. What was never designed for is its knock-on effect: the whole
 * pre-swap apparatus built in response to those failures only runs on the WIDE path, so
 * capping the engine to narrow positions turns all of it off at once.
 *
 *  - `rehearseOpenPosition` plans steps only when `binWidth > DLMM_BINS_PER_INIT`. Under
 *    the cap it always returns zero steps and always `ok: true` — the "dress rehearsal"
 *    gate simulates nothing, on every entry, while still paying its RPC round trips.
 *  - `preCreateMissingBinArrays` is gated the same way and never runs.
 *  - So the execution breaker's two FREE strike paths (rehearsal refusal, bin-array prep
 *    failure) can never fire. Only the post-swap `stage: "open"` strike remains — the
 *    expensive one the breaker exists to prevent a repeat of.
 *
 * None of that is wrong on its own. What was wrong is that the engine said the opposite:
 * a zero-step rehearsal logged "no account creation needed (all bin arrays exist)", and
 * `binArraysToCreate` was forced to 0 on the narrow path no matter how many were missing.
 * Bin-array rent is the one cost this engine can never reclaim, so the log claiming there
 * was none is the wrong thing to be wrong about.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const liveExecutionSource = read("../services/liveExecution.ts");
const executorSource = read("../services/onchainExecutor.ts");

describe("narrow-only — the narrow/wide boundary is the SDK's constant everywhere", () => {
  it("has no hand-written 70 deciding which path a position takes", () => {
    /*
     * `DLMM_BINS_PER_INIT` is asserted against the installed SDK by
     * `onchainExecutor.test.ts`; a literal 70 is invisible to that test. This file
     * decided the boundary three times and one of them was a literal — the one choosing
     * which transaction shape to charge against `ONCHAIN_MAX_LAMPORTS_PER_TX`. An SDK
     * bump would have moved the real boundary and left that line charging the wrong
     * shape, and the failure surfaces as a refusal AFTER the balancing swap, which is
     * the class of failure every gate in that function exists to move in front of the
     * spend.
     */
    assert.ok(
      !/binWidth <= 70\b/.test(liveExecutionSource),
      "the narrow/wide branch is hand-written again instead of reading DLMM_BINS_PER_INIT",
    );
    assert.match(
      liveExecutionSource,
      /binWidth <= DLMM_BINS_PER_INIT \?/,
      "the spend-ceiling branch no longer reads the SDK-bound constant",
    );
  });
});

describe("narrow-only — the rehearsal says what it did and did not check", () => {
  it("reports the bin arrays the CHAIN says are missing, on both paths", () => {
    /*
     * `binArraysToCreate: wide ? missing.length : 0` conflated "we will not create these
     * separately" with "these do not need creating". The narrow path still creates them,
     * fused into the open, at 0.0714 SOL each that never comes back.
     */
    assert.ok(
      !/binArraysToCreate: wide \? missing\.length : 0/.test(executorSource),
      "the narrow path reports zero missing bin arrays again, regardless of the chain",
    );
    assert.match(executorSource, /binArraysToCreate: missing\.length,/);
  });

  it("keeps 'nothing was simulated' separate from 'nothing needs creating'", () => {
    // One is a fact about this function, the other a fact about the chain. Collapsing
    // them is what produced the false log line.
    assert.match(executorSource, /fusedIntoOpen: !wide,/);
    assert.match(executorSource, /fusedIntoOpen: boolean;/);
  });

  it("no longer claims all bin arrays exist whenever no step ran", () => {
    assert.ok(
      !liveExecutionSource.includes("no account creation needed ` +\n        `(all bin arrays exist"),
      "the rehearsal log asserts arrays exist again when it simply did not look",
    );
    assert.match(
      liveExecutionSource,
      /NOTHING WAS REHEARSED/,
      "a rehearsal that simulated nothing no longer says so",
    );
    // And when arrays ARE missing, the line prices them, because that rent is the one
    // spend the engine cannot undo.
    assert.match(liveExecutionSource, /UNRECOVERABLE rent/);
  });
});

describe("narrow-only — the entry's unrecoverable rent is finally worth-it checked", () => {
  it("refuses an open whose bin-array rent exceeds what the trade projects to make", () => {
    /*
     * The affordability gate beside this one asks "can I afford this open" and answers
     * from the rent budget, so it passes a trade spending $7 of unrecoverable rent to
     * chase a $1.50 projected net. Both questions are legitimate; only one was asked.
     */
    assert.match(liveExecutionSource, /class UnrecoverableRentError extends LiveEntryRefusedError/);
    assert.match(liveExecutionSource, /rentUsd > projected \* liveMicroCapital\.maxRentToPnl/);
  });

  it("uses the CHAIN's array count, not a screening-time guess", () => {
    // `cost` comes from `quoteCreatePosition`, which reads the chain: zero on a pool
    // whose arrays exist. A guessed constant charged to every candidate would move the
    // binding bar from 7.50% to 29.82% fee/TVL and admit nothing at all.
    assert.match(liveExecutionSource, /cost\.binArraySol > 0/);
  });

  it("fires BEFORE the balancing swap, so a refusal costs nothing", () => {
    const rentAt = liveExecutionSource.indexOf("UnrecoverableRentError(");
    const swapAt = liveExecutionSource.indexOf("executeJupiterSwap(");
    assert.ok(rentAt > 0 && swapAt > 0, "expected both the rent gate and the swap");
    assert.ok(
      rentAt < swapAt,
      "the rent gate moved after the swap, where a refusal strands a memecoin balance",
    );
  });
});
