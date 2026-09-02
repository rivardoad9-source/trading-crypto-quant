/**
 * Pure pieces of the live analytics payload.
 *
 * The SQL is exercised by the API smoke test; what is worth pinning here is the
 * arithmetic that decides what a reader sees, because each of these has a plausible
 * wrong answer that no type checker would catch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCurrentWinStreak } from "../services/metrics.js";
import { displayPoolLabel, trailingWindowStart } from "../services/analytics.js";

describe("computeCurrentWinStreak", () => {
  it("counts consecutive wins back from the most recent close", () => {
    assert.equal(computeCurrentWinStreak([-5, 3, 1, 2]), 3);
  });

  it("is zero when the last close lost", () => {
    assert.equal(computeCurrentWinStreak([4, 9, -1]), 0);
  });

  it("stops at a break-even close rather than counting it as a win", () => {
    // A flat trade is not a win. Counting it would let a $0.00 close bridge two
    // separate runs into one long streak that never happened.
    assert.equal(computeCurrentWinStreak([2, 0, 5, 6]), 2);
  });

  it("stops at a non-finite entry instead of assuming a win", () => {
    assert.equal(computeCurrentWinStreak([1, Number.NaN, 3]), 1);
  });

  it("is zero for an empty history", () => {
    assert.equal(computeCurrentWinStreak([]), 0);
  });
});

describe("trailingWindowStart", () => {
  it("counts today as the first of the N days", () => {
    // 7 days ending the 10th spans the 4th-10th inclusive, not the 3rd.
    assert.equal(trailingWindowStart(7, "2026-09-10"), "2026-09-04");
  });

  it("crosses a month boundary", () => {
    assert.equal(trailingWindowStart(7, "2026-09-02"), "2026-08-27");
  });

  it("crosses a year boundary", () => {
    assert.equal(trailingWindowStart(30, "2026-01-05"), "2025-12-07");
  });

  it("treats a one-day window as today only", () => {
    assert.equal(trailingWindowStart(1, "2026-09-02"), "2026-09-02");
  });
});

describe("displayPoolLabel", () => {
  it("uses the pair name when upstream supplied a real one", () => {
    assert.equal(displayPoolLabel("CYBERLEEK-SOL", "CK3ztgZaUs6dpJa5S1ku7fAiEhdrq1BBib4kDUV8hJnS"), "CYBERLEEK-SOL");
  });

  it("falls back to the address when the name is half-missing", () => {
    // Meteora returns names like "-SOL" when a token symbol never resolved. Rendering
    // that as though it were the pair invents a token that was never identified.
    assert.equal(displayPoolLabel("-SOL", "CMLqxbQU7CDKqzWPpAbKTgiQKuPV1tzYZNLyDjr1BwZz"), "CMLq…BwZz");
    assert.equal(displayPoolLabel("SOL-", "CMLqxbQU7CDKqzWPpAbKTgiQKuPV1tzYZNLyDjr1BwZz"), "CMLq…BwZz");
  });

  it("falls back on an empty or null name", () => {
    assert.equal(displayPoolLabel("", "CMLqxbQU7CDKqzWPpAbKTgiQKuPV1tzYZNLyDjr1BwZz"), "CMLq…BwZz");
    assert.equal(displayPoolLabel(null, "CMLqxbQU7CDKqzWPpAbKTgiQKuPV1tzYZNLyDjr1BwZz"), "CMLq…BwZz");
  });
});
