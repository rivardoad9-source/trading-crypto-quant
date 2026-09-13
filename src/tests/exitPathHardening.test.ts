/**
 * Exit-path hardening — 13 Sep 2026, the second day an operator finished an exit by hand.
 *
 *  P1.1 After Jupiter refuses the residual sale at every rung, the engine sells DIRECTLY into
 *       the pool the position just left — judged against Jupiter's own estimate before
 *       anything is signed — and pages only when that fails too, with both errors.
 *  P1.2 A close reads the position account before acting, so a close that already landed
 *       while it was reported failed is recorded, not sent again.
 *
 * Reached THROUGH THE BRIDGE only: the executor's allowlist in `onchainExecutor.test.ts` is
 * a security boundary, and a test is not a reason to widen it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-exitpath-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Live = typeof import("../services/liveExecution.js");
let live: Live;

before(async () => {
  live = await import("../services/liveExecution.js");
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows can hold the temp dir open for a moment; a leftover temp dir is not a test result.
  }
});

const MINT = "EMBERmint11111111111111111111111111111111111";
const CTX = { pairName: "EMBER-SOL", positionAddress: "AxQcU8Uavddqmsj2Z2Vz3Pn2xgB3F9FFEsr4JN96acC4" };

/* ------------------------------------------------------------------ */

describe("assessPoolSaleQuote — the pool must not be a worse market than the one refused", () => {
  it("admits a pool quote within the cap, with the stricter of the two floors", () => {
    const v = live.assessPoolSaleQuote({
      quoteOutLamports: 780_000_000,
      quoteMinOutLamports: 756_600_000,
      marketEstimateLamports: 788_421_000,
      capBps: 300,
    });
    // market floor = 788,421,000 x 0.97 = 764,768,370 > the pool's own 756,600,000.
    assert.deepEqual(v, { ok: true, minOutLamports: 764_768_370, reason: null });
    assert.ok(v.minOutLamports <= 780_000_000, "the floor never demands more than the pool quotes");
  });

  it("uses the pool's own minimum when it is the stricter floor", () => {
    const v = live.assessPoolSaleQuote({
      quoteOutLamports: 800_000_000,
      quoteMinOutLamports: 790_000_000,
      marketEstimateLamports: 800_000_000,
      capBps: 300,
    });
    assert.equal(v.minOutLamports, 790_000_000);
  });

  it("REFUSES a pool quoting below the market by more than the cap", () => {
    const v = live.assessPoolSaleQuote({
      quoteOutLamports: 700_000_000,
      quoteMinOutLamports: 679_000_000,
      marketEstimateLamports: 788_421_000,
      capBps: 300,
    });
    assert.equal(v.ok, false);
    assert.equal(v.minOutLamports, 0);
    assert.match(v.reason ?? "", /below the market estimate/);
  });

  it("FAILS CLOSED with no market estimate, or a nonsense pool quote", () => {
    for (const marketEstimateLamports of [null, 0, -1]) {
      const v = live.assessPoolSaleQuote({ quoteOutLamports: 1, quoteMinOutLamports: 1, marketEstimateLamports, capBps: 300 });
      assert.equal(v.ok, false, `market ${marketEstimateLamports}`);
    }
    assert.equal(
      live.assessPoolSaleQuote({ quoteOutLamports: Number.NaN, quoteMinOutLamports: 0, marketEstimateLamports: 10, capBps: 300 }).ok,
      false,
    );
  });
});

/* ------------------------------------------------------------------ */

