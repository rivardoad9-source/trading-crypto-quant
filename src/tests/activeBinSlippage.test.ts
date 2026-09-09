/**
 * The execution-time volatility gate — the free half of the 9 Sep 2026 active-bin fix.
 *
 * The other two halves live in `onchainExecutor.test.ts`, because they are the
 * executor's: the deposit's active-bin tolerance getting its own bound, and a funding
 * rebuild carrying a fresh active bin. This file is the third — a pool that moves
 * faster than any tolerance worth sending is refused BEFORE the balancing swap, where
 * a refusal costs nothing.
 *
 * WHAT IT IS NOT. The screener already has volatility gates, and they ask a different
 * question in a different unit: is this a good place to HOLD liquidity, in percent per
 * hour. This one asks whether the pool will hold still long enough for the funding to
 * LAND, and answers in BINS — the unit the DLMM program actually rejects on
 * (`ExceededBinSlippageTolerance`, custom 6004). A pool at 15%/h clears the screener's
 * 20%/h limit and still drifts ~15 bins an hour at bin_step 100.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActiveBinRaceError, LiveEntryRefusedError } from "../services/liveExecution.js";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const liveSource = readFileSync(join(srcDir, "services/liveExecution.ts"), "utf8");

describe("execution-time volatility — the free refusal", () => {
  it("is a routine skip, not an execution-breaker strike", () => {
    /*
     * `LiveEntryRefusedError` is what `seekNewEntry` catches, so this must extend it or
     * a busy pool would page the operator. And it must NOT count towards the breaker:
     * volatility is a fact about the pool right now, not evidence the chain will always
     * reject this open, and a 24-hour bench earned by a busy half-hour is the gate
     * punishing the wrong thing.
     */
    const err = new ActiveBinRaceError("FOO-SOL", "pool", 12.5, 3, 41.2, 90);
    assert.ok(err instanceof LiveEntryRefusedError);
    assert.equal(err.name, "ActiveBinRaceError");
    assert.match(err.message, /nothing was signed or spent/i);

    // The base class takes the strike flag as its fourth argument; only the rehearsal
    // passes it. Asserted at source because the field name is private to the class.
    const ctor = liveSource.slice(
      liveSource.indexOf("export class ActiveBinRaceError"),
      liveSource.indexOf("export class OpenRehearsalFailedError"),
    );
    assert.doesNotMatch(ctor, /poolAddress,\s*\n\s*true,/);
  });

  it("converts volatility into bins with the pool's own step", () => {
    /*
     * The arithmetic the gate runs, restated: bin_step is bps, so one bin is
     * binStep/100 percent of price, and percent-per-hour divides straight into
     * bins-per-hour. A unit slip here reads as a working gate.
     */
    const projected = (rvolPctPerHour: number, binStep: number, windowSeconds: number) =>
      (rvolPctPerHour / (binStep / 100)) * (windowSeconds / 3600);

    // 20%/h — the screener's own limit — on a bin_step 100 pool is 20 bins an hour.
    assert.equal(projected(20, 100, 3600), 20);
    // Over a 90-second funding window that is half a bin: admitted against 3.
    assert.equal(Number(projected(20, 100, 90).toFixed(2)), 0.5);
    // The same 20%/h on bin_step 10 is 200 bins an hour, 5 over 90s: refused.
    assert.equal(Number(projected(20, 10, 90).toFixed(2)), 5);

    assert.match(liveSource, /const binsPerHour = rvol \/ \(poolBinStep \/ 100\)/);
    assert.match(
      liveSource,
      /projectedBins = binsPerHour \* \(env\.LIVE_EXECUTION_WINDOW_SECONDS \/ 3600\)/,
    );
  });

  it("runs BEFORE the swap and before the rehearsal, where a refusal costs nothing", () => {
    const gate = liveSource.indexOf("EXECUTION-TIME VOLATILITY");
    const rehearsal = liveSource.indexOf("const rehearsal = await rehearseOpenPosition");
    const swap = liveSource.indexOf("const { result: swap } = await executeJupiterSwap");
    assert.ok(gate > 0 && gate < rehearsal && rehearsal < swap);
  });

  it("answers 'volatility unavailable' with the engine's existing policy, not a new one", () => {
    /*
     * `VOLATILITY_ON_UNKNOWN` already decides this for the screener. A second knob
     * would let one concept hold two answers depending on which gate you asked.
     */
    assert.match(liveSource, /env\.VOLATILITY_ON_UNKNOWN === "reject"/);
  });

  it("says so when it did not run, rather than logging a pass it did not earn", () => {
    /*
     * The bin step comes from the open-cost quote, which only runs under the live
     * micro-capital profile. A gate that silently does nothing is the "all bin arrays
     * exist" log line again — a true-looking statement about a check that never
     * happened.
     */
    assert.match(liveSource, /NO BIN-DRIFT CHECK/);
    assert.match(liveSource, /skipped, not passed/);
  });
});
