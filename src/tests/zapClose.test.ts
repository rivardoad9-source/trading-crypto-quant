/**
 * The arithmetic of the atomic (zap) close, and the guards that keep the composition honest.
 *
 * WHY THESE NUMBERS. Every test vector below is taken from the read-only spike against the
 * operator's live position (`/tmp/zap-spike/REPORT.md`), not invented: the withdrawn amount,
 * the 300 bps fee, the lamport-exact floor and the 1 176-byte message are all measurements.
 * A unit test is only worth its vector if the vector came from the chain.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_TRANSACTION_BYTES,
  ZAP_CLOSE_COMPUTE_UNITS_FLOOR,
  ZapCloseUnavailableError,
  swapInputAfterTransferFee,
  transferFeeUnits,
  zapCloseFits,
} from "../services/zapClose.js";

/* The spike's position: 70 698 273 541 withdrawn X, 300 bps Token-2022 transfer fee. */
const WITHDRAWN_X = 70_698_273_541n;
const FEE_UNITS = 2_120_948_206n;

describe("transferFeeUnits — what the token withholds on a transfer", () => {
  it("takes the scheduled basis points off the amount", () => {
    assert.equal(transferFeeUnits({ amount: WITHDRAWN_X, feeBps: 300, maximumFee: null }), FEE_UNITS);
    /* Independently: 3% of the withdrawn amount, which is what the pool reserve delta showed. */
    assert.equal((WITHDRAWN_X * 300n) / 10_000n, FEE_UNITS);
  });

  it("honours the schedule's absolute cap", () => {
    assert.equal(
      transferFeeUnits({ amount: WITHDRAWN_X, feeBps: 300, maximumFee: 1_000_000n }),
      1_000_000n,
      "the maximumFee cap was ignored",
    );
  });

  it("is a no-op for a mint with no fee — every classic SPL token the engine trades", () => {
    assert.equal(transferFeeUnits({ amount: WITHDRAWN_X, feeBps: 0, maximumFee: null }), 0n);
  });

  it("never invents a fee out of a nonsense schedule", () => {
    assert.equal(transferFeeUnits({ amount: WITHDRAWN_X, feeBps: Number.NaN, maximumFee: null }), 0n);
    assert.equal(transferFeeUnits({ amount: WITHDRAWN_X, feeBps: -300, maximumFee: null }), 0n);
    assert.equal(transferFeeUnits({ amount: 0n, feeBps: 300, maximumFee: null }), 0n);
  });
});

describe("swapInputAfterTransferFee — the amount the pool actually receives", () => {
  it("subs the fee off the amount the wallet holds", () => {
    const { swappedIn, feeUnits } = swapInputAfterTransferFee({
      amount: WITHDRAWN_X,
      feeBps: 300,
      maximumFee: null,
    });
    assert.equal(feeUnits, FEE_UNITS);
    assert.equal(swappedIn, WITHDRAWN_X - FEE_UNITS);
    /* The spike measured 66 520 005 573 X reaching the pool on a round trip that pays the
     * fee TWICE (5.910%). This is the number the QUOTE is taken at, and it is deliberately
     * the more optimistic one: a floor cannot be allowed to demand an output the pool will
     * never quote, which is the revert this guards (DLMM Swap2 Custom:6003). */
    assert.ok(swappedIn > 66_520_005_573n);
  });

  it("REFUSES a fee that would consume the whole balance", () => {
    assert.throws(
      () => swapInputAfterTransferFee({ amount: WITHDRAWN_X, feeBps: 10_000, maximumFee: null }),
      ZapCloseUnavailableError,
    );
  });
});

describe("zapCloseFits — the 1 232-byte message limit", () => {
  it("admits the measured composition and refuses one byte more", () => {
    assert.equal(zapCloseFits(1176), true, "the spike's own composition must fit");
    assert.equal(zapCloseFits(MAX_TRANSACTION_BYTES), true);
    assert.equal(zapCloseFits(MAX_TRANSACTION_BYTES + 1), false);
  });

  it("treats an unknown size as too big, not as small", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(zapCloseFits(bad), false, `${bad} was treated as a safe size`);
    }
  });

  it("budgets more compute than the composed path measured (501 908 CU)", () => {
    assert.ok(ZAP_CLOSE_COMPUTE_UNITS_FLOOR > 501_908);
  });
});

/*
 * The source guards. They are here because the two mistakes they catch are silent: a zap
 * whose floor is quoted from the wrong amount reverts on-chain only sometimes (it passed by
 * 0-1 lamport at 300 bps on the spike), and a zap whose bound is the ENTRY bound is exactly
 * the 13 Sep 2026 refusal — a real sale refused at 50 bps.
 */
describe("the composition in onchainExecutor.ts keeps its two guarantees", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "services", "onchainExecutor.ts"),
    "utf8",
  );
  const start = source.indexOf("async function composeAndSendZapClose");
  const zapClose = source.slice(start, source.indexOf("export const dlmmExecutor", start));

  it("quotes the floor from the FEE-ADJUSTED input, never from the withdrawn amount", () => {
    assert.ok(start > 0, "composeAndSendZapClose is gone — this guard is checking nothing");
    assert.match(zapClose, /swapQuote\(new BN\(swappedIn\.toString\(\)\)/, "the floor is not quoted from `swappedIn`");
    assert.equal(
      /swapQuote\(new BN\(withdrawnX/.test(zapClose),
      false,
      "a floor quoted on the FULL withdrawn amount is the false positive that reverts",
    );
  });

  it("bounds the swap with the EXIT bound, not the entry one", () => {
    assert.match(zapClose, /resolveExitSlippageBps\(/);
    assert.equal(/resolveSlippageBps\(/.test(zapClose), false);
  });

  it("checks the serialized size BEFORE sending, and refuses over the limit", () => {
    assert.match(zapClose, /zapCloseFits\(transactionBytes\)/);
    const check = zapClose.indexOf("zapCloseFits(transactionBytes)");
    const send = zapClose.indexOf("await sendAndConfirm");
    assert.ok(check > send, "the size check must run inside the builder, before the send");
  });

  it("swaps in the position's own DLMM pool — no Jupiter route, no API key", () => {
    assert.match(zapClose, /zapOutThroughDlmm\(/);
    assert.equal(/zapOutThroughJupiter/.test(zapClose), false, "the keyed Jupiter route crept in");
    assert.match(zapClose, /percentageToZapOut: 100/);
  });
});
