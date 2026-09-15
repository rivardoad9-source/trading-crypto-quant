/**
 * Self-heal for the residual token of a FAILED OPEN — the decision, with every effect injected.
 *
 * WHY (15 Sep 2026, LEVERCAT-SOL, the third time). A failed open whose auto-unwind could not sell
 * leaves the paired token in the wallet and a `live_execution_attempts` row with
 * `outcome='failed'`, `unwind='orphan'` — and NO `simulated_positions` row. The `*\/2` self-heal
 * (`scripts/retryResidualSweep.ts`) only looked at position rows, so this shape was recoverable
 * only by a human running a script (id 2 MANLET, id 5 NEARKAT, id 10 LEVERCAT). This is that
 * shape folded into the same tool, through the same sell path.
 *
 * Deliberately NOT here: signing, SQL, RPC. The script supplies them; this module imports no
 * executor, so the security allowlist in `onchainExecutor.test.ts` is unchanged and the whole
 * decision is testable offline.
 *
 * The order is the safety argument:
 *  1. busy pool                      -> skip   (never race a live open)
 *  2. position account EXISTS        -> skip   (a funded orphan is `recoverFundedOrphan.ts`'s job)
 *  3. pool's paired mint != row mint -> refuse (selling the wrong token is not a recovery)
 *  4. sell via the engine's sweep    -> not settled: write nothing, capital is still in the token
 *  5. close the emptied ATA          -> best effort; `withheld-fee` is an outcome, not a failure
 *  6. measure the wallet ("confirmed")
 *  7. wallet moved by anything else since the attempt -> do not write a cost it cannot attribute
 *  8. the settle script's own chain proof, then its own refusal rules, then its one write
 */

export interface AttemptRowForHeal {
  id: number;
  attempted_at: string;
  pair_name: string;
  pool_address: string;
  token_mint: string | null;
  outcome: string;
  unwind: string | null;
  position_address: string | null;
  wallet_lamports_before: number | null;
}

/** Structural so this module need not import the executor's type. */
export interface AttemptHealSweep {
  state: "swept" | "dust" | "failed" | "unmeasured";
  mint: string | null;
  amount: string | null;
  signature: string | null;
  error: string | null;
  slippageBps?: number;
}

export interface AttemptHealDeps {
  /** Null when it is safe to touch the pool; otherwise why not. */
  busyReason(): string | null;
  /** Whether the row's position account exists on-chain. Throws when unreadable. */
  positionAccountExists(address: string): Promise<boolean>;
  resolvePairedMint(): Promise<string>;
  /** `sweepResidualPairedToken` + `defaultResidualSweepDeps` — the engine's one sell path. */
  sweep(): Promise<AttemptHealSweep>;
  closeTokenAccount(mint: string): Promise<{ state: string; signature?: string; detail?: string; amount?: string }>;
  /** Wallet lamports at "confirmed"; null when unreadable (never 0). */
  readWalletLamports(): Promise<number | null>;
  /** Null when nothing else touched the wallet since the attempt; otherwise what did. */
  walletMovedSince(): string | null;
  /** `settleRecoveredAttempt.cjs`'s `chainIsClean` — problems found, empty when clean. */
  proof(mint: string): Promise<string[]>;
  /** `settleRecoveredAttempt.cjs`'s `planSettlement`. */
  plan(afterLamports: number): { refusals: string[]; cost: number | null };
  /** `settleRecoveredAttempt.cjs`'s `writeSettlement`; returns rows changed. */
  write(cost: number, afterLamports: number, extras: { rescueSignature: string | null; ataCloseSignature: string | null }): number;
}

export type AttemptHealOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "sale-failed"; sweep: AttemptHealSweep }
  | {
      kind: "sold-not-recorded";
      sweep: AttemptHealSweep;
      tokenAccount: string;
      walletLamports: number | null;
      reason: string;
    }
  | { kind: "recorded"; sweep: AttemptHealSweep; tokenAccount: string; walletLamports: number; costLamports: number };

export async function healAttemptResidual(row: AttemptRowForHeal, deps: AttemptHealDeps): Promise<AttemptHealOutcome> {
  const busy = deps.busyReason();
  if (busy) return { kind: "skipped", reason: busy };

  if (row.outcome !== "failed" || row.unwind !== "orphan") {
    return { kind: "refused", reason: `row is outcome='${row.outcome}' unwind='${row.unwind}', not a failed open with stranded capital` };
  }
  if (!row.position_address) {
    return { kind: "refused", reason: "row names no position address, so the token-only shape cannot be verified" };
  }

  let exists: boolean;
  try {
    exists = await deps.positionAccountExists(row.position_address);
  } catch (err) {
    return { kind: "skipped", reason: `position account unreadable (${err instanceof Error ? err.message : String(err)}) — not a proof of absence` };
  }
  if (exists) {
    return {
      kind: "skipped",
      reason: `position ${row.position_address} EXISTS on-chain — a funded orphan is scripts/recoverFundedOrphan.ts's job, not this one`,
    };
  }

  const mint = await deps.resolvePairedMint();
  if (row.token_mint && row.token_mint !== mint) {
    return { kind: "refused", reason: `the pool's paired mint ${mint} is not the row's token_mint ${row.token_mint}` };
  }

  const sweep = await deps.sweep();
  if (sweep.state !== "swept" && sweep.state !== "dust") return { kind: "sale-failed", sweep };

  let tokenAccount = "not attempted";
  let ataCloseSignature: string | null = null;
  try {
    const closed = await deps.closeTokenAccount(mint);
    tokenAccount = closed.state;
    if (closed.state === "closed" && closed.signature) ataCloseSignature = closed.signature;
    if (closed.state === "withheld-fee") tokenAccount = `withheld-fee (rent stays parked: ${closed.detail ?? "withheld transfer fees"})`;
  } catch (err) {
    tokenAccount = `close failed: ${err instanceof Error ? err.message : String(err)} (rent stays, the sale is unaffected)`;
  }

  const after = await deps.readWalletLamports();
  const notRecorded = (reason: string): AttemptHealOutcome => ({ kind: "sold-not-recorded", sweep, tokenAccount, walletLamports: after, reason });
  if (after === null) return notRecorded("the wallet balance could not be read, so the real cost is unmeasured");

  const moved = deps.walletMovedSince();
  if (moved) return notRecorded(`the wallet also moved for another reason since the attempt (${moved}), so the balance cannot be attributed to this recovery`);

  const problems = await deps.proof(mint);
  if (problems.length > 0) return notRecorded(`chain proof refused: ${problems.join("; ")}`);

  const { refusals, cost } = deps.plan(after);
  if (refusals.length > 0 || cost === null) return notRecorded(`settlement refused: ${refusals.join("; ")}`);

  const changed = deps.write(cost, after, { rescueSignature: sweep.signature, ataCloseSignature });
  if (changed !== 1) return notRecorded("the row changed underneath us (already settled?)");
  return { kind: "recorded", sweep, tokenAccount, walletLamports: after, costLamports: cost };
}
