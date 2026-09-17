/**
 * A failed open that HALF-LANDED leaves a real position, and the engine walked away.
 *
 * 10 Sep 2026, KNOTS-SOL. The balancing swap confirmed, the wide path's funding
 * transactions were sent one at a time, two landed, and the next was refused at
 * preflight for insufficient funds. The engine's remediation ran exactly as designed —
 * it sold the WALLET's leftover KNOTS back to SOL and benched the pool — and every word
 * of that is about the wallet. The POSITION account was partially funded, stayed
 * on-chain, and earned $18.47 over four hours with nothing valuing it, nothing enforcing
 * its stop-loss and the engine reporting an empty book. A human noticed and closed it.
 *
 * Three rules meet in the hole, and each is individually right:
 *
 *  - no row is written until the open CONFIRMS, so a half-landed open writes nothing;
 *  - the failure path unwinds the WALLET, because a stranded token balance is what a
 *    failed open used to leave behind;
 *  - `requirePosition` fails closed on an owner scan that can lag a position the engine
 *    itself just created, so the one call that could have closed it refuses.
 *
 * This file is the BRIDGE's half of the fix: on a `DlmmPartialExecutionError` — the only
 * failure that names a position — ask the chain what that account holds and close it if
 * it holds anything, before unwinding the wallet. The EXECUTOR's half (reading a position
 * by address, withdraw-claim-close, and the narrow path's pre-send simulation) is in
 * `onchainExecutor.test.ts`, which is the file allowed to import the signer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StrandedSwapError,
  recoverPartiallyFundedPosition,
  type OrphanRecovery,
} from "../services/liveExecution.js";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const liveSource = readFileSync(join(srcDir, "services/liveExecution.ts"), "utf8");

/** The executor's outcome shape, restated so this file need not import the signer. */
interface Outcome {
  state: "absent" | "empty" | "closed";
  liquidityX: string;
  liquidityY: string;
  unclaimedFeeX: string;
  unclaimedFeeY: string;
  signatures: string[];
}

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  state: "closed",
  liquidityX: "0",
  liquidityY: "0",
  unclaimedFeeX: "0",
  unclaimedFeeY: "0",
  signatures: [],
  ...over,
});

describe("orphan recovery — a partially funded position is closed, not abandoned", () => {
  it("closes a funded position and reports what came back", async () => {
    const calls: { poolAddress: string; positionAddress: string }[] = [];
    const recovery = await recoverPartiallyFundedPosition(
      { pairName: "KNOTS-SOL", poolAddress: "pool-1", positionAddress: "pos-1" },
      async (params) => {
        calls.push(params);
        return outcome({
          state: "closed",
          liquidityX: "900000000",
          liquidityY: "412",
          signatures: ["close-a", "close-b"],
        });
      },
    );

    // The address comes from the FAILURE, not from a lookup — that is the whole point:
    // the owner scan is the thing that could not see it.
    assert.deepEqual(calls, [{ poolAddress: "pool-1", positionAddress: "pos-1" }]);
    assert.equal(recovery.state, "closed");
    assert.deepEqual(recovery.signatures, ["close-a", "close-b"]);
    assert.equal(recovery.error, null);
  });

  it("reports an empty position without claiming to have closed one", async () => {
    /*
     * "Exists but holds nothing" is a different fact from "closed it", and only rent is
     * at stake. Reporting it as a close would tell the operator capital came back when
     * none had gone out.
     */
    const recovery = await recoverPartiallyFundedPosition(
      { pairName: "FOO-SOL", poolAddress: "pool-1", positionAddress: "pos-1" },
      async () => outcome({ state: "empty" }),
    );
    assert.equal(recovery.state, "empty");
    assert.deepEqual(recovery.signatures, []);
  });

  it("never throws, so the wallet auto-unwind still runs", async () => {
    /*
     * This runs on a failure path that still has work to do. A recovery that threw would
     * trade a funded position for a stranded token balance — one unmonitored asset for
     * another — and the operator would learn about neither.
     */
    const recovery = await recoverPartiallyFundedPosition(
      { pairName: "FOO-SOL", poolAddress: "pool-1", positionAddress: "pos-1" },
      async () => {
        throw new Error("RPC exploded");
      },
    );
    assert.equal(recovery.state, "failed");
    assert.match(recovery.error ?? "", /RPC exploded/);
    assert.deepEqual(recovery.signatures, []);
  });
});

