/**
 * Live micro-capital profile.
 *
 * Two classes of failure are worth a test here, and they are not the same:
 *
 *  1. ARITHMETIC that is invisible until it costs money. A reserve that sizing can
 *     reach is not a reserve; a friction gate that treats an unavailable gas estimate
 *     as zero is the exact bug that let this strategy churn itself into a loss. None
 *     of that throws — it just quietly spends.
 *  2. INERTNESS. Every gate here defaults to off, and the paper engine must behave
 *     exactly as it did before this profile existed. A default that flips is not a
 *     tuning change, it is an unreviewed live-capital rule applied to every backtest
 *     and every dry run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessMicroCapitalFriction,
  chargeRoundTripGasUsd,
  describeLiveEnvelope,
  effectiveFeeRequirement,
  liveMicroCapital,
  parseLiveConfig,
  requiredFeeTvlRatio24h,
  requiredFeeTvlRatioForCoverage,
  sizeNextPositionSol,
  type LiveMicroCapitalConfig,
} from "../config/liveConfig.js";
import { assessBreakeven } from "../services/meteora.js";
import {
  INSUFFICIENT_GAS_RESERVE,
  InsufficientGasReserveError,
  runLivePreflight,
} from "../services/livePreflight.js";

const srcDir = fileURLToPath(new URL("..", import.meta.url));

/** The SHIPPED profile, independent of whatever the operator's .env happens to say. */
function profile(overrides: Partial<LiveMicroCapitalConfig> = {}): LiveMicroCapitalConfig {
  return {
    enabled: true,
    capitalSol: 1.0,
    maxPositionSol: 0.5,
    maxConcurrentPositions: 1,
    minReserveSol: 0.15,
    deployableSol: 0.85,
    maxExposureSol: 0.5,
    roundTripGasSol: 0.008,
    minNetPnlUsd: 1.5,
    pnlHorizonHours: 24,
    minWalletSol: 0.2,
    walletAddress: "SoLWa11etAddressForTestsOnly1111111111111111",
    ...overrides,
  };
}

/**
 * A deliberately MULTI-position fixture (0.20 x 3), which is no longer the shipped
 * profile. The free-capital arithmetic has to be correct for any concurrency, not just
 * the one currently configured — with `maxConcurrentPositions: 1` nothing is ever open
 * when sizing runs, so the shipped profile alone cannot exercise the double-spend path
 * that this arithmetic exists to prevent. Keep this fixture even while the live config
 * says 1.
 */
function multiPositionProfile(
  overrides: Partial<LiveMicroCapitalConfig> = {},
): LiveMicroCapitalConfig {
  return profile({
    maxPositionSol: 0.2,
    maxConcurrentPositions: 3,
    maxExposureSol: 0.6,
    ...overrides,
  });
}

const ok = (r: ReturnType<typeof parseLiveConfig>): LiveMicroCapitalConfig => {
  assert.ok(r.ok, `expected a valid config, got: ${r.ok ? "" : r.issues.join("; ")}`);
  return r.config;
};

