/**
 * Backtest integrity: the live-eligible arm, the bin-step-aware exit cost, and the
 * non-overlapping windows the variant verdicts are read across.
 *
 * Every published backtest figure was produced with the balancing swap free, a
 * take-profit exit free, and a universe live cannot enter. These tests pin the three
 * corrections — and, just as hard, pin that NONE of them moves a run that did not ask
 * for it, because a harness whose old numbers drift cannot anchor a new one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  balancingSwapFrictionUsd,
  defaultBacktestConfig,
  runSimulation,
  type BacktestConfig,
} from "../backtest/engine.js";
import type { Bar, PoolHistory } from "../backtest/historicalData.js";
import type { TvlModel } from "../backtest/tvlModel.js";
import {
  LIVE_EXIT_OBSERVATIONS,
  calibrateExitCostModel,
  exitConcessionPct,
  exitCostModelFromFlag,
  flatExitCostModel,
  maxProfitableBinStep,
  takeProfitAfterCost,
  type ExitCostModel,
} from "../backtest/exitCost.js";
import {
  annotateTokenScreens,
  classifyLiveEligibility,
  describeEligibilityArms,
  pairedMintOf,
  partitionLiveEligible,
} from "../backtest/liveEligibility.js";
import { nonOverlappingWindows } from "../backtest/sweepHarness.js";
import { WSOL_MINT } from "../config/constants.js";
import type { TokenExtensionReading } from "../services/tokenExtensions.js";

const HOUR = 3600;
const T0 = 1_700_000_000;
const CLEAN: TokenExtensionReading = { transferFeeBps: 0, hasTransferHook: false, nonTransferable: false };

const approx = (a: number, e: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - e) <= tol, `expected ${a} within ${tol} of ${e}`);

function bars(prices: number[], volume = 5_000, start = T0): Bar[] {
  return prices.map((c, i) => ({ t: start + i * HOUR, o: c, h: c, l: c, c, v: volume }));
}

function pool(over: Partial<PoolHistory> = {}): PoolHistory {
  return {
    address: "poolA",
    pairName: "AAA-SOL",
    baseSymbol: "AAA",
    quoteSymbol: "USDC",
    baseMint: "mintA",
    quoteMint: WSOL_MINT,
    tvlTodayUsd: 100_000,
    createdAtMs: 1_600_000_000_000,
    feeRate: 0.01,
    binStep: 20,
    quoteIsUsd: true,
    cohort: "survivor",
    lifetimeVolumeUsd: 10_000_000,
    bars: bars(Array(100).fill(100)),
    ...over,
  };
}

const model = (k = 0.2083333333333333): TvlModel => ({ medianK: k, p25K: k, p75K: k, samples: 10, perPoolK: { poolA: k } });
const solBars = bars(Array(600).fill(100), 0);

const cfg = (over: Partial<BacktestConfig> = {}): BacktestConfig => ({
  ...defaultBacktestConfig(),
  startingCapitalUsd: null,
  gasSolPerTransaction: 0,
  forcedExitSlippagePct: 2,
  minTvlUsd: 0,
  maxFeeTvlRatio: 999,
  maxPriceChange24hPct: 1e9,
  minFeeCostCoverage: 0,
  positionSizePct: 100,
  takeProfitFeePct: Number.POSITIVE_INFINITY,
  ...over,
});

const run = (pools: PoolHistory[], c: BacktestConfig) =>
  runSimulation({ label: "t", pools, solUsdBars: solBars, tvlModel: model(), config: c });

/* ------------------------------------------------------------------ */

