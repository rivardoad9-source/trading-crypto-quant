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
  liveMicroCapital,
  parseLiveConfig,
  requiredFeeTvlRatio24h,
  sizeNextPositionSol,
  type LiveMicroCapitalConfig,
} from "../config/liveConfig.js";
import {
  INSUFFICIENT_GAS_RESERVE,
  InsufficientGasReserveError,
  runLivePreflight,
} from "../services/livePreflight.js";

const srcDir = fileURLToPath(new URL("..", import.meta.url));

/** The requested profile, independent of whatever the operator's .env happens to say. */
function profile(overrides: Partial<LiveMicroCapitalConfig> = {}): LiveMicroCapitalConfig {
  return {
    enabled: true,
    capitalSol: 1.0,
    maxPositionSol: 0.2,
    maxConcurrentPositions: 3,
    minReserveSol: 0.15,
    deployableSol: 0.85,
    maxExposureSol: 0.6,
    roundTripGasSol: 0.008,
    minNetPnlUsd: 1.5,
    pnlHorizonHours: 24,
    minWalletSol: 0.2,
    walletAddress: "SoLWa11etAddressForTestsOnly1111111111111111",
    ...overrides,
  };
}

const ok = (r: ReturnType<typeof parseLiveConfig>): LiveMicroCapitalConfig => {
  assert.ok(r.ok, `expected a valid config, got: ${r.ok ? "" : r.issues.join("; ")}`);
  return r.config;
};

describe("live micro-capital — shipped defaults", () => {
  it("ships the requested 1 SOL profile with no configuration at all", () => {
    const cfg = ok(parseLiveConfig({}));
    assert.equal(cfg.capitalSol, 1.0);
    assert.equal(cfg.maxPositionSol, 0.2);
    assert.equal(cfg.maxConcurrentPositions, 3);
    assert.equal(cfg.minReserveSol, 0.15);
    assert.equal(cfg.roundTripGasSol, 0.008);
    assert.equal(cfg.minNetPnlUsd, 1.5);
    assert.equal(cfg.minWalletSol, 0.2);
  });

  it("is OFF by default — arming live sizing takes an explicit opt-in", () => {
    assert.equal(ok(parseLiveConfig({})).enabled, false);
    assert.equal(liveMicroCapital.enabled, false, "this machine has the live profile armed");
  });

  it("derives 0.85 SOL deployable and 0.60 SOL of maximum exposure", () => {
    const cfg = ok(parseLiveConfig({}));
    assert.equal(cfg.deployableSol, 0.85);
    assert.ok(Math.abs(cfg.maxExposureSol - 0.6) < 1e-9);
    assert.ok(cfg.maxExposureSol <= cfg.deployableSol, "full book would eat into the reserve");
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
  const cfg = profile();

  it("deploys the full position size when nothing is open", () => {
    const d = sizeNextPositionSol(0, 0, cfg);
    assert.equal(d.sizeSol, 0.2);
    assert.equal(d.freeSol, 0.85);
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
    const required = requiredFeeTvlRatio24h(20, SOL, cfg, 2);
    assert.ok(Math.abs(required - 0.135) < 1e-9, `expected 13.5%/24h, got ${required}`);
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
      assert.ok(
        ["config/env.ts", "config/liveConfig.ts", "tests/liveConfig.test.ts"].includes(relative),
        `${relative} references SOLANA_PRIVATE_KEY outside the env schema`,
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
