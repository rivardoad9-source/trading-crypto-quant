/**
 * The auto-unwind is finished when the wallet RE-READS empty — not when a swap is submitted.
 *
 * 17-18 Sep 2026, KNOTS-SOL, ~0.37 SOL parked for three hours and 0.094529764 SOL gone. The
 * failed open had recovered the position it half-funded FIRST, and that withdrawal returned
 * 1763.991215 KNOTS to the wallet. The unwind then read the balance, the node answered with the
 * figure it had before the withdrawal landed, and one sale of 2157.005388 followed. The
 * remaining 1763.991215 KNOTS sat in the wallet while the attempt was recorded `clean` — so no
 * recovery path ever looked at it again, and the cost line charged the unsold tokens as pure
 * loss (a 0.461917 SOL "loss" against a 0.15 SOL breaker budget, which shut entries for a real
 * loss of 0.094529764).
 *
 * The property under test, stated exactly: a sale is only evidence that a sale was SENT. The
 * loop re-reads after every sale, keeps selling until the read says zero, and reports what is
 * still held when it cannot get there — which the caller turns into `orphan`, never `clean`.
 *
 * The second half pins the other end of the same failure: the funding plan that asked for the
 * wallet's ENTIRE paired balance left no room for the margin the pool's `RebalanceLiquidity`
 * pulls with, which is what refused chunk 2 in the first place.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-unwind-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Live = typeof import("../services/liveExecution.js");

/*
 * THE EXECUTOR IS DELIBERATELY NOT IMPORTED HERE. `onchainExecutor.test.ts` pins the
 * allowlist of files allowed to import the signer (its own test, the bridge, and the three
 * operator scripts), and a new test is not a reason to widen that boundary. The
 * funding-headroom half of this incident is therefore asserted in the EXECUTOR's own test
 * file, which is already on the list; this file holds the unwind and sweep halves, both of
 * which reach the chain only through `liveExecution.ts`.
 */
let live: Live;

before(async () => {
  live = await import("../services/liveExecution.js");
});

