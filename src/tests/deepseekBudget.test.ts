/**
 * The cost ceiling on DeepSeek calls, and the screener cadence that decides how often
 * one is paid for.
 *
 * Both were tuned because deepseek-reasoner's chain-of-thought dominated the token
 * bill: a screener tick every 10 minutes, each free to double its budget from 16000 to
 * 32000 after a truncated attempt. These tests pin the ceiling and the interval,
 * because raising either is invisible in behaviour and only shows up on the invoice.
 *
 * The floor matters as much as the ceiling here. Live measurement (commit 6a6c23b)
 * put the entry decision's CoT above 8000 tokens every cycle, so cutting this budget
 * to 8000 would truncate every decision — and truncation now skips the cycle instead
 * of retrying bigger, which would stop the engine trading rather than merely cost
 * more. Hence the explicit assertion that the budget is not below what was measured.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DeepSeekTruncatedError,
  MAX_STRUCTURED_ATTEMPTS,
  REASONER_MAX_TOKENS,
  firstChoiceOrThrow,
  resolveTokenBudget,
} from "../services/deepseek.js";
import { CRON, DLMM_BASE_CADENCE_MIN } from "../config/constants.js";

describe("deepseek token budget", () => {
  it("locks a reasoning call to REASONER_MAX_TOKENS", () => {
    assert.equal(REASONER_MAX_TOKENS, 16_000);
    assert.equal(resolveTokenBudget(true, undefined), 16_000);
  });

  it("keeps the budget above the chain-of-thought length measured live", () => {
    // 2026-08-30: the entry decision's CoT exceeded 8000 tokens on every cycle. At or
    // below that, every decision truncates and every cycle is skipped.
    assert.ok(
      REASONER_MAX_TOKENS > 8000,
      `budget ${REASONER_MAX_TOKENS} is at or below the measured CoT length; ` +
        `entry decisions would truncate on every cycle`,
    );
  });

  it("refuses to let a caller ask for more than the cap", () => {
    assert.equal(resolveTokenBudget(true, 32_000), REASONER_MAX_TOKENS);
  });

  it("lets a caller ask for less", () => {
    assert.equal(resolveTokenBudget(true, 2000), 2000);
  });

  it("leaves non-reasoning calls on their own default", () => {
    assert.equal(resolveTokenBudget(false, undefined), 1500);
    assert.equal(resolveTokenBudget(undefined, 160), 160);
  });
});

describe("deepseek retry policy", () => {
  it("allows one retry, not an open-ended loop", () => {
    assert.equal(MAX_STRUCTURED_ATTEMPTS, 2);
  });

  it("reports truncation as its own error type so callers can skip rather than fail", () => {
    const err = new DeepSeekTruncatedError("2 attempts; empty completion");
    assert.ok(err instanceof DeepSeekTruncatedError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "DeepSeekTruncatedError");
  });
});

describe("deepseek response envelope", () => {
  /*
   * 15 Sep 2026, 02:00-04:00 WIB: five consecutive cycles aborted with
   * `TypeError: Cannot read properties of undefined (reading '0')` from deepseek.ts:200,
   * the first of them preceded by a `Premature close` transport error. Reading
   * `choices[0]` was unguarded and sat OUTSIDE the retry loop, so a malformed provider
   * envelope escaped `structuredCompletion` and killed the cycle instead of being
   * retried. These tests pin the classification: a missing choice is an ordinary Error
   * naming the model, never a TypeError.
   */

  it("returns the first choice of a normal envelope", () => {
    const choice = { finish_reason: "stop", message: { content: "{}" } };
    assert.equal(
      firstChoiceOrThrow({ choices: [choice] } as never, "deepseek-chat"),
      choice,
    );
  });

  it("throws a plain Error — not a TypeError — when the envelope carries no choices", () => {
    for (const envelope of [
      { choices: [] },
      {} as { choices?: unknown[] },
      undefined,
      null,
    ]) {
      assert.throws(
        () => firstChoiceOrThrow(envelope as never, "deepseek-reasoner"),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must be an Error the caller can classify");
          assert.equal((err as Error).name, "Error");
          assert.match((err as Error).message, /provider returned no choices/);
          assert.match((err as Error).message, /deepseek-reasoner/);
          return true;
        },
      );
    }
  });

  it("names the response keys so an error envelope is diagnosable from the log", () => {
    assert.throws(
      () => firstChoiceOrThrow({ error: { message: "insufficient balance" } } as never, "deepseek-chat"),
      /response keys: error/,
    );
  });
});

describe("screener cadence", () => {
  it("runs the heavy screener every 30 minutes", () => {
    /*
     * The cron entry is now a 5-minute TICK, and the RUN cadence it produces is still 30
     * minutes — off-cadence ticks return before the screener, the upstreams or DeepSeek,
     * so the bill is unchanged. The rule lives in services/screenerCadence.ts with its own
     * tests; what is pinned here is the cost-relevant fact: the interval did not shrink.
     */
    assert.equal(CRON.DLMM_TICK, "*/5 * * * *");
    assert.equal(DLMM_BASE_CADENCE_MIN, 30);
  });

  it("keeps the position monitor on its own 60-second clock", () => {
    // The screener's cost is per-tick; the monitor's exit timing is not negotiable
    // against it. Slowing the screener must never slow this.
    assert.equal(CRON.FAST_MONITOR, "* * * * *");
  });
});