function sweepHarness(plan: {
  jupiterFails: number[];
  poolQuote?: { outLamports: number; minOutLamports: number } | Error;
  poolSellFails?: Error;
  withPoolRoute?: boolean;
}) {
  const calls: string[] = [];
  const pages: string[] = [];
  const poolSells: Array<{ amount: bigint; minOut: number }> = [];
  const deps: Parameters<Live["sweepResidualPairedToken"]>[1] = {
    resolvePairedMint: async () => MINT,
    readBalance: async () => 4_498_666_263n,
    quoteToSol: async () => 788_421_000,
    swapToSol: async (_m, _a, bps) => {
      calls.push(`jupiter:${bps}`);
      if (plan.jupiterFails.includes(bps ?? -1)) throw new Error(`0xe at ${bps} bps`);
      return "JUP-SIG";
    },
    alert: async (message) => {
      pages.push(message);
    },
  };
  if (plan.withPoolRoute !== false) {
    deps.quotePoolSale = async () => {
      calls.push("pool:quote");
      if (plan.poolQuote instanceof Error) throw plan.poolQuote;
      return plan.poolQuote ?? { outLamports: 780_000_000, minOutLamports: 756_600_000 };
    };
    deps.sellInPool = async (_m, amount, minOut) => {
      calls.push("pool:sell");
      poolSells.push({ amount, minOut });
      if (plan.poolSellFails) throw plan.poolSellFails;
      return "POOL-SIG";
    };
  }
  return { deps, calls, pages, poolSells };
}

describe("the residual sale's last resort is the position's own pool", () => {
  it("never touches the pool when a Jupiter rung sells", async () => {
    const h = sweepHarness({ jupiterFails: [50] });
    const r = await live.sweepResidualPairedToken(CTX, h.deps);
    assert.equal(r.state, "swept");
    assert.equal(r.route, "jupiter");
    assert.deepEqual(h.calls, ["jupiter:50", "jupiter:150"]);
  });

  it("sells into the pool after EVERY rung failed, with the judged floor, and does not page", async () => {
    const h = sweepHarness({ jupiterFails: [50, 150, 300] });
    const r = await live.sweepResidualPairedToken(CTX, h.deps);
    assert.equal(r.state, "swept");
    assert.equal(r.route, "dlmm-pool");
    assert.equal(r.signature, "POOL-SIG");
    assert.equal(r.error, null);
    assert.deepEqual(h.calls, ["jupiter:50", "jupiter:150", "jupiter:300", "pool:quote", "pool:sell"]);
    assert.deepEqual(h.poolSells, [{ amount: 4_498_666_263n, minOut: 764_768_370 }]);
    assert.equal(h.pages.length, 0);
  });

  it("refuses a bad pool quote BEFORE signing, and pages with mint, amount, value and both errors", async () => {
    const h = sweepHarness({ jupiterFails: [50, 150, 300], poolQuote: { outLamports: 600_000_000, minOutLamports: 582_000_000 } });
    const r = await live.sweepResidualPairedToken(CTX, h.deps);
    assert.equal(r.state, "failed");
    assert.equal(h.calls.includes("pool:sell"), false, "nothing is signed on a refused quote");
    assert.equal(h.pages.length, 1);
    const page = h.pages[0]!;
    assert.match(page, /4498666263 base units of EMBERmint/);
    assert.match(page, /~0\.788421 SOL/);
    assert.match(page, /0xe at 300 bps/, "the Jupiter error");
    assert.match(page, /direct pool sale failed too: refused before signing/, "the pool error");
    assert.match(r.error ?? "", /^jupiter: .* \| pool: /);
  });

  it("pages with both errors when the pool sale itself fails", async () => {
    const h = sweepHarness({ jupiterFails: [50, 150, 300], poolSellFails: new Error("ExceededAmountSlippageTolerance") });
    const r = await live.sweepResidualPairedToken(CTX, h.deps);
    assert.equal(r.state, "failed");
    assert.equal(r.signature, null);
    assert.match(h.pages[0]!, /0xe at 300 bps.*ExceededAmountSlippageTolerance/s);
  });

  it("keeps the old ladder-then-page behaviour when no pool route is wired", async () => {
    const h = sweepHarness({ jupiterFails: [50, 150, 300], withPoolRoute: false });
    const r = await live.sweepResidualPairedToken(CTX, h.deps);
    assert.equal(r.state, "failed");
    assert.match(h.pages[0]!, /at every bound up to 300 bps/);
    assert.match(h.pages[0]!, /No pool route was available/);
  });
});

/* ------------------------------------------------------------------ */

