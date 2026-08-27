import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assessBreakeven,
  estimateFeeYieldUsd,
  impermanentLossFraction,
  inRangeFactor,
  isOutOfRange,
  screenPools,
  valuePosition,
  type DlmmPool,
  type ScreenerThresholds,
} from "../services/meteora.js";
import { computeBinRange, evaluateExit, positionNotionalUsd } from "../agents/dlmmTraderAgent.js";
import { env } from "../config/env.js";

const approx = (actual: number, expected: number, tolerance = 1e-9): void => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

/* ------------------------------------------------------------------ */

describe("impermanentLossFraction", () => {
  it("is zero when price is unchanged", () => {
    approx(impermanentLossFraction(1), 0);
  });

  it("is negative for any price move in either direction", () => {
    assert.ok(impermanentLossFraction(2) < 0);
    assert.ok(impermanentLossFraction(0.5) < 0);
  });

  it("is symmetric for reciprocal price ratios", () => {
    approx(impermanentLossFraction(4), impermanentLossFraction(0.25), 1e-12);
  });

  it("matches the closed form at a 2x move: 2*sqrt(2)/3 - 1 = -5.7191%", () => {
    approx(impermanentLossFraction(2), (2 * Math.SQRT2) / 3 - 1, 1e-12);
    approx(impermanentLossFraction(2), -0.0571909, 1e-6);
  });

  it("matches the textbook value at a 4x move (-20%)", () => {
    approx(impermanentLossFraction(4), -0.2, 1e-9);
  });

  it("returns 0 rather than NaN for degenerate input", () => {
    approx(impermanentLossFraction(0), 0);
    approx(impermanentLossFraction(-1), 0);
    approx(impermanentLossFraction(Number.NaN), 0);
  });
});

/* ------------------------------------------------------------------ */

describe("range helpers", () => {
  it("detects out-of-range on both sides, inclusive at the edges", () => {
    assert.equal(isOutOfRange(100, 90, 110), false);
    assert.equal(isOutOfRange(90, 90, 110), false, "lower edge counts as in range");
    assert.equal(isOutOfRange(110, 90, 110), false, "upper edge counts as in range");
    assert.equal(isOutOfRange(89.99, 90, 110), true);
    assert.equal(isOutOfRange(110.01, 90, 110), true);
  });

  it("zeroes the earning factor when out of range", () => {
    assert.equal(inRangeFactor(100, 90, 110), 1);
    assert.equal(inRangeFactor(120, 90, 110), 0);
  });
});

describe("computeBinRange", () => {
  const noFloor = { minDownsidePct: 0, minUpsidePct: 0 };

  it("builds a range as a percentage of current price", () => {
    const { lower, upper } = computeBinRange(100, 10, 20, noFloor);
    approx(lower, 90, 1e-9);
    approx(upper, 120, 1e-9);
  });

  it("never produces a non-positive lower bound at 100% downside", () => {
    const { lower } = computeBinRange(100, 100, 5, noFloor);
    assert.ok(lower > 0, "lower bound must stay positive");
  });

  it("widens a too-tight range up to the anti-churn floor", () => {
    // A tight range exits sooner, and every exit burns gas plus slippage.
    const r = computeBinRange(100, 5, 3, { minDownsidePct: 40, minUpsidePct: 15 });
    approx(r.lower, 60, 1e-9);
    approx(r.upper, 115, 1e-9);
    assert.equal(r.widened, true);
    assert.equal(r.downsidePct, 40);
    assert.equal(r.upsidePct, 15);
  });

  it("leaves a range that already clears the floor untouched", () => {
    const r = computeBinRange(100, 50, 25, { minDownsidePct: 40, minUpsidePct: 15 });
    approx(r.lower, 50, 1e-9);
    approx(r.upper, 125, 1e-9);
    assert.equal(r.widened, false);
  });

  it("applies the live floor by default", () => {
    const r = computeBinRange(100, 1, 1);
    assert.ok(r.downsidePct >= env.MIN_DOWNSIDE_COVER_PCT);
    assert.ok(r.upsidePct >= env.MIN_UPSIDE_COVER_PCT);
  });
});

