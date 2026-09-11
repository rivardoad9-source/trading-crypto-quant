/**
 * Wallet drift: does the accounting baseline still describe the wallet it claims to?
 *
 * On 11 Sep 2026 `STARTING_BALANCE_USD` was pinned at 298.02 while the wallet held
 * about $285.5 — roughly $12 apart — and nothing told anyone. This measures the gap; it
 * corrects nothing.
 *
 * And the SECOND lesson of the same day, which these tests are mostly about: the first
 * version compared the USD book with `walletSol x spot`, so a 1.15% SOL/USD dip on a
 * wallet that had not moved by a lamport paged "a drift of $-3.31 (-0.033474 SOL)". The
 * SOL figure was the USD gap divided by the price — not a measurement. Now the book is
 * put in SOL at the price it was PINNED at, and the breach is decided on
 * `walletSol - bookSol`, full stop.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessWalletDrift, describeWalletDrift } from "../services/reconciliation.js";

const THRESHOLDS = { maxPct: 1, maxSol: 0.02 };

/** The 11 Sep re-pin: $288.27 = 2.880994 SOL x $100.06. */
const WALLET = 2.880994;
const BASELINE = 100.06;
const BOOK_USD = 288.27;

describe("assessWalletDrift — a SOL/USD move is not drift", () => {
  it("11 Sep: identical wallet, price 100.06 -> 99.29 — ok, nothing breached, no alert", () => {
    /*
     * Under the USD comparison this read -0.0223 SOL and breached maxSol=0.02 — a 0.77%
     * price move beating a threshold that was meant to be about SOL. The wallet is the
     * same 2.880994 SOL before and after.
     */
    const before = assessWalletDrift({
      bookUsd: BOOK_USD,
      walletSol: WALLET,
      solPriceUsd: BASELINE,
      baselineSolPriceUsd: BASELINE,
      thresholds: THRESHOLDS,
    });
    const after = assessWalletDrift({
      bookUsd: BOOK_USD,
      walletSol: WALLET,
      solPriceUsd: 99.29,
      baselineSolPriceUsd: BASELINE,
      thresholds: THRESHOLDS,
    });

    for (const r of [before, after]) {
      assert.equal(r.status, "ok");
      assert.deepEqual(r.breached, []);
      assert.equal(r.reason, null, "an ok reading carried an alert");
    }
    // The measurement did not move, because nothing it measures moved.
    assert.equal(after.driftSol, before.driftSol);
    assert.ok(Math.abs(after.driftSol ?? 1) < 0.0001, `driftSol ${after.driftSol}`);

    // And the line says PRICE, with both prices, and prints no SOL drift of -0.02.
    const line = describeWalletDrift(after);
    assert.match(line, /within thresholds/);
    assert.match(line, /PRICE/);
    assert.match(line, /100\.06/);
    assert.match(line, /99\.29/);
    assert.doesNotMatch(line, /-0\.02\d* SOL/, "a price move was rendered as a SOL drift");
  });

  it("the 1.15% dip that actually paged (98.91) is ok as well", () => {
    const r = assessWalletDrift({
      bookUsd: BOOK_USD,
      walletSol: WALLET,
      solPriceUsd: 98.91,
      baselineSolPriceUsd: BASELINE,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "ok");
    assert.doesNotMatch(describeWalletDrift(r), /0\.033474/);
  });
});

describe("assessWalletDrift — real SOL movement", () => {
  it("SOL actually leaves (-0.05 SOL): drifted, and driftSol IS the SOL difference", () => {
    const r = assessWalletDrift({
      bookUsd: BOOK_USD,
      walletSol: WALLET - 0.05,
      // A spot price far from the baseline, to prove it plays no part in the number.
      solPriceUsd: 140,
      baselineSolPriceUsd: BASELINE,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "drifted");
    assert.deepEqual(r.breached, ["pct", "sol"]);
    const bookSol = BOOK_USD / BASELINE;
    assert.ok(Math.abs((r.driftSol ?? 0) - (WALLET - 0.05 - bookSol)) < 1e-9, `${r.driftSol}`);
    assert.ok(Math.abs((r.driftSol ?? 0) + 0.05) < 0.0001, "driftSol was not the real -0.05 SOL");
    assert.match(r.reason ?? "", /LEFT the wallet/);
    assert.match(r.reason ?? "", /live_execution_attempts/);
    assert.match(r.reason ?? "", /NOT a SOL\/USD move/);
    // Display only, and priced explicitly.
    assert.match(r.reason ?? "", /\$140/);
  });

  it("SOL arrives: driftSol is POSITIVE, not clamped to zero", () => {
    const r = assessWalletDrift({
      bookUsd: BOOK_USD,
      walletSol: WALLET + 0.05,
      solPriceUsd: 90,
      baselineSolPriceUsd: BASELINE,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "drifted");
    assert.ok((r.driftSol ?? 0) > 0.049, `${r.driftSol}`);
    assert.match(r.reason ?? "", /ARRIVED/);
  });

  it("still flags the original 11 Sep gap: book $298.02 pinned at $100.06, wallet 2.880994 SOL", () => {
    const r = assessWalletDrift({
      bookUsd: 298.02,
      walletSol: WALLET,
      solPriceUsd: 99.09,
      baselineSolPriceUsd: BASELINE,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "drifted");
    assert.ok((r.driftSol ?? 0) < -0.09, `${r.driftSol}`);
    assert.match(r.reason ?? "", /298\.02/);
    assert.match(r.reason ?? "", /2\.880994/);
    assert.match(r.reason ?? "", /STARTING_BALANCE_USD/);
  });

  /*
   * EITHER threshold fires. A percentage alone never fires on a large book that has
   * quietly lost real SOL; an absolute alone fires constantly on a small one.
   */
  it("fires on the SOL threshold alone when the percentage is comfortable", () => {
    // 100 SOL book, 0.05 SOL short: 0.05%, but 0.05 SOL.
    const r = assessWalletDrift({
      bookUsd: 10_000,
      walletSol: 99.95,
      solPriceUsd: 100,
      baselineSolPriceUsd: 100,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "drifted");
    assert.deepEqual(r.breached, ["sol"]);
  });

  it("fires on the PERCENTAGE threshold alone when the absolute is tiny", () => {
    // 0.01 SOL book, 0.005 SOL short: 50%, under 0.02 SOL.
    const r = assessWalletDrift({
      bookUsd: 1,
      walletSol: 0.005,
      solPriceUsd: 100,
      baselineSolPriceUsd: 100,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "drifted");
    assert.deepEqual(r.breached, ["pct"]);
  });
});

describe("assessWalletDrift — boundaries and refusals to claim", () => {
  it("EXACTLY at maxSol passes; one lamport over breaches (same direction as assessLiveSizing)", () => {
    // 3 SOL book. 2.98 SOL is exactly 0.02 short — floating residue must not decide it.
    const at = assessWalletDrift({
      bookUsd: 300,
      walletSol: 2.98,
      solPriceUsd: 100,
      baselineSolPriceUsd: 100,
      thresholds: { maxPct: 100, maxSol: 0.02 },
    });
    assert.equal(at.status, "ok", `at the bound: ${at.driftSol}`);
    assert.deepEqual(at.breached, []);

    const over = assessWalletDrift({
      bookUsd: 300,
      walletSol: 2.979999999,
      solPriceUsd: 100,
      baselineSolPriceUsd: 100,
      thresholds: { maxPct: 100, maxSol: 0.02 },
    });
    assert.deepEqual(over.breached, ["sol"]);
  });

  it("EXACTLY at maxPct passes", () => {
    // 3 SOL book, 0.03 SOL short = exactly 1%.
    const r = assessWalletDrift({
      bookUsd: 300,
      walletSol: 2.97,
      solPriceUsd: 100,
      baselineSolPriceUsd: 100,
      thresholds: { maxPct: 1, maxSol: 1 },
    });
    assert.equal(r.status, "ok", `${r.driftPct}`);
  });

  /*
   * UNMEASURED IS NOT ZERO. A drift of 0 and a drift that could not be computed render
   * identically to a reader, and only one of them means the two numbers agree.
   */
  it("is UNMEASURED, never 0, with no baseline price, a non-positive one, no wallet or no book", () => {
    for (const input of [
      { bookUsd: BOOK_USD, walletSol: WALLET, baselineSolPriceUsd: null },
      { bookUsd: BOOK_USD, walletSol: WALLET, baselineSolPriceUsd: 0 },
      { bookUsd: BOOK_USD, walletSol: WALLET, baselineSolPriceUsd: -100 },
      { bookUsd: BOOK_USD, walletSol: null, baselineSolPriceUsd: BASELINE },
      { bookUsd: null, walletSol: WALLET, baselineSolPriceUsd: BASELINE },
      { bookUsd: Number.NaN, walletSol: WALLET, baselineSolPriceUsd: BASELINE },
    ]) {
      const r = assessWalletDrift({ ...input, solPriceUsd: 99, thresholds: THRESHOLDS });
      assert.equal(r.status, "unmeasured", JSON.stringify(input));
      assert.equal(r.driftSol, null);
      assert.equal(r.driftUsd, null);
      assert.equal(r.driftPct, null);
      assert.equal(r.reason, null);
      assert.deepEqual(r.breached, []);
      assert.match(describeWalletDrift(r), /NOT MEASURED/);
    }
    assert.match(
      describeWalletDrift(
        assessWalletDrift({
          bookUsd: BOOK_USD,
          walletSol: WALLET,
          solPriceUsd: 99,
          baselineSolPriceUsd: null,
          thresholds: THRESHOLDS,
        }),
      ),
      /BASELINE_SOL_PRICE_USD is not set/,
    );
  });

  it("a missing SPOT price blanks the dollars but decides nothing — the SOL check still runs", () => {
    const r = assessWalletDrift({
      bookUsd: BOOK_USD,
      walletSol: WALLET - 0.05,
      solPriceUsd: null,
      baselineSolPriceUsd: BASELINE,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.status, "drifted");
    assert.equal(r.driftUsd, null);
    assert.equal(r.walletUsd, null);
    assert.equal(r.priceMovePct, null);
    assert.ok((r.driftSol ?? 0) < 0);
  });

  it("yields a null percentage on a zero book rather than Infinity", () => {
    const r = assessWalletDrift({
      bookUsd: 0,
      walletSol: 1,
      solPriceUsd: 100,
      baselineSolPriceUsd: 100,
      thresholds: THRESHOLDS,
    });
    assert.equal(r.bookSol, 0);
    assert.equal(r.driftPct, null);
    // The absolute threshold still binds, so the reading is not silently swallowed.
    assert.equal(r.status, "drifted");
    assert.deepEqual(r.breached, ["sol"]);
  });
});

describe("the drift check stays LIVE-ONLY", () => {
  /*
   * Paper mode must stay byte-identical: no wallet read, no drift line, no alert. Both
   * the boot call and the hourly cron sit behind `isLiveExecutionActive()`, and nothing
   * else calls `reportCapitalHealth`.
   */
  it("reportCapitalHealth is only reached behind isLiveExecutionActive()", () => {
    const source = readFileSync("src/index.ts", "utf8");
    const calls = [...source.matchAll(/reportCapitalHealth(?!\(\): Promise)/g)].map((m) => m.index ?? 0);
    // The definition, the boot call and the cron registration.
    const uses = calls.filter((i) => !source.slice(i - 15, i).includes("function "));
    assert.equal(uses.length, 2, `unexpected reportCapitalHealth references: ${uses.length}`);
    for (const i of uses) {
      const guard = source.lastIndexOf("if (isLiveExecutionActive()) {", i);
      assert.ok(guard > 0, "a reportCapitalHealth call has no live guard above it");
      // The guard's block must still be open at the call: no closing brace at its indent.
      const between = source.slice(guard, i);
      assert.equal(/\n  }\n/.test(between.replace(/\r\n/g, "\n")), false, "the call is outside the live guard");
    }
  });
});