describe("orphan recovery — the alert says whether capital is still on-chain", () => {
  const stranded = (orphan: OrphanRecovery | null, cause: unknown = new Error("boom")) =>
    new StrandedSwapError("MINT", "123", "swap-sig", cause, "rescue-sig", null, orphan);

  it("says the position was closed and the capital is back", () => {
    const err = stranded({
      position: "pos-1",
      state: "closed",
      signatures: ["close-a"],
      error: null,
    });
    assert.match(err.message, /pos-1/);
    assert.match(err.message, /CLOSED/);
    assert.match(err.message, /close-a/);
  });

  it("SHOUTS when a funded position could not be closed", () => {
    /*
     * The same words `/close_all` uses for the same situation, and for the same reason: a
     * position that is still open with no row tracking it is the one outcome an operator
     * must act on immediately.
     */
    const err = stranded({
      position: "pos-1",
      state: "failed",
      signatures: [],
      error: "simulation failed",
    });
    assert.match(err.message, /THE ON-CHAIN POSITION IS STILL OPEN/);
    assert.match(err.message, /simulation failed/);
  });

  it("says nothing about a position when the open never created one", () => {
    // Most failed opens create nothing. Naming a position there would send the operator
    // looking for an account that provably never existed.
    const err = stranded(null, new Error("quote failed"));
    assert.doesNotMatch(err.message, /POSITION/);
    assert.doesNotMatch(err.message, /pos-/);
  });

  it("fails LOUD when a partial execution arrives with no recovery report", () => {
    /*
     * `orphan` defaults to null because most failed opens never created a position. On a
     * `DlmmPartialExecutionError` that default would be a lie by omission — the error
     * itself says a position exists — so the ABSENCE of a report is reported, with the
     * address to check. Asserted at source because constructing that error here would
     * mean importing the signer, which this file is deliberately not allowed to do.
     */
    const branch = liveSource.slice(
      liveSource.indexOf("function describeOrphan("),
      liveSource.indexOf("export interface OrphanRecovery"),
    );
    assert.ok(branch.length > 0, "describeOrphan is gone");
    assert.match(branch, /if \(cause instanceof DlmmPartialExecutionError\)/);
    assert.match(branch, /A POSITION MAY STILL BE FUNDED ON-CHAIN/);
    assert.match(branch, /CHECK \$\{cause\.position\} BY HAND/);
  });
});

describe("orphan recovery — ordering and gating", () => {
  it("recovers the POSITION before unwinding the WALLET", () => {
    /*
     * Order is load-bearing, not stylistic. The withdrawal returns the paired token to the
     * wallet, so closing first means the unwind's re-read sweeps it up in the same pass.
     * Reversed, the unwind would sell against a balance the position still held and leave
     * the withdrawn tokens behind.
     */
    const recovery = liveSource.indexOf("await recoverPartiallyFundedPosition(");
    /*
     * The unwind's anchor is its CALL SITE, not a variable inside it. Until 18 Sep 2026 this
     * pointed at `let rescueSignature: string | null = null;`; that single sale became a loop
     * that re-reads the wallet after every sale (`unwindPairedBalance`), so the variable the
     * old anchor named is gone and the call itself is the stable marker of where the unwind
     * begins.
     */
    const unwind = liveSource.indexOf("await unwindPairedBalance({");
    assert.ok(recovery > 0 && unwind > 0);
    assert.ok(recovery < unwind, "the wallet unwind now runs before the position recovery");
  });

  it("only runs for the failure that NAMES a position", () => {
    // Every other failure means no position was created, so there is no address to act on
    // and a lookup would be guessing.
    assert.match(
      liveSource,
      /err instanceof DlmmPartialExecutionError\s*\n?\s*\?\s*await recoverPartiallyFundedPosition\(/,
      "the recovery is no longer gated on the error that carries a position address",
    );
  });

  it("writes no database row for what it recovered", () => {
    /*
     * A recovered position is not a holding. It was closed; recording it would be the
     * fabricated row the "no row until the open confirms" rule exists to prevent, arrived
     * at from the other direction.
     */
    const start = liveSource.indexOf("export async function recoverPartiallyFundedPosition");
    assert.ok(start > 0);
    const rest = liveSource.slice(start);
    const body = rest.slice(0, rest.indexOf("\n}\n") + 3);
    assert.ok(
      !/recordPosition|openPositionRow|INSERT/i.test(body),
      "the recovery writes a database row for a position it just closed",
    );
  });

  it("reports the deposit the EXECUTOR made, not the balance this file read", () => {
    /*
     * The narrow path may re-quote the deposit down when its pre-send simulation finds the
     * account short, which makes the pre-open balance read stale — and that read used to
     * be written to the position row as `depositedPairedAmount`.
     */
    assert.match(liveSource, /depositedPairedAmount: opened\.depositedPairedAmount,/);
    assert.ok(
      !/depositedPairedAmount: pairedAmount\.toString\(\)/.test(liveSource),
      "the bridge reports its own earlier read as what was deposited again",
    );
  });
});