function closeHarness(state: "absent" | "empty" | "funded" | Error | undefined, found: string | null | Error = "PRIOR-CLOSE-SIG") {
  const calls: string[] = [];
  const deps: Parameters<Live["closeLivePosition"]>[1] = {
    async closeOnChain() {
      calls.push("close");
      return ["remove-sig", "close-sig"];
    },
    sweep: {
      resolvePairedMint: async () => MINT,
      readBalance: async () => 0n,
      quoteToSol: async () => 0,
      swapToSol: async () => "never",
      alert: async () => undefined,
    },
    closeTokenAccount: async () => ({ state: "absent" as const, ata: "ATA" }),
    listTokenBalances: async () => [],
    readWalletLamports: async () => 3_143_187_000,
  };
  if (state !== undefined) {
    deps.readPositionState = async () => {
      calls.push("read-state");
      if (state instanceof Error) throw state;
      return state;
    };
    deps.findCloseSignature = async () => {
      calls.push("find-sig");
      if (found instanceof Error) throw found;
      return found;
    };
  }
  return { deps, calls };
}

const CLOSE = { poolAddress: "HdyjL5pE2zJqCLXFPuBthft1mGnRAPER2AjzC8Tufgom", ...CTX };

describe("a close reads the chain before it acts", () => {
  it("does NOT send a second close for a position already gone, and records the chain's signature", async () => {
    const h = closeHarness("absent");
    const out = await live.closeLivePosition(CLOSE, h.deps);
    assert.deepEqual(h.calls, ["read-state", "find-sig"]);
    assert.equal(out.closeSignature, "PRIOR-CLOSE-SIG");
    assert.equal(out.residual.state, "dust", "the sweep still runs — the first close returned the token");
  });

  it("THROWS rather than invent a signature when the gone position's close cannot be read", async () => {
    for (const found of [null, new Error("429")]) {
      const h = closeHarness("absent", found);
      await assert.rejects(live.closeLivePosition(CLOSE, h.deps), /already GONE on-chain.*NOT sending a second close/s);
      assert.equal(h.calls.includes("close"), false);
    }
  });

  it("closes as before when the position is funded, empty, or unreadable", async () => {
    for (const state of ["funded", "empty", new Error("rpc timeout")] as const) {
      const h = closeHarness(state);
      const out = await live.closeLivePosition(CLOSE, h.deps);
      assert.deepEqual(h.calls, ["read-state", "close"], String(state));
      assert.equal(out.closeSignature, "close-sig");
    }
  });

  it("closes as before when no state reader is wired (existing callers)", async () => {
    const h = closeHarness(undefined);
    assert.equal((await live.closeLivePosition(CLOSE, h.deps)).closeSignature, "close-sig");
    assert.deepEqual(h.calls, ["close"]);
  });
});

describe("the executor half, by source (this file may not import the executor)", () => {
  const executor = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "services", "onchainExecutor.ts"),
    "utf8",
  );

  it("guards EVERY close send with the state check before a rebuild", () => {
    const start = executor.indexOf("async function withdrawClaimAndClose(");
    const body = executor.slice(start, executor.indexOf("export const dlmmExecutor", start));
    const sends = body.match(/sendSequentially\(/g) ?? [];
    assert.equal(sends.length, 2, "the withdraw path and the empty-account path");
    assert.equal((body.match(/beforeRebuild,?\s*\}\)/g) ?? []).length, 2, "both pass beforeRebuild");
    assert.match(body, /closeRebuildDecision\(state\)/);
  });

  it("asks before building, so a stopped rebuild signs nothing", () => {
    const start = executor.indexOf("async function sendSequentially(");
    const body = executor.slice(start, start + 6000);
    const hook = body.indexOf("context.beforeRebuild(index, attempt)");
    const build = body.indexOf("asVersionedTransaction(");
    assert.ok(hook > 0 && build > hook, "the state check must precede the build");
  });

  it("sells into a pool only with a positive floor, pinned across rebuilds", () => {
    const start = executor.indexOf("async sellToSolInPool(");
    const body = executor.slice(start, executor.indexOf("function poolSaleSide", start));
    assert.match(body, /minOut\.lten\(0\)/);
    assert.match(body, /minOutAmount: minOut,/, "the floor is the caller's, not re-derived per build");
    assert.match(body, /async \(\{ blockhash, plan \}\)/, "the builder takes the tracked blockhash");
  });
});
