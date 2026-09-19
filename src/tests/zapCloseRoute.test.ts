/**
 * Which route a live exit takes, and what it does when the atomic one cannot.
 *
 * 20 Sep 2026. The engine's exit was sequential — close the position, then sell what came
 * back — and the gap between those two transactions is where 51.067138 CATE was stranded on
 * 19 Sep 2026 when the process died mid-swap. The zap close (withdraw + claim + close + swap
 * + unwrap in ONE transaction) removes that gap, and the operator chose it for every future
 * exit.
 *
 * But an atomic close is not always POSSIBLE: the DLMM SDK chunks a wide withdrawal across
 * transactions, a pool can have no wSOL side, and the message has a 1 232-byte ceiling. An
 * exit that refuses to happen is worse than an exit with a known gap, so the zap falls back.
 *
 * The tests below are about that fallback, and the rule they all turn on is this: the ERROR
 * does not say whether the position is still there. Only the chain does. A fallback that
 * trusted the error would either send a second close for a position that is already gone, or
 * leave a funded position open because a confirmation happened to time out.
 *
 * Runs offline: every dep is a mock. The database is a temp file, as elsewhere.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ZapCloseUnavailableError } from "../services/zapClose.js";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-zaproute-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Live = typeof import("../services/liveExecution.js");
let live: Live;

before(async () => {
  live = await import("../services/liveExecution.js");
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const MINT = "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR";
const params = {
  poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
  positionAddress: "ALJeYsVGHAa8bzKWXpy6dFiRyuFZgdzT8pzZbSNba58a",
  pairName: "HcRL-SOL",
};

/**
 * A close harness where the CHAIN is scripted.
 *
 * `states` is read in order by `readPositionState`, so a test can say "funded when the zap
 * was tried, gone when we looked afterwards" — which is exactly the ambiguity the fallback
 * has to resolve. The last entry repeats once the list runs out.
 */
function harness(over: {
  states?: Array<"absent" | "empty" | "funded">;
  zapFails?: Error;
  zapSignatures?: string[];
  closeSignatures?: string[];
  closeFails?: Error;
  foundCloseSignature?: string | null;
  omitZap?: boolean;
  noStateReader?: boolean;
} = {}) {
  const calls: string[] = [];
  const states = over.states ?? ["funded"];
  let reads = 0;

  const deps: Parameters<Live["closeLivePosition"]>[1] = {
    async closeOnChain() {
      calls.push("close");
      if (over.closeFails) throw over.closeFails;
      return over.closeSignatures ?? ["remove-sig", "close-sig"];
    },
    sweep: {
      async resolvePairedMint() {
        calls.push("mint");
        return MINT;
      },
      async readBalance() {
        calls.push("balance");
        return 0n;
      },
      async quoteToSol() {
        calls.push("quote");
        return 0;
      },
      async swapToSol() {
        calls.push("swap");
        return "sweep-sig";
      },
      async alert(message: string) {
        calls.push("alert");
        assert.ok(message.length > 0);
      },
    },
    async closeTokenAccount() {
      calls.push("account");
      return { state: "absent" as const, ata: "ATA111" };
    },
    async listTokenBalances() {
      calls.push("list");
      return [];
    },
    async readWalletLamports() {
      calls.push("wallet");
      return 2_545_210_838;
    },
    ...(over.noStateReader
      ? {}
      : {
          async readPositionState() {
            calls.push("state");
            const value = states[Math.min(reads, states.length - 1)];
            reads += 1;
            return value ?? "funded";
          },
        }),
    findCloseSignature: async () => {
      calls.push("find-close");
      return over.foundCloseSignature ?? null;
    },
    ...(over.omitZap
      ? {}
      : {
          async closeWithZap() {
            calls.push("zap");
            if (over.zapFails) throw over.zapFails;
            return over.zapSignatures ?? ["zap-sig"];
          },
        }),
  };

  return { deps, calls };
}

