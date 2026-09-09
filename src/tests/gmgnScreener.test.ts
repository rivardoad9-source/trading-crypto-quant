import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  judgeGmgnHolders,
  type GmgnHolderAssessment,
} from "../services/gmgnScreener.js";

function assessment(overrides: Partial<GmgnHolderAssessment> = {}): GmgnHolderAssessment {
  return {
    holders: [],
    badWallets: [],
    badConcentrationPct: 0,
    top1: null,
    checkedAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

const holder = (pct: number, tags: string[], unrealizedX: number | null = null, costUsd = 0) => ({
  pct, tags, unrealizedX, costUsd,
});

const reason0 = (v: { reasons: string[] }): string => v.reasons[0] ?? "";

describe("judgeGmgnHolders", () => {
  it("passes a clean pool (no bad wallets, normal top holder)", () => {
    const v = judgeGmgnHolders(assessment({
      holders: [holder(5, ["top_holder"], 1.5, 50_000)],
      top1: holder(5, ["top_holder"], 1.5, 50_000),
    }), { maxBadConcentrationPct: 15, mode: "report" });
    assert.equal(v.reject, false);
    assert.deepEqual(v.reasons, []);
  });

  it("flags a free-insider top holder in report mode but does not reject", () => {
    const v = judgeGmgnHolders(assessment({
      top1: holder(7.09, ["top_holder", "transfer_in"], 462, 2_715),
    }), { maxBadConcentrationPct: 15, mode: "report" });
    assert.equal(v.reject, false); // report mode never rejects
    assert.ok(v.reasons.length > 0);
    assert.match(reason0(v), /insider dump risk/);
  });

  it("rejects a free-insider top holder in enforce mode", () => {
    const v = judgeGmgnHolders(assessment({
      top1: holder(7.09, ["top_holder", "transfer_in"], 462, 2_715),
    }), { maxBadConcentrationPct: 15, mode: "enforce" });
    assert.equal(v.reject, true);
    assert.ok(v.reasons.length > 0);
  });

  it("does NOT flag a top holder who paid real money even at high multiple", () => {
    const v = judgeGmgnHolders(assessment({
      top1: holder(49, ["top_holder"], 3, 87_000_000),
    }), { maxBadConcentrationPct: 15, mode: "enforce" });
    assert.equal(v.reject, false);
    assert.deepEqual(v.reasons, []);
  });

  it("does NOT flag a transfer_in top holder at a low unrealized multiple", () => {
    // Jimothy-style: got tokens free but they are worth LESS now — not a dump threat.
    const v = judgeGmgnHolders(assessment({
      top1: holder(6.24, ["top_holder", "transfer_in"], -0.6, 0),
    }), { maxBadConcentrationPct: 15, mode: "enforce" });
    assert.equal(v.reject, false);
    assert.deepEqual(v.reasons, []);
  });

  it("flags bundler concentration above the threshold", () => {
    const bad = holder(1.5, ["bundler"], 5, 1000);
    const v = judgeGmgnHolders(assessment({
      badWallets: [bad, bad, bad, bad, bad, bad, bad], // 7 x 1.5 = 10.5%
      badConcentrationPct: 10.5,
    }), { maxBadConcentrationPct: 15, mode: "enforce" });
    assert.equal(v.reject, false); // 10.5 < 15
    const v2 = judgeGmgnHolders(assessment({
      badWallets: [holder(2.2, ["rat_trader"])],
      badConcentrationPct: 2.2,
    }), { maxBadConcentrationPct: 15, mode: "enforce" });
    assert.equal(v2.reject, false);
  });

  it("rejects heavy bundler concentration in enforce mode", () => {
    const bads = Array.from({ length: 8 }, () => holder(2, ["bundler"]));
    const v = judgeGmgnHolders(assessment({
      badWallets: bads,
      badConcentrationPct: 16, // 8 x 2% = 16% >= 15
    }), { maxBadConcentrationPct: 15, mode: "enforce" });
    assert.equal(v.reject, true);
    assert.match(reason0(v), /bundler\/sniper\/rat wallets hold 16.0%/);
  });

  it("report mode flags but never rejects even a worst-case pool", () => {
    const bads = Array.from({ length: 10 }, () => holder(2, ["bundler"]));
    const v = judgeGmgnHolders(assessment({
      badWallets: bads,
      badConcentrationPct: 20,
      top1: holder(9, ["top_holder", "transfer_in"], 400, 100),
    }), { maxBadConcentrationPct: 15, mode: "report" });
    assert.equal(v.reject, false);
    assert.equal(v.reasons.length, 2);
  });
});
