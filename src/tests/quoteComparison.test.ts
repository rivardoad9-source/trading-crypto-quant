/**
 * The SOL-quoted vs USDC-quoted comparison, and the one correction that makes it a
 * comparison rather than a reading of the window.
 *
 * The engine values a position in its QUOTE asset. `positionValueChangeUsd` is
 * `notional x (sqrt(r) - 1)` where r is the base priced in the quote — a USD figure
 * for a USDC pool, and a SOL figure carried on a USD notional for a SOL pool. So the
 * engine's PnL for a SOL-quoted position silently assumes SOL/USD was flat for the
 * whole hold, and the two arms of this comparison are denominated in different things.
 *
 * Over a 91-day window SOL can move tens of percent. Left uncorrected, whichever arm
 * happens to hold the asset that ran would win, and the report would present a
 * property of the WINDOW as a property of the quote asset. That is the failure this
 * suite exists to prevent — so what is asserted here is not that the correction is
 * large but that it is applied to exactly the trades it belongs to, in the right
 * direction, and never invented where SOL/USD could not be read.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { adjustTradeForSolMove, isSolArm, isUsdArm } from "../backtest/runQuoteComparison.js";
import {
  balancingSwapCost,
  balancingSwapFrictionUsd,
  defaultBacktestConfig,
} from "../backtest/engine.js";
import { WSOL_MINT } from "../config/constants.js";
import type { BacktestTrade } from "../backtest/engine.js";
import type { Bar } from "../backtest/historicalData.js";
import type { UniversePool } from "../backtest/universe.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME_MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";

function pool(over: Partial<UniversePool>): UniversePool {
  return {
    address: "pool",
    pairName: "PAIR",
    baseSymbol: "MEME",
    quoteSymbol: "SOL",
    baseMint: MEME_MINT,
    quoteMint: WSOL_MINT,
    createdAtMs: 0,
    binStep: 100,
    feeRate: 0.004,
    tvlTodayUsd: 100_000,
    volume24hTodayUsd: 50_000,
    lifetimeVolumeUsd: 1_000_000,
    bothTokensVerified: false,
    isBlacklisted: false,
    cohort: "survivor",
    ...over,
  };
}

/** Hourly SOL/USD bars at a flat price, one per hour from `t0`. */
function solBars(t0: number, prices: number[]): Bar[] {
  return prices.map((c, i) => ({ t: t0 + i * 3600, o: c, h: c, l: c, c, v: 0 }));
}

const T0 = 1_750_000_000;

function trade(over: Partial<BacktestTrade>): BacktestTrade {
  return {
    poolAddress: "pool",
    pairName: "MEME-SOL",
    cohort: "survivor",
    entryTime: new Date(T0 * 1000).toISOString(),
    exitTime: new Date((T0 + 5 * 3600) * 1000).toISOString(),
    durationHours: 5,
    entryPrice: 1,
    exitPrice: 1,
    effectiveExitPrice: 1,
    entryRatio: 1,
    exitRatio: 1,
    lowerBinPrice: 0.55,
    upperBinPrice: 1.15,
    quoteDenominatedIn: "SOL",
    notionalUsd: 100,
    modelledTvlAtEntryUsd: 100_000,
    solPriceAtEntry: 200,
    feesEarnedUsd: 2,
    feesEarnedPct: 2,
    positionValueChangeUsd: 0,
    divergenceVsHoldUsd: 0,
    gasCostUsd: 1,
    slippageCostUsd: 0,
    swapCostUsd: 0,
    netPnlUsd: 1,
    netPnlPct: 1,
    netPnlSol: 0.005,
    exitReason: "TAKE_PROFIT",
    rugged: false,
    catastrophic: false,
    barsHeld: 5,
    barsOutOfRange: 0,
    ...over,
  };
}

describe("arm membership mirrors what describePair() enforces live", () => {
  it("a pool with a wSOL leg is fundable today, even when the other leg is USDC", () => {
    const solUsdc = pool({ baseMint: WSOL_MINT, baseSymbol: "SOL", quoteMint: USDC_MINT, quoteSymbol: "USDC" });

    assert.equal(isSolArm(solUsdc), true);
    /*
     * The live refusal is the ABSENCE of a wSOL leg, not the presence of a stablecoin.
     * Filing SOL-USDC in the USDC arm would put a pool the engine already trades into
     * the arm labelled "what it refuses", and the headline would then compare a
     * capability gap against nothing of the kind.
     */
    assert.equal(isUsdArm(solUsdc), false);
  });

  it("a memecoin/USDC pool with no wSOL leg is the arm the engine refuses", () => {
    // The 9 Sep 2026 incident pool: tokenY USDC, no SOL anywhere.
    const memeUsdc = pool({ quoteMint: USDC_MINT, quoteSymbol: "USDC" });

    assert.equal(isSolArm(memeUsdc), false);
    assert.equal(isUsdArm(memeUsdc), true);
  });

  it("a pool with neither leg is in NEITHER arm, not silently in one", () => {
    const memeMeme = pool({ quoteMint: MEME_MINT, quoteSymbol: "BONK" });

    assert.equal(isSolArm(memeMeme), false);
    assert.equal(isUsdArm(memeMeme), false);
  });
});

