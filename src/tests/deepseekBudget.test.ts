/**
 * The cost ceiling on DeepSeek calls, and the screener cadence that decides how often
 * one is paid for.
 *
 * Both were tuned because deepseek-reasoner's chain-of-thought dominated the token
 * bill: a screener tick every 10 minutes, each free to double its budget to 8000 after
 * a truncated attempt. These tests pin the ceiling and the interval, because raising
 * either is invisible in behaviour and only shows up on the invoice.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DeepSeekTruncatedError,
  MAX_STRUCTURED_ATTEMPTS,
  REASONER_MAX_TOKENS,
  resolveTokenBudget,
} from "../services/deepseek.js";
import { CRON } from "../config/constants.js";

describe("deepseek token budget", () => {
  it("locks a reasoning call to REASONER_MAX_TOKENS", () => {
    assert.equal(REASONER_MAX_TOKENS, 8000);
    assert.equal(resolveTokenBudget(true, undefined), 8000);
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

describe("screener cadence", () => {
  it("runs the heavy screener every 30 minutes", () => {
    assert.equal(CRON.DLMM_LOOP, "*/30 * * * *");
  });

  it("keeps the position monitor on its own 60-second clock", () => {
    // The screener's cost is per-tick; the monitor's exit timing is not negotiable
    // against it. Slowing the screener must never slow this.
    assert.equal(CRON.FAST_MONITOR, "* * * * *");
  });
});