describe("the zap route is preferred when it is available", () => {
  it("closes ATOMICALLY: one call, no sequential close, route recorded", async () => {
    const h = harness({ states: ["funded"] });
    const out = await live.closeLivePosition(params, h.deps);

    assert.equal(h.calls.includes("zap"), true, "the zap was never attempted");
    assert.equal(h.calls.includes("close"), false, "the sequential close ran alongside the zap");
    assert.equal(out.route, "zap");
    assert.equal(out.routeFallbackReason, null);
    assert.equal(out.closeSignature, "zap-sig");
    /* The sweep still runs after a zap: it is the net for whatever the zap could not sell
     * (another token a route left behind), and it must find nothing to sell here. */
    assert.equal(h.calls.indexOf("balance") > h.calls.indexOf("zap"), true);
    assert.equal(out.residual.state, "dust");
  });
});

describe("a zap that cannot be built falls back to the sequential close", () => {
  it("re-reads the chain, finds the position still there, and closes it the old way", async () => {
    const h = harness({
      states: ["funded", "funded"],
      zapFails: new ZapCloseUnavailableError("the withdrawal splits into 3 transactions"),
    });
    const out = await live.closeLivePosition(params, h.deps);

    assert.equal(h.calls.includes("close"), true, "the fallback never closed the position");
    assert.equal(out.route, "legacy");
    assert.match(out.routeFallbackReason ?? "", /splits into 3 transactions/);
    assert.equal(out.closeSignature, "close-sig");

    /* The chain is read BETWEEN the failed zap and the fallback. Without that read the
     * fallback is a guess, and guessing wrong here either double-closes or strands. */
    const zap = h.calls.indexOf("zap");
    const state = h.calls.lastIndexOf("state");
    const close = h.calls.indexOf("close");
    assert.ok(zap < state && state < close, `fallback did not consult the chain: ${h.calls.join(",")}`);
  });

  it("an unreadable chain counts as still there, and the sequential path reads again itself", async () => {
    const h = harness({ noStateReader: true, zapFails: new ZapCloseUnavailableError("no wSOL side") });
    const out = await live.closeLivePosition(params, h.deps);

    assert.equal(h.calls.includes("close"), true);
    assert.equal(out.route, "legacy");
    assert.match(out.routeFallbackReason ?? "", /no wSOL side/);
  });
});

describe("a zap that landed is never closed twice", () => {
  it("records the zap's own signature when the chain says the position is gone", async () => {
    const h = harness({
      states: ["funded", "absent"],
      zapFails: new Error("confirmation timed out after broadcast"),
      foundCloseSignature: "zap-landed-sig",
    });
    const out = await live.closeLivePosition(params, h.deps);

    assert.equal(h.calls.includes("close"), false, "sent a second close for a position already gone");
    assert.equal(out.route, "zap", "a landed zap was reported as a sequential close");
    assert.equal(out.closeSignature, "zap-landed-sig");
  });

  it("throws instead of guessing when that signature cannot be read", async () => {
    const h = harness({
      states: ["funded", "absent"],
      zapFails: new Error("RPC error after broadcast"),
      foundCloseSignature: null,
    });

    await assert.rejects(live.closeLivePosition(params, h.deps), /GONE on-chain/);
    assert.equal(h.calls.includes("close"), false, "sent a close it could not justify");
  });
});

describe("the route is a switch, not a hard dependency", () => {
  it("EXIT_ROUTE=legacy (no zap deps) goes straight to the sequential close", async () => {
    const h = harness({ states: ["funded"], omitZap: true });
    const out = await live.closeLivePosition(params, h.deps);

    assert.equal(h.calls.includes("zap"), false);
    assert.equal(h.calls.includes("close"), true);
    assert.equal(out.route, "legacy");
    /* Absent deps are not a failure: nothing is reported as a fallback reason. */
    assert.equal(out.routeFallbackReason, null);
  });

  it("the state precheck still wins: a position already gone is recorded, not zap-closed", async () => {
    const h = harness({ states: ["absent"], foundCloseSignature: "earlier-close-sig" });
    const out = await live.closeLivePosition(params, h.deps);

    assert.equal(h.calls.includes("zap"), false, "attempted a zap for a position that is gone");
    assert.equal(h.calls.includes("close"), false);
    assert.equal(out.closeSignature, "earlier-close-sig");
  });
});
