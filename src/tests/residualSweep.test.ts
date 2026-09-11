/**
 * The exit's second half: sell the paired token a close returned, THEN read the wallet.
 *
 * 11 Sep 2026, MANLET-SOL — the engine's first live trade that opened, was monitored and
 * closed itself. `closePosition` is withdraw + claim + close, so it returned SOL AND the
 * paired token, and nothing sold the token: ~0.84 SOL of value sat as an unmonitored
 * memecoin until an operator happened to sell it by hand 37 minutes later. The failed-open
 * path had had an auto-unwind for months; the successful path had none.
 *
 * And because the after-balance was read with that token still unsold, the reconciliation
 * reported "$-127.16 drift" on a trade that booked +$9.49.
 *
 * Everything here runs offline: the chain, Jupiter and Telegram are injected mocks. The
 * DATABASE is real (a temp file), because "the row stays CLOSED when the sweep fails" is a
 * claim about what gets written, and a mock can be made to agree with anything.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-residualsweep-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Live = typeof import("../services/liveExecution.js");
type Repos = typeof import("../database/repositories.js");
type Db = typeof import("../database/db.js");
type Agent = typeof import("../agents/dlmmTraderAgent.js");

let live: Live;
let repos: Repos;
let dbModule: Db;
let agent: Agent;

before(async () => {
  dbModule = await import("../database/db.js");
  repos = await import("../database/repositories.js");
  live = await import("../services/liveExecution.js");
  agent = await import("../agents/dlmmTraderAgent.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

const MINT = "MANLETmint1111111111111111111111111111111111";
const LAMPORTS = 1_000_000_000;

/**
 * A mock wallet and a mock Jupiter, with a call log that records ORDER. Selling moves the
 * token balance to zero and the SOL balance up, so re-running the sweep sees what a real
 * wallet would.
 */
function harness(over: {
  tokenBalance?: bigint | null;
  quoteLamports?: number;
  swapFails?: Error;
  quoteFails?: Error;
  closeFails?: Error;
  mintFails?: Error;
  /** How the empty-account close answers: default "closed". */
  accountClose?: "closed" | "absent" | "not-empty" | Error;
} = {}) {
  const calls: string[] = [];
  const accountCloses: string[] = [];
  const swaps: Array<{ mint: string; amount: bigint }> = [];
  const alerts: string[] = [];
  const wallet = {
    token: over.tokenBalance === undefined ? 5_000_000_000n : over.tokenBalance,
    lamports: 2.116302 * LAMPORTS,
  };

  const deps = {
    async closeOnChain() {
      calls.push("close");
      if (over.closeFails) throw over.closeFails;
      return ["remove-sig", "close-sig"];
    },
    sweep: {
      async resolvePairedMint() {
        calls.push("mint");
        if (over.mintFails) throw over.mintFails;
        return MINT;
      },
      async readBalance(mint: string) {
        calls.push("balance");
        assert.equal(mint, MINT);
        return wallet.token;
      },
      async quoteToSol() {
        calls.push("quote");
        if (over.quoteFails) throw over.quoteFails;
        return over.quoteLamports ?? 844_718_000;
      },
      async swapToSol(mint: string, amount: bigint) {
        calls.push("swap");
        swaps.push({ mint, amount });
        if (over.swapFails) throw over.swapFails;
        wallet.token = 0n;
        wallet.lamports += over.quoteLamports ?? 844_718_000;
        return "sweep-sig";
      },
      async alert(message: string) {
        calls.push("alert");
        alerts.push(message);
      },
    },
    async closeTokenAccount(mint: string) {
      calls.push("account");
      accountCloses.push(mint);
      const mode = over.accountClose ?? "closed";
      if (mode instanceof Error) throw mode;
      if (mode === "closed") {
        wallet.lamports += 2_039_280;
        return { state: "closed" as const, signature: "ata-close-sig", ata: "ATA111" };
      }
      if (mode === "absent") return { state: "absent" as const, ata: "ATA111" };
      return { state: "not-empty" as const, ata: "ATA111", amount: "12345" };
    },
    async readWalletLamports() {
      calls.push("wallet");
      return wallet.lamports;
    },
  };

  return { deps, calls, swaps, alerts, wallet, accountCloses };
}

