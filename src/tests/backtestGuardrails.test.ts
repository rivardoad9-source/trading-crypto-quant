import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assessCooldownAt,
  defaultBacktestConfig,
  isFailureExit,
  priceSurge1hPct,
  runSimulation,
  type BacktestConfig,
} from "../backtest/engine.js";
import type { Bar, PoolHistory } from "../backtest/historicalData.js";
import type { TvlModel } from "../backtest/tvlModel.js";

/**
 * Coverage for the V1.1 guardrails the backtest gained so it could mirror the live
 * engine: pool age, the sweet-spot TVL ceiling, the 1h surge gate, the pool cooldown
 * and the consecutive-failure lockout, plus concurrent-position capital accounting.
 *
 * Every one of these defaults to OFF in `defaultBacktestConfig`, so the pre-existing
 * backtest and sweep output is unchanged. These tests pin the behaviour when they are
 * switched on.
 */

const HOUR = 3600;
const T0 = 1_700_000_000;

const approx = (actual: number, expected: number, tol = 1e-9): void =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`,
  );

function makeBars(count: number, price = 100, volume = 20_000, start = T0): Bar[] {
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
    // Comfortably older than any age gate under test unless a case overrides it.
    createdAtMs: (T0 - 240 * HOUR) * 1000,
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

/** k = 100_000 TVL / 480_000 vol24h, matching the standard fixture pool. */
const K = 0.2083333333333333;

const makeModel = (addresses: string[] = ["poolA"]): TvlModel => ({
  medianK: K,
  p25K: K,
  p75K: K,
  samples: 10,
  perPoolK: Object.fromEntries(addresses.map((a) => [a, K])),
});

/** Costs off and filters open, so each test isolates the one gate it is about. */
const config = (over: Partial<BacktestConfig> = {}): BacktestConfig => ({
  ...defaultBacktestConfig(),
  startingCapitalUsd: null,
  gasSolPerTransaction: 0,
  forcedExitSlippagePct: 0,
  minTvlUsd: 0,
  maxFeeTvlRatio: 999,
  maxPriceChange24hPct: 1e9,
  minFeeCostCoverage: 0,
  positionSizePct: 100,
  ...over,
});

const run = (pools: PoolHistory[], cfg: BacktestConfig, model = makeModel(), sol = solBars) =>
  runSimulation({ label: "test", pools, solUsdBars: sol, tvlModel: model, config: cfg });

/* ------------------------------------------------------------------ */

describe("priceSurge1hPct", () => {
  it("is null on the first bar, where there is no prior close to compare", () => {
    assert.equal(priceSurge1hPct(makeBars(5, 100, 0), 0), null);
  });

  it("measures the single-bar change", () => {
    const bars = makeBars(5, 100, 0);
    bars[3] = { ...bars[3]!, c: 120 };
    approx(priceSurge1hPct(bars, 3)!, 20);
  });
});

describe("isFailureExit", () => {
  it("counts stop-loss, out-of-range and rug as failures", () => {
    assert.equal(isFailureExit("STOP_LOSS"), true);
    assert.equal(isFailureExit("OUT_OF_RANGE"), true);
    assert.equal(isFailureExit("RUGGED"), true);
  });

  it("treats take-profit and timeout as non-failures, mirroring FAILURE_STATUSES", () => {
    assert.equal(isFailureExit("TAKE_PROFIT"), false);
    assert.equal(isFailureExit("FEE_TAKE_PROFIT"), false);
    // A timeout is neutral: the position simply aged out while still in range.
    assert.equal(isFailureExit("TIMEOUT"), false);
    assert.equal(isFailureExit("END_OF_DATA"), false);
  });

  it("treats the ratchet stop as a non-failure", () => {
    /*
     * The ratchet only fires on a position that already reached its arming threshold,
     * at a floor set at or above breakeven, so live would book it as CLOSED_PROFIT.
     * Counting it as a failure would let a run of SUCCESSFUL ratchets arm the
     * circuit breaker and bench a pool that was working.
     */
    assert.equal(isFailureExit("RATCHET_STOP"), false);
  });
});

describe("assessCooldownAt", () => {
  const t = 1_000_000;
  const cfg = { poolCooldownHours: 4, lockoutConsecutiveFailures: 2, lockoutHours: 24 };

  it("never blocks a pool with no closed history", () => {
    assert.equal(assessCooldownAt(undefined, t, cfg).blocked, false);
  });

  it("benches a pool for 4h after any close, win or lose", () => {
    const state = { lastClosedAt: t, lastFailureAt: null, consecutiveFailures: 0 };
    assert.deepEqual(assessCooldownAt(state, t + 3.9 * 3600, cfg), {
      blocked: true,
      kind: "cooldown",
    });
    assert.equal(assessCooldownAt(state, t + 4.1 * 3600, cfg).blocked, false);
  });

  it("locks out for 24h once the consecutive-failure run trips the breaker", () => {
    const state = { lastClosedAt: t, lastFailureAt: t, consecutiveFailures: 2 };
    assert.deepEqual(assessCooldownAt(state, t + 10 * 3600, cfg), {
      blocked: true,
      kind: "lockout",
    });
    assert.equal(assessCooldownAt(state, t + 25 * 3600, cfg).blocked, false);
  });

  it("checks lockout before cooldown, as the live gate does", () => {
    // Past the 4h cooldown but inside the 24h lockout: the longer rule must win.
    const state = { lastClosedAt: t, lastFailureAt: t, consecutiveFailures: 3 };
    assert.equal(assessCooldownAt(state, t + 6 * 3600, cfg).kind, "lockout");
  });

  it("does not lock out below the consecutive-failure threshold", () => {
    const state = { lastClosedAt: t, lastFailureAt: t, consecutiveFailures: 1 };
    assert.equal(assessCooldownAt(state, t + 5 * 3600, cfg).blocked, false);
  });

  it("treats 0 as disabled for both rules", () => {
    const state = { lastClosedAt: t, lastFailureAt: t, consecutiveFailures: 9 };
    const off = { poolCooldownHours: 0, lockoutConsecutiveFailures: 0, lockoutHours: 0 };
    assert.equal(assessCooldownAt(state, t + 1, off).blocked, false);
  });
});

describe("runSimulation V1.1 entry gates", () => {
  it("rejects a pool that is under minPoolAgeHours for the whole window", () => {
    // 40 bars of history on a pool born an hour earlier: it never reaches 48h.
    const bars = makeBars(40);
    const young = makePool({ createdAtMs: (bars[0]!.t - HOUR) * 1000, bars });
    const r = run([young], config({ minPoolAgeHours: 48 }));
    assert.equal(r.trades.length, 0);
    assert.ok((r.gateRejections.tooYoung ?? 0) > 0);
  });

  it("holds off until a pool born mid-window crosses the age threshold", () => {
    const bars = makeBars(200);
    const createdAtMs = (bars[0]!.t - HOUR) * 1000;
    const r = run([makePool({ createdAtMs, bars })], config({ minPoolAgeHours: 48 }));

    // The pool does age in, so trades are expected — but never before hour 48.
    assert.ok(r.trades.length > 0, "expected the pool to become eligible");
    assert.ok((r.gateRejections.tooYoung ?? 0) > 0, "expected early bars to be refused");
    for (const trade of r.trades) {
      const ageAtEntryHours = (Date.parse(trade.entryTime) - createdAtMs) / 3_600_000;
      assert.ok(ageAtEntryHours >= 48, `entered at ${ageAtEntryHours.toFixed(1)}h old`);
    }
  });

  it("admits the same pool once it has aged past the gate", () => {
    const bars = makeBars(100);
    const aged = makePool({ createdAtMs: (bars[0]!.t - 72 * HOUR) * 1000, bars });
    assert.ok(run([aged], config({ minPoolAgeHours: 48 })).trades.length > 0);
  });

  it("fails closed when the creation time is unknown", () => {
    const r = run([makePool({ createdAtMs: 0 })], config({ minPoolAgeHours: 48 }));
    assert.equal(r.trades.length, 0);
    assert.ok((r.gateRejections.ageUnknown ?? 0) > 0);
  });

  it("rejects pools above the sweet-spot TVL ceiling", () => {
    // Modelled TVL is k x vol24h = 0.2083 x 480_000, about 100k, so 50k excludes it.
    const r = run([makePool()], config({ maxTvlUsd: 50_000 }));
    assert.equal(r.trades.length, 0);
    assert.ok((r.gateRejections.highTvl ?? 0) > 0);
  });

  it("rejects a pool that surged more than maxPriceSurge1hPct on the entry bar", () => {
    const bars = makeBars(100);
    for (let i = 30; i < bars.length; i++) {
      bars[i] = { ...bars[i]!, o: 200, h: 200, l: 200, c: 200 };
    }
    const r = run([makePool({ bars })], config({ maxPriceSurge1hPct: 10 }));
    const surgeBarIso = new Date(bars[30]!.t * 1000).toISOString();
    // The 100 -> 200 bar is a 100% surge and must never be the entry bar.
    assert.ok(r.trades.every((t) => t.entryTime !== surgeBarIso));
    assert.ok((r.gateRejections.surged ?? 0) > 0);
  });
});

describe("runSimulation anti-churn gates", () => {
  /** A pool that repeatedly dumps out of range, forcing failing exits. */
  const choppyPool = (): PoolHistory => {
    const bars = makeBars(400);
    for (let i = 0; i < bars.length; i++) {
      const c = i % 20 === 10 ? 40 : 100;
      bars[i] = { ...bars[i]!, o: c, h: c, l: c, c };
    }
    return makePool({ bars });
  };

  const range = { downsideCoverPct: 20, upsideCoverPct: 20 };
  const churn = (over: Partial<BacktestConfig> = {}): BacktestConfig =>
    config({
      ...range,
      poolCooldownHours: 4,
      lockoutConsecutiveFailures: 2,
      lockoutHours: 24,
      ...over,
    });

  it("re-enters the same pool immediately when the cooldown is disabled", () => {
    const r = run([choppyPool()], config(range));
    assert.ok(r.trades.length > 2, `expected repeated churn, got ${r.trades.length}`);
  });

  it("cuts re-entries once the 4h cooldown and 24h lockout are active", () => {
    const pool = choppyPool();
    const free = run([pool], config(range));
    const gated = run([pool], churn());

    assert.ok(
      gated.trades.length < free.trades.length,
      `gated ${gated.trades.length} should be below ungated ${free.trades.length}`,
    );
    assert.ok((gated.gateRejections.cooldown ?? 0) + (gated.gateRejections.lockout ?? 0) > 0);
  });

  it("trips the lockout after two consecutive failing exits", () => {
    const gated = run([choppyPool()], churn());
    assert.ok((gated.gateRejections.lockout ?? 0) > 0, "expected the breaker to trip");
  });

  it("never re-enters a pool sooner than the cooldown allows", () => {
    const gated = run([choppyPool()], churn());
    const byExit = [...gated.trades].sort(
      (a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime),
    );
    for (let i = 1; i < byExit.length; i++) {
      const gapHours =
        (Date.parse(byExit[i]!.entryTime) - Date.parse(byExit[i - 1]!.exitTime)) / 3_600_000;
      assert.ok(gapHours >= 4, `re-entered after only ${gapHours.toFixed(2)}h`);
    }
  });
});

describe("runSimulation capital accounting", () => {
  it("never deploys more than the account across concurrent positions", () => {
    const addresses = ["p1", "p2", "p3", "p4"];
    const pools = addresses.map((a) => makePool({ address: a, pairName: `${a}-USDC` }));

    const r = run(
      pools,
      config({
        startingCapitalUsd: 100,
        positionSizePct: 50,
        maxConcurrentPositions: 3,
        // Hold everything open to the end of the window so all three overlap.
        maxDurationHours: 1e9,
        takeProfitFeePct: 1e9,
        takeProfitNetPct: Number.POSITIVE_INFINITY,
        stopLossPct: -1e9,
      }),
      makeModel(addresses),
    );

    // 3 x 50% would be 150% of the account. Free-capital capping must hold the sum of
    // simultaneously-open notionals at or below the starting equity.
    const stillOpen = r.trades.filter((t) => t.exitReason === "END_OF_DATA");
    const deployed = stillOpen.reduce((s, t) => s + t.notionalUsd, 0);
    assert.ok(deployed <= 100.0001, `deployed $${deployed.toFixed(2)} of a $100 account`);
  });
});
