/**
 * Range physics, checked against numbers published in another implementation rather
 * than against itself.
 *
 * The -40% figures come from the dlmmbot repo's `src/ranges/planner.ts` comment: "-40% is
 * 52 bins at step 100, but 256 at step 20 and 512 at step 10". If this file ever disagrees
 * with those, one of the two is wrong and the card is quoting a fabricated depth.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BIN_ARRAY_RENT_SOL,
  DLMM_MAX_BINS_PER_POSITION,
  assessBinRange,
  binArraysEstimate,
  binRangeCardLines,
  binsDownPct,
  binsUpPct,
  depthForBins,
} from "../services/binRange.js";

describe("bins per percent move", () => {
  it("matches dlmmbot's published bin counts for -40%", () => {
    assert.equal(binsDownPct(40, 100), 52); // step 100
    assert.equal(binsDownPct(40, 20), 256); // step 20
    assert.equal(binsDownPct(40, 10), 512); // step 10
  });

  it("costs more bins as the step gets finer, never fewer", () => {
    const steps = [1, 2, 5, 10, 20, 50, 100, 200];
    const counts = steps.map((s) => binsDownPct(45, s));
    for (let i = 1; i < counts.length; i += 1) {
      const prev = counts[i - 1] ?? 0;
      const cur = counts[i] ?? 0;
      assert.ok(cur < prev, `step ${steps[i]} should need fewer bins`);
    }
  });

  it("is symmetric in the reciprocal sense: a rise uses the plain factor", () => {
    // +100% doubles the price: ln(2)/ln(1+step), i.e. the same count as a -50% drop.
    assert.equal(binsUpPct(100, 20), binsDownPct(50, 20));
  });

  it("returns 0 for nonsense instead of Infinity", () => {
    assert.equal(binsDownPct(0, 20), 0);
    assert.equal(binsDownPct(100, 20), 0);
    assert.equal(binsDownPct(45, 0), 0);
    assert.equal(binsUpPct(0, 20), 0);
  });

  it("round-trips bins -> depth -> bins (to the nearest bin)", () => {
    for (const step of [1, 4, 20, 100]) {
      for (const bins of [10, 70, 300, 1400]) {
        const pct = depthForBins(bins, step);
        // ceil() on a floating-point log can land one bin high; the range is checked
        // exactly, so a single bin of slack here is arithmetic noise, not a bug.
        const back = binsDownPct(pct, step);
        assert.ok(Math.abs(back - bins) <= 1, `step ${step}, bins ${bins}, back ${back}`);
      }
    }
  });
});

describe("bin arrays and rent", () => {
  it("assumes the straddling case (one more array than a clean division)", () => {
    assert.equal(binArraysEstimate(0), 0);
    assert.equal(binArraysEstimate(1), 2);
    assert.equal(binArraysEstimate(70), 2);
    assert.equal(binArraysEstimate(71), 3);
    assert.equal(binArraysEstimate(300), 6);
  });

  it("prices rent per array at the on-chain deposit", () => {
    // 370 bins (300 down + 70 up) at step 20: ceil(370/70)+1 = 7 arrays worst case.
    const a = assessBinRange({ downPct: 45, upPct: 15, binStep: 20 });
    assert.equal(a.binArrays, 7);
    assert.equal(a.binRentSol, 7 * BIN_ARRAY_RENT_SOL);
  });
});

describe("assessBinRange", () => {
  it("fits a -45%/+15% range on a step-20 pool under the program cap", () => {
    const a = assessBinRange({ downPct: 45, upPct: 15, binStep: 20 });
    assert.equal(a.binsNeeded, 300 + 70); // 300 down, 70 up
    assert.equal(a.binCap, DLMM_MAX_BINS_PER_POSITION);
    assert.equal(a.fits, true);
    assert.equal(a.deepestRealPct, null);
  });

  it("flags truncation on a fine-step pool and reports the real depth", () => {
    const a = assessBinRange({ downPct: 45, upPct: 15, binStep: 2 });
    assert.ok(a.binsNeeded > DLMM_MAX_BINS_PER_POSITION, `needed ${a.binsNeeded}`);
    assert.equal(a.fits, false);
    // 1400 bins at step 2 can only span ~24%, not 45%.
    assert.ok(a.deepestRealPct !== null && a.deepestRealPct > 20 && a.deepestRealPct < 30);
  });

  it("honours a stricter operator cap", () => {
    const a = assessBinRange({ downPct: 45, upPct: 15, binStep: 20, binCap: 70 });
    assert.equal(a.binCap, 70);
    assert.equal(a.fits, false);
    // 70 bins at step 20 is about -13%.
    assert.ok(a.deepestRealPct !== null && a.deepestRealPct > 12 && a.deepestRealPct < 15);
  });

  it("cannot be asked for more than the program maximum", () => {
    const a = assessBinRange({ downPct: 45, upPct: 15, binStep: 20, binCap: 999_999 });
    assert.equal(a.binCap, DLMM_MAX_BINS_PER_POSITION);
  });
});

describe("card lines", () => {
  it("reads correctly for the real signal (CATE-USDC: step 20, -45%/+15%)", () => {
    const a = assessBinRange({ downPct: 45, upPct: 15, binStep: 20, binCap: 1400 });
    assert.deepEqual(binRangeCardLines(a, 45, 15), [
      "Rentang −45% / +15% butuh 370 bin (batas 1.400) — muat",
      "Sewa bin: paling banyak 7 array × 0,075 SOL = 0,525 SOL (titipan, bukan biaya — balik utuh saat posisi ditutup)",
    ]);
  });

  it("adds the truncation warning on a fine-step pool instead of claiming the depth", () => {
    const a = assessBinRange({ downPct: 45, upPct: 15, binStep: 2, binCap: 1400 });
    const lines = binRangeCardLines(a, 45, 15);
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", /TIDAK muat$/);
    assert.match(lines[1] ?? "", /^⚠️ Kalau dipaksa, kedalaman yang benar-benar bisa dibangun cuma sekitar −2\d,\d%/);
  });
});