const params = {
  poolAddress: "ManletPool111111111111111111111111111111111",
  positionAddress: "EDUquTp5ypXH7bY5BSMmNWsWmW1hFtMXJDcwcfw8uLhr",
  pairName: "MANLET-SOL",
};

describe("residual sweep — a successful exit sells what came back", () => {
  it("swaps ONCE, with the pool's paired mint and the balance the CHAIN reports", async () => {
    const h = harness({ tokenBalance: 5_000_000_000n });
    const out = await live.closeLivePosition(params, h.deps);

    assert.equal(h.swaps.length, 1, "the residual was not sold exactly once");
    assert.equal(h.swaps[0]?.mint, MINT);
    assert.equal(h.swaps[0]?.amount, 5_000_000_000n);
    assert.equal(out.residual.state, "swept");
    assert.equal(out.residual.signature, "sweep-sig");
    assert.equal(out.closeSignature, "close-sig");
    assert.equal(h.alerts.length, 0, "a clean sweep paged the operator");
  });

  it("sells only AFTER the close confirmed, and reads the wallet only AFTER the sale", async () => {
    const h = harness();
    const out = await live.closeLivePosition(params, h.deps);

    const close = h.calls.indexOf("close");
    const swap = h.calls.indexOf("swap");
    const wallet = h.calls.indexOf("wallet");
    assert.ok(close >= 0 && swap > close, `sold before the close confirmed: ${h.calls.join(",")}`);
    assert.ok(wallet > swap, `the wallet was read before the sale: ${h.calls.join(",")}`);
    assert.equal(h.calls.filter((c) => c === "wallet").length, 1);
    // The balance includes the proceeds, which is the whole point of reading it last.
    // Proceeds, plus the emptied account's rent (see the token-account tests below).
    assert.equal(out.walletLamportsAfter, 2.116302 * LAMPORTS + 844_718_000 + 2_039_280);
  });

  it("never sells when the close itself fails — the position is still holding the token", async () => {
    const h = harness({ closeFails: new Error("close refused") });
    await assert.rejects(live.closeLivePosition(params, h.deps), /close refused/);
    assert.deepEqual(h.calls, ["close"]);
  });
});

describe("residual sweep — idempotent: dust or nothing sends no transaction", () => {
  it("sends nothing on a zero balance, and does not even quote", async () => {
    const h = harness({ tokenBalance: 0n });
    const out = await live.closeLivePosition(params, h.deps);
    assert.equal(h.swaps.length, 0);
    assert.equal(h.calls.includes("quote"), false);
    assert.equal(out.residual.state, "dust");
    // Dust is settled: the balance IS the trade's result.
    assert.equal(typeof out.walletLamportsAfter, "number");
  });

  it("sends nothing when the balance quotes under the dust line", async () => {
    const h = harness({ tokenBalance: 12_345n, quoteLamports: live.RESIDUAL_DUST_LAMPORTS - 1 });
    const out = await live.closeLivePosition(params, h.deps);
    assert.equal(h.swaps.length, 0);
    assert.equal(out.residual.state, "dust");
    assert.equal(h.alerts.length, 0);
  });

  it("a second run on a swept wallet finds nothing and sends nothing", async () => {
    const h = harness();
    const first = await live.sweepResidualPairedToken(params, h.deps.sweep);
    const second = await live.sweepResidualPairedToken(params, h.deps.sweep);
    assert.equal(first.state, "swept");
    assert.equal(second.state, "dust");
    assert.equal(h.swaps.length, 1, "re-running the sweep sent a second sell");
  });
});

