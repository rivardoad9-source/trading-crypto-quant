/**
 * The TVL validation's arithmetic. The comparison it produces decides whether any backtest
 * conclusion stands, so the pieces that turn chain readings into a TVL and a TVL into a verdict
 * are pinned offline, with no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bandConfusion,
  evaluateKVariant,
  impliedK,
  postBalanceOf,
  spearman,
  summariseErrors,
  topNOverlap,
  tvlFromReserves,
  type TvlObservation,
} from "../backtest/tvlValidation.js";

const flags = { xIsSol: false, yIsSol: false, xIsStable: false, yIsStable: false };

describe("tvlFromReserves", () => {
  it("prices a TOKEN-SOL pool through SOL, matching the 14 Sep fone-SOL self-check shape", () => {
    // 5,533,836 fone at 0.0000661 SOL + 2,070 SOL, SOL $102.39 → ~$249k (Meteora API said $249,368).
    const tvl = tvlFromReserves({ ...flags, yIsSol: true, x: 5_533_836, y: 2_070.03, ratioYPerX: 0.0000661097, solUsd: 102.39 });
    assert.ok(tvl !== null && Math.abs(tvl - 249_400) / 249_400 < 0.01, String(tvl));
  });

  it("prices SOL-USDC through the stable side and needs no SOL price", () => {
    assert.equal(tvlFromReserves({ ...flags, xIsSol: true, yIsStable: true, x: 10, y: 1_000, ratioYPerX: 100, solUsd: null }), 2_000);
  });

  it("prices SOL-TOKEN (SOL as X) through SOL", () => {
    assert.equal(tvlFromReserves({ ...flags, xIsSol: true, x: 10, y: 2_000, ratioYPerX: 1_000, solUsd: 100 }), 1_200);
  });

  it("refuses to guess: no SOL or stable side, no SOL price, or an unusable ratio → null", () => {
    assert.equal(tvlFromReserves({ ...flags, x: 1, y: 1, ratioYPerX: 1, solUsd: 100 }), null);
    assert.equal(tvlFromReserves({ ...flags, yIsSol: true, x: 1, y: 1, ratioYPerX: 1, solUsd: null }), null);
    assert.equal(tvlFromReserves({ ...flags, yIsStable: true, x: 1, y: 1, ratioYPerX: 0, solUsd: 1 }), null);
  });
});

describe("postBalanceOf", () => {
  const tx = {
    transaction: { message: { accountKeys: [{ pubkey: "payer" }, { pubkey: "RESERVE_X" }, "RESERVE_Y"] } },
    meta: {
      postTokenBalances: [
        { accountIndex: 1, uiTokenAmount: { uiAmountString: "10607756.25217", amount: "10607756252170", decimals: 6 } },
        { accountIndex: 2, uiTokenAmount: { amount: "3140411992982", decimals: 9 } },
      ],
    },
  };
  it("reads the reserve's post-balance by account key, from either key shape", () => {
    assert.equal(postBalanceOf(tx, "RESERVE_X"), 10607756.25217);
    assert.equal(postBalanceOf(tx, "RESERVE_Y"), 3140.411992982);
  });
  it("is null — not 0 — when the tx does not carry the account", () => {
    assert.equal(postBalanceOf(tx, "OTHER"), null);
    assert.equal(postBalanceOf(null, "RESERVE_X"), null);
  });
});

describe("statistics", () => {
  it("summarises the error in log2 units and counts within-2x", () => {
    const s = summariseErrors([
      { modelled: 100, real: 100 },
      { modelled: 50, real: 100 },
      { modelled: 400, real: 100 },
      { modelled: 0, real: 100 }, // unusable, excluded rather than read as infinitely wrong
    ]);
    assert.equal(s.n, 3);
    assert.equal(s.log2Ratio.median, 0);
    assert.equal(s.within2x, 2 / 3);
  });

  it("classifies band decisions from the backtest's point of view", () => {
    const band = { minUsd: 50_000, maxUsd: 500_000 };
    assert.deepEqual(
      bandConfusion(
        [
          { modelled: 100_000, real: 100_000 },
          { modelled: 10_000, real: 10_000 },
          { modelled: 100_000, real: 10_000 }, // backtest trades it, live would not
          { modelled: 10_000, real: 100_000 }, // backtest never sees it
        ],
        band,
      ),
      { bothIn: 1, bothOut: 1, falseAccept: 1, falseReject: 1 },
    );
  });

  it("spearman: 1 for the same order, -1 reversed, null when undefined", () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
    assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
    assert.equal(spearman([1, 2], [1, 2]), null);
    assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
  });

  it("topNOverlap measures whether the same pools lead both rankings", () => {
    const items = [
      { id: "a", a: 3, b: 1 },
      { id: "b", a: 2, b: 2 },
      { id: "c", a: 1, b: 3 },
    ];
    assert.equal(topNOverlap(items, 1), 0);
    assert.equal(topNOverlap(items, 3), 1);
  });
});

describe("evaluateKVariant — the structural point, measured", () => {
  const obs = (feeRate: number, vol: number, real: number, kToday: number | null = null): TvlObservation => ({
    pool: `P${feeRate}-${vol}`,
    pairName: "X-SOL",
    window: "W1",
    t: 1,
    feeRate,
    vol24hUsd: vol,
    realTvlUsd: real,
    perPoolKToday: kToday,
  });

  it("with ONE global k, modelled fee/TVL is feeRate / k whatever the volume", () => {
    const e = evaluateKVariant([obs(0.01, 1_000, 5_000), obs(0.01, 1_000_000, 5_000)], 0.5, { minUsd: 0, maxUsd: 1e12 }, { min: 0.019, max: 0.25 });
    // 0.01 / 0.5 = 0.02 for both pools: both pass the model's gate, whatever the real TVL says.
    assert.equal(e.feeTvlGate.modelledPass, 2);
    // On-chain: 0.01 x 1000 / 5000 = 0.002 (fails) and 0.01 x 1e6 / 5000 = 2 (outlier ceiling): neither passes.
    assert.equal(e.feeTvlGate.realPass, 0);
  });

  it("per-pool k today skips pools with no usable k rather than inventing one", () => {
    const e = evaluateKVariant([obs(0.01, 1_000, 5_000, 5), obs(0.01, 1_000, 5_000, null)], "per-pool-today", { minUsd: 0, maxUsd: 1e12 }, { min: 0, max: 1 });
    assert.equal(e.n, 1);
    assert.equal(e.errors.log2Ratio.median, 0);
  });

  it("separates TIME from COMPOSITION: the same pools unchanged, the global median moved by the mix", async () => {
    const { impliedKByGroup, samePoolKDrift, impliedK: ik } = await import("../backtest/tvlValidation.js");
    const o = (pool: string, window: string, k: number, pair = "X-SOL"): TvlObservation => ({
      pool, pairName: pair, window, t: 1, feeRate: 0.01, vol24hUsd: 1_000, realTvlUsd: 1_000 * k, perPoolKToday: null,
    });
    const obsAll = [
      o("MEME", "W1", 0.2), o("MEME", "W2", 0.2),
      o("MAJOR", "W2", 4, "M-USDC"),
      o("MAJOR2", "W2", 4, "N-USDC"),
    ];
    assert.equal(ik(obsAll.filter((x) => x.window === "W1")).median, 0.2);
    assert.equal(ik(obsAll.filter((x) => x.window === "W2")).median, 4, "the global median jumped 20x");
    assert.deepEqual(samePoolKDrift(obsAll, "W1", "W2"), { pools: 1, medianLog2OlderOverNewer: 0 }, "the only shared pool did not move");
    const g = impliedKByGroup(obsAll.filter((x) => x.window === "W2"), (x) => (x.pairName.endsWith("USDC") ? "usd" : "sol"));
    assert.deepEqual([g.usd?.median, g.sol?.median], [4, 0.2]);
  });

  it("impliedK is real TVL over trailing volume", () => {
    assert.deepEqual(impliedK([obs(0.01, 1_000, 5_000), obs(0.01, 1_000, 3_000)]).median, 4);
  });
});

describe("validateTvlModel script safety", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "validateTvlModel.ts"), "utf8");
  it("reads only: no executor, no signing, no send", () => {
    assert.equal(/onchainExecutor|liveExecution|sendTransaction|sendAndConfirm|Keypair|\.sign\(/.test(src), false);
  });
  it("never echoes the RPC URL (it carries the provider key)", () => {
    assert.equal(/console\.[a-z]+\([^)]*SOLANA_RPC_URL/.test(src), false);
    assert.equal(/Error\([^)]*SOLANA_RPC_URL/.test(src), false);
  });
});