describe("exit cost model", () => {
  const m: ExitCostModel = { label: "m", spreadPerBinStepPct: 2, impactPerTvlPct: 1, minPct: 0.1 };

  it("scales with bin step and with the share of TVL sold", () => {
    // 200 bps = 2% x 2 = 4%; $1,000 of $100,000 = 1% x 1 = 1%.
    approx(exitConcessionPct(m, 200, 1_000, 100_000), 5);
    approx(exitConcessionPct(m, 400, 1_000, 100_000), 9);
    approx(exitConcessionPct(m, 200, 2_000, 100_000), 6);
  });

  it("never exits for free: the floor applies to a missing bin step or TVL", () => {
    approx(exitConcessionPct(m, Number.NaN, 1_000, 0), 0.1);
    approx(exitConcessionPct(m, 0, 1_000, Number.NaN), 0.1);
  });

  it("clamps below 100% instead of marking a sale below zero", () => {
    assert.equal(exitConcessionPct({ ...m, spreadPerBinStepPct: 1_000 }, 400, 1, 1), 99);
  });

  it("converts NEARKAT to a per-leg cost with the 3% transfer fee removed from both legs", () => {
    const nearkat = LIVE_EXIT_OBSERVATIONS.find((o) => o.label === "NEARKAT-SOL")!;
    // (8.774% - 5.91%) / 2 ≈ 1.43% — the transfer fee is not a bin-step cost.
    approx(nearkat.concessionPct, 1.432, 0.01);
  });

  it("calibrates non-negative coefficients, and the envelope bounds every observation", () => {
    const cal = calibrateExitCostModel(LIVE_EXIT_OBSERVATIONS);
    assert.ok(cal.fit.spreadPerBinStepPct >= 0 && cal.fit.impactPerTvlPct >= 0);
    for (const r of cal.residuals) {
      assert.ok(r.envelopePct + 1e-9 >= r.observedPct, `${r.label}: envelope ${r.envelopePct} < observed ${r.observedPct}`);
    }
    // EMBER is the worst per bin step, so it sets the envelope exactly.
    approx(cal.envelope.spreadPerBinStepPct, 3.95 / 2, 1e-9);
  });

  it("drops a regressor whose fitted coefficient would make a bigger sale CHEAPER", () => {
    // Impact is anti-correlated with cost here; a two-variable fit goes negative on it.
    const cal = calibrateExitCostModel([
      { label: "a", binStepBps: 100, shareOfTvlPct: 5, concessionPct: 1, source: "" },
      { label: "b", binStepBps: 200, shareOfTvlPct: 1, concessionPct: 4, source: "" },
      { label: "c", binStepBps: 300, shareOfTvlPct: 0.5, concessionPct: 6, source: "" },
    ]);
    assert.equal(cal.fit.impactPerTvlPct, 0);
    assert.ok(cal.fit.spreadPerBinStepPct > 0);
  });

  it("resolves the runner flag, with legacy as the default", () => {
    assert.equal(exitCostModelFromFlag(undefined, 2), null);
    assert.equal(exitCostModelFromFlag("legacy", 2), null);
    assert.equal(exitCostModelFromFlag("flat", 2)?.minPct, 2);
    assert.ok(exitCostModelFromFlag("envelope", 2)!.spreadPerBinStepPct > 0);
    assert.throws(() => exitCostModelFromFlag("cheap", 2), /legacy, flat, fit or envelope/);
  });

  it("books less at a take-profit the wider the bin step, and names the last profitable one", () => {
    const rows = takeProfitAfterCost({
      model: { label: "x", spreadPerBinStepPct: 3, impactPerTvlPct: 0, minPct: 0 },
      binStepsBps: [50, 100, 200, 400],
      takeProfitPct: 5,
      notionalUsd: 189,
      tvlUsd: 100_000,
      gasRoundTripPctOfNotional: 0.4,
      entrySwapPct: 0.25,
    });
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i]!.netAtTakeProfitPct < rows[i - 1]!.netAtTakeProfitPct);
    // 400 bps: c = 12%, exit = 1 - sqrt(0.88) = 6.19%; 5 - 0.4 - 0.125 - 6.19 < 0.
    // 200 bps: c = 6%, exit = 3.04%; 5 - 0.4 - 0.125 - 3.04 = +1.43.
    assert.equal(rows[3]!.profitable, false);
    assert.equal(maxProfitableBinStep(rows), 200);
  });
});

/* ------------------------------------------------------------------ */

