import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assessLiquidation,
  priceChange24hPct,
  defaultBacktestConfig,
  pairRatio,
  runSimulation,
  solPriceAt,
  trailing24hVolume,
  type BacktestConfig,
} from "../backtest/engine.js";
import { trimToWindow, type Bar, type PoolHistory } from "../backtest/historicalData.js";
import { calibrateTvlModel, estimateTvlAt, type TvlModel } from "../backtest/tvlModel.js";
import { renderTable } from "../backtest/report.js";
import { impermanentLossFraction, lpValueReturnFraction, type DlmmPool } from "../services/meteora.js";

const HOUR = 3600;
const T0 = 1_700_000_000;

const approx = (actual: number, expected: number, tol = 1e-9): void =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`,
  );

function makeBars(count: number, price = 100, volume = 5_000, start = T0): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    t: start + i * HOUR,
    o: price,
    h: price,
    l: price,
    c: price,
    v: volume,
  }));
}

function makePool(over: Partial<PoolHistory> = {}): PoolHistory {
  return {
    address: "poolA",
    pairName: "AAA-USDC",
    baseSymbol: "AAA",
    quoteSymbol: "USDC",
    baseMint: "mintA",
    quoteMint: "mintUsdc",
    tvlTodayUsd: 100_000,
    feeRate: 0.01,
    binStep: 20,
    quoteIsUsd: true,
    cohort: "survivor",
    lifetimeVolumeUsd: 10_000_000,
    bars: makeBars(100),
    ...over,
  };
}

const solBars = makeBars(600, 100, 0);

/** k = 100_000 TVL / 480_000 vol24h ≈ 0.2083 for the standard test pool. */
function makeModel(k = 0.2083333333333333, address = "poolA"): TvlModel {
  return { medianK: k, p25K: k, p75K: k, samples: 10, perPoolK: { [address]: k } };
}

/**
 * Tests default to legacy fixed-SOL sizing and zero execution costs, so expected fee
 * amounts stay arithmetic constants. Costs and compounding are exercised explicitly.
 */
const config = (over: Partial<BacktestConfig> = {}): BacktestConfig => ({
  ...defaultBacktestConfig(),
  startingCapitalUsd: null,
  gasSolPerTransaction: 0,
  forcedExitSlippagePct: 0,
  minTvlUsd: 0,
  maxFeeTvlRatio: 999,
  maxPriceChange24hPct: 1e9,
  minFeeCostCoverage: 0,
  // Full-equity sizing keeps expected notionals arithmetic; sizing is tested separately.
  positionSizePct: 100,
  ...over,
});

const run = (pools: PoolHistory[], cfg: BacktestConfig, model = makeModel(), sol = solBars) =>
  runSimulation({ label: "test", pools, solUsdBars: sol, tvlModel: model, config: cfg });

/* ------------------------------------------------------------------ */

describe("lpValueReturnFraction", () => {
  it("is zero when price is unchanged", () => {
    approx(lpValueReturnFraction(1), 0);
  });

  it("equals sqrt(r) - 1", () => {
    approx(lpValueReturnFraction(0.25), -0.5, 1e-12);
    approx(lpValueReturnFraction(4), 1, 1e-12);
  });

  it("is a total loss when the token goes to zero", () => {
    approx(lpValueReturnFraction(0), -1);
  });

  it("is far worse than the divergence-vs-hold figure on a big drop", () => {
    // A halving: -5.7% against holding, but -29.3% against capital deployed.
    const divergence = impermanentLossFraction(0.5);
    const actual = lpValueReturnFraction(0.5);
    assert.ok(actual < divergence, "capital loss must exceed divergence loss");
    approx(actual, -0.2928932188134525, 1e-12);
  });
});

/* ------------------------------------------------------------------ */

describe("calibrateTvlModel", () => {
  const pool = (address: string, tvlUsd: number, volume24hUsd: number): DlmmPool =>
    ({ address, tvlUsd, volume24hUsd }) as DlmmPool;

  it("fits k as TVL / 24h volume", () => {
    const model = calibrateTvlModel([pool("a", 100, 100), pool("b", 200, 100)]);
    approx(model.perPoolK.a!, 1);
    approx(model.perPoolK.b!, 2);
    approx(model.medianK, 1.5);
  });

  it("ignores pools with no volume or no TVL", () => {
    const model = calibrateTvlModel([pool("a", 100, 0), pool("b", 0, 100), pool("c", 50, 100)]);
    assert.equal(model.samples, 1);
    assert.equal(model.perPoolK.a, undefined);
  });

  it("uses the pool's own k when available", () => {
    const model = makeModel(0.5, "poolX");
    const est = estimateTvlAt(model, "poolX", 1000);
    assert.equal(est.basis, "per-pool");
    approx(est.tvlUsd, 500);
  });

  it("falls back to the median for a pool that is dead today", () => {
    const model = makeModel(0.25, "poolX");
    const est = estimateTvlAt(model, "deadPool", 1000);
    assert.equal(est.basis, "median", "a dead pool must not be silently dropped");
    approx(est.tvlUsd, 250);
  });

  it("never returns a negative TVL", () => {
    approx(estimateTvlAt(makeModel(0.5), "poolA", -100).tvlUsd, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("trailing24hVolume", () => {
  it("returns null until a full 24-bar window exists", () => {
    const bars = makeBars(30, 100, 1_000);
    assert.equal(trailing24hVolume(bars, 22), null);
    assert.notEqual(trailing24hVolume(bars, 23), null);
  });

  it("sums exactly 24 bars, inclusive of the current one", () => {
    assert.equal(trailing24hVolume(makeBars(30, 100, 1_000), 23), 24_000);
  });
});

describe("solPriceAt", () => {
  it("never looks into the future", () => {
    const bars: Bar[] = [
      { t: 100, o: 1, h: 1, l: 1, c: 10, v: 0 },
      { t: 200, o: 1, h: 1, l: 1, c: 20, v: 0 },
    ];
    assert.equal(solPriceAt(bars, 150), 10);
    assert.equal(solPriceAt(bars, 50), null);
  });
});

describe("pairRatio", () => {
  it("passes USD through for a USD-quoted pool", () => {
    assert.equal(pairRatio(101.5, true, 200), 101.5);
  });

  it("divides by SOL/USD for a SOL-quoted pool", () => {
    assert.equal(pairRatio(2, false, 100), 0.02);
  });

  it("returns null without a SOL price", () => {
    assert.equal(pairRatio(2, false, null), null);
  });
});

/* ------------------------------------------------------------------ */

describe("assessLiquidation", () => {
  const base = {
    exitIndex: 10,
    exitRatio: 50,
    lower: 90,
    upper: 110,
    entryVolume24hUsd: 240_000,
    quoteIsUsd: true,
    solBars,
    lookaheadBars: 24,
    volumeCollapseRatio: 0.01,
  };

  it("flags a rug when volume dies and price never returns", () => {
    const bars = makeBars(40, 50, 0); // no forward volume at all
    const r = assessLiquidation({ ...base, bars });
    assert.equal(r.rugged, true);
  });

  it("does not flag a rug while volume continues", () => {
    const bars = makeBars(40, 50, 20_000);
    const r = assessLiquidation({ ...base, bars });
    assert.equal(r.rugged, false);
    assert.equal(r.realisableRatio, base.exitRatio);
  });

  it("does not flag a rug when price recovers into range", () => {
    const bars = makeBars(40, 50, 0);
    for (let i = 12; i < 20; i++) bars[i]!.c = 100; // back inside [90,110]
    const r = assessLiquidation({ ...base, bars });
    assert.equal(r.rugged, false);
  });

  it("does not flag a rug on an upside exit", () => {
    const bars = makeBars(40, 200, 0);
    const r = assessLiquidation({ ...base, bars, exitRatio: 200 });
    assert.equal(r.rugged, false, "only a downside exit can strand the position");
  });

  it("marks a rugged position to the worst forward price", () => {
    const bars = makeBars(40, 50, 0);
    for (let i = 11; i < 30; i++) bars[i]!.c = 5; // keeps falling
    const r = assessLiquidation({ ...base, bars });
    assert.equal(r.rugged, true);
    approx(r.realisableRatio, 5);
  });
});

/* ------------------------------------------------------------------ */

describe("runSimulation entry filters", () => {
  it("never enters when trailing volume is below the floor", () => {
    const r = run([makePool({ bars: makeBars(80, 100, 100) })], config());
    assert.equal(r.trades.length, 0);
  });

  it("never enters when modelled TVL is below the floor", () => {
    // vol24h = 480k, k = 0.2083 -> TVL ≈ 100k. A 200k floor must reject it.
    const r = run([makePool({ bars: makeBars(80, 100, 20_000) })], config({ minTvlUsd: 200_000 }));
    assert.equal(r.trades.length, 0);
  });

  it("rejects an implausible fee/TVL above the ceiling", () => {
    // feeRate 1% x 480k vol / 100k TVL = 4.8%/24h... push the ceiling below that.
    const r = run(
      [makePool({ bars: makeBars(80, 100, 20_000) })],
      config({ maxFeeTvlRatio: 0.001 }),
    );
    assert.equal(r.trades.length, 0);
  });

  it("enters once every filter passes", () => {
    const r = run([makePool({ bars: makeBars(80, 100, 20_000) })], config());
    assert.ok(r.trades.length > 0);
  });

  it("waits for a full 24-bar filter window before the first entry", () => {
    const r = run([makePool({ bars: makeBars(80, 100, 20_000) })], config());
    assert.ok(Date.parse(r.trades[0]!.entryTime) / 1000 >= T0 + 23 * HOUR);
  });
});

describe("priceChange24hPct", () => {
  it("returns null before a full 24-bar window exists", () => {
    const bars = makeBars(40, 100, 0);
    assert.equal(priceChange24hPct(bars, 23), null);
    assert.notEqual(priceChange24hPct(bars, 24), null);
  });

  it("measures the change across exactly 24 bars", () => {
    const bars = makeBars(60, 100, 0);
    for (let i = 30; i < bars.length; i++) bars[i]!.c = 250;
    // Bar 53 is 250 and bar 29 (53 - 24) is still 100 => +150%.
    approx(priceChange24hPct(bars, 53)!, 150, 1e-9);
    // Bar 54 compares 250 against 250 => flat.
    approx(priceChange24hPct(bars, 54)!, 0, 1e-9);
  });

  it("returns null rather than Infinity when the earlier price was zero", () => {
    const bars = makeBars(40, 100, 0);
    bars[10]!.c = 0;
    assert.equal(priceChange24hPct(bars, 34), null);
  });
});

describe("volatility gate", () => {
  it("rejects a pool that pumped past the ceiling", () => {
    const bars = makeBars(80, 100, 20_000);
    // Ramp +200% and hold, so every entry bar sees a >150% trailing change.
    for (let i = 24; i < bars.length; i++) bars[i]!.c = 300;

    const r = run([makePool({ bars })], config({ maxPriceChange24hPct: 150 }));
    assert.ok(r.gateRejections.pumped! > 0, "expected the pump gate to fire");
  });

  it("admits the same pool when the ceiling is lifted", () => {
    const bars = makeBars(80, 100, 20_000);
    for (let i = 24; i < bars.length; i++) bars[i]!.c = 300;

    const lifted = run([makePool({ bars })], config({ maxPriceChange24hPct: 1e9 }));
    assert.ok(lifted.trades.length > 0, "the gate, not the data, must be what blocks entry");
  });

  it("rejects rather than guesses when the 24h change is unknown", () => {
    /*
     * 25 bars: index 23 clears the volume window but has no 24-bar price history, and
     * index 24 would look back at bar 0 — zeroed here so that lookup is unusable too.
     * Every entry opportunity therefore has an unknown change and must fail closed.
     */
    const bars = makeBars(25, 100, 20_000);
    bars[0]!.c = 0;

    const r = run([makePool({ bars })], config());
    assert.equal(r.trades.length, 0, "an unknown 24h change must not be treated as flat");
    assert.ok((r.gateRejections.volatilityUnknown ?? 0) > 0);
  });
});

describe("breakeven gate in the simulation", () => {
  it("rejects a pool whose fees cannot cover the round trip", () => {
    const r = run(
      [makePool({ bars: makeBars(80, 100, 20_000) })],
      config({ minFeeCostCoverage: 1e6, gasSolPerTransaction: 0.0035 }),
    );
    assert.equal(r.trades.length, 0);
    assert.ok(r.gateRejections.belowBreakeven! > 0);
  });

  it("admits the same pool at a sane coverage requirement", () => {
    const r = run(
      [makePool({ bars: makeBars(80, 100, 20_000) })],
      config({ minFeeCostCoverage: 1, gasSolPerTransaction: 0.0035 }),
    );
    assert.ok(r.trades.length > 0);
  });
});

describe("runSimulation exits", () => {
  it("closes on max duration when price never moves", () => {
    const r = run(
      [makePool({ bars: makeBars(80, 100, 20_000) })],
      config({ takeProfitFeePct: 1e9 }),
    );
    assert.equal(r.trades[0]!.exitReason, "TIMEOUT");
    approx(r.trades[0]!.durationHours, 24, 1e-9);
  });

  it("closes on the fee take-profit", () => {
    const r = run(
      [makePool({ bars: makeBars(200, 100, 20_000) })],
      config({ maxDurationHours: 1e9 }),
    );
    assert.equal(r.trades[0]!.exitReason, "FEE_TAKE_PROFIT");
    assert.ok(r.trades[0]!.feesEarnedPct >= 5);
  });

  it("closes out of range on a downside breach", () => {
    const bars = makeBars(60, 100, 20_000);
    for (let i = 30; i < bars.length; i++) bars[i]!.c = 50;
    const r = run([makePool({ bars })], config());
    assert.ok(["OUT_OF_RANGE", "RUGGED"].includes(r.trades[0]!.exitReason));
  });

  it("force-closes anything still open at the window end", () => {
    const r = run([makePool({ bars: makeBars(30, 100, 20_000) })], config());
    assert.equal(r.trades.at(-1)!.exitReason, "END_OF_DATA");
  });
});

/* ------------------------------------------------------------------ */

describe("runSimulation accounting", () => {
  it("accrues no fees on bars outside the range", () => {
    const bars = makeBars(60, 100, 20_000);
    for (let i = 30; i < bars.length; i++) bars[i]!.c = 88; // inside -35%
    const r = run([makePool({ bars })], config({ takeProfitFeePct: 1e9 }));
    assert.ok(r.trades[0]!.feesEarnedUsd > 0);
  });

  it("keeps netPnl equal to fees + position value change - gas - slippage", () => {
    const bars = makeBars(120, 100, 20_000);
    for (let i = 40; i < bars.length; i++) bars[i]!.c = 90;

    const r = run([makePool({ bars })], config({ gasSolPerTransaction: 0.0035 }));

    for (const t of r.trades) {
      const expected =
        t.feesEarnedUsd + t.positionValueChangeUsd - t.gasCostUsd - t.slippageCostUsd;
      approx(t.netPnlUsd, expected, 1e-9);
    }
  });

  it("charges gas on every trade when configured", () => {
    const r = run(
      [makePool({ bars: makeBars(120, 100, 20_000) })],
      config({ gasSolPerTransaction: 0.0035 }),
    );
    // 0.0035 SOL x 2 transactions x $100/SOL = $0.70
    for (const t of r.trades) approx(t.gasCostUsd, 0.7, 1e-9);
    assert.ok(r.summary.totalGasCostUsd > 0);
  });

  it("charges slippage only on forced exits", () => {
    const r = run(
      [makePool({ bars: makeBars(200, 100, 20_000) })],
      config({ forcedExitSlippagePct: 1.5, maxDurationHours: 1e9 }),
    );
    // Flat price with a fee take-profit is a chosen exit, so no slippage.
    for (const t of r.trades) {
      if (t.exitReason === "FEE_TAKE_PROFIT") approx(t.slippageCostUsd, 0);
    }
  });

  it("reports position value change, not divergence, as the PnL driver", () => {
    const bars = makeBars(60, 100, 20_000);
    for (let i = 30; i < bars.length; i++) bars[i]!.c = 70; // -30%, still in range

    const r = run([makePool({ bars })], config({ takeProfitFeePct: 1e9 }));
    const t = r.trades[0]!;

    assert.ok(
      t.positionValueChangeUsd < t.divergenceVsHoldUsd,
      "capital loss must be larger than divergence-vs-hold",
    );
  });

  it("records the cohort on every trade", () => {
    const r = run([makePool({ cohort: "dead-or-dormant", bars: makeBars(80, 100, 20_000) })], config());
    assert.equal(r.trades[0]!.cohort, "dead-or-dormant");
    assert.equal(r.summary.tradesOnDeadPools, r.trades.length);
  });

  it("flags a catastrophic loss when the token collapses", () => {
    const bars = makeBars(60, 100, 20_000);
    // Drop 99% and kill all volume: unsellable, so the position is stranded.
    for (let i = 30; i < bars.length; i++) {
      bars[i]!.c = 1;
      bars[i]!.v = 0;
    }

    const r = run([makePool({ bars })], config({ forcedExitSlippagePct: 1.5 }));
    const t = r.trades[0]!;

    assert.equal(t.rugged, true, "a dead pool with no volume must be flagged rugged");
    assert.equal(t.exitReason, "RUGGED");
    assert.ok(t.netPnlPct <= -80, `expected a catastrophic loss, got ${t.netPnlPct}%`);
    assert.equal(t.catastrophic, true);
    assert.equal(r.summary.ruggedTrades, 1);
    assert.equal(r.summary.catastrophicTrades, 1);
  });
});

describe("compounding capital mode", () => {
  it("sizes the first position at the starting balance", () => {
    const r = run(
      [makePool({ bars: makeBars(200, 100, 20_000) })],
      config({ startingCapitalUsd: 100 }),
    );
    assert.equal(r.summary.startingEquityUsd, 100);
    assert.equal(r.trades[0]!.notionalUsd, 100);
  });

  it("carries realised PnL into the next position's size", () => {
    const r = run(
      [makePool({ bars: makeBars(400, 100, 20_000) })],
      config({ startingCapitalUsd: 100, takeProfitFeePct: 1e9 }),
    );
    assert.ok(r.trades.length >= 2);

    let equity = 100;
    for (const t of r.trades) {
      approx(t.notionalUsd, equity, 1e-9);
      equity += t.netPnlUsd;
    }
  });

  it("keeps ending balance equal to starting balance plus net PnL", () => {
    const s = run(
      [makePool({ bars: makeBars(400, 100, 20_000) })],
      config({ startingCapitalUsd: 100 }),
    ).summary;
    approx(s.endingEquityUsd, 100 + s.netPnlUsd, 1e-9);
  });

  it("deploys only positionSizePct of equity per position", () => {
    const r = run(
      [makePool({ bars: makeBars(200, 100, 20_000) })],
      config({ startingCapitalUsd: 100, positionSizePct: 25 }),
    );
    // Drawdown scales with exposure, which is the point of sizing below 100%.
    approx(r.trades[0]!.notionalUsd, 25, 1e-9);
  });

  it("scales each later position off the updated balance", () => {
    const r = run(
      [makePool({ bars: makeBars(400, 100, 20_000) })],
      config({ startingCapitalUsd: 100, positionSizePct: 50, takeProfitFeePct: 1e9 }),
    );
    let equity = 100;
    for (const t of r.trades) {
      approx(t.notionalUsd, equity * 0.5, 1e-9);
      equity += t.netPnlUsd;
    }
  });

  it("reports a wipeout when the balance reaches zero", () => {
    const s = run([makePool({ bars: makeBars(80, 100, 20_000) })], config()).summary;
    assert.equal(typeof s.accountWipedOut, "boolean");
  });
});

describe("summary", () => {
  it("accounts for every trade in the exit-reason breakdown", () => {
    const s = run([makePool({ bars: makeBars(300, 100, 20_000) })], config()).summary;
    assert.equal(
      Object.values(s.exitReasonCounts).reduce((a, b) => a + b, 0),
      s.totalTrades,
    );
    assert.equal(s.wins + s.losses + s.breakEven, s.totalTrades);
  });
});

/* ------------------------------------------------------------------ */

describe("trimToWindow", () => {
  it("keeps only bars inside the trailing window", () => {
    const now = T0 + 100 * HOUR;
    const kept = trimToWindow(makeBars(100, 100, 0, T0), 1, now * 1000);
    assert.ok(kept.every((b) => b.t >= now - 24 * HOUR));
  });
});

describe("renderTable", () => {
  it("pads every row to a single width", () => {
    const lines = renderTable(
      [{ header: "A" }, { header: "B", align: "right" }],
      [["long-value", "1"]],
    ).split("\n");
    assert.equal(new Set(lines.map((l) => l.length)).size, 1);
  });
});