describe("residual sweep — a failed sale never un-closes a closed position", () => {
  it("does not throw, pages with the amount, mint and value, and leaves the after-balance NULL", async () => {
    const h = harness({ tokenBalance: 5_000_000_000n, swapFails: new Error("route not found") });
    const out = await live.closeLivePosition(params, h.deps);

    assert.equal(out.residual.state, "failed");
    assert.match(out.residual.error ?? "", /route not found/);
    assert.equal(out.walletLamportsAfter, null, "an unfinal balance was recorded as the result");
    assert.equal(h.calls.includes("wallet"), false, "the wallet was read for a trade that never settled");

    assert.equal(h.alerts.length, 1);
    const alert = h.alerts[0] ?? "";
    assert.match(alert, /5000000000/, "the alert did not name the amount");
    assert.match(alert, new RegExp(MINT), "the alert did not name the mint");
    assert.match(alert, /0\.844718 SOL/, "the alert did not estimate the value");
    assert.match(alert, /IS CLOSED/);
    // The facts a human acts on must survive `sendError`'s 500-character truncation.
    assert.ok(alert.indexOf(MINT) < 480, "the mint is past sendError's truncation");
  });

  it("an unreadable balance is UNMEASURED, not dust — no sale, a page, and no after-balance", async () => {
    const h = harness({ tokenBalance: null });
    const out = await live.closeLivePosition(params, h.deps);
    assert.equal(out.residual.state, "unmeasured");
    assert.equal(h.swaps.length, 0);
    assert.equal(out.walletLamportsAfter, null);
    assert.match(h.alerts[0] ?? "", /could not be read/);
  });

  it("a failed quote or an unresolvable mint is paged too, and still never throws", async () => {
    const quote = harness({ quoteFails: new Error("HTTP 429") });
    const q = await live.closeLivePosition(params, quote.deps);
    assert.equal(q.residual.state, "failed");
    assert.equal(q.walletLamportsAfter, null);
    assert.match(quote.alerts[0] ?? "", /UNKNOWN/);

    const mint = harness({ mintFails: new Error("pool fetch failed") });
    const m = await live.closeLivePosition(params, mint.deps);
    assert.equal(m.residual.state, "unmeasured");
    assert.equal(mint.swaps.length, 0);
  });

  it("a page that itself fails still does not throw", async () => {
    const h = harness({ swapFails: new Error("boom") });
    h.deps.sweep.alert = async () => {
      throw new Error("telegram down");
    };
    const out = await live.closeLivePosition(params, h.deps);
    assert.equal(out.residual.state, "failed");
  });

  it("END TO END: the row is marked CLOSED with the sweep's failure and a NULL after-balance", async () => {
    repos.insertPosition({
      positionId: "manlet-e2e",
      poolAddress: params.poolAddress,
      pairName: params.pairName,
      strategyType: "SPOT",
      entryPrice: 100,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      virtualSolAmount: 0.9,
      entryTvl: 50_000,
      entry24hVolume: 500_000,
      confidenceScore: 70,
      reasoningLog: "t",
      entrySolPriceUsd: 100,
      executionMode: "LIVE",
      positionAddress: params.positionAddress,
      openSignature: "sig-open",
    });

    const h = harness({ swapFails: new Error("slippage exceeded") });
    const result = await agent.forceCloseAllPositions({
      fetchPool: async () => ({ currentPrice: 105, feeTvlRatio24h: 0.01 }),
      reflect: async () => null,
      notify: async () => undefined,
      closeLive: (p) => live.closeLivePosition(p, h.deps),
    });

    assert.equal(result.closed, 1, "a closed position was reported as not closed");
    assert.equal(result.failed.length, 0, "a failed SWEEP was reported as a failed CLOSE");

    const row = repos.getPositionById("manlet-e2e");
    assert.equal(row?.status, "CLOSED_MANUAL");
    assert.equal(row?.close_signature, "close-sig");
    assert.equal(row?.wallet_lamports_after ?? null, null);
    assert.equal(row?.residual_sweep, "failed");
    assert.equal(row?.sweep_signature ?? null, null);
    assert.equal(h.alerts.length, 1);
  });

  it("END TO END: a clean sweep records its state, its signature and the settled balance", async () => {
    repos.insertPosition({
      positionId: "manlet-e2e-ok",
      poolAddress: `${params.poolAddress}2`,
      pairName: params.pairName,
      strategyType: "SPOT",
      entryPrice: 100,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      virtualSolAmount: 0.9,
      entryTvl: 50_000,
      entry24hVolume: 500_000,
      confidenceScore: 70,
      reasoningLog: "t",
      entrySolPriceUsd: 100,
      executionMode: "LIVE",
      positionAddress: params.positionAddress,
      openSignature: "sig-open",
    });

    const h = harness();
    await agent.forceCloseAllPositions({
      fetchPool: async () => ({ currentPrice: 105, feeTvlRatio24h: 0.01 }),
      reflect: async () => null,
      notify: async () => undefined,
      closeLive: (p) => live.closeLivePosition(p, h.deps),
    });

    const row = repos.getPositionById("manlet-e2e-ok");
    assert.equal(row?.residual_sweep, "swept");
    assert.equal(row?.sweep_signature, "sweep-sig");
    assert.equal(row?.wallet_lamports_after, 2.116302 * LAMPORTS + 844_718_000 + 2_039_280);
  });
});

