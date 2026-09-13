/**
 * EXIT-leg slippage — 13 Sep 2026, the incident where the operator sold by hand.
 *
 * A close returned 1,568 EMBER. The residual sale was refused at the 50 bps ENTRY bound,
 * the three re-quotes inside `executeJupiterSwapFreshQuote` all used that same bound, the
 * ten-minute self-heal retried at the same bound and failed identically, and the price
 * moved while a human finished the job.
 *
 * The properties under test are the two that make that impossible to repeat:
 *  1. an exit leg has its OWN bound (`EXIT_MAX_SLIPPAGE_BPS`, hard cap 500 bps), and the
 *     entry bound is not consulted for it;
 *  2. the residual sale WALKS a ladder of wider bounds with a fresh quote per rung, and
 *     only reports failure after the widest one.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-exitslip-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Live = typeof import("../services/liveExecution.js");
type Auth = import("../services/liveExecution.js").ExecutionAuthorization;

/*
 * Reached THROUGH THE BRIDGE. This file must not contain the executor's module path at all
 * — `onchainExecutor.test.ts` pins the allowlist of files allowed to import it, and a test is
 * not a reason to widen that list. `liveExecution.ts` re-exports the two pure resolvers and
 * both hard caps, so everything asserted below arrives the way the engine reaches it.
 */
let live: Live;