describe("the SOL-beta correction", () => {
  it("leaves a USD-quoted trade exactly as the engine reported it", () => {
    const t = trade({ quoteDenominatedIn: "USD", netPnlUsd: 7.5 });
    const adjusted = adjustTradeForSolMove(t, solBars(T0, [200, 200, 200, 200, 200, 260]));

    assert.equal(adjusted.adjustedNetPnlUsd, 7.5);
    assert.equal(adjusted.solBetaUsd, 0);
    assert.equal(adjusted.measured, true, "a USD quote is always measurable — there is nothing to read");
  });

  it("adds the SOL move to a SOL-quoted trade, on the LP value and not on the fees", () => {
    /*
     * $100 notional, LP value flat in SOL, $2 of fees, $1 of gas -> the engine books
     * +$1. SOL then rises 30% over the hold: the SOL the position is made of is worth
     * 30% more, so the LP leg is worth $130 against $100 deployed.
     *
     * Fees and gas are already USD figures at the time they were charged and must NOT
     * be re-scaled; only the position's value carries the move.
     */
    const t = trade({ positionValueChangeUsd: 0, feesEarnedUsd: 2, gasCostUsd: 1, netPnlUsd: 1 });
    const adjusted = adjustTradeForSolMove(t, solBars(T0, [200, 200, 200, 200, 200, 260]));

    assert.equal(adjusted.solPriceAtExit, 260);
    // 2 + (100 x 1.3 - 100) - 1 = 31
    assert.ok(Math.abs(adjusted.adjustedNetPnlUsd - 31) < 1e-9, `got ${adjusted.adjustedNetPnlUsd}`);
    assert.ok(Math.abs(adjusted.solBetaUsd - 30) < 1e-9);
  });

  it("charges the move in BOTH directions — a SOL drawdown turns a quoted win into a loss", () => {
    const t = trade({ positionValueChangeUsd: 0, feesEarnedUsd: 2, gasCostUsd: 1, netPnlUsd: 1 });
    const adjusted = adjustTradeForSolMove(t, solBars(T0, [200, 200, 200, 200, 200, 140]));

    // 2 + (100 x 0.7 - 100) - 1 = -29
    assert.ok(Math.abs(adjusted.adjustedNetPnlUsd - -29) < 1e-9, `got ${adjusted.adjustedNetPnlUsd}`);
    assert.ok(adjusted.adjustedNetPnlUsd < 0 && t.netPnlUsd > 0, "the sign must be able to flip");
  });

  it("compounds the move with the LP's own quote-denominated change, not beside it", () => {
    /*
     * The position lost 10% of its value IN SOL and SOL then gained 30% in USD. The
     * dollar outcome is multiplicative (0.9 x 1.3), not additive (-10% + 30%): adding
     * them would misstate the result by the cross term on every trade that moved.
     */
    const t = trade({ positionValueChangeUsd: -10, feesEarnedUsd: 0, gasCostUsd: 0, netPnlUsd: -10 });
    const adjusted = adjustTradeForSolMove(t, solBars(T0, [200, 200, 200, 200, 200, 260]));

    // 90 x 1.3 - 100 = 17, NOT 100 x (1 - 0.10 + 0.30) - 100 = 20.
    assert.ok(Math.abs(adjusted.adjustedNetPnlUsd - 17) < 1e-9, `got ${adjusted.adjustedNetPnlUsd}`);
  });

  it("reports UNMEASURED rather than a zero correction when SOL/USD cannot be read", () => {
    /*
     * "No basis to compare" and "compared, and SOL did not move" are different facts
     * that render identically as a zero. The reconciliation service already refuses to
     * conflate them; a run whose SOL series does not reach the exit bar must say so.
     */
    const t = trade({});
    /*
     * `solPriceAt` answers with the last bar AT OR BEFORE the timestamp, so a series
     * that merely ends early still yields a (stale) price. The unreadable case is a
     * series that does not begin until after the exit — nothing at or before it.
     */
    const adjusted = adjustTradeForSolMove(t, solBars(T0 + 100 * 3600, [200, 260]));

    assert.equal(adjusted.measured, false);
    assert.equal(adjusted.solBetaUsd, 0);
    assert.equal(adjusted.adjustedNetPnlUsd, t.netPnlUsd, "an unreadable price must not move the number");
  });

  it("treats a zero or missing entry price as unmeasured, never as a free ride", () => {
    const t = trade({ solPriceAtEntry: 0 });
    const adjusted = adjustTradeForSolMove(t, solBars(T0, [200, 200, 200, 200, 200, 260]));

    assert.equal(adjusted.measured, false);
    assert.equal(adjusted.solBetaUsd, 0);
  });
});