describe("the engine under an exit cost model", () => {
  it("defaults to the legacy accounting, so no published figure moves", () => {
    const d = defaultBacktestConfig();
    assert.equal(d.exitCostModel, null);
    assert.equal(d.gateUsesExitCostModel, false);
    assert.equal(d.swapSlippagePct, 0);
  });

  // Flat price: fees alone carry net PnL to the take-profit, so it is never a forced exit.
  const tpPool = pool({ bars: bars(Array(80).fill(100)) });

  it("legacy: a TAKE_PROFIT exit pays NO concession even with a 2% forced-exit setting", () => {
    const r = run([tpPool], cfg({ takeProfitNetPct: 2 }));
    const t = r.trades[0]!;
    assert.equal(t.exitReason, "TAKE_PROFIT");
    assert.equal(t.slippageCostUsd, 0);
    assert.equal(t.exitConcessionPct, 0);
  });

  it("with a model: the same TAKE_PROFIT pays the modelled concession and books less", () => {
    const legacy = run([tpPool], cfg({ takeProfitNetPct: 2 })).trades[0]!;
    const priced = run([tpPool], cfg({ takeProfitNetPct: 2, exitCostModel: flatExitCostModel(3) })).trades[0]!;
    assert.equal(priced.exitReason, "TAKE_PROFIT");
    assert.equal(priced.exitConcessionPct, 3);
    assert.ok(priced.slippageCostUsd > 0);
    assert.ok(priced.netPnlUsd < legacy.netPnlUsd);
    approx(legacy.netPnlUsd - priced.netPnlUsd, priced.slippageCostUsd, 1e-9);
  });

  it("a forced exit pays the WORSE of the model and the flat setting — never less than before", () => {
    // -20% stays inside the -25% range, so this is a stop-loss and not an out-of-range exit.
    const slPool = pool({ bars: bars([...Array(35).fill(100), ...Array(30).fill(80)]) });
    const cheap: ExitCostModel = { label: "cheap", spreadPerBinStepPct: 0.1, impactPerTvlPct: 0, minPct: 0 };
    const t = run([slPool], cfg({ stopLossPct: -3, exitCostModel: cheap })).trades[0]!;
    assert.equal(t.exitReason, "STOP_LOSS");
    assert.equal(t.exitConcessionPct, 2);

    const dear: ExitCostModel = { label: "dear", spreadPerBinStepPct: 0, impactPerTvlPct: 0, minPct: 5 };
    assert.equal(run([slPool], cfg({ stopLossPct: -3, exitCostModel: dear })).trades[0]!.exitConcessionPct, 5);
  });

  it("legacy charges a forced exit's slippage TWICE; the model path charges it once", async () => {
    const { lpValueReturnFraction } = await import("../services/meteora.js");
    const slPool = pool({ bars: bars([...Array(35).fill(100), ...Array(30).fill(80)]) });
    const gross = (t: { feesEarnedUsd: number; notionalUsd: number; exitRatio: number; entryRatio: number }) =>
      t.feesEarnedUsd + t.notionalUsd * lpValueReturnFraction(t.exitRatio / t.entryRatio);

    // Pinned, not endorsed: fixing it moves every published figure. See engine.ts.
    const legacy = run([slPool], cfg({ stopLossPct: -3 })).trades[0]!;
    approx(legacy.netPnlUsd, gross(legacy) - 2 * legacy.slippageCostUsd, 1e-9);

    const priced = run([slPool], cfg({ stopLossPct: -3, exitCostModel: flatExitCostModel(2) })).trades[0]!;
    approx(priced.slippageCostUsd, legacy.slippageCostUsd, 1e-9);
    approx(priced.netPnlUsd, gross(priced) - priced.slippageCostUsd, 1e-9);
    approx(priced.netPnlUsd - legacy.netPnlUsd, legacy.slippageCostUsd, 1e-9);
  });

  it("does not charge the paired token's exit swap twice once the model prices it", () => {
    const solPool = { baseMint: "meme", quoteMint: WSOL_MINT };
    const usdPool = { baseMint: "meme", quoteMint: "usdc" };
    const swap = { swapSlippagePct: 1, swapGasSolPerLeg: 0 };
    const m = flatExitCostModel(2);
    // wSOL pool: 1.0x round trip -> 0.5x (the entry leg only).
    approx(balancingSwapFrictionUsd(solPool, 1_000, swap, 100), 10);
    approx(balancingSwapFrictionUsd(solPool, 1_000, { ...swap, exitCostModel: m }, 100), 5);
    // no wSOL leg: 2.0x -> 1.5x (both entry legs + the USDC half's way back).
    approx(balancingSwapFrictionUsd(usdPool, 1_000, { ...swap, exitCostModel: m }, 100), 15);
  });

  it("moves the entry gate only when asked: accounting and strategy are separate switches", () => {
    // Coverage 1x against a pool whose fees clear a 0% exit but not a 90% one.
    const gatePool = pool({ binStep: 400 });
    const pricey: ExitCostModel = { label: "p", spreadPerBinStepPct: 22.5, impactPerTvlPct: 0, minPct: 0 };
    const base = cfg({ minFeeCostCoverage: 1, forcedExitSlippagePct: 0, exitCostModel: pricey });
    const accountingOnly = run([gatePool], base);
    const gated = run([gatePool], { ...base, gateUsesExitCostModel: true });
    assert.ok(accountingOnly.trades.length > 0, "the flat 0% gate admits the pool");
    assert.equal(gated.trades.length, 0);
    assert.ok((gated.gateRejections.belowBreakeven ?? 0) > 0);
  });
});