describe("token account rent — the emptied account is closed once the sweep settled", () => {
  it("closes the paired-token account after a confirmed sale, BEFORE the wallet read", async () => {
    const h = harness();
    const out = await live.closeLivePosition(params, h.deps);

    assert.deepEqual(h.accountCloses, [MINT], "the account was not closed exactly once, for the paired mint");
    assert.equal(out.tokenAccount.state, "closed");
    assert.equal(out.tokenAccount.signature, "ata-close-sig");
    // The sweep's own evidence is untouched.
    assert.equal(out.residual.signature, "sweep-sig");
    const account = h.calls.indexOf("account");
    assert.ok(account > h.calls.indexOf("swap") && account < h.calls.indexOf("wallet"), h.calls.join(","));
    // The rent that came back is part of the measured result.
    assert.equal(out.walletLamportsAfter, 2.116302 * LAMPORTS + 844_718_000 + 2_039_280);
  });

  it("closes it on a zero balance too, but NOT on a dust balance (not empty)", async () => {
    const zero = harness({ tokenBalance: 0n });
    assert.equal((await live.closeLivePosition(params, zero.deps)).tokenAccount.state, "closed");

    const dust = harness({ tokenBalance: 12_345n, quoteLamports: 1 });
    const out = await live.closeLivePosition(params, dust.deps);
    assert.equal(out.residual.state, "dust");
    assert.equal(out.tokenAccount.state, "skipped");
    assert.equal(dust.accountCloses.length, 0);
  });

  it("does NOT touch the account when the sweep failed or could not measure — value may be in it", async () => {
    for (const h of [
      harness({ swapFails: new Error("route not found") }),
      harness({ tokenBalance: null }),
      harness({ quoteFails: new Error("HTTP 429") }),
      harness({ mintFails: new Error("pool fetch failed") }),
    ]) {
      const out = await live.closeLivePosition(params, h.deps);
      assert.equal(out.tokenAccount.state, "skipped", out.residual.state);
      assert.equal(h.accountCloses.length, 0, `closed an account after a ${out.residual.state} sweep`);
    }
  });

  it("an account that is already gone is a SUCCESS, and sends nothing", async () => {
    const h = harness({ accountClose: "absent" });
    const out = await live.closeLivePosition(params, h.deps);
    assert.equal(out.tokenAccount.state, "absent");
    assert.equal(out.tokenAccount.error, null);
  });

  it("a failed account close does not fail the close, does not page, and keeps the after-balance", async () => {
    const h = harness({ accountClose: new Error("blockhash expired") });
    const out = await live.closeLivePosition(params, h.deps);
    assert.equal(out.tokenAccount.state, "failed");
    assert.match(out.tokenAccount.error ?? "", /blockhash expired/);
    assert.equal(h.alerts.length, 0, "~$0.20 of rent paged the operator");
    assert.equal(out.residual.state, "swept");
    assert.equal(typeof out.walletLamportsAfter, "number", "a rent-only failure unsettled the trade");
  });

  it("END TO END: the row records ata_close_signature beside, not instead of, sweep_signature", async () => {
    repos.insertPosition({
      positionId: "manlet-ata",
      poolAddress: `${params.poolAddress}3`,
      pairName: params.pairName,
      strategyType: "SPOT",
      entryPrice: 100,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      virtualSolAmount: 0.9,
      entryTvl: 50_000,
      entry24hVolume: 500_000,
      confidenceScore: 70,
      reasoningLog: "t",
      entrySolPriceUsd: 100,
      executionMode: "LIVE",
      positionAddress: params.positionAddress,
      openSignature: "sig-open",
    });
    const h = harness();
    await agent.forceCloseAllPositions({
      fetchPool: async () => ({ currentPrice: 105, feeTvlRatio24h: 0.01 }),
      reflect: async () => null,
      notify: async () => undefined,
      closeLive: (p) => live.closeLivePosition(p, h.deps),
    });
    const row = repos.getPositionById("manlet-ata");
    assert.equal(row?.sweep_signature, "sweep-sig");
    assert.equal(row?.ata_close_signature, "ata-close-sig");
  });

  it("reclaimEmptyTokenAccount never throws on its own", async () => {
    const r = await live.reclaimEmptyTokenAccount({ pairName: "X-SOL", mint: MINT }, async () => {
      throw new Error("rpc down");
    });
    assert.equal(r.state, "failed");
  });

  it("the FAILED-open unwind closes the account too, only after an unwind that did not fail", () => {
    const source = readFileSync("src/services/liveExecution.ts", "utf8");
    const rescue = source.indexOf("rescueSignature = rescue.result.signature;");
    const reclaim = source.indexOf("closeEmptyTokenAccount(auth, {", rescue);
    const after = source.indexOf("const walletLamportsAfter = await readWalletLamports();", rescue);
    assert.ok(rescue > 0 && reclaim > rescue && after > reclaim, "the unwind's account close is missing or misordered");
    const guard = source.slice(source.lastIndexOf("const tokenAccount =", reclaim), reclaim);
    assert.match(guard, /rescueError === null/);
    assert.match(guard, /orphan\?\.state !== "failed"/);
    assert.ok(source.includes("ataCloseSignature: tokenAccount.signature"));
  });
});

