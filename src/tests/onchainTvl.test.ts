/**
 * Backtest on ON-CHAIN TVL (15 Sep 2026). The validation showed `k x volume` wrong by more than 2x
 * most of the time, so these tests pin the replacement's three promises: the measured TVL is used
 * or NOTHING (no silent fall back to the model), nothing reads a sample from after the bar, and a
 * run that did not ask for on-chain TVL is byte-identical to before.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultBacktestConfig, runSimulation, type BacktestConfig } from "../backtest/engine.js";
import type { Bar, PoolHistory } from "../backtest/historicalData.js";
import { tvlAtBar, type TvlModel } from "../backtest/tvlModel.js";
import {
  classifyPricing,
  closedBarPrice,
  ensureTvlSeries,
  gridTimes,
  lookupTvl,
  orientationCheck,
  seriesPoints,
  tvlFromSample,
  type OnchainTvlDeps,
  type PoolReserveMeta,
} from "../backtest/onchainTvl.js";
import { loadWindowDataset, selectWindowUniverse } from "../backtest/windowUniverse.js";
import type { UniversePool } from "../backtest/universe.js";
import { WSOL_MINT } from "../config/constants.js";

const HOUR = 3600;
const T0 = 1_700_000_000 - (1_700_000_000 % (12 * HOUR));
const cacheDir = mkdtempSync(join(tmpdir(), "flowmetrix-onchain-tvl-"));
after(() => {
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    // Windows may hold it; not a test result.
  }
});

const bars = (prices: number[], volume = 5_000, start = T0): Bar[] => prices.map((c, i) => ({ t: start + i * HOUR, o: c, h: c, l: c, c, v: volume }));

describe("pure pieces", () => {
  it("grid instants are aligned to the cadence, so every window shares one cache", () => {
    const g = gridTimes(T0 + 1, T0 + 49 * HOUR, 12 * HOUR);
    assert.deepEqual(g, [T0 + 12 * HOUR, T0 + 24 * HOUR, T0 + 36 * HOUR, T0 + 48 * HOUR]);
  });

  it("prices from the bar that had CLOSED by T — never the bar still open at T", () => {
    const b = bars([1, 2, 3]);
    assert.equal(closedBarPrice(b, T0 + HOUR), 1, "bar 0 closes exactly at T0+1h");
    assert.equal(closedBarPrice(b, T0 + HOUR - 1), null, "nothing had closed yet");
    assert.equal(closedBarPrice(b, T0 + 2.5 * HOUR), 2, "bar 2 is open at T0+2.5h and must not be read");
  });

  it("prices only through wSOL or a stable on the Y side; anything else is refused, not guessed", () => {
    const m = (y: { address: string; symbol: string }): PoolReserveMeta => ({ reserve_x: "rx", reserve_y: "ry", token_x: { address: "x", symbol: "X" }, token_y: y });
    assert.deepEqual(classifyPricing(m({ address: WSOL_MINT, symbol: "SOL" })), { side: "y-sol" });
    assert.deepEqual(classifyPricing(m({ address: "usdc", symbol: "USDC" })), { side: "y-stable" });
    assert.ok("refused" in classifyPricing(m({ address: "hype", symbol: "HYPE" })));
  });

  it("orientation: a day of memecoin drift passes, an inverted pair does not, and no price is 'unchecked'", () => {
    assert.equal(orientationCheck(1.5, 1), "ok");
    assert.equal(orientationCheck(1, 83), "mismatch");
    assert.equal(orientationCheck(1, null), "unchecked");
  });

  it("TVL = x * base USD + y * (SOL or 1); a missing price is null, never 0", () => {
    assert.equal(tvlFromSample({ x: 100, y: 2, side: "y-sol", baseUsd: 3, solUsd: 150 }), 600);
    assert.equal(tvlFromSample({ x: 100, y: 2, side: "y-stable", baseUsd: 3, solUsd: null }), 302);
    assert.equal(tvlFromSample({ x: 100, y: 2, side: "y-sol", baseUsd: 3, solUsd: null }), null);
    assert.equal(tvlFromSample({ x: 100, y: 2, side: "y-stable", baseUsd: null, solUsd: 1 }), null);
  });

  it("lookup takes the last sample at or before t and refuses a stale one", () => {
    const pts = [{ t: 100, tvlUsd: 1 }, { t: 200, tvlUsd: 2 }];
    assert.equal(lookupTvl(pts, 199, 1000), 1);
    assert.equal(lookupTvl(pts, 200, 1000), 2);
    assert.equal(lookupTvl(pts, 99, 1000), null);
    assert.equal(lookupTvl(pts, 1300, 1000), null, "1100s old against a 1000s limit");
  });
});

describe("tvlAtBar and the engine", () => {
  const pool = (over: Partial<PoolHistory> = {}): PoolHistory => ({
    address: "poolA", pairName: "AAA-SOL", baseSymbol: "AAA", quoteSymbol: "USDC", baseMint: "mintA", quoteMint: WSOL_MINT,
    tvlTodayUsd: 100_000, createdAtMs: 1_600_000_000_000, feeRate: 0.01, binStep: 20, quoteIsUsd: true, cohort: "survivor",
    lifetimeVolumeUsd: 10_000_000, bars: bars(Array(100).fill(100)), ...over,
  });
  const k = 0.2083333333333333; // 24 x 5,000 x k = $25,000
  const model: TvlModel = { medianK: k, p25K: k, p75K: k, samples: 10, perPoolK: { poolA: k } };
  const cfg: BacktestConfig = {
    ...defaultBacktestConfig(), startingCapitalUsd: null, gasSolPerTransaction: 0, forcedExitSlippagePct: 2, minTvlUsd: 0,
    maxFeeTvlRatio: 999, maxPriceChange24hPct: 1e9, minFeeCostCoverage: 0, positionSizePct: 100, takeProfitFeePct: Number.POSITIVE_INFINITY,
  };
  const solBars = bars(Array(600).fill(100), 0);
  const run = (m: TvlModel) => runSimulation({ label: "t", pools: [pool()], solUsdBars: solBars, tvlModel: m, config: cfg });

  it("without series, tvlAtBar is exactly the volume model", () => {
    assert.equal(tvlAtBar(model, "poolA", 120_000, T0), k * 120_000);
  });

  it("a series equal to what the model said reproduces the model run exactly", () => {
    const series = { poolA: Array.from({ length: 100 }, (_, i) => ({ t: T0 + i * HOUR, tvlUsd: k * 120_000 })) };
    const a = run(model);
    const b = run({ ...model, series, seriesMaxStaleSec: 2 * HOUR });
    assert.ok(a.trades.length > 0);
    assert.deepEqual(b.summary, a.summary);
  });

  it("a pool with no series is REFUSED as tvlUnknown — never priced with k", () => {
    const r = run({ ...model, series: {}, seriesMaxStaleSec: 2 * HOUR });
    assert.equal(r.trades.length, 0);
    assert.ok((r.gateRejections.tvlUnknown ?? 0) > 0);
  });

  it("a stale series is unknown too, and the real TVL moves the band decision the model got wrong", () => {
    const stale = run({ ...model, series: { poolA: [{ t: T0, tvlUsd: 25_000 }] }, seriesMaxStaleSec: 2 * HOUR });
    assert.equal(stale.trades.length, 0);
    const series = { poolA: Array.from({ length: 100 }, (_, i) => ({ t: T0 + i * HOUR, tvlUsd: 2_000_000 })) };
    const banded = runSimulation({ label: "t", pools: [pool()], solUsdBars: solBars, tvlModel: { ...model, series, seriesMaxStaleSec: 2 * HOUR }, config: { ...cfg, maxTvlUsd: 500_000 } });
    assert.equal(banded.trades.length, 0, "model said $25k (in band), chain says $2M (above it)");
    assert.ok((banded.gateRejections.highTvl ?? 0) > 0);
  });
});

describe("ensureTvlSeries", () => {
  const meta: PoolReserveMeta = { reserve_x: "RX", reserve_y: "RY", token_x: { address: "x", symbol: "AAA", price: 2 }, token_y: { address: WSOL_MINT, symbol: "SOL" } };
  const priceBars = bars(Array(48).fill(2));
  const sol = bars(Array(48).fill(100), 0);

  it("fetches each instant once, caches settled answers, and does NOT cache a transport failure", async () => {
    const calls: string[] = [];
    let failT: number | null = T0 + 24 * HOUR;
    const deps: OnchainTvlDeps = {
      poolMeta: async () => meta,
      reserveAt: async (account, t) => {
        calls.push(`${account}@${t}`);
        if (t === failT) throw new Error("429");
        if (t < T0 + 12 * HOUR) return null; // before the pool's first tx
        return account === "RX" ? 1_000 : 10;
      },
      log: () => undefined,
    };
    const times = [T0, T0 + 12 * HOUR, T0 + 24 * HOUR];
    const first = await ensureTvlSeries({ address: "P1", bars: priceBars, solUsdBars: sol, times, deps, cacheDir, concurrency: 2 });
    assert.equal(first.failed, 1);
    assert.equal(first.file.samples[String(T0)]?.tvlUsd, null, "no tx before T is a settled null, with a reason");
    assert.match(first.file.samples[String(T0)]?.reason ?? "", /no reserve balance/);
    assert.equal(first.file.samples[String(T0 + 12 * HOUR)]?.tvlUsd, 1_000 * 2 + 10 * 100);
    assert.equal(first.file.samples[String(T0 + 24 * HOUR)], undefined, "the 429 is not remembered as an answer");

    calls.length = 0;
    failT = null;
    const second = await ensureTvlSeries({ address: "P1", bars: priceBars, solUsdBars: sol, times, deps, cacheDir });
    assert.deepEqual(calls.sort(), [`RX@${T0 + 24 * HOUR}`, `RY@${T0 + 24 * HOUR}`], "only the failed instant is refetched");
    assert.deepEqual(seriesPoints(second.file, T0, T0 + 48 * HOUR).map((p) => p.t), [T0 + 12 * HOUR, T0 + 24 * HOUR]);
  });

  it("an instant before the pool was created is a settled null and costs no RPC read", async () => {
    let reads = 0;
    const deps: OnchainTvlDeps = { poolMeta: async () => meta, reserveAt: async () => (reads++, 5), log: () => undefined };
    const r = await ensureTvlSeries({ address: "P9", bars: priceBars, solUsdBars: sol, times: [T0, T0 + 12 * HOUR], deps, cacheDir, createdAtSec: T0 + 6 * HOUR });
    assert.equal(reads, 2, "only the instant after creation is read (two reserves)");
    assert.equal(r.file.samples[String(T0)]?.reason, "before pool creation");
    assert.equal(r.file.samples[String(T0)]?.tvlUsd, null);
  });

  it("refuses — and remembers refusing — an unpriceable pair and a mis-oriented price; an unreadable meta is not remembered", async () => {
    let reserveCalls = 0;
    const deps = (m: PoolReserveMeta | null): OnchainTvlDeps => ({ poolMeta: async () => m, reserveAt: async () => (reserveCalls++, 1), log: () => undefined });
    const hype = await ensureTvlSeries({ address: "P2", bars: priceBars, solUsdBars: sol, times: [T0 + 12 * HOUR], deps: deps({ ...meta, token_y: { address: "h", symbol: "HYPE" } }), cacheDir });
    assert.match(hype.file.refused ?? "", /neither wSOL nor a stable/);
    const inverted = await ensureTvlSeries({ address: "P3", bars: priceBars, solUsdBars: sol, times: [T0 + 12 * HOUR], deps: deps({ ...meta, token_x: { ...meta.token_x, price: 166 } }), cacheDir });
    assert.match(inverted.file.refused ?? "", /base is not token_x/);
    const again = await ensureTvlSeries({ address: "P3", bars: priceBars, solUsdBars: sol, times: [T0 + 12 * HOUR], deps: deps(meta), cacheDir });
    assert.ok(again.file.refused, "a persisted refusal is not re-litigated with a different meta");
    const noMeta = await ensureTvlSeries({ address: "P4", bars: priceBars, solUsdBars: sol, times: [T0 + 12 * HOUR], deps: deps(null), cacheDir });
    assert.match(noMeta.file.refused ?? "", /meta unreadable/);
    const recovered = await ensureTvlSeries({ address: "P4", bars: priceBars, solUsdBars: sol, times: [T0 + 12 * HOUR], deps: deps(meta), cacheDir });
    assert.equal(recovered.file.refused, null, "the API being down is not a fact about the pool");
    assert.equal(reserveCalls, 2);
  });
});

describe("window selection on on-chain TVL", () => {
  const W = { start: T0, end: T0 + 30 * 24 * HOUR };
  const up = (address: string, over: Partial<UniversePool> = {}): UniversePool => ({
    address, pairName: `${address}-SOL`, baseSymbol: address, quoteSymbol: "SOL", baseMint: `${address}m`, quoteMint: WSOL_MINT,
    createdAtMs: (T0 - 100 * 86_400) * 1000, binStep: 100, feeRate: 0.01, tvlTodayUsd: 100_000, volume24hTodayUsd: 500_000,
    lifetimeVolumeUsd: 1e7, bothTokensVerified: true, isBlacklisted: false, cohort: "survivor", ...over,
  });
  const inWin = bars(Array(30 * 24).fill(1), 1_000, T0);

  it("the band reads the measured TVL; unknown is rejected and counted, not modelled", () => {
    const sel = selectWindowUniverse({
      candidates: [{ pool: up("IN"), bars: inWin }, { pool: up("BIG"), bars: inWin }, { pool: up("NONE"), bars: inWin }],
      window: W,
      n: 10,
      // k would put all three at $4.8k — below the band. The chain disagrees for IN.
      tvlBand: { minUsd: 50_000, maxUsd: 500_000, k: 0.2 },
      tvlOf: (a) => (a === "IN" ? 120_000 : a === "BIG" ? 9_000_000 : null),
    });
    assert.deepEqual(sel.selected.map((s) => s.pool.address), ["IN"]);
    assert.equal(sel.rejected.tvlBand, 2);
    assert.deepEqual(sel.tvlBandDetail, { belowMin: 0, aboveMax: 1, unknown: 1 });
  });

  it("loadWindowDataset carries the series, marks its basis, and re-selects a model-basis cache", async () => {
    const dir = join(cacheDir, "window");
    const deps = {
      buildUniverse: async () => ({ pools: [up("IN"), up("OUT")], survivors: 2, deadOrDormant: 0, scanned: 2, totalUniverseSize: 2 }),
      fetchBars: async () => inWin,
      log: () => undefined,
      nowMs: () => (W.end + 86_400) * 1000,
    };
    const base = { window: W, n: 5, candidatesCap: 10, solUsdPool: "SOLUSDC", refresh: false, cacheDir: dir, tvlBand: { minUsd: 50_000, maxUsd: 500_000 }, deps };
    const model = await loadWindowDataset(base);
    assert.equal(model.dataset.selection.tvlBasis, "model");
    assert.equal(model.dataset.tvlSeries, undefined);

    const asked: string[] = [];
    const onchain = await loadWindowDataset({
      ...base,
      onchainTvl: {
        cadenceSec: 12 * HOUR,
        seriesFor: async (address, times) => {
          asked.push(address);
          assert.ok(times[0]! < W.start, "the grid starts one cadence before the window");
          return address === "IN"
            ? { points: times.map((t) => ({ t, tvlUsd: 100_000 })), refused: null }
            : { points: [], refused: "token_y HYPE is neither wSOL nor a stable: not priced" };
        },
      },
    });
    assert.notEqual(onchain.cache, "hit", "a model-basis cache is not served to an on-chain run");
    assert.deepEqual(asked.sort(), ["IN", "OUT"]);
    assert.equal(onchain.dataset.selection.tvlBasis, "onchain");
    assert.equal(onchain.dataset.selection.k, null);
    assert.deepEqual(onchain.dataset.pools.map((p) => p.address), ["IN"]);
    assert.ok((onchain.dataset.tvlSeries?.IN?.length ?? 0) > 0);
    assert.deepEqual(onchain.dataset.selection.tvlRefusals, { "token_y HYPE is neither wSOL nor a stable: not priced": 1 });
  });
});

describe("runner flags", () => {
  it("--tvl defaults to model; cadence must divide a day", async () => {
    const { readTvlFlags } = await import("../backtest/runIntegrity.js");
    assert.deepEqual(readTvlFlags(new Map()), { basis: "model", cadenceSec: 12 * HOUR, concurrency: 6 });
    assert.deepEqual(readTvlFlags(new Map([["tvl", "onchain"], ["tvl-cadence-hours", "6"]])), { basis: "onchain", cadenceSec: 6 * HOUR, concurrency: 6 });
    assert.throws(() => readTvlFlags(new Map([["tvl", "k"]])), /model or onchain/);
    assert.throws(() => readTvlFlags(new Map([["tvl-cadence-hours", "5"]])), /divide 24/);
  });
});
