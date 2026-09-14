/**
 * The post-swap balance read: three attempts, then a second source.
 *
 * 13 Sep 2026, `NEARKAT-SOL`, 0.079110 SOL of real money. The balancing swap CONFIRMED,
 * the next read of the token account answered "could not find account", the single
 * unretried attempt read as "nothing arrived", the open aborted, and the auto-unwind
 * sold the tokens back for 0.822476 of the 0.901586 SOL that had just left. The account
 * existed the whole time — the engine tried to CLOSE it seconds later and Token-2022
 * refused because it still held a withheld-fee balance.
 *
 * So the property under test is narrow and worth stating exactly: a read that fails or
 * answers zero is NO LONGER the same fact as "the swap delivered nothing". Only after
 * every attempt and the wallet-wide listing agree does this report zero.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-postswap-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Live = typeof import("../services/liveExecution.js");
type PublicKey = import("@solana/web3.js").PublicKey;

let live: Live;

const WALLET = "FaVHg7bThap7wcF9G7kjSjrDsMbVrgUkpG6twzi1yQKi";
const MINT = "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr";
const TOKEN_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** A stand-in PublicKey: the function only ever calls `toBase58` on the mint. */
const key = (address: string) => ({ toBase58: () => address }) as unknown as PublicKey;

before(async () => {
  live = await import("../services/liveExecution.js");
});

after(async () => {
  // Close the SQLite handle the liveExecution import opened: Windows refuses to delete an open file (EPERM).
  (await import("../database/db.js")).closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

interface Attempts {
  /** One entry per read attempt, in order. */
  reads: Array<bigint | null | "throw">;
  listing?: Array<{ mint: string; amount: string; uiAmount: number | null }> | "throw";
}

function deps(plan: Attempts) {
  const slept: number[] = [];
  let calls = 0;
  return {
    slept,
    calls: () => calls,
    deps: {
      readPaired: async () => {
        const next = plan.reads[Math.min(calls, plan.reads.length - 1)];
        calls += 1;
        if (next === "throw") throw new Error("Invalid param: could not find account");
        return next ?? null;
      },
      listBalances: async () => {
        if (plan.listing === "throw") throw new Error("listing failed");
        return plan.listing ?? [];
      },
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
  };
}

describe("the post-swap balance read", () => {
  it("returns the first non-zero read without waiting", async () => {
    const harness = deps({ reads: [1234n] });
    const amount = await live.readPostSwapTokenBalance(
      key(WALLET),
      key(MINT),
      key(TOKEN_PROGRAM),
      harness.deps,
    );
    assert.equal(amount, 1234n);
    assert.deepEqual(harness.slept, [], "a measured balance must not cost a delay");
    assert.equal(harness.calls(), 1, "one good read is enough");
  });

  it("retries what the 13 Sep failure looked like, and uses the later answer", async () => {
    /*
     * The exact shape of that evening: attempt 1 could not find the account. Here
     * attempt 2 answers, which is what the retry is for — the swap DID deliver, the
     * first read simply raced the account's creation inside the swap transaction.
     */
    const harness = deps({ reads: [null, 4498666263n] });
    const amount = await live.readPostSwapTokenBalance(
      key(WALLET),
      key(MINT),
      key(TOKEN_PROGRAM),
      harness.deps,
    );
    assert.equal(amount, 4498666263n);
    assert.deepEqual(harness.slept, [1500], "the first backoff is 1.5s");
  });

  it("survives a read that throws", async () => {
    const harness = deps({ reads: ["throw", "throw", 77n] });
    const amount = await live.readPostSwapTokenBalance(
      key(WALLET),
      key(MINT),
      key(TOKEN_PROGRAM),
      harness.deps,
    );
    assert.equal(amount, 77n);
    assert.deepEqual(harness.slept, [1500, 3000]);
  });

  it("falls back to the wallet's own token listing when no read answers", async () => {
    /*
     * The second source asks a different question — "what does the WALLET hold" rather
     * than "what does this ATA hold" — and it is the account the deposit is funded from,
     * so it wins.
     */
    const harness = deps({
      reads: [null, null, null],
      listing: [{ mint: MINT, amount: "5000000", uiAmount: 5 }],
    });
    const amount = await live.readPostSwapTokenBalance(
      key(WALLET),
      key(MINT),
      key(TOKEN_PROGRAM),
      harness.deps,
    );
    assert.equal(amount, 5000000n);
    assert.deepEqual(harness.slept, [1500, 3000], "both backoffs were taken first");
  });

  it("still reports a genuine zero as zero", async () => {
    /*
     * The line that must not move: a swap that really delivered nothing has to reach the
     * caller as 0 and abort the open, or the engine would deposit against a balance it
     * does not have. The retry buys evidence, not optimism.
     */
    const zero = deps({ reads: [0n, 0n, 0n], listing: [] });
    assert.equal(
      await live.readPostSwapTokenBalance(key(WALLET), key(MINT), key(TOKEN_PROGRAM), zero.deps),
      0n,
    );

    // A listing for a DIFFERENT mint is not this position's balance either.
    const other = deps({
      reads: [null, null, null],
      listing: [{ mint: "SomeOtherMint", amount: "999", uiAmount: 9 }],
    });
    assert.equal(
      await live.readPostSwapTokenBalance(key(WALLET), key(MINT), key(TOKEN_PROGRAM), other.deps),
      0n,
    );
  });

  it("never throws when both sources are broken", async () => {
    /*
     * The caller's catch is what runs the auto-unwind and writes the attempt row. A
     * different exception escaping from here would skip the unwind — the 0.9 SOL
     * stranded on 9 Sep. So a broken listing is a measurement that failed, not a
     * failure that propagates.
     */
    const harness = deps({ reads: ["throw", "throw", "throw"], listing: "throw" });
    const amount = await live.readPostSwapTokenBalance(
      key(WALLET),
      key(MINT),
      key(TOKEN_PROGRAM),
      harness.deps,
    );
    assert.equal(amount, 0n);
  });
});

describe("the open path uses it", () => {
  const source = readFileSync("src/services/liveExecution.ts", "utf8");

  it("reads the post-swap balance through the retrying reader, not the raw one", () => {
    /*
     * The raw `readTokenBalance` collapses "unreadable" and "zero" into the same 0n,
     * which is what turned one flaky read into a forced round trip on 13 Sep. It is
     * still the right call for a DEPOSIT decision elsewhere; it must not be the call
     * made immediately after the balancing swap.
     */
    const call = source.indexOf(
      "pairedAmount = await readPostSwapTokenBalance(auth.wallet, pairedMint, pairedTokenProgram)",
    );
    assert.ok(call > 0, "the post-swap read no longer goes through the retrying reader");
    assert.equal(
      source.includes("pairedAmount = await readTokenBalance(auth.wallet, pairedMint"),
      false,
      "the unretried read is back on the post-swap path",
    );
  });

  it("keeps a measured zero as an abort", () => {
    // The retry buys evidence, not optimism: a swap that delivered nothing must still
    // stop the open before any deposit is attempted.
    const zeroCheck = source.indexOf(
      'throw new Error("the swap confirmed but no token balance could be read")',
    );
    const read = source.indexOf("readPostSwapTokenBalance(auth.wallet");
    assert.ok(read > 0 && zeroCheck > read, "the zero check must follow the read");
  });
});
