/**
 * The self-heal for a FAILED OPEN's residual token (WO#6 task 3, 15 Sep 2026 LEVERCAT-SOL).
 *
 * Three failed opens (ids 2, 5, 10) each left the paired token in the wallet with an attempt row
 * `outcome='failed'`, `unwind='orphan'` and no position row, and each was recovered by a human
 * because `retryResidualSweep.ts` only read position rows. These tests pin the decision the
 * script now runs for that shape — offline, every effect a stub, no key, no chain.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { healAttemptResidual, type AttemptHealDeps, type AttemptRowForHeal } from "../services/attemptResidualHeal.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const settle = require(join(repoRoot, "scripts", "settleRecoveredAttempt.cjs")) as {
  chainIsClean(pool: string, position: string, mint: string | null, wallet: string, conn: unknown): Promise<string[]>;
  planSettlement(row: AttemptRowForHeal, after: number): { refusals: string[]; cost: number | null };
  writeSettlement(db: unknown, id: number, cost: number, after: number, extras: object): number;
};

const WALLET = "11111111111111111111111111111111";
const POSITION = "So11111111111111111111111111111111111111112";
const MINT = "LeverCat";

/** id 10, as it stood before the hand recovery. */
const row10: AttemptRowForHeal = {
  id: 10,
  attempted_at: "2026-09-15 14:33:47",
  pair_name: "LEVERCAT-SOL",
  pool_address: "42JnUXw5N9ftMkbM1tMzJw2tnzqs1U9RxWBk5LzNv4gD",
  token_mint: MINT,
  outcome: "failed",
  unwind: "orphan",
  position_address: POSITION,
  wallet_lamports_before: 3_013_486_822,
};

function deps(over: Partial<AttemptHealDeps> = {}): { deps: AttemptHealDeps; writes: unknown[]; sold: number } {
  const state = { writes: [] as unknown[], sold: 0 };
  const d: AttemptHealDeps = {
    busyReason: () => null,
    positionAccountExists: async () => false,
    resolvePairedMint: async () => MINT,
    sweep: async () => {
      state.sold++;
      return { state: "swept", mint: MINT, amount: "40053970000", signature: "jfi7qnmE", error: null, slippageBps: 150 };
    },
    closeTokenAccount: async () => ({ state: "withheld-fee", detail: "withheld transfer fees" }),
    readWalletLamports: async () => 2_893_532_394,
    walletMovedSince: () => null,
    proof: async () => [],
    plan: (after) => settle.planSettlement(row10, after),
    write: (cost, after, extras) => {
      state.writes.push({ cost, after, extras });
      return 1;
    },
    ...over,
  };
  return {
    deps: d,
    get writes() {
      return state.writes;
    },
    get sold() {
      return state.sold;
    },
  };
}

