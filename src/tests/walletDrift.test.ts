/**
 * Wallet drift: does the accounting baseline still describe the wallet it claims to?
 *
 * On 11 Sep 2026 `STARTING_BALANCE_USD` was pinned at 298.02 while the wallet held
 * about $285.5 — roughly $12 apart — and nothing told anyone. Two causes look identical
 * from here and both need a human: a baseline pinned above what the wallet ever held
 * (the pin double-counts trades already booked), and real SOL spent on live attempts
 * that produced no rows at all. This measures the gap; it corrects nothing, for the same
 * reason `seedStartingBalanceFromWallet` refuses to rebase under existing trades.
 *
 * The rule under test is mostly about REFUSING TO CLAIM: an unmeasured drift is null,
 * never 0, because "no basis to compare" and "compared, and they agree" render
 * identically otherwise.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessWalletDrift, describeWalletDrift } from "../services/reconciliation.js";

const THRESHOLDS = { maxPct: 1, maxSol: 0.02 };

describe("assessWalletDrift", () => {
  it("flags the 11 Sep gap: book $298.02, wallet 2.880994 SOL at $99.09", () => {
    const r = assessWalletDrift({
      bookUsd: 298.02,
      walletSol: 2.880994,
      solPriceUsd: 99.09,
      thresholds: THRESHOLDS,
    });

    assert.equal(r.status, "drifted");
    // ~$285.48 against $298.02 — the wallet is POORER, which is the direction every
    // unmodelled cost pushes.
    assert.ok((r.driftUsd ?? 0) < 0);
    assert.ok(Math.abs((r.driftUsd ?? 0) + 12.54) < 0.1, `${r.driftUsd}`);
    // Both thresholds are breached at once; both are named.
    assert.deepEqual(r.breached, ["pct", "sol"]);
    assert.match(r.reason ?? "", /298\.02/);
    assert.match(r.reason ?? "", /2\.880994/);
    assert.match(r.reason ?? "", /live_execution_attempts/);
    assert.match(r.reason ?? "", /STARTING_BALANCE_USD/);
  });

  it("stays quiet when the two agree", () => {
    const r = assessWalletDrift({
      bookUsd: 285.5,
      walletSol: 2.880994,
      solPriceUsd: 99.09,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.reason, null);
    assert.deepEqual(r.breached, []);
    assert.match(describeWalletDrift(r), /within thresholds/);
  });

  /*
   * EITHER unit fires. A percentage alone never fires on a large book that has quietly
   * lost real SOL; an absolute alone fires constantly on a small one.
   */
  it("fires on the SOL threshold alone when the percentage is comfortable", () => {
    // $10,000 book; 0.05 SOL short at $100 is $5 — 0.05% of the book, but 0.05 SOL.
    const r = assessWalletDrift({
      bookUsd: 10_000,
      walletSol: 99.95,
      solPriceUsd: 100,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "drifted");
    assert.deepEqual(r.breached, ["sol"]);
  });

  it("fires on the PERCENTAGE threshold alone when the absolute is tiny", () => {
    // $1 book, 0.005 SOL short at $100 is $0.50 — 50% of the book, under 0.02 SOL.
    const r = assessWalletDrift({
      bookUsd: 1,
      walletSol: 0.005,
      solPriceUsd: 100,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "drifted");
    assert.deepEqual(r.breached, ["pct"]);
  });

  it("reports a wallet RICHER than the book too — drift is not one-directional by fiat", () => {
    const r = assessWalletDrift({
      bookUsd: 100,
      walletSol: 2,
      solPriceUsd: 100,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "drifted");
    assert.ok((r.driftUsd ?? 0) > 0);
  });

  /*
   * UNMEASURED IS NOT ZERO. A drift of 0 and a drift that could not be computed render
   * identically to a reader, and only one of them means the two numbers agree.
   */
  it("is UNMEASURED, never 0, when any input is missing", () => {
    for (const input of [
      { bookUsd: null, walletSol: 2, solPriceUsd: 100 },
      { bookUsd: 100, walletSol: null, solPriceUsd: 100 },
      { bookUsd: 100, walletSol: 2, solPriceUsd: null },
      { bookUsd: 100, walletSol: 2, solPriceUsd: 0 },
      { bookUsd: Number.NaN, walletSol: 2, solPriceUsd: 100 },
    ]) {
      const r = assessWalletDrift({ ...input, thresholds: THRESHOLDS });
      assert.equal(r.status, "unmeasured", JSON.stringify(input));
      assert.equal(r.driftUsd, null);
      assert.equal(r.driftSol, null);
      assert.equal(r.driftPct, null);
      assert.deepEqual(r.breached, []);
    }
    assert.match(
      describeWalletDrift(
        assessWalletDrift({
          bookUsd: null,
          walletSol: 2,
          solPriceUsd: 100,
          thresholds: THRESHOLDS,
        }),
      ),
      /NOT MEASURED/,
    );
  });

  /*
   * A zero book makes the ratio undefined. Null rather than Infinity, so it cannot
   * render on a dashboard as a real measurement — the same rule `profitFactor` follows.
   */
  it("yields a null percentage on a zero book rather than Infinity", () => {
    const r = assessWalletDrift({
      bookUsd: 0,
      walletSol: 1,
      solPriceUsd: 100,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.driftPct, null);
    // The absolute threshold still binds, so the reading is not silently swallowed.
    assert.equal(r.status, "drifted");
    assert.deepEqual(r.breached, ["sol"]);
  });
});