describe("live micro-capital — shipped defaults", () => {
  it("ships the requested 1 SOL profile with no configuration at all", () => {
    const cfg = ok(parseLiveConfig({}));
    assert.equal(cfg.capitalSol, 1.0);
    assert.equal(cfg.maxPositionSol, 0.5);
    assert.equal(cfg.maxConcurrentPositions, 1);
    assert.equal(cfg.minReserveSol, 0.15);
    assert.equal(cfg.roundTripGasSol, 0.008);
    assert.equal(cfg.minNetPnlUsd, 1.5);
    assert.equal(cfg.minWalletSol, 0.2);
  });

  it("is OFF by default — arming live sizing takes an explicit opt-in", () => {
    assert.equal(ok(parseLiveConfig({})).enabled, false);
    assert.equal(liveMicroCapital.enabled, false, "this machine has the live profile armed");
  });

  it("derives 0.85 SOL deployable and 0.50 SOL of maximum exposure", () => {
    const cfg = ok(parseLiveConfig({}));
    assert.equal(cfg.deployableSol, 0.85);
    assert.ok(Math.abs(cfg.maxExposureSol - 0.5) < 1e-9);
  });

  it("verifies at boot that 0.50 x 1 fits inside 0.85 deployable SOL", () => {
    // The arithmetic the profile change turns on: one 0.50 SOL position against a
    // 1 SOL book with 0.15 SOL reserved. 0.50 <= 0.85, with 0.35 SOL of slack.
    const cfg = ok(parseLiveConfig({}));
    const deployable = cfg.capitalSol - cfg.minReserveSol;
    assert.ok(Math.abs(deployable - 0.85) < 1e-9);
    assert.ok(
      cfg.maxPositionSol * cfg.maxConcurrentPositions <= deployable + 1e-9,
      "the full book reaches into the reserve",
    );
    assert.ok(Math.abs(deployable - cfg.maxExposureSol - 0.35) < 1e-9, "expected 0.35 SOL slack");
  });

  it("reads LIVE_MICRO_CAPITAL as a boolean opt-in", () => {
    assert.equal(ok(parseLiveConfig({ LIVE_MICRO_CAPITAL: "true" })).enabled, true);
    assert.equal(ok(parseLiveConfig({ LIVE_MICRO_CAPITAL: "1" })).enabled, true);
    assert.equal(ok(parseLiveConfig({ LIVE_MICRO_CAPITAL: "no" })).enabled, false);
  });
});