describe("residual sweep — the FAILED-open path is untouched", () => {
  const source = readFileSync("src/services/liveExecution.ts", "utf8");
  const openStart = source.indexOf("export async function openLivePosition");
  const openEnd = source.indexOf("/* Residual sweep");
  const openBody = source.slice(openStart, openEnd);

  it("openLivePosition does not call the exit sweep — its unwind is its own", () => {
    assert.ok(openStart > 0 && openEnd > openStart);
    assert.equal(openBody.includes("sweepResidualPairedToken"), false);
    assert.equal(openBody.includes("isSettledSweep"), false);
    // The unwind still sells the re-read balance and still measures cost after it.
    assert.ok(openBody.includes("rescueSignature = rescue.result.signature;"));
    assert.ok(openBody.includes("const walletLamportsAfter = await readWalletLamports();"));
    assert.ok(openBody.includes("throw stranded;"));
  });

  it("StrandedSwapError still classifies and reports the unwind exactly as before", () => {
    const failedRescue = new live.StrandedSwapError(
      "MINT",
      "123",
      "swap-sig",
      new Error("open failed"),
      null,
      "rescue failed",
      null,
      1_000,
      "orphan",
    );
    assert.equal(failedRescue.name, "StrandedSwapError");
    assert.equal(failedRescue.unwind, "orphan");
    assert.match(failedRescue.message, /ORPHAN LEFT/);
    assert.match(failedRescue.message, /Auto-unwind back to SOL FAILED \(rescue failed\)/);
    assert.match(failedRescue.message, /COST 0\.000001 SOL/);

    const clean = new live.StrandedSwapError("MINT", "123", "swap-sig", "x", "rescue-sig", null, null, null, "clean");
    assert.match(clean.message, /UNWOUND CLEAN/);
    assert.match(clean.message, /COST NOT MEASURED/);
  });
});
