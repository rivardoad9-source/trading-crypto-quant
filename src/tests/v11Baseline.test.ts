/**
 * The V1.1 official baseline, locked.
 *
 * V1.1 is the only configuration the live engine runs. These six values ARE that
 * configuration, and every one of them is invisible in behaviour until it costs money:
 * a cooldown that silently became 0 does not throw, it just churns; a screener that
 * silently returned to 10 minutes does not throw, it just triples the DeepSeek bill.
 * Nothing else in the suite fails if one of them drifts, so this file exists to.
 *
 * Two layers, because they catch different mistakes:
 *
 *  1. The SHIPPED DEFAULT in `src/config/env.ts`. This is the stronger claim — a fresh
 *     install with no `.env` still lands on V1.1. It is asserted against the source
 *     text because the schema is not exported and `env` is parsed once at import, so
 *     there is no way to ask the module "what would you do with no configuration?".
 *     A behavioural check would only re-measure the operator's own `.env`.
 *  2. The EFFECTIVE value on this machine (`env.*`). This says the deployment actually
 *     running the tests is on the baseline, not merely capable of it.
 *
 * A zero is not a neutral value in any of these: `env.ts` accepts zero for the
 * anti-churn keys and documents that zero DISABLES the gate. Reintroducing pre-V1.1
 * behaviour therefore does not require deleting any code — it needs one config line.
 * That is the drift this file is here to catch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { liveMicroCapital } from "../config/liveConfig.js";
import { CRON } from "../config/constants.js";
import { REASONER_MAX_TOKENS, MAX_STRUCTURED_ATTEMPTS } from "../services/deepseek.js";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const envSource = read("../config/env.ts");
const agentSource = read("../agents/dlmmTraderAgent.ts");

/** Reads the literal `KEY: numeric(N)` default out of the env schema. */
function shippedDefault(key: string): number {
  const match = envSource.match(new RegExp(`\\b${key}:\\s*numeric\\(([-\\d.]+)\\)`));
  assert.ok(match, `${key} is no longer declared as numeric(<default>) in src/config/env.ts`);
  return Number(match[1]);
}

describe("V1.1 baseline — anti-churn guardrails", () => {
  it("benches a pool for 4 hours after a close", () => {
    assert.equal(shippedDefault("POOL_COOLDOWN_HOURS"), 4);
    assert.equal(env.POOL_COOLDOWN_HOURS, 4);
  });

  it("locks a pool out after 2 consecutive failures, for 24 hours", () => {
    assert.equal(shippedDefault("POOL_LOCKOUT_CONSECUTIVE_FAILURES"), 2);
    assert.equal(shippedDefault("POOL_LOCKOUT_HOURS"), 24);
    assert.equal(env.POOL_LOCKOUT_CONSECUTIVE_FAILURES, 2);
    assert.equal(env.POOL_LOCKOUT_HOURS, 24);
  });

  it("keeps every anti-churn gate armed — zero would disable it", () => {
    // env.ts accepts zero for these and says "zero disables the gate". A zero here is
    // not a tuning choice, it is pre-V1.1 behaviour restored through configuration.
    assert.ok(env.POOL_COOLDOWN_HOURS > 0, "cooldown disabled");
    assert.ok(env.POOL_LOCKOUT_CONSECUTIVE_FAILURES > 0, "lockout trigger disabled");
    assert.ok(env.POOL_LOCKOUT_HOURS > 0, "lockout duration disabled");
  });
});

describe("V1.1 baseline — breakeven friction gate", () => {
  it("requires the 24h fee estimate to cover 2.5x the round-trip cost", () => {
    assert.equal(shippedDefault("MIN_FEE_COST_COVERAGE"), 2.5);
    assert.equal(env.MIN_FEE_COST_COVERAGE, 2.5);
  });

  it("stays ON — a coverage of 1.0 or less is what let the strategy churn", () => {
    assert.ok(
      env.MIN_FEE_COST_COVERAGE > 1,
      "a pool only has to break even, not clear a margin: the friction gate is off",
    );
  });
});

describe("V1.1 baseline — clocks", () => {
  it("screens every 30 minutes", () => {
    assert.equal(CRON.DLMM_LOOP, "*/30 * * * *");
  });

  it("marks open positions every 60 seconds", () => {
    // The screener's token cost is per-tick; the monitor's exit timing is not
    // negotiable against it. Slowing the screener must never slow this.
    assert.equal(CRON.FAST_MONITOR, "* * * * *");
  });
});

describe("V1.1 baseline — DeepSeek budget", () => {
  it("caps a reasoning call at 16000 tokens", () => {
    assert.equal(REASONER_MAX_TOKENS, 16_000);
  });

  it("allows one retry, not an open-ended loop", () => {
    assert.equal(MAX_STRUCTURED_ATTEMPTS, 2);
  });

  it("skips the cycle gracefully when the chain-of-thought is truncated", () => {
    // Behaviour, not shape: seekNewEntry must catch DeepSeekTruncatedError and return
    // rather than propagate, or a truncated CoT aborts the whole trading cycle and
    // pages the operator over a known, bounded budget limit. Asserted against source
    // because reproducing it live would need a real DeepSeek call.
    assert.match(
      agentSource,
      /if \(!\(err instanceof DeepSeekTruncatedError\)\) throw err;/,
      "seekNewEntry no longer skips gracefully on a truncated completion",
    );
  });
});