/* ------------------------------------------------------------------ */

describe("the live-eligible arm", () => {
  const policy = { maxTransferFeeBps: 0 };
  const withScreen = (reading: TokenExtensionReading | null, error: string | null = null, over: Partial<PoolHistory> = {}) =>
    pool({ tokenScreen: { mint: "mintA", reading, error }, ...over });

  it("refuses a pool with no wSOL leg before it looks at the mint", async () => {
    const v = await classifyLiveEligibility(withScreen(CLEAN, null, { quoteMint: "usdc" }), policy);
    assert.deepEqual([v.eligible, v.reason], [false, "noWsol"]);
  });

  it("FAILS CLOSED on a pool that was never annotated", async () => {
    const v = await classifyLiveEligibility(pool(), policy);
    assert.deepEqual([v.eligible, v.reason], [false, "unannotated"]);
  });

  it("FAILS CLOSED on a mint that could not be read, using the live screen's own refusal", async () => {
    const v = await classifyLiveEligibility(withScreen(null, "429 Too Many Requests"), policy);
    assert.equal(v.eligible, false);
    assert.equal(v.reason, "tokenScreen");
    assert.match(v.detail ?? "", /could not read/);
  });

  it("refuses a transfer fee, a hook and a non-transferable mint; admits a clean one", async () => {
    const fee = await classifyLiveEligibility(withScreen({ ...CLEAN, transferFeeBps: 50 }), policy);
    const hook = await classifyLiveEligibility(withScreen({ ...CLEAN, hasTransferHook: true }), policy);
    const nt = await classifyLiveEligibility(withScreen({ ...CLEAN, nonTransferable: true }), policy);
    const clean = await classifyLiveEligibility(withScreen(CLEAN), policy);
    assert.deepEqual([fee.eligible, hook.eligible, nt.eligible, clean.eligible], [false, false, false, true]);
    // The fee is judged against the policy, exactly as live: 50 bps passes a 100 bps cap.
    assert.equal((await classifyLiveEligibility(withScreen({ ...CLEAN, transferFeeBps: 50 }), { maxTransferFeeBps: 100 })).eligible, true);
  });

  it("reads the non-wSOL leg, on either side of the pair", () => {
    assert.equal(pairedMintOf({ baseMint: WSOL_MINT, quoteMint: "usdc" }), "usdc");
    assert.equal(pairedMintOf({ baseMint: "meme", quoteMint: WSOL_MINT }), "meme");
  });

  it("annotates one RPC read per distinct mint, and does not remember a failure as a fact", async () => {
    const calls: string[] = [];
    const read = async (mint: string) => {
      calls.push(mint);
      if (mint === "bad") throw new Error("rpc down");
      return CLEAN;
    };
    const pools = [
      pool({ address: "1", baseMint: "m1" }),
      pool({ address: "2", baseMint: "m1" }),
      pool({ address: "3", baseMint: "bad" }),
    ];
    const res = await annotateTokenScreens(pools, { read, cachePath: null, delayMs: 0 });
    assert.deepEqual(calls, ["m1", "bad"]);
    assert.deepEqual([res.rpcReads, res.failures], [2, 1]);
    assert.equal(pools[2]!.tokenScreen?.reading, null);

    // A second pass re-reads ONLY the failed mint.
    calls.length = 0;
    await annotateTokenScreens(pools, { read, cachePath: null, delayMs: 0 });
    assert.deepEqual(calls, ["bad"]);
  });

  it("partitions with counts that add up to the universe", async () => {
    const pools = [
      withScreen(CLEAN, null, { address: "ok" }),
      withScreen(CLEAN, null, { address: "usd", quoteMint: "usdc" }),
      withScreen({ ...CLEAN, hasTransferHook: true }, null, { address: "hook" }),
      pool({ address: "unread" }),
    ];
    const p = await partitionLiveEligible(pools, policy);
    assert.deepEqual(p.eligible.map((x) => x.address), ["ok"]);
    assert.deepEqual(p.counts, { noWsol: 1, tokenScreen: 1, unannotated: 1 });
  });

  it("prints (a) live-eligible, (b) full universe, (c) the difference — in that order", () => {
    const lines = describeEligibilityArms(
      { pools: 5, trades: 7, netPnlUsd: -20.64, profitFactor: 0.8, maxDrawdownPct: 12 },
      { pools: 22, trades: 42, netPnlUsd: 351.78, profitFactor: 2.09, maxDrawdownPct: 40.1 },
    );
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^\(a\) live-eligible .*7 trades .*net -\$20\.64/);
    assert.match(lines[1]!, /^\(b\) full universe .*42 trades .*net \+\$351\.78/);
    assert.match(lines[2]!, /^\(c\) selisih .*35 trades .*net \+\$372\.42/);
  });
});

