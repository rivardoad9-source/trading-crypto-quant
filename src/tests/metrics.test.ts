import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeMaxDrawdown, computeProfitFactor } from "../services/metrics.js";
import { normalisePostMortem } from "../agents/postMortemAgent.js";
import { acceptsSafetyVerdict } from "../agents/dlmmTraderAgent.js";
import { riskMintOf, QUOTE_MINTS } from "../services/meteora.js";
import { realizedVolatilityPctPerHour } from "../services/statistics.js";

const approx = (actual: number, expected: number, tol = 1e-9): void =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`,
  );

/* ------------------------------------------------------------------ */

describe("computeMaxDrawdown", () => {
  it("is zero for an empty history", () => {
    const r = computeMaxDrawdown([], 1000);
    approx(r.maxDrawdownPct, 0);
    approx(r.maxDrawdownUsd, 0);
  });

  it("is zero for a monotonically rising curve", () => {
    const r = computeMaxDrawdown([10, 20, 5, 15], 1000);
    approx(r.maxDrawdownPct, 0);
    approx(r.currentDrawdownPct, 0);
  });

  it("measures a single peak-to-trough decline", () => {
    // 1000 -> 1100 (peak) -> 990 (trough). Decline 110 / 1100 = 10%.
    const r = computeMaxDrawdown([100, -110], 1000);
    approx(r.maxDrawdownUsd, 110, 1e-9);
    approx(r.maxDrawdownPct, 10, 1e-9);
    approx(r.peakEquityUsd, 1100);
    approx(r.troughEquityUsd, 990);
  });

  it("keeps the deepest decline, not the most recent", () => {
    // 1000 -> 1200 -> 600 (-50%) -> 1300 -> 1170 (-10%)
    const r = computeMaxDrawdown([200, -600, 700, -130], 1000);
    approx(r.maxDrawdownPct, 50, 1e-9);
    approx(r.maxDrawdownUsd, 600, 1e-9);
  });

  it("measures the trough of a multi-step decline, not each step", () => {
    // 1000 -> 1100 -> 1000 -> 900 -> 800. Worst is 300/1100 = 27.27%.
    const r = computeMaxDrawdown([100, -100, -100, -100], 1000);
    approx(r.maxDrawdownUsd, 300, 1e-9);
    approx(r.maxDrawdownPct, (300 / 1100) * 100, 1e-9);
  });

  it("reports how far below the running peak the curve currently sits", () => {
    // 1000 -> 1200 (peak) -> 1080. Recovered nothing: current = 10%.
    const r = computeMaxDrawdown([200, -120], 1000);
    approx(r.currentDrawdownPct, 10, 1e-9);
  });

  it("reports zero current drawdown once the curve makes a new high", () => {
    const r = computeMaxDrawdown([200, -120, 500], 1000);
    approx(r.currentDrawdownPct, 0);
    assert.ok(r.maxDrawdownPct > 0, "the historical drawdown must still be recorded");
  });

  it("ignores non-finite entries rather than producing NaN", () => {
    const r = computeMaxDrawdown([100, Number.NaN, -110], 1000);
    assert.equal(Number.isFinite(r.maxDrawdownPct), true);
    approx(r.maxDrawdownPct, 10, 1e-9);
  });

  it("does not divide by a non-positive peak", () => {
    const r = computeMaxDrawdown([-100, -100], 0);
    assert.equal(Number.isFinite(r.maxDrawdownPct), true);
    assert.equal(Number.isFinite(r.maxDrawdownUsd), true);
  });
});

/* ------------------------------------------------------------------ */

describe("computeProfitFactor", () => {
  it("divides gross profit by gross loss", () => {
    const r = computeProfitFactor([10, 20, -15]);
    approx(r.grossProfitUsd, 30);
    approx(r.grossLossUsd, 15);
    approx(r.profitFactor!, 2, 1e-9);
  });

  it("returns null rather than Infinity when nothing lost", () => {
    const r = computeProfitFactor([10, 20]);
    assert.equal(r.profitFactor, null, "an undefined ratio must not render as a number");
    approx(r.grossLossUsd, 0);
  });

  it("returns null for an empty history", () => {
    assert.equal(computeProfitFactor([]).profitFactor, null);
  });

  it("returns 0 when every trade lost", () => {
    const r = computeProfitFactor([-10, -20]);
    approx(r.profitFactor!, 0);
    approx(r.grossLossUsd, 30);
  });

  it("counts a break-even trade as neither profit nor loss", () => {
    const r = computeProfitFactor([10, 0, -5]);
    assert.equal(r.winningTrades, 1);
    assert.equal(r.losingTrades, 1);
    approx(r.grossProfitUsd, 10);
    approx(r.grossLossUsd, 5);
  });

  it("reports below 1 for a net-losing strategy", () => {
    const r = computeProfitFactor([10, -40]);
    assert.ok(r.profitFactor! < 1);
  });
});

/* ------------------------------------------------------------------ */

describe("riskMintOf", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const MEME = "MemeMintAddress1111111111111111111111111111";

  it("returns null when both legs are recognised quote assets", () => {
    assert.equal(riskMintOf({ baseMint: SOL, quoteMint: USDC }), null);
  });

  it("picks the non-quote leg regardless of which side it sits on", () => {
    assert.equal(riskMintOf({ baseMint: MEME, quoteMint: SOL }), MEME);
    assert.equal(riskMintOf({ baseMint: SOL, quoteMint: MEME }), MEME);
  });

  it("falls back to the base leg when neither side is a known quote", () => {
    assert.equal(riskMintOf({ baseMint: MEME, quoteMint: "OtherMint" }), MEME);
  });

  it("recognises SOL, USDC and USDT as quote assets", () => {
    assert.equal(QUOTE_MINTS.has(SOL), true);
    assert.equal(QUOTE_MINTS.has(USDC), true);
    assert.equal(QUOTE_MINTS.has("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), true);
  });
});

/* ------------------------------------------------------------------ */

describe("acceptsSafetyVerdict", () => {
  it("accepts a genuine pass under either policy", () => {
    assert.equal(acceptsSafetyVerdict("PASS", "reject"), true);
    assert.equal(acceptsSafetyVerdict("PASS", "allow"), true);
  });

  it("never accepts a failure, even under the permissive policy", () => {
    assert.equal(acceptsSafetyVerdict("FAIL", "reject"), false);
    assert.equal(
      acceptsSafetyVerdict("FAIL", "allow"),
      false,
      "a definitive rug-rule breach must not be overridable by the error policy",
    );
  });

  it("rejects an unverifiable pool by default (fail closed)", () => {
    assert.equal(
      acceptsSafetyVerdict("UNKNOWN", "reject"),
      false,
      "an unrunnable check must not be treated as a pass",
    );
  });

  it("accepts an unverifiable pool only under an explicit allow policy", () => {
    assert.equal(acceptsSafetyVerdict("UNKNOWN", "allow"), true);
  });
});

/* ------------------------------------------------------------------ */

describe("realizedVolatilityPctPerHour", () => {
  it("is zero for a perfectly flat series", () => {
    approx(realizedVolatilityPctPerHour(Array(25).fill(100))!, 0, 1e-12);
  });

  it("returns null when there are too few usable returns", () => {
    assert.equal(realizedVolatilityPctPerHour([100, 101, 102]), null);
  });

  it("returns null rather than a number the caller might trust as calm", () => {
    assert.equal(realizedVolatilityPctPerHour([]), null);
  });

  it("grows with the size of the swings", () => {
    const calm = Array.from({ length: 25 }, (_, i) => 100 * (1 + (i % 2 ? 0.001 : -0.001)));
    const wild = Array.from({ length: 25 }, (_, i) => 100 * (1 + (i % 2 ? 0.2 : -0.2)));
    assert.ok(realizedVolatilityPctPerHour(wild)! > realizedVolatilityPctPerHour(calm)!);
  });

  it("ignores non-positive closes instead of producing NaN", () => {
    const closes = Array(25).fill(100);
    closes[5] = 0;
    const v = realizedVolatilityPctPerHour(closes);
    assert.ok(v !== null && Number.isFinite(v));
  });
});

describe("normalisePostMortem", () => {
  it("keeps a single clean sentence intact", () => {
    const s = "Price left the upper bin after 3h so fees never offset IL.";
    assert.equal(normalisePostMortem(s), s);
  });

  it("strips surrounding quotes and list markers", () => {
    assert.equal(normalisePostMortem('"Fees outpaced IL."'), "Fees outpaced IL.");
    assert.equal(normalisePostMortem("- Fees outpaced IL."), "Fees outpaced IL.");
    assert.equal(normalisePostMortem("1. Fees outpaced IL."), "Fees outpaced IL.");
  });

  it("truncates to the first sentence when the model writes more", () => {
    const out = normalisePostMortem("Fees outpaced IL. Next time widen the range. And again.");
    assert.equal(out, "Fees outpaced IL.");
  });

  it("collapses newlines and repeated whitespace", () => {
    assert.equal(normalisePostMortem("Fees\n\n  outpaced   IL."), "Fees outpaced IL.");
  });

  it("clamps an over-long single sentence", () => {
    const out = normalisePostMortem(`${"x".repeat(400)}`);
    assert.ok(out.length <= 240, `expected <= 240 chars, got ${out.length}`);
  });

  it("returns an empty string for empty input rather than throwing", () => {
    assert.equal(normalisePostMortem("   "), "");
  });
});