/* ------------------------------------------------------------------ */

describe("assessBreakeven", () => {
  const base = {
    notionalUsd: 100,
    gasCostRoundTripUsd: 0.5,
    slippagePct: 1.5,
    minCoverageRatio: 2,
  };
  // roundTripCost = 0.5 gas + 1.50 slippage = $2.00

  it("passes a pool whose fees comfortably clear the round-trip cost", () => {
    // 10% of TVL per 24h on $100 = $10 of fees vs $2.00 cost = 5x
    const r = assessBreakeven({ ...base, feeTvlRatio24h: 0.1 });
    approx(r.expectedFee24hUsd, 10, 1e-9);
    approx(r.roundTripCostUsd, 2, 1e-9);
    approx(r.coverageRatio, 5, 1e-9);
    assert.equal(r.passes, true);
  });

  it("rejects a pool that cannot cover the cost of trading it", () => {
    // 1% per 24h = $1 of fees against $2.00 of cost.
    const r = assessBreakeven({ ...base, feeTvlRatio24h: 0.01 });
    approx(r.coverageRatio, 0.5, 1e-9);
    assert.equal(r.passes, false);
  });

  it("passes exactly at the coverage threshold", () => {
    // Need 2x of $2.00 = $4 => 4% of notional.
    const r = assessBreakeven({ ...base, feeTvlRatio24h: 0.04 });
    approx(r.coverageRatio, 2, 1e-9);
    assert.equal(r.passes, true);
  });

  it("counts slippage as well as gas, not gas alone", () => {
    const withSlippage = assessBreakeven({ ...base, feeTvlRatio24h: 0.05 });
    const gasOnly = assessBreakeven({ ...base, feeTvlRatio24h: 0.05, slippagePct: 0 });
    assert.ok(
      withSlippage.roundTripCostUsd > gasOnly.roundTripCostUsd,
      "ignoring slippage would understate the hurdle",
    );
  });

  it("scales the hurdle with position size", () => {
    const small = assessBreakeven({ ...base, notionalUsd: 10, feeTvlRatio24h: 0.05 });
    const large = assessBreakeven({ ...base, notionalUsd: 1000, feeTvlRatio24h: 0.05 });
    // Gas is fixed, so a larger position clears the hurdle more easily.
    assert.ok(large.coverageRatio > small.coverageRatio);
  });
});

/* ------------------------------------------------------------------ */

describe("estimateFeeYieldUsd", () => {
  it("earns the full daily fee rate over 24 in-range hours", () => {
    // $1000 at 0.8% of TVL per 24h => $8
    approx(estimateFeeYieldUsd(1000, 0.008, 24, true), 8, 1e-9);
  });

  it("prorates over a partial interval", () => {
    approx(estimateFeeYieldUsd(1000, 0.008, 12, true), 4, 1e-9);
  });

  it("earns nothing while out of range", () => {
    approx(estimateFeeYieldUsd(1000, 0.008, 24, false), 0);
  });

  it("earns nothing for a zero or negative interval", () => {
    approx(estimateFeeYieldUsd(1000, 0.008, 0, true), 0);
    approx(estimateFeeYieldUsd(1000, 0.008, -5, true), 0);
  });
});

/* ------------------------------------------------------------------ */