/* ------------------------------------------------------------------ */

describe("sweep flags", () => {
  it("leave the published 30-day / $100 / 50% sweep byte-identical when absent", async () => {
    const { applySweepFlags, readSweepFlags } = await import("../backtest/sweepHarness.js");
    const flags = readSweepFlags(["--live-entry"]);
    assert.equal(flags.days, 30);
    const base = defaultBacktestConfig();
    assert.deepEqual(applySweepFlags(base, flags), base);
  });

  it("override only the field each flag names", async () => {
    const { applySweepFlags, readSweepFlags } = await import("../backtest/sweepHarness.js");
    const flags = readSweepFlags(["--days=91", "--capital=300", "--sizepct=63", "--concurrent=1", "--gas=0.004", "--exitcost=envelope"]);
    const out = applySweepFlags(defaultBacktestConfig(), flags);
    assert.deepEqual(
      [flags.days, out.startingCapitalUsd, out.positionSizePct, out.maxConcurrentPositions, out.gasSolPerTransaction],
      [91, 300, 63, 1, 0.004],
    );
    assert.ok(out.exitCostModel && out.exitCostModel.spreadPerBinStepPct > 0);
    assert.equal(out.swapSlippagePct, 0, "an absent --swapslip must not start pricing the swap");
    assert.throws(() => readSweepFlags(["--capital=lots"]), /not a number/);
  });
});

describe("non-overlapping windows", () => {
  const long = pool({ bars: bars(Array(24 * 20).fill(100)) }); // 20 days

  it("cuts back from the latest bar, newest first, and the windows never share a bar", () => {
    const ws = nonOverlappingWindows([long], solBars, 7, 2);
    assert.equal(ws.length, 2);
    assert.ok(ws[0]!.start >= ws[1]!.end, "W1 must start where W2 ends, or later");
    const w1 = new Set(ws[0]!.pools[0]!.bars.map((b) => b.t));
    assert.ok(ws[1]!.pools[0]!.bars.every((b) => !w1.has(b.t)));
    approx(ws[0]!.coveredDays, 7, 1e-9);
  });

  it("reports a truncated oldest window with its real coverage, and drops an empty one", () => {
    const ws = nonOverlappingWindows([long], solBars, 9, 3);
    assert.equal(ws.length, 3);
    assert.ok(ws[2]!.coveredDays < 9, `oldest window claims ${ws[2]!.coveredDays} days of a 20-day series`);
    assert.equal(nonOverlappingWindows([long], solBars, 15, 3).length, 2);
  });
});
