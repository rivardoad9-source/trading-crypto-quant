/**
 * The capital guard: does the wallet actually hold what the engine sizes against?
 *
 * THE FAILURE THIS PINS. On 11 Sep 2026 `LIVE_CAPITAL_SOL` was 3.05 while the wallet
 * held 2.880994 SOL. The pin had been correct when it was set. Nothing compared them,
 * so `openLivePosition` sized a deposit against 2.90 SOL of deployable capital, the
 * balancing swap sent 0.9 SOL and CONFIRMED, and the DLMM deposit leg then died on
 * `TransferChecked -> insufficient funds`. Three times inside thirty minutes:
 * -0.0639 SOL, zero positions opened, zero rows written.
 *
 * The engine already READ that balance at every boot and printed it. The whole defect
 * was that the reading was never an input to anything, and the whole fix is one
 * comparison made before money moves — which is why every test here is offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessLiveSizing, describeLiveSizing } from "../services/liveSizingGuard.js";
import type { LiveMicroCapitalConfig } from "../config/liveConfig.js";

/** The 11 Sep deployed profile: 3.05 capital, 0.15 reserve, 2.90 deployable. */
function profile(over: Partial<LiveMicroCapitalConfig> = {}): LiveMicroCapitalConfig {
  return Object.freeze({
    enabled: true,
    capitalSol: 3.05,
    maxPositionSol: 1.8,
    maxConcurrentPositions: 1,
    minReserveSol: 0.15,
    deployableSol: 2.9,
    maxExposureSol: 1.8,
    roundTripGasSol: 0.008,
    entryRentSol: 0,
    maxRentToPnl: 1,
    minNetPnlUsd: 1.5,
    pnlHorizonHours: 24,
    minWalletSol: 0.2,
    walletAddress: "FaVHg7111111111111111111111111111111111111",
    ...over,
  }) as LiveMicroCapitalConfig;
}

describe("assessLiveSizing", () => {
  it("REFUSES when deployable capital exceeds the real balance — the 11 Sep incident", () => {
    const v = assessLiveSizing({ balanceSol: 2.880994, config: profile() });

    assert.equal(v.ok, false);
    assert.equal(v.status, "over-capital");
    assert.equal(v.actualBalanceSol, 2.880994);
    // 2.9 - 2.880994. The incident's own figure, to six places.
    assert.ok(v.shortfallSol !== null);
    assert.ok(Math.abs((v.shortfallSol ?? 0) - 0.019006) < 1e-9);
    // The reason must carry BOTH numbers and the remedy, because it is what an operator
    // reads at 02:00 with money already gone.
    assert.match(v.reason ?? "", /3\.05/);
    assert.match(v.reason ?? "", /2\.880994/);
    assert.match(v.reason ?? "", /LIVE_CAPITAL_SOL/);
  });

  it("passes when the wallet covers deployable capital", () => {
    const v = assessLiveSizing({ balanceSol: 3.5, config: profile() });
    assert.equal(v.ok, true);
    assert.equal(v.status, "ok");
    assert.equal(v.shortfallSol, null);
    assert.equal(v.reason, null);
  });

  /*
   * THE BOUNDARY, STATED RATHER THAN DISCOVERED.
   *
   * At exact equality every lamport the engine may deploy is provably in the wallet,
   * which is the condition being tested — refusing there would make the guard stricter
   * than its own statement and would refuse a wallet that is exactly, correctly funded.
   * That the untouchable reserve is ALSO present is a different question, asked by
   * LIVE_MIN_WALLET_SOL in livePreflight.ts. If this direction is ever changed, it is a
   * change to what the guard means, not a tidy-up.
   */
  it("PASSES at exact equality (deployable === balance), and that direction is deliberate", () => {
    const v = assessLiveSizing({ balanceSol: 2.9, config: profile() });
    assert.equal(v.ok, true);
    assert.equal(v.status, "ok");
  });

  it("refuses one lamport below the boundary", () => {
    const v = assessLiveSizing({ balanceSol: 2.9 - 1e-9, config: profile() });
    assert.equal(v.ok, false);
    assert.equal(v.status, "over-capital");
  });

  it("FAILS CLOSED when the balance could not be read", () => {
    const v = assessLiveSizing({
      balanceSol: null,
      balanceError: "429 Too Many Requests",
      config: profile(),
    });
    assert.equal(v.ok, false);
    assert.equal(v.status, "balance-unknown");
    // Never invented as zero, and the shortfall is null rather than a made-up number.
    assert.equal(v.actualBalanceSol, null);
    assert.equal(v.shortfallSol, null);
    assert.match(v.reason ?? "", /429 Too Many Requests/);
  });

  it("treats a non-finite balance as unread, not as a number", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = assessLiveSizing({ balanceSol: bad, config: profile() });
      assert.equal(v.status, "balance-unknown", `${bad}`);
      assert.equal(v.ok, false);
    }
  });

  /*
   * A DRAINED wallet is a measurement, not a failure. 0 must reach the over-capital
   * branch with its real number rather than being reported as an unreadable balance —
   * the two need different operator actions (top up vs fix the RPC).
   */
  it("reports a genuinely empty wallet as over-capital, not as unknown", () => {
    const v = assessLiveSizing({ balanceSol: 0, config: profile() });
    assert.equal(v.status, "over-capital");
    assert.equal(v.actualBalanceSol, 0);
    assert.equal(v.shortfallSol, 2.9);
  });

  it("is INERT in paper mode — nothing checked, nothing refused", () => {
    const v = assessLiveSizing({ balanceSol: null, config: profile({ enabled: false }) });
    assert.equal(v.ok, true);
    assert.equal(v.status, "inert");
    assert.equal(v.reason, null);
    assert.match(describeLiveSizing(v), /NOT checked/);
  });

  it("says which way it went, in one line, in every state", () => {
    assert.match(
      describeLiveSizing(assessLiveSizing({ balanceSol: 3.5, config: profile() })),
      /OK, margin/,
    );
    assert.match(
      describeLiveSizing(assessLiveSizing({ balanceSol: 2.0, config: profile() })),
      /REFUSING LIVE ENTRIES/,
    );
    assert.match(
      describeLiveSizing(assessLiveSizing({ balanceSol: null, config: profile() })),
      /REFUSING LIVE ENTRIES/,
    );
  });
});