describe("valuePosition", () => {
  it("nets fee income against impermanent loss", () => {
    const v = valuePosition({
      positionValueUsd: 1000,
      entryPrice: 100,
      currentPrice: 110,
      lowerBinPrice: 90,
      upperBinPrice: 120,
      accruedFeeUsd: 12,
    });

    // Net PnL is driven by LP value vs capital, not by divergence vs holding.
    const expectedValueChange = 1000 * (Math.sqrt(1.1) - 1);
    const expectedDivergence = 1000 * impermanentLossFraction(1.1);

    approx(v.positionValueChangeUsd, expectedValueChange, 1e-9);
    approx(v.divergenceVsHoldUsd, expectedDivergence, 1e-9);
    approx(v.netPnlUsd, 12 + expectedValueChange, 1e-9);
    approx(v.netPnlPct, ((12 + expectedValueChange) / 1000) * 100, 1e-9);
    assert.equal(v.inRange, true);
  });

  it("reports a flat position as pure fee income", () => {
    const v = valuePosition({
      positionValueUsd: 500,
      entryPrice: 50,
      currentPrice: 50,
      lowerBinPrice: 45,
      upperBinPrice: 55,
      accruedFeeUsd: 3,
    });
    approx(v.positionValueChangeUsd, 0, 1e-12);
    approx(v.divergenceVsHoldUsd, 0, 1e-12);
    approx(v.netPnlUsd, 3, 1e-12);
  });

  it("flags out-of-range without crediting further fees", () => {
    const v = valuePosition({
      positionValueUsd: 1000,
      entryPrice: 100,
      currentPrice: 130,
      lowerBinPrice: 90,
      upperBinPrice: 120,
      accruedFeeUsd: 5,
    });
    assert.equal(v.inRange, false);
    approx(v.feeYieldUsd, 5, 1e-12);
  });

  it("does not divide by zero on a zero-notional position", () => {
    const v = valuePosition({
      positionValueUsd: 0,
      entryPrice: 100,
      currentPrice: 110,
      lowerBinPrice: 90,
      upperBinPrice: 120,
      accruedFeeUsd: 0,
    });
    assert.equal(Number.isFinite(v.netPnlPct), true);
    approx(v.netPnlPct, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("evaluateExit", () => {
  it("prioritises out-of-range over every other trigger", () => {
    const d = evaluateExit({ netPnlPct: env.TAKE_PROFIT_PCT + 10, inRange: false, ageHours: 1 });
    assert.equal(d.shouldClose, true);
    assert.equal(d.status, "CLOSED_OUT_OF_RANGE");
  });

  it("closes in profit at the take-profit threshold", () => {
    const d = evaluateExit({ netPnlPct: env.TAKE_PROFIT_PCT, inRange: true, ageHours: 1 });
    assert.equal(d.status, "CLOSED_PROFIT");
  });

  it("closes at a loss at the stop-loss threshold", () => {
    const d = evaluateExit({ netPnlPct: env.STOP_LOSS_PCT, inRange: true, ageHours: 1 });
    assert.equal(d.status, "CLOSED_LOSS");
  });

  it("closes on max age", () => {
    const d = evaluateExit({
      netPnlPct: 0,
      inRange: true,
      ageHours: env.MAX_POSITION_AGE_HOURS,
    });
    assert.equal(d.status, "CLOSED_TIMEOUT");
  });

  it("holds a healthy young position", () => {
    const d = evaluateExit({ netPnlPct: 1, inRange: true, ageHours: 1 });
    assert.equal(d.shouldClose, false);
    assert.equal(d.status, "ACTIVE");
  });
});

/* ------------------------------------------------------------------ */

describe("positionNotionalUsd", () => {
  it("multiplies virtual SOL by the SOL price captured at entry", () => {
    approx(positionNotionalUsd({ virtual_sol_amount: 1.5, entry_sol_price_usd: 200 }), 300);
  });

  it("is zero when the entry price was never recorded", () => {
    approx(positionNotionalUsd({ virtual_sol_amount: 1.5, entry_sol_price_usd: null }), 0);
  });
});

/* ------------------------------------------------------------------ */

const basePool = (over: Partial<DlmmPool> = {}): DlmmPool => ({
  address: "pool1",
  pairName: "AAA-SOL",
  baseSymbol: "AAA",
  quoteSymbol: "SOL",
  baseMint: "mintA",
  quoteMint: "mintB",
  binStep: 20,
  baseFeePct: 0.2,
  tvlUsd: 50_000,
  currentPrice: 1.5,
  volume24hUsd: 500_000,
  volume1hUsd: 20_000,
  fees24hUsd: 1_000,
  feeTvlRatio24h: 0.02,
  estimatedAprPct: 730,
  bothTokensVerified: true,
  isBlacklisted: false,
  ageHours: 100,
  tags: [],
  ...over,
});

const thresholds: ScreenerThresholds = {
  minVolume24hUsd: 10_000,
  minFeeTvlRatio24h: 0.008,
  maxFeeTvlRatio24h: 2.0,
  minTvlUsd: 5_000,
  maxTvlUsd: 500_000,
  minPoolAgeHours: 48,
  requireVerifiedTokens: true,
};

describe("screenPools", () => {
  it("keeps a pool that clears every threshold", () => {
    const r = screenPools([basePool()], thresholds);
    assert.equal(r.candidates.length, 1);
  });

  it("rejects blacklisted, unverified, thin, quiet and low-yield pools", () => {
    const r = screenPools(
      [
        basePool({ address: "p1", isBlacklisted: true }),
        basePool({ address: "p2", bothTokensVerified: false }),
        basePool({ address: "p3", tvlUsd: 100 }),
        basePool({ address: "p4", volume24hUsd: 100 }),
        basePool({ address: "p5", feeTvlRatio24h: 0.0001 }),
      ],
      thresholds,
    );
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.blacklisted, 1);
    assert.equal(r.rejected.unverifiedToken, 1);
    assert.equal(r.rejected.lowTvl, 1);
    assert.equal(r.rejected.lowVolume, 1);
    assert.equal(r.rejected.lowFeeRatio, 1);
  });

  it("rejects implausible fee/TVL outliers from collapsed-TVL pools", () => {
    // Live data really does contain pools reporting 300% fee/TVL in 24h.
    const r = screenPools([basePool({ feeTvlRatio24h: 3.0 })], thresholds);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.feeRatioOutlier, 1);
  });

  it("rejects a pool above the TVL sweet spot", () => {
    // Above ~$500k fee income is too thin: that bucket averaged 0.00% net.
    const r = screenPools([basePool({ tvlUsd: 2_000_000 })], thresholds);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.highTvl, 1);
  });

  it("rejects a pool younger than the age floor", () => {
    // Pools under 48h carried a 7.3x lift in the rate of losses worse than -10%.
    const r = screenPools([basePool({ ageHours: 12 })], thresholds);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.tooYoung, 1);
  });

  it("accepts a pool exactly at the age floor", () => {
    assert.equal(screenPools([basePool({ ageHours: 48 })], thresholds).candidates.length, 1);
  });

  it("rejects rather than guesses when the pool age is unknown", () => {
    const r = screenPools([basePool({ ageHours: Number.NaN })], thresholds);
    assert.equal(r.candidates.length, 0, "an unmeasured age must not pass as old enough");
    assert.equal(r.rejected.ageUnknown, 1);
  });

  it("rejects a pool with a non-positive price", () => {
    const r = screenPools([basePool({ currentPrice: 0 })], thresholds);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.rejected.badPrice, 1);
  });

  it("ranks by (fee/TVL) * volume, highest first", () => {
    const r = screenPools(
      [
        basePool({ address: "low", feeTvlRatio24h: 0.01, volume24hUsd: 100_000 }), // 1000
        basePool({ address: "high", feeTvlRatio24h: 0.05, volume24hUsd: 900_000 }), // 45000
        basePool({ address: "mid", feeTvlRatio24h: 0.02, volume24hUsd: 400_000 }), // 8000
      ],
      thresholds,
    );
    assert.deepEqual(
      r.candidates.map((c) => c.address),
      ["high", "mid", "low"],
    );
  });

  it("counts every scanned pool even when all are rejected", () => {
    const r = screenPools([basePool({ tvlUsd: 1 }), basePool({ tvlUsd: 2 })], thresholds);
    assert.equal(r.scanned, 2);
  });
});
