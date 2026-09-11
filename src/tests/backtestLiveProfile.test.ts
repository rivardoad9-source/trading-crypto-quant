/**
 * The backtest simulates the account live runs, not a $100 demo account.
 *
 * 11 Sep 2026: `npm run backtest:micro` with no flags simulated $100 x 27.5% x 3 positions
 * while live ran ~$294 at 63% per position and could fund ONE. Same data, same gates: PF
 * 2.09 vs 3.22, maxDD 40.1% vs 5.72%, and nothing in the report said which account it was.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveMicroCapital } from "../config/liveConfig.js";
import { liveV11Config } from "../backtest/runMicroCapital.js";
import {
  BacktestProfileError,
  describeBacktestProfile,
  readProfileOverrides,
  resolveBacktestProfile,
} from "../backtest/liveProfile.js";

const LIVE_HOST = { capitalSol: 2.85, maxPositionSol: 1.8, maxConcurrentPositions: 1 };

describe("backtest profile — derived from the live envelope", () => {
  it("the live host's 2.85 / 1.8 profile at $103 is ~$294, 63.16%, ONE position", () => {
    const p = resolveBacktestProfile({
      overrides: {},
      windowStartSolUsd: 103,
      defaultGasSolPerTransaction: 0.0035,
      profile: LIVE_HOST,
    });
    assert.ok(Math.abs(p.options.capitalUsd - 293.55) < 1e-9, `${p.options.capitalUsd}`);
    assert.ok(Math.abs(p.options.positionSizePct - (1.8 / 2.85) * 100) < 1e-9);
    assert.equal(p.options.maxConcurrentPositions, 1);
    assert.ok(Math.abs(p.notionalSol - 1.8) < 1e-9, "the notional is not the live position size");
    assert.ok(Math.abs(p.notionalUsd - 185.4) < 1e-9);
    assert.equal(p.matchesLive, true);
  });

  it("the default built by liveV11Config() is consistent with the env's live profile", () => {
    // Under the test runner the env is the code default (no .env is read): 1.15 / 0.8 / 1.
    const p = resolveBacktestProfile({
      overrides: {},
      windowStartSolUsd: 150,
      defaultGasSolPerTransaction: 0.0035,
    });
    const config = liveV11Config(p.options);
    assert.ok(Math.abs((config.startingCapitalUsd ?? NaN) - liveMicroCapital.capitalSol * 150) < 1e-9);
    assert.ok(
      Math.abs(config.positionSizePct - (liveMicroCapital.maxPositionSol / liveMicroCapital.capitalSol) * 100) < 1e-9,
    );
    assert.equal(config.maxConcurrentPositions, liveMicroCapital.maxConcurrentPositions);
    assert.notEqual(config.startingCapitalUsd, 100, "the $100 demo account came back");
  });

  it("concurrency is what the capital can FUND, never more than the live cap", () => {
    const capped = resolveBacktestProfile({
      overrides: {},
      windowStartSolUsd: 100,
      defaultGasSolPerTransaction: 0,
      profile: { capitalSol: 3, maxPositionSol: 0.5, maxConcurrentPositions: 2 },
    });
    assert.equal(capped.options.maxConcurrentPositions, 2, "floor(3/0.5)=6 exceeded the live cap of 2");

    const funded = resolveBacktestProfile({
      overrides: {},
      windowStartSolUsd: 100,
      defaultGasSolPerTransaction: 0,
      profile: { capitalSol: 2.85, maxPositionSol: 1.8, maxConcurrentPositions: 3 },
    });
    assert.equal(funded.options.maxConcurrentPositions, 1, "three positions the capital cannot fund");
  });

  it("FAILS with the missing piece named — never falls back to $100", () => {
    assert.throws(
      () =>
        resolveBacktestProfile({
          overrides: {},
          windowStartSolUsd: null,
          defaultGasSolPerTransaction: 0,
          profile: LIVE_HOST,
        }),
      (e: unknown) => e instanceof BacktestProfileError && /--solusd/.test(e.message),
    );
    assert.throws(
      () =>
        resolveBacktestProfile({
          overrides: {},
          windowStartSolUsd: 100,
          defaultGasSolPerTransaction: 0,
          profile: { capitalSol: 0, maxPositionSol: 1.8, maxConcurrentPositions: 1 },
        }),
      /incomplete/,
    );
    assert.throws(
      () =>
        resolveBacktestProfile({
          overrides: {},
          windowStartSolUsd: 100,
          defaultGasSolPerTransaction: 0,
          profile: { capitalSol: 1, maxPositionSol: 1.8, maxConcurrentPositions: 1 },
        }),
      /cannot fund one/,
    );
  });
});

describe("backtest profile — overrides are allowed and announced", () => {
  it("--capital/--sizepct/--concurrent still work, and the header says NOT THE LIVE PROFILE", () => {
    const overrides = readProfileOverrides(
      new Map([
        ["capital", "100"],
        ["sizepct", "27.5"],
        ["concurrent", "3"],
      ]),
    );
    const p = resolveBacktestProfile({
      overrides,
      windowStartSolUsd: 103,
      defaultGasSolPerTransaction: 0.0035,
      profile: LIVE_HOST,
    });
    assert.equal(p.options.capitalUsd, 100);
    assert.equal(p.options.maxConcurrentPositions, 3);
    assert.equal(p.matchesLive, false);
    assert.deepEqual(p.overridden, ["capital", "sizepct", "concurrent"]);
    const header = describeBacktestProfile(p).join("\n");
    assert.match(header, /NOT THE LIVE PROFILE/);
    assert.match(header, /WARNING/);
    assert.match(header, /--capital, --sizepct, --concurrent/);
  });

  it("the header carries capital, size %, notional in USD and SOL, concurrent, gas and SOL/USD", () => {
    const p = resolveBacktestProfile({
      overrides: {},
      windowStartSolUsd: 103,
      defaultGasSolPerTransaction: 0.0035,
      profile: LIVE_HOST,
    });
    const header = describeBacktestProfile(p).join("\n");
    for (const expected of [/\$293\.55/, /63\.16%/, /\$185\.40/, /1\.8000 SOL notional/, /concurrent\s*: 1/, /0\.0035 SOL\/tx/, /\$103\.00 \(window start\)/]) {
      assert.match(header, expected);
    }
    assert.doesNotMatch(header, /WARNING/);
  });

  it("a non-numeric flag is an error, not a silent default", () => {
    assert.throws(() => readProfileOverrides(new Map([["capital", "lots"]])), /not a number/);
  });

  it("no runner hard-codes the demo account any more", () => {
    for (const file of [
      "src/backtest/runMicroCapital.ts",
      "src/backtest/runAnnual.ts",
      "src/backtest/runQuoteComparison.ts",
      "src/scripts/sweepRiskReward.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /n\("capital", 100\)/, file);
      assert.doesNotMatch(source, /n\("sizepct", 27\.5\)/, file);
      assert.doesNotMatch(source, /n\("concurrent", env\.MAX_CONCURRENT_POSITIONS\)/, file);
      assert.match(source, /resolveBacktestProfile\(/, `${file} does not resolve the live profile`);
      assert.match(source, /describeBacktestProfile\(/, `${file} does not print the profile`);
    }
  });
});