describe("failed-open residual self-heal — the decision", () => {
  it("sells through the sweep and records the MEASURED cost, unwind clean (tonight's numbers)", async () => {
    const h = deps();
    const out = await healAttemptResidual(row10, h.deps);
    assert.equal(out.kind, "recorded");
    if (out.kind !== "recorded") return;
    assert.equal(out.costLamports, 3_013_486_822 - 2_893_532_394);
    assert.equal(out.costLamports, 119_954_428, "the cost the operator settled id 10 at by hand");
    assert.deepEqual(h.writes, [{ cost: 119_954_428, after: 2_893_532_394, extras: { rescueSignature: "jfi7qnmE", ataCloseSignature: null } }]);
    assert.match(out.tokenAccount, /^withheld-fee/, "rent not reclaimed is reported, not treated as a failed sale");
  });

  it("a FUNDED position account is recoverFundedOrphan's job: skipped, nothing sold", async () => {
    const h = deps({ positionAccountExists: async () => true });
    const out = await healAttemptResidual(row10, h.deps);
    assert.equal(out.kind, "skipped");
    assert.match((out as { reason: string }).reason, /recoverFundedOrphan/);
    assert.equal(h.sold, 0);
  });

  it("an unreadable position account is not proof of absence", async () => {
    const h = deps({ positionAccountExists: async () => { throw new Error("429"); } });
    assert.equal((await healAttemptResidual(row10, h.deps)).kind, "skipped");
    assert.equal(h.sold, 0);
  });

  it("a busy pool is skipped before anything is read", async () => {
    const h = deps({ busyReason: () => "an ACTIVE position is open on this pool (1)", positionAccountExists: async () => assert.fail("read a busy pool") });
    assert.equal((await healAttemptResidual(row10, h.deps)).kind, "skipped");
  });

  it("refuses to sell a token that is not the row's", async () => {
    const h = deps({ resolvePairedMint: async () => "SomeOtherMint" });
    assert.equal((await healAttemptResidual(row10, h.deps)).kind, "refused");
    assert.equal(h.sold, 0);
  });

  it("a sale that did not settle writes nothing", async () => {
    const h = deps({ sweep: async () => ({ state: "failed", mint: MINT, amount: "1", signature: null, error: "every rung" }) });
    assert.equal((await healAttemptResidual(row10, h.deps)).kind, "sale-failed");
    assert.deepEqual(h.writes, []);
  });

  it("sold, but the chain proof or the settle rules refuse: reported, NOT written", async () => {
    for (const over of [
      { proof: async () => ["wallet still holds 3 of LeverCat"] },
      { readWalletLamports: async () => null },
      { walletMovedSince: () => "1 live position(s) opened or closed since" },
      { readWalletLamports: async () => 3_100_000_000 }, // higher than before: a top-up
    ] as Partial<AttemptHealDeps>[]) {
      const h = deps(over);
      const out = await healAttemptResidual(row10, h.deps);
      assert.equal(out.kind, "sold-not-recorded", JSON.stringify(out));
      assert.deepEqual(h.writes, []);
    }
  });

  it("a close that throws does not turn a landed sale into a failure", async () => {
    const h = deps({ closeTokenAccount: async () => { throw new Error("rpc"); } });
    assert.equal((await healAttemptResidual(row10, h.deps)).kind, "recorded");
  });

  it("only failed opens with stranded capital are touched", async () => {
    for (const r of [{ ...row10, unwind: "clean" }, { ...row10, outcome: "opened" }, { ...row10, position_address: null }]) {
      const h = deps();
      assert.equal((await healAttemptResidual(r, h.deps)).kind, "refused");
      assert.equal(h.sold, 0);
    }
  });
});

describe("settleRecoveredAttempt.cjs — the proof it shares", () => {
  const conn = (holdings: Record<string, number>, positionExists = false) => ({
    getAccountInfo: async () => (positionExists ? { lamports: 1 } : null),
    getParsedTokenAccountsByOwner: async (_owner: unknown, filter: { programId: { toBase58(): string } }) => ({
      value: Object.entries(holdings)
        .filter(([program]) => program === filter.programId.toBase58())
        .map(([, amount]) => ({ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: String(amount), uiAmountString: String(amount) } } } } } })),
    }),
  });

  it("sees a Token-2022 residual — LEVERCAT is Token-2022, and the old proof only asked SPL Token", async () => {
    const problems = await settle.chainIsClean(row10.pool_address, POSITION, MINT, WALLET, conn({ TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 40_053 }));
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /still holds 40053 of LeverCat/);
    assert.deepEqual(await settle.chainIsClean(row10.pool_address, POSITION, MINT, WALLET, conn({})), []);
    assert.equal((await settle.chainIsClean(row10.pool_address, POSITION, MINT, WALLET, conn({}, true))).length, 1);
  });

  it("derives the cost and keeps the old refusals", () => {
    assert.deepEqual(settle.planSettlement(row10, 2_893_532_394), { refusals: [], cost: 119_954_428 });
    assert.ok(settle.planSettlement(row10, 3_100_000_000).refusals.some((r) => /top-up/.test(r)));
    assert.ok(settle.planSettlement({ ...row10, unwind: "clean" }, 2_893_532_394).refusals.length > 0);
  });
});

describe("one sell path", () => {
  it("the hand-run sweepAttemptResidual.ts is gone, and the self-heal sells through the engine's sweep", () => {
    assert.throws(() => readFileSync(join(repoRoot, "scripts", "sweepAttemptResidual.ts")));
    const src = readFileSync(join(repoRoot, "scripts", "retryResidualSweep.ts"), "utf8");
    assert.match(src, /WHERE outcome = 'failed' AND unwind = 'orphan'/);
    assert.match(src, /sweep: \(\) => sweepResidualPairedToken\(/);
    assert.match(src, /settle\.chainIsClean\(/);
    assert.match(src, /settle\.writeSettlement\(/);
    assert.equal(/executeJupiterSwap|sellToSolInPool/.test(src), false, "no second sell path");
  });
});