describe("the balancing swap, now priced as friction", () => {
  const solPool = { baseMint: MEME_MINT, quoteMint: WSOL_MINT };
  const usdPool = { baseMint: MEME_MINT, quoteMint: USDC_MINT };

  it("stays FREE under the default config, so no existing result moves", () => {
    /*
     * The harness never charged for the balancing swap. Pricing it is a change to
     * every number the harness produces, so it must be opt-in: a default that started
     * charging would silently rewrite every cached sweep and every figure quoted from
     * one — the same rule the V1.1 guardrails and `takeProfitNetPct` follow.
     */
    const cfg = defaultBacktestConfig();

    assert.equal(cfg.swapSlippagePct, 0);
    assert.equal(cfg.swapGasSolPerLeg, 0);
    assert.equal(balancingSwapFrictionUsd(solPool, 1000, cfg, 200), 0);
    assert.equal(balancingSwapFrictionUsd(usdPool, 1000, cfg, 200), 0);
  });

  it("counts two legs for a wSOL pool and four for one without", () => {
    /*
     * A wSOL pool: half the SOL becomes the other token, half stays put. One leg in,
     * one back out. A USDC-quoted pool holds NEITHER asset the wallet has, so both
     * halves must be converted — two legs in, two back out.
     */
    assert.deepEqual(balancingSwapCost(solPool), { legs: 2, turnover: 1 });
    assert.deepEqual(balancingSwapCost(usdPool), { legs: 4, turnover: 2 });
  });

  it("charges a USDC-quoted pool exactly DOUBLE the concession at the same rate", () => {
    const cfg = { swapSlippagePct: 0.25, swapGasSolPerLeg: 0 };

    const sol = balancingSwapFrictionUsd(solPool, 1000, cfg, 200);
    const usd = balancingSwapFrictionUsd(usdPool, 1000, cfg, 200);

    assert.ok(Math.abs(sol - 2.5) < 1e-9, `got ${sol}`); // 1000 x 1.0 x 0.25%
    assert.ok(Math.abs(usd - 5.0) < 1e-9, `got ${usd}`); // 1000 x 2.0 x 0.25%
    assert.ok(Math.abs(usd - 2 * sol) < 1e-9, "the whole point of the comparison");
  });

  it("charges gas per LEG, so the extra transactions are not free either", () => {
    const cfg = { swapSlippagePct: 0, swapGasSolPerLeg: 0.001 };

    // 2 legs x 0.001 SOL x $200 = $0.40 ; 4 legs = $0.80.
    assert.ok(Math.abs(balancingSwapFrictionUsd(solPool, 1000, cfg, 200) - 0.4) < 1e-9);
    assert.ok(Math.abs(balancingSwapFrictionUsd(usdPool, 1000, cfg, 200) - 0.8) < 1e-9);
  });

  it("reads the wSOL leg on EITHER side of the pair", () => {
    // Meteora reports token_y as the quote, but SOL is not always on that side.
    assert.deepEqual(balancingSwapCost({ baseMint: WSOL_MINT, quoteMint: USDC_MINT }), {
      legs: 2,
      turnover: 1,
    });
  });

  it("scales with notional, so a bigger position does not dilute it", () => {
    /*
     * Gas is fixed per trade and dilutes as the position grows — that is the argument
     * for raising LIVE_MAX_POSITION_SOL. Swap concession does NOT: it is proportional,
     * so it survives every sizing change. Conflating the two is how a fixed-cost
     * argument gets applied to a variable cost.
     */
    const cfg = { swapSlippagePct: 0.25, swapGasSolPerLeg: 0 };

    const small = balancingSwapFrictionUsd(usdPool, 100, cfg, 200);
    const large = balancingSwapFrictionUsd(usdPool, 1000, cfg, 200);

    assert.ok(Math.abs(large - 10 * small) < 1e-9);
    assert.ok(Math.abs(small / 100 - large / 1000) < 1e-12, "cost per dollar is constant");
  });
});

describe("the two corrections do not cancel each other", () => {
  it("carries the swap cost through the SOL adjustment instead of refunding it", () => {
    /*
     * The swap was paid in dollars at entry and exit. Restating the POSITION in USD
     * must not hand that money back: an adjustment that only re-derives the value term
     * and forgets a cost term reads as a strictly better trade, and the arm that pays
     * the most swap cost would benefit most from the correction meant to make it
     * comparable. That is the failure this asserts against.
     */
    const t = trade({
      positionValueChangeUsd: 0,
      feesEarnedUsd: 2,
      gasCostUsd: 1,
      swapCostUsd: 4,
      netPnlUsd: -3,
    });
    const adjusted = adjustTradeForSolMove(t, solBars(T0, [200, 200, 200, 200, 200, 260]));

    // 2 + (100 x 1.3 - 100) - 1 - 4 = 27, not 31.
    assert.ok(Math.abs(adjusted.adjustedNetPnlUsd - 27) < 1e-9, `got ${adjusted.adjustedNetPnlUsd}`);
    // The SOL move alone is still +$30; the swap cost is not part of the beta.
    assert.ok(Math.abs(adjusted.solBetaUsd - 30) < 1e-9, `got ${adjusted.solBetaUsd}`);
  });
});