after(async () => {
  (await import("../database/db.js")).closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

/** A scripted wallet: one balance per read, and every sale it was asked for. */
function wallet(readings: Array<bigint | null | Error>, failsAtSale?: number) {
  const queue = [...readings];
  const sold: bigint[] = [];
  const signatures: string[] = [];
  let reads = 0;
  return {
    sold,
    signatures,
    get reads() {
      return reads;
    },
    deps: {
      readBalance: async (): Promise<bigint | null> => {
        reads += 1;
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return next === undefined ? null : next;
      },
      sell: async (amount: bigint): Promise<string> => {
        if (failsAtSale !== undefined && sold.length === failsAtSale) {
          throw new Error("the pool cannot be priced right now");
        }
        sold.push(amount);
        const signature = `sell-${sold.length}`;
        signatures.push(signature);
        return signature;
      },
    },
  };
}

describe("the auto-unwind sells until the wallet reads empty", () => {
  it("sells nothing when there is nothing: no swap, no signature, and zero means zero", async () => {
    const w = wallet([0n]);
    const result = await live.unwindPairedBalance(w.deps);

    assert.equal(w.sold.length, 0);
    assert.deepEqual(result.signatures, []);
    assert.equal(result.remaining, 0n);
    assert.equal(result.error, null);
  });

  it("18 Sep: a single sale is not the end of the unwind — it re-reads and stops only at zero", async () => {
    const w = wallet([2_157_005_388n, 0n]);
    const result = await live.unwindPairedBalance(w.deps);

    assert.deepEqual(w.sold, [2_157_005_388n]);
    assert.deepEqual(result.signatures, ["sell-1"]);
    assert.equal(result.remaining, 0n);
    assert.equal(result.error, null);
  });

  it("THE STRAND: a stale read is followed by the balance the withdrawal returned, and both sell", async () => {
    /*
     * The exact incident sequence. The pre-withdrawal figure is what the first read answered
     * even though the withdrawal had already landed, so one sale of it left 1763.991215 behind.
     */
    const w = wallet([2_157_005_388n, 1_763_991_215n, 0n]);
    const result = await live.unwindPairedBalance(w.deps);

    assert.deepEqual(w.sold, [2_157_005_388n, 1_763_991_215n]);
    // 3,920,996,603 base units — the KNOTS the attempt's swap had put in the wallet in total,
    // which the single-sale unwind would have left 45% of behind.
    assert.equal(w.sold.reduce((a, b) => a + b, 0n), 3_920_996_603n);
    assert.equal(result.remaining, 0n);
    assert.equal(result.error, null);
  });

  it("stops at the pass bound and REPORTS what is still held, so the caller cannot call it clean", async () => {
    const w = wallet([1_000n]);
    const result = await live.unwindPairedBalance(w.deps);

    assert.equal(w.sold.length, live.UNWIND_MAX_PASSES);
    assert.equal(result.remaining, 1_000n);
    // No error: every sale it made CONFIRMED. What it cannot claim is emptiness.
    assert.equal(result.error, null);
    assert.ok(result.remaining !== null && result.remaining > 0n);
  });

  it("an unreadable balance is NOT an empty wallet: nothing is sold and the error says so", async () => {
    const nulled = wallet([null]);
    const unreadable = await live.unwindPairedBalance(nulled.deps);
    assert.equal(nulled.sold.length, 0);
    assert.equal(unreadable.remaining, null);
    assert.match(String(unreadable.error), /could not be read/);

    const thrown = wallet([new Error("rpc down")]);
    const failed = await live.unwindPairedBalance(thrown.deps);
    assert.equal(thrown.sold.length, 0);
    assert.equal(failed.remaining, null);
    assert.match(String(failed.error), /rpc down/);
  });

  it("a refused sale keeps the signatures that did confirm and reports the balance it could not sell", async () => {
    const w = wallet([5_000n], 1);
    const result = await live.unwindPairedBalance(w.deps);

    assert.deepEqual(result.signatures, ["sell-1"]);
    assert.deepEqual(w.sold, [5_000n]);
    assert.equal(result.remaining, 5_000n);
    assert.match(String(result.error), /cannot be priced/);
  });

  it("never sells more than the pass bound allows, even when every pass confirms", async () => {
    const w = wallet([2_000n]);
    await live.unwindPairedBalance(w.deps, 2);
    assert.equal(w.sold.length, 2);
  });
});

/*
 * THE SAME RULE ON THE EXIT SIDE. The residual sweep used to report `swept` on the strength of
 * a CONFIRMED SALE alone, and `swept` is what lets the close record `wallet_lamports_after` as
 * the trade's final effect (`isSettledSweep`). A sale of the balance it read can still leave
 * tokens behind — a withdrawal that landed after the read, or a node answering an old balance —
 * so the sweep now re-reads before it calls the wallet clear. 18 Sep 2026 is the worked example
 * on the failed-open side; these tests hold the exit side to the same standard.
 */
describe("the residual sweep proves the wallet empty before calling it settled", () => {
  function sweepDeps(
    reads: (bigint | null)[],
    onSell?: (amount: bigint) => void,
  ) {
    let i = 0;
    const pages: string[] = [];
    const amounts: bigint[] = [];
    const deps = {
      async resolvePairedMint() {
        return "MintPaired111111111111111111111111111111";
      },
      async readBalance() {
        const next = reads.length > 1 ? reads.shift()! : reads[0]!;
        i += 1;
        return next;
      },
      async quoteToSol(_mint: string, amount: bigint) {
        return Number(amount) * 100;
      },
      async swapToSol(_mint: string, amount: bigint) {
        amounts.push(amount);
        onSell?.(amount);
        return "sold-sig";
      },
      async alert(message: string) {
        pages.push(message);
      },
    };
    return { deps, pages, amounts, reads: () => i };
  }

  it("re-reads after the sale and reports swept only when the wallet reads empty", async () => {
    const h = sweepDeps([100_000n, 0n]);
    const sweep = await live.sweepResidualPairedToken(
      { pairName: "X-SOL", positionAddress: "Pos111" },
      h.deps,
    );
    assert.equal(sweep.state, "swept");
    assert.deepEqual(h.amounts, [100_000n]);
    assert.equal(h.reads(), 2, "the balance must be re-read after the sale");
    assert.equal(sweep.error, null);
    assert.deepEqual(h.pages, []);
    assert.equal(live.isSettledSweep(sweep), true);
  });

  it("a sale that leaves a balance behind is NOT settled, and pages the remainder", async () => {
    const h = sweepDeps([100_000n, 40_000n]);
    const sweep = await live.sweepResidualPairedToken(
      { pairName: "X-SOL", positionAddress: "Pos111" },
      h.deps,
    );
    assert.equal(sweep.state, "failed");
    assert.equal(live.isSettledSweep(sweep), false, "a wallet that still holds is not final");
    assert.match(sweep.error ?? "", /STILL HOLDS 40000 base units/);
    assert.equal(sweep.signature, "sold-sig", "the sale DID land and must stay visible");
    assert.equal(h.pages.length, 1);
    assert.match(h.pages[0]!, /RESIDUAL TOKEN NOT SWEPT/);
    assert.match(h.pages[0]!, /wallet_lamports_after was left NULL/);
  });

  it("a leftover under the dust line is dust and stays settled, without paging", async () => {
    // 40 base units → 4,000 lamports, under the 1,000,000-lamport dust default: a crumb that
    // costs more in fees to sell than it recovers. Settled, logged, and no page.
    const h = sweepDeps([100_000n, 40n]);
    const sweep = await live.sweepResidualPairedToken(
      { pairName: "X-SOL", positionAddress: "Pos111" },
      h.deps,
    );
    assert.equal(sweep.state, "dust");
    assert.equal(live.isSettledSweep(sweep), true);
    assert.deepEqual(h.pages, []);
  });

  it("an unreadable re-read keeps the sale and records the doubt instead of paging", async () => {
    const h = sweepDeps([100_000n, null]);
    const sweep = await live.sweepResidualPairedToken(
      { pairName: "X-SOL", positionAddress: "Pos111" },
      h.deps,
    );
    assert.equal(sweep.state, "swept");
    assert.equal(sweep.signature, "sold-sig");
    assert.match(sweep.error ?? "", /could not be re-read/);
    assert.deepEqual(h.pages, [], "a confirmed sale plus a hiccup is not a page");
  });

  it("a zero balance is dust and is never re-read", async () => {
    const h = sweepDeps([0n]);
    const sweep = await live.sweepResidualPairedToken(
      { pairName: "X-SOL", positionAddress: "Pos111" },
      h.deps,
    );
    assert.equal(sweep.state, "dust");
    assert.equal(h.reads(), 1);
    assert.deepEqual(h.amounts, []);
  });

  it("stores a leftover that clears the dust line and only settles it once the wallet is empty", async () => {
    // A 100,000-lamport quote against a 1,000-lamport dust line: worth selling, so the sweep
    // must sell AND verify. Guards the boundary the sweep is most likely to blur.
    const h = sweepDeps([1_000_000_000n, 0n]);
    const sweep = await live.sweepResidualPairedToken(
      { pairName: "X-SOL", positionAddress: "Pos111" },
      h.deps,
      1_000,
    );
    assert.equal(sweep.state, "swept");
    assert.deepEqual(h.amounts, [1_000_000_000n]);
    assert.equal(h.reads(), 2);
  });
});