describe("live micro-capital — the reserve is unreachable by construction", () => {
  it("refuses a profile whose full book would spend the reserve", () => {
    // 4 x 0.20 = 0.80 fits in 0.85, but 5 x 0.20 = 1.00 does not.
    const r = parseLiveConfig({ LIVE_MAX_CONCURRENT_POSITIONS: "5" });
    assert.equal(r.ok, false);
    assert.ok(
      !r.ok && r.issues.some((i) => i.includes("LIVE_MAX_CONCURRENT_POSITIONS")),
      "exposure exceeding deployable capital was accepted",
    );
  });

  it("refuses a single position larger than the deployable capital", () => {
    const r = parseLiveConfig({ LIVE_MAX_POSITION_SOL: "0.9" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.issues.some((i) => i.includes("LIVE_MAX_POSITION_SOL")));
  });

  it("refuses a reserve that consumes the whole book", () => {
    const r = parseLiveConfig({ LIVE_MIN_RESERVE_SOL: "1.0" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.issues.some((i) => i.includes("nothing deployable")));
  });

  it("refuses a startup floor beneath the reserve it is meant to protect", () => {
    const r = parseLiveConfig({ LIVE_MIN_WALLET_SOL: "0.05" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.issues.some((i) => i.includes("already short")));
  });

  it("refuses a fractional position count", () => {
    const r = parseLiveConfig({ LIVE_MAX_CONCURRENT_POSITIONS: "2.5" });
    assert.equal(r.ok, false);
  });
});

describe("live micro-capital — sizing runs off free capital, not the capital base", () => {
  const cfg = multiPositionProfile();

  it("deploys the full position size when nothing is open", () => {
    const d = sizeNextPositionSol(0, 0, cfg);
    assert.equal(d.sizeSol, 0.2);
    assert.equal(d.freeSol, 0.85);
  });

  it("deploys 0.50 SOL once, then refuses, under the SHIPPED single-position profile", () => {
    const shipped = profile();
    assert.equal(sizeNextPositionSol(0, 0, shipped).sizeSol, 0.5);

    // One position open is the ceiling now, and 0.35 SOL of free capital stays unused
    // rather than being opened as a stub that cannot clear its own gas.
    const second = sizeNextPositionSol(0.5, 1, shipped);
    assert.equal(second.sizeSol, 0);
    assert.match(second.reason ?? "", /at capacity/);
    assert.ok(Math.abs(second.freeSol - 0.35) < 1e-9);
  });

  it("subtracts open notional, so three positions cannot spend the same SOL", () => {
    // The trap the backtest documents: sizing off equity would return 0.20 every time
    // and quietly deploy 0.60 SOL out of a 0.85 SOL allowance three times over.
    assert.equal(sizeNextPositionSol(0.2, 1, cfg).sizeSol, 0.2);
    assert.equal(sizeNextPositionSol(0.4, 2, cfg).sizeSol, 0.2);

    const free = sizeNextPositionSol(0.4, 2, cfg).freeSol;
    assert.ok(Math.abs(free - 0.45) < 1e-9, `expected 0.45 SOL free, got ${free}`);
  });

  it("stops at the concurrency ceiling even with capital to spare", () => {
    const d = sizeNextPositionSol(0.6, 3, cfg);
    assert.equal(d.sizeSol, 0);
    assert.match(d.reason ?? "", /at capacity/);
    assert.ok(d.freeSol > 0, "capital was free; concurrency is what stopped the entry");
  });

  it("never lets sizing reach into the reserve", () => {
    // 0.70 SOL open leaves 0.15 free, which is exactly the reserve. A naive
    // min(cap, free) would open a 0.15 SOL stub and zero the reserve.
    const d = sizeNextPositionSol(0.7, 2, cfg);
    assert.equal(d.sizeSol, 0);
    assert.match(d.reason ?? "", /below the 0\.2 SOL position size/);
  });

  it("refuses a stub rather than opening a position that cannot clear its own gas", () => {
    const d = sizeNextPositionSol(0.75, 1, cfg);
    assert.equal(d.sizeSol, 0, "opened an undersized position; gas is per-tx, not per-SOL");
  });

  it("treats a nonsense open notional as zero rather than as free capital", () => {
    assert.equal(sizeNextPositionSol(Number.NaN, 0, cfg).freeSol, 0.85);
    assert.equal(sizeNextPositionSol(-5, 0, cfg).freeSol, 0.85);
  });
});

describe("live micro-capital — friction gate", () => {
  const cfg = profile();
  const SOL = 100; // ~$100/SOL, so 0.20 SOL = $20 of notional.

  it("charges the 0.008 SOL round trip when no live estimate exists", () => {
    const a = assessMicroCapitalFriction({
      notionalUsd: 20,
      feeTvlRatio24h: 0.2,
      gasRoundTripUsd: null,
      solPriceUsd: SOL,
      slippagePct: 2,
      config: cfg,
    });
    // 0.008 SOL x $100 = $0.80 gas, plus 2% of $20 = $0.40 slippage.
    assert.ok(Math.abs(a.gasRoundTripUsd - 0.8) < 1e-9);
    assert.ok(Math.abs(a.roundTripCostUsd - 1.2) < 1e-9);
    assert.equal(a.gasFloorApplied, true);
  });

  it("never treats an unavailable gas estimate as a free trip", () => {
    const a = assessMicroCapitalFriction({
      notionalUsd: 20,
      feeTvlRatio24h: 0.2,
      gasRoundTripUsd: null,
      solPriceUsd: SOL,
      config: cfg,
    });
    assert.ok(a.gasRoundTripUsd > 0, "unknown cost was priced at zero");
  });

  it("takes the HIGHER of the live estimate and the configured floor", () => {
    const cheap = assessMicroCapitalFriction({
      notionalUsd: 20,
      feeTvlRatio24h: 0.2,
      gasRoundTripUsd: 0.01,
      solPriceUsd: SOL,
      slippagePct: 2,
      config: cfg,
    });
    assert.ok(Math.abs(cheap.gasRoundTripUsd - 0.8) < 1e-9, "floor did not win");
    assert.equal(cheap.gasFloorApplied, true);

    const dear = assessMicroCapitalFriction({
      notionalUsd: 20,
      feeTvlRatio24h: 0.2,
      gasRoundTripUsd: 3.0,
      solPriceUsd: SOL,
      slippagePct: 2,
      config: cfg,
    });
    assert.equal(dear.gasRoundTripUsd, 3.0, "a genuinely expensive slot was discounted");
    assert.equal(dear.gasFloorApplied, false);
  });

  it("rejects a pool whose projected net PnL is under $1.50", () => {
    // A pool at the live MIN_FEE_TVL_RATIO (0.8%/24h) earns $0.16 on $20 against
    // $1.20 of friction — a projected loss, not a thin win.
    const a = assessMicroCapitalFriction({
      notionalUsd: 20,
      feeTvlRatio24h: 0.008,
      gasRoundTripUsd: null,
      solPriceUsd: SOL,
      slippagePct: 2,
      config: cfg,
    });
    assert.equal(a.passes, false);
    assert.ok(a.projectedNetPnlUsd < 0);
    assert.match(a.reason ?? "", /below the \$1\.50 floor/);
  });

  it("accepts a pool that clears the floor", () => {
    // 15%/24h on $20 = $3.00 of fees, less $1.20 friction = $1.80 net.
    const a = assessMicroCapitalFriction({
      notionalUsd: 20,
      feeTvlRatio24h: 0.15,
      gasRoundTripUsd: null,
      solPriceUsd: SOL,
      slippagePct: 2,
      config: cfg,
    });
    assert.equal(a.passes, true);
    assert.ok(Math.abs(a.projectedNetPnlUsd - 1.8) < 1e-9);
  });

  it("passes exactly at the floor, not merely above it", () => {
    // Required fee = $1.50 + $1.20 = $2.70 on $20 => 13.5%/24h.
    const a = assessMicroCapitalFriction({
      notionalUsd: 20,
      feeTvlRatio24h: 0.135,
      gasRoundTripUsd: null,
      solPriceUsd: SOL,
      slippagePct: 2,
      config: cfg,
    });
    assert.equal(a.passes, true);
    assert.ok(Math.abs(a.projectedNetPnlUsd - 1.5) < 1e-9);
  });

  it("reports the fee yield the dollar floor actually demands", () => {
    // $20 notional: friction $1.20, so fees must reach $2.70 => 13.5%/24h.
    assert.ok(Math.abs(requiredFeeTvlRatio24h(20, SOL, cfg, 2) - 0.135) < 1e-9);
    // $50 notional: friction $1.80, so fees must reach $3.30 => 6.6%/24h.
    assert.ok(Math.abs(requiredFeeTvlRatio24h(50, SOL, cfg, 2) - 0.066) < 1e-9);
  });

  it("a larger position lowers the required yield — the lever, not a looser gate", () => {
    // Gas is per transaction and does not shrink with the position, so raising the
    // notional dilutes a fixed cost. This is the whole reason 0.20 -> 0.50 helps
    // without any guardrail moving.
    const small = requiredFeeTvlRatio24h(20, SOL, cfg, 2);
    const large = requiredFeeTvlRatio24h(50, SOL, cfg, 2);
    assert.ok(large < small, "a bigger position did not dilute the fixed gas cost");
  });
});

describe("live micro-capital — the binding gate is reported, not the friendlier one", () => {
  const cfg = profile();
  const SOL = 100;

  it("computes both gates at $50 notional", () => {
    const req = effectiveFeeRequirement(50, SOL, cfg, 2);
    assert.ok(Math.abs(req.dollarFloor - 0.066) < 1e-9, `floor ${req.dollarFloor}`);
    assert.ok(Math.abs(req.coverageRatio - 0.09) < 1e-9, `coverage ${req.coverageRatio}`);
  });

  it("reports the STRICTER of the two as the real bar", () => {
    // Quoting only the $1.50 floor would advertise 6.6% while the screener rejects
    // anything under 9%, which reads as a broken screener rather than a working gate.
    const req = effectiveFeeRequirement(50, SOL, cfg, 2);
    assert.equal(req.binding, Math.max(req.dollarFloor, req.coverageRatio));
    assert.ok(Math.abs(req.binding - 0.09) < 1e-9);
    assert.equal(req.bindingGate, "coverage ratio");
  });

  it("never reports a bar below either gate, at any position size", () => {
    for (const sol of [0.05, 0.1, 0.2, 0.5, 0.85]) {
      const req = effectiveFeeRequirement(sol * SOL, SOL, cfg, 2);
      assert.ok(req.binding >= req.dollarFloor - 1e-12, `understated the floor at ${sol}`);
      assert.ok(req.binding >= req.coverageRatio - 1e-12, `understated coverage at ${sol}`);
    }
  });

  it("names whichever gate binds, and that flips with notional", () => {
    // The dollar floor is absolute and the ratio is scale-free, so which one binds is
    // a function of size. Hard-coding either as "the" requirement would be wrong at
    // some size the operator will eventually configure.
    const tiny = effectiveFeeRequirement(2, SOL, cfg, 2);
    assert.equal(tiny.bindingGate, "dollar floor");
    assert.ok(tiny.dollarFloor > tiny.coverageRatio);

    const large = effectiveFeeRequirement(500, SOL, cfg, 2);
    assert.equal(large.bindingGate, "coverage ratio");
  });

  it("surfaces the binding number and both gates in the boot summary", () => {
    const lines = describeLiveEnvelope(SOL, cfg).join(" | ");
    assert.match(lines, /0\.5 SOL \(~\$50\.00\) x 1 max = 0\.50 SOL exposure/);
    assert.match(lines, /gates      :.*floor needs 6\.60%.*coverage needs 9\.00%/);
    assert.match(lines, /implies    : a pool must show >= 9\.00%/);
    assert.match(lines, /binding gate: coverage ratio/);
  });
});

describe("live micro-capital — both gates charge one gas basis", () => {
  const cfg = profile();
  const SOL = 100;
  const FLOOR_USD = 0.008 * SOL; // $0.80

  it("prices an absent estimate at the floor, never at zero", () => {
    for (const absent of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = chargeRoundTripGasUsd(absent, SOL, cfg);
      assert.equal(c.gasRoundTripUsd, FLOOR_USD, `priced ${String(absent)} wrong`);
      assert.equal(c.floorApplied, true);
    }
  });

  it("takes the higher of the live estimate and the floor, and the floor wins ties", () => {
    assert.deepEqual(chargeRoundTripGasUsd(0.01, SOL, cfg), {
      gasRoundTripUsd: FLOOR_USD,
      floorApplied: true,
    });
    assert.deepEqual(chargeRoundTripGasUsd(FLOOR_USD, SOL, cfg), {
      gasRoundTripUsd: FLOOR_USD,
      floorApplied: true,
    });
    assert.deepEqual(chargeRoundTripGasUsd(2.5, SOL, cfg), {
      gasRoundTripUsd: 2.5,
      floorApplied: false,
    });
  });

  it("gives the micro gate exactly what chargeRoundTripGasUsd returns", () => {
    // The micro gate must not keep a second copy of this rule; two copies is how the
    // coverage gate came to disagree with the bar printed at boot.
    for (const live of [null, 0.01, 5]) {
      const charge = chargeRoundTripGasUsd(live, SOL, cfg);
      const a = assessMicroCapitalFriction({
        notionalUsd: 50,
        feeTvlRatio24h: 0.1,
        gasRoundTripUsd: live,
        solPriceUsd: SOL,
        slippagePct: 2,
        config: cfg,
      });
      assert.equal(a.gasRoundTripUsd, charge.gasRoundTripUsd);
      assert.equal(a.gasFloorApplied, charge.floorApplied);
    }
  });

  /*
   * The regression this whole change exists for.
   *
   * `requiredFeeTvlRatioForCoverage` prices gas at the 0.008 SOL floor; before the fix
   * the runtime call site handed `assessBreakeven` the live priority fee instead
   * (~$0.003 against a $0.81 floor). The boot line therefore advertised 9.00% while
   * the gate enforced 5.1% — 52 pools in the 67h Hermes run cleared coverage and then
   * failed the $1.50 floor, which cannot happen if coverage really binds at 9%.
   *
   * The invariant is one-sided, and deliberately so. The runtime gate must NEVER be
   * looser than the advertised bar — that was the bug. It may be STRICTER, because
   * `LIVE_ROUND_TRIP_GAS_SOL` is a floor: when the live estimate exceeds it the gate
   * charges the real, higher cost. Asserting equality in that case would be asserting
   * that a genuinely expensive network is priced as if it were cheap.
   *
   * So: under-enforcement is a failure at every size and every estimate; and where the
   * floor is what gets charged — the normal case, and the one boot describes — the two
   * agree exactly.
   */
  it("never enforces a looser bar than requiredFeeTvlRatioForCoverage advertises", () => {
    const COVERAGE = 2.5;
    for (const sol of [0.05, 0.2, 0.5, 0.85]) {
      for (const solPriceUsd of [40, 100, 250]) {
        const notionalUsd = sol * solPriceUsd;
        const bar = requiredFeeTvlRatioForCoverage(notionalUsd, solPriceUsd, cfg, 2);

        // Whatever the live estimate says, including nothing at all.
        for (const live of [null, 0.001, 0.5]) {
          const charge = chargeRoundTripGasUsd(live, solPriceUsd, cfg);
          const where = `${sol} SOL @ $${solPriceUsd}, live=${String(live)}`;
          const gate = (feeTvlRatio24h: number) =>
            assessBreakeven({
              notionalUsd,
              feeTvlRatio24h,
              gasCostRoundTripUsd: charge.gasRoundTripUsd,
              slippagePct: 2,
              minCoverageRatio: COVERAGE,
            });

          // Never looser: anything under the advertised bar is refused, always.
          assert.ok(!gate(bar * 0.999).passes, `a pool under the advertised bar passed (${where})`);

          if (charge.floorApplied) {
            // Exactly the advertised bar, which is what boot promises.
            const at = gate(bar);
            assert.ok(at.passes, `a pool exactly at the advertised bar was rejected (${where})`);
            assert.ok(
              Math.abs(at.coverageRatio - COVERAGE) < 1e-9,
              `the advertised bar is not the 2.5x point (${where}): got ${at.coverageRatio}`,
            );
          } else {
            // A live estimate above the floor may only make the gate harder.
            assert.ok(
              gate(bar).coverageRatio <= COVERAGE + 1e-9,
              `a live estimate above the floor made the gate EASIER (${where})`,
            );
          }
        }
      }
    }
  });

  it("puts the shipped 0.50 SOL profile back on a 9.00% coverage bar", () => {
    // The number the operator reads at boot, now the number the gate applies.
    const gas = chargeRoundTripGasUsd(0.003, SOL, cfg).gasRoundTripUsd;
    const notionalUsd = 50;

    const nineExactly = assessBreakeven({
      notionalUsd,
      feeTvlRatio24h: 0.09,
      gasCostRoundTripUsd: gas,
      slippagePct: 2,
      minCoverageRatio: 2.5,
    });
    assert.ok(nineExactly.passes, "9.00% fee/TVL no longer clears the coverage gate");

    // 7.87% is the fone-SOL entry from the 67h run: it passed under the old cost
    // basis and must now be refused, which is the point of the change.
    const sevenNine = assessBreakeven({
      notionalUsd,
      feeTvlRatio24h: 0.0787,
      gasCostRoundTripUsd: gas,
      slippagePct: 2,
      minCoverageRatio: 2.5,
    });
    assert.ok(!sevenNine.passes, "the gate still admits pools below the advertised 9% bar");
  });
});

describe("live micro-capital — startup gate", () => {
  const wallet = "SoLWa11etAddressForTestsOnly1111111111111111";
  const balance = (sol: number) => ({
    address: wallet,
    lamports: Math.round(sol * 1_000_000_000),
    sol,
    readAt: new Date().toISOString(),
  });
  const silent = () => {};

  it("does nothing at all when the profile is not armed", async () => {
    let touched = false;
    const r = await runLivePreflight({
      config: profile({ enabled: false }),
      readBalance: async () => {
        touched = true;
        return balance(0);
      },
      log: silent,
    });
    assert.equal(r.status, "skipped");
    assert.equal(touched, false, "paper boot reached the network");
  });

  it("starts when the wallet clears the 0.2 SOL floor", async () => {
    const r = await runLivePreflight({
      config: profile(),
      readBalance: async () => balance(0.5),
      alert: async () => assert.fail("alerted on a healthy wallet"),
      log: silent,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.balance?.sol, 0.5);
  });

  it("refuses to start below 0.2 SOL and raises INSUFFICIENT_GAS_RESERVE", async () => {
    const alerts: string[] = [];
    await assert.rejects(
      runLivePreflight({
        config: profile(),
        readBalance: async () => balance(0.05),
        alert: async (t) => void alerts.push(t),
        log: silent,
      }),
      (err: unknown) => {
        assert.ok(err instanceof InsufficientGasReserveError);
        assert.equal(err.code, INSUFFICIENT_GAS_RESERVE);
        assert.equal(err.balanceSol, 0.05);
        assert.equal(err.requiredSol, 0.2);
        return true;
      },
    );
    assert.equal(alerts.length, 1, "operator was not paged");
    assert.match(alerts[0] ?? "", /INSUFFICIENT_GAS_RESERVE/);
    assert.match(alerts[0] ?? "", /REFUSED/);
  });

  it("treats an unreadable balance as a failure, not as permission to start", async () => {
    // "The RPC was down" is not evidence of solvency. Same fail-closed rule as the
    // anti-rug screen, and the opposite of the anti-churn gates.
    const alerts: string[] = [];
    await assert.rejects(
      runLivePreflight({
        config: profile(),
        readBalance: async () => {
          throw new Error("connect ETIMEDOUT");
        },
        alert: async (t) => void alerts.push(t),
        log: silent,
      }),
      (err: unknown) => err instanceof InsufficientGasReserveError && err.balanceSol === null,
    );
    assert.equal(alerts.length, 1);
  });

  it("refuses when no wallet address is configured to check", async () => {
    await assert.rejects(
      runLivePreflight({
        config: profile({ walletAddress: undefined }),
        alert: async () => {},
        log: silent,
      }),
      (err: unknown) => err instanceof InsufficientGasReserveError,
    );
  });

  it("still refuses when the Telegram alert itself fails", async () => {
    // The alert is a courtesy; the refusal is the safety property. Swallowing the
    // throw because the notification failed would start the engine on an empty wallet.
    await assert.rejects(
      runLivePreflight({
        config: profile(),
        readBalance: async () => balance(0.01),
        alert: async () => {
          throw new Error("telegram 502");
        },
        log: silent,
      }),
      (err: unknown) => err instanceof InsufficientGasReserveError,
    );
  });
});

describe("live micro-capital — secrets stay in the environment", () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return name.endsWith(".ts") ? [full] : [];
    });

  it("reads SOLANA_PRIVATE_KEY only from the environment schema", () => {
    const hits = sourceFiles(srcDir).filter((f) =>
      readFileSync(f, "utf8").includes("SOLANA_PRIVATE_KEY"),
    );
    for (const file of hits) {
      const relative = file.slice(srcDir.length).replace(/\\/g, "/");
      /*
       * A deliberately short allowlist, extended only by review. Each entry earns its
       * place: env.ts parses it, liveConfig.ts answers whether one EXISTS without
       * returning it, and onchainExecutor.ts is the signer — the one place that must
       * actually decode it, where it stays module-private inside loadWallet(). A new
       * name appearing here is the signal this test exists to raise.
       */
      assert.ok(
        [
          "config/env.ts",
          "config/liveConfig.ts",
          "services/onchainExecutor.ts",
          "tests/liveConfig.test.ts",
          "tests/onchainExecutor.test.ts",
        ].includes(relative),
        `${relative} references SOLANA_PRIVATE_KEY outside the reviewed set`,
      );
    }
  });

  it("has no base58 key literal checked into src/", () => {
    // A Solana secret key is 87-88 base58 characters. Anything that long and that
    // shaped in the source is a leaked key, not a constant.
    const base58Secret = /['"`][1-9A-HJ-NP-Za-km-z]{86,90}['"`]/;
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      assert.ok(
        !base58Secret.test(text),
        `${file.slice(srcDir.length)} contains what looks like a hardcoded base58 secret key`,
      );
    }
  });

  it("exposes no accessor that returns the key", () => {
    const text = readFileSync(join(srcDir, "config", "liveConfig.ts"), "utf8");
    assert.ok(
      !/return\s+env\.SOLANA_PRIVATE_KEY/.test(text),
      "liveConfig hands out the signing key; nothing here can sign, so nothing should read it",
    );
  });
});