before(async () => {
  live = await import("../services/liveExecution.js");
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Only `maxSlippageBps` is read by the entry resolver; the rest is unused here. */
const ENTRY_AUTH = { maxSlippageBps: 50 } as unknown as Auth;

describe("the exit bound is its own bound", () => {
  it("resolves EXIT_MAX_SLIPPAGE_BPS by default, not the 50 bps entry bound", () => {
    const cap = live.exitSlippageCapBps();
    assert.equal(cap, 300, "the shipped exit cap");
    assert.equal(live.resolveExitSlippageBps(), 300);
    // The entry resolver is unchanged and still cannot exceed its own hard cap.
    assert.equal(live.resolveSlippageBps(ENTRY_AUTH), 50);
    assert.equal(live.resolveSlippageBps(ENTRY_AUTH, 400), 50, "an entry never widens past 50");
  });

  it("never widens past the exit hard cap, whatever is asked", () => {
    assert.equal(live.resolveExitSlippageBps(5_000), 300, "clamped to the configured cap");
    assert.equal(
      live.resolveExitSlippageBps(500, { exitMaxSlippageBps: 900 }),
      500,
      "a configured cap above the hard cap settles AT the hard cap",
    );
    assert.equal(live.resolveExitSlippageBps(120, { exitMaxSlippageBps: 300 }), 120);
  });

  it("refuses a nonsense bound rather than rounding it into a trade", () => {
    assert.throws(() => live.resolveExitSlippageBps(0), /positive number/);
    assert.throws(() => live.resolveExitSlippageBps(-5), /positive number/);
    assert.throws(() => live.resolveExitSlippageBps(Number.NaN), /positive number/);
  });

  it("builds a ladder that always ends at the cap", () => {
    assert.deepEqual(live.sweepSlippageLadder(300), [50, 150, 300]);
    assert.deepEqual(live.sweepSlippageLadder(100), [50, 100]);
    assert.deepEqual(live.sweepSlippageLadder(30), [30], "a tight cap is the only rung");
    assert.deepEqual(live.SWEEP_SLIPPAGE_LADDER_BPS, [50, 150, 300]);
  });

  it("keeps the two hard caps apart in the values they export", () => {
    // 50 bounds entries, 500 bounds exits. If these ever converge, the asymmetry the
    // incident argued for is gone.
    assert.equal(live.HARD_MAX_SLIPPAGE_BPS, 50);
    assert.equal(live.HARD_MAX_EXIT_SLIPPAGE_BPS, 500);
  });
});

interface SweepHarness {
  calls: number[];
  pages: string[];
  deps: Parameters<Live["sweepResidualPairedToken"]>[1];
}

function harness(plan: { fails: number[]; balance?: bigint }): SweepHarness {
  const calls: number[] = [];
  const pages: string[] = [];
  return {
    calls,
    pages,
    deps: {
      resolvePairedMint: async () => "So11111111111111111111111111111111111111112",
      readBalance: async () => plan.balance ?? 1_568_253_230n,
      quoteToSol: async () => 600_000_000,
      swapToSol: async (_mint, _amount, slippageBps) => {
        const bps = slippageBps ?? -1;
        calls.push(bps);
        if (plan.fails.includes(bps)) throw new Error(`refused at ${bps} bps`);
        return "SIG";
      },
      alert: async (message) => {
        pages.push(message);
        return true;
      },
    },
  };
}

describe("the residual sale walks the ladder", () => {
  it("sells at the first bound that works, and does not go wider", async () => {
    const h = harness({ fails: [50] });
    const result = await live.sweepResidualPairedToken(
      { pairName: "EMBER-SOL", positionAddress: "Pos1" },
      h.deps,
    );
    assert.equal(result.state, "swept");
    assert.equal(result.signature, "SIG");
    assert.deepEqual(h.calls, [50, 150], "refused at 0.5%, sold at 1.5% — then stopped");
    assert.equal(h.pages.length, 0, "a sale that lands is not paged");
  });

  it("does not page until the WIDEST bound has failed", async () => {
    /*
     * The behaviour that would have changed 13 Sep: three refusals at 0.5% is not a failed
     * sale, it is three refusals at the same width. Failure is only reported after the cap.
     */
    const h = harness({ fails: [50, 150, 300] });
    const result = await live.sweepResidualPairedToken(
      { pairName: "EMBER-SOL", positionAddress: "Pos1" },
      h.deps,
    );
    assert.equal(result.state, "failed");
    assert.equal(result.signature, null);
    assert.deepEqual(h.calls, [50, 150, 300]);
    assert.equal(h.pages.length, 1);
    assert.match(h.pages[0]!, /at every bound up to 300 bps/);
    assert.match(h.pages[0]!, /1568253230 base units/);
  });

  it("sells straight away when the first bound is enough", async () => {
    const h = harness({ fails: [] });
    const result = await live.sweepResidualPairedToken(
      { pairName: "EMBER-SOL", positionAddress: "Pos1" },
      h.deps,
    );
    assert.equal(result.state, "swept");
    assert.deepEqual(h.calls, [50], "the narrowest bound is tried first, and one attempt suffices");
  });

  it("still treats a genuine dust balance as dust, not as a failed sale", async () => {
    const h = harness({ fails: [], balance: 0n });
    const result = await live.sweepResidualPairedToken(
      { pairName: "EMBER-SOL", positionAddress: "Pos1" },
      h.deps,
    );
    assert.equal(result.state, "dust");
    assert.deepEqual(h.calls, [], "nothing to sell, nothing attempted");
    assert.equal(h.pages.length, 0);
  });
});

describe("which legs may use the wider bound", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "services", "liveExecution.ts"),
    "utf8",
  );

  it("marks ONLY the residual sale and the auto-unwind as exit legs", () => {
    /*
     * The balancing swap before an open is an ENTRY: it must keep the 50 bps bound, because
     * refusing it costs nothing and paying 3% to enter a position is a real loss. So the
     * count of `leg: "exit"` sites is asserted rather than assumed — a third one appearing
     * is a decision someone has to make on purpose.
     */
    const exits = source.match(/leg: "exit",/g) ?? [];
    assert.equal(exits.length, 2, "expected exactly the residual sale and the auto-unwind");

    const balancing = source.indexOf('}, "balancing swap")');
    assert.ok(balancing > 0);
    const window = source.slice(Math.max(0, balancing - 400), balancing);
    assert.equal(window.includes('leg: "exit"'), false, "the balancing swap is not an exit leg");
  });
});