describe("V1.1 baseline — no pre-V1.1 live path", () => {
  it("has no env flag that reverts the live engine to pre-V1.1 behaviour", () => {
    // The backtest harness deliberately keeps an anti-churn-off control arm
    // (`withoutAntiChurn`) for its A/B. That is measurement scaffolding and lives in
    // src/backtest — it must never gain an env switch that reaches the live engine.
    for (const forbidden of [
      "LEGACY_MODE",
      "ENGINE_V10",
      "DISABLE_ANTI_CHURN",
      "DISABLE_COOLDOWN",
      "DISABLE_LOCKOUT",
      "DISABLE_BREAKEVEN",
    ]) {
      assert.ok(
        !envSource.includes(forbidden),
        `${forbidden} would let the live engine run pre-V1.1 behaviour`,
      );
    }
  });
});

describe("V1.1 baseline — the live micro-capital profile does not touch it", () => {
  /*
   * The 1 SOL live profile adds SIZING and an extra friction layer. It is allowed to
   * make entry harder; it is not allowed to move a V1.1 guardrail. The risk is not
   * that someone edits `env.ts` — the tests above catch that — but that the live
   * profile grows its own copy of a guardrail and the two silently disagree, at which
   * point "V1.1" names two different configurations depending on a flag.
   */
  const liveSource = read("../config/liveConfig.ts");

  it("declares no cooldown, lockout, coverage or clock of its own", () => {
    for (const forbidden of [
      "POOL_COOLDOWN_HOURS",
      "POOL_LOCKOUT_CONSECUTIVE_FAILURES",
      "POOL_LOCKOUT_HOURS",
      "MIN_FEE_COST_COVERAGE",
      "REASONER_MAX_TOKENS",
      "DLMM_LOOP",
      "FAST_MONITOR",
    ]) {
      assert.ok(
        !new RegExp(`LIVE_${forbidden}|${forbidden}:\s*numeric`).test(liveSource),
        `liveConfig.ts declares its own ${forbidden}; V1.1 would then depend on a flag`,
      );
    }
  });

  it("leaves the V1.1 values untouched on this machine", () => {
    assert.equal(env.POOL_COOLDOWN_HOURS, 4);
    assert.equal(env.POOL_LOCKOUT_CONSECUTIVE_FAILURES, 2);
    assert.equal(env.POOL_LOCKOUT_HOURS, 24);
    assert.equal(env.MIN_FEE_COST_COVERAGE, 2.5);
    assert.equal(REASONER_MAX_TOKENS, 16_000);
  });

  it("keeps the micro-capital gate ADDITIVE — it never relaxes the 2.5x ratio", () => {
    // The micro gate runs only after the breakeven filter has already narrowed the
    // list, so a candidate must clear both. A refactor that made it an alternative
    // path would let a $2 net win through on 1.1x coverage.
    const agent = read("../agents/dlmmTraderAgent.ts");
    const breakevenAt = agent.indexOf("assessBreakeven({");
    const microAt = agent.indexOf("assessMicroCapitalFriction({");
    assert.ok(breakevenAt > 0 && microAt > 0, "one of the two friction gates is gone");
    assert.ok(
      breakevenAt < microAt,
      "the micro-capital gate no longer runs after the 2.5x coverage gate",
    );
  });

  it("charges the 2.5x gate the SAME gas the boot line prices it at", () => {
    /*
     * The gap this closes: `requiredFeeTvlRatioForCoverage` prices gas at the 0.008
     * SOL floor to print "coverage needs 9.00%" at boot, while the runtime call site
     * handed `assessBreakeven` the live priority fee (~$0.003). Same gate, two cost
     * bases — the enforced bar was 5.1%, not the 9.00% advertised.
     *
     * Asserted against source rather than behaviour because the expression lives
     * inside `seekNewEntry`, which needs the network, a SOL price and the LLM to
     * reach. `liveConfig.test.ts` carries the behavioural half: that a pool passes
     * the runtime gate exactly when it meets the advertised requirement.
     */
    assert.match(
      agentSource,
      /chargeEntryFrictionUsd\(liveRoundTripGasUsd, solPriceUsd\)/,
      "the coverage gate no longer charges the shared live cost basis; the bar printed " +
        "at boot and the bar enforced at runtime can now disagree again",
    );

    const gateAt = agentSource.indexOf("assessBreakeven({");
    const chargeAt = agentSource.indexOf("chargeEntryFrictionUsd(liveRoundTripGasUsd");
    assert.ok(chargeAt > 0 && chargeAt < gateAt, "the gas basis is resolved after the gate reads it");

    // Both gates must be handed the identical figure, or they drift apart again.
    assert.match(
      agentSource,
      /gasRoundTripUsd: liveRoundTripGasUsd,/,
      "the micro gate is fed a different gas estimate than the coverage gate",
    );
  });

  it("keeps the live gas floor out of paper mode", () => {
    /*
     * The other half of the same rule. A live-capital cost basis that reached the
     * disarmed engine would silently rewrite every dry run and every cached sweep,
     * the same reason `defaultBacktestConfig()` ships its guardrails inert. The
     * pre-profile fallback (0.0035 SOL round trip) must survive verbatim.
     */
    assert.match(
      agentSource,
      /liveMicroCapital\.enabled\s*\?\s*chargeEntryFrictionUsd/,
      "the coverage gate's cost basis is no longer gated on the live profile being armed",
    );
    assert.match(
      agentSource,
      /liveRoundTripGasUsd \?\? 0\.0035 \* 2 \* solPriceUsd/,
      "the pre-profile paper-mode gas fallback changed",
    );
  });

  it("stays inert unless explicitly armed", () => {
    assert.match(
      liveSource,
      /LIVE_MICRO_CAPITAL: booleanish\(false\)/,
      "the live profile no longer defaults to off",
    );
    assert.equal(liveMicroCapital.enabled, false, "this machine has the live profile armed");
  });
});
