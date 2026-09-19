/**
 * OPS SCRIPT, RUN BY HAND: recover a FUNDED DLMM position the engine left behind when an
 * open half-landed, and put the wallet back into SOL.
 *
 * Written for the 12 Sep 2026 incident. At 11:08 WIB the engine opened MANLET-SOL on pool
 * `68C62WPY…`: the balancing swap confirmed (0.9 SOL -> 99 285 MANLET), the position
 * account was created (0.0624 SOL of rent), the wSOL leg landed (0.84 SOL) — and the
 * paired-token leg was rejected at preflight (`RebalanceLiquidity` -> `insufficient
 * funds`). The engine's own recovery ran and FAILED on both paths: the Jupiter auto-unwind
 * and `dlmmExecutor.closeOrphanPosition` each gave up after three builds on an expired
 * blockhash. Result: 1.802543 SOL out of the wallet, a FUNDED position nothing monitors,
 * and 99 285 MANLET sitting in the wallet.
 *
 * `scripts/closeOrphanPosition.cjs` REFUSES this shape on purpose — it closes EMPTY
 * accounts only. This script is its counterpart for the case that actually strands capital.
 *
 * It uses the ENGINE'S OWN paths and adds no signing code:
 *   - close  = `dlmmExecutor.closeOrphanPosition` -> `withdrawClaimAndClose`
 *              (`removeLiquidity(bps=10 000)` + `shouldClaimAndClose`, one operation);
 *   - sell   = `executeJupiterSwap` (the same call the engine's residual sweep makes);
 *   - rent   = `closeEmptyTokenAccount` for the ATA the recovery empties.
 * That is deliberate: a hand-rolled `removeLiquidity` here is how a recovery path drifts
 * into closing without claiming.
 *
 * WHAT IT DOES NOT DO: it does not write the database. `live_execution_attempts` for this
 * incident was already written by the engine (`outcome='failed'`, `unwind='orphan'`,
 * `cost_lamports` = the measured burn at the moment of failure). Re-pointing that row at
 * the recovered balance is a bookkeeping decision for a human, and it is called out in the
 * hand-off brief rather than done silently here.
 *
 * DRY RUN IS THE DEFAULT and it SIMULATES the close against mainnet (`sigVerify: false`,
 * nothing signed, nothing sent), so the operator sees the recovered amounts BEFORE spending
 * anything. Spending needs `-- --execute`.
 *
 *   node --env-file=.env --import tsx scripts/recoverFundedOrphan.ts \
 *     --pool 68C62WPY… --position 2uYWjuvEFR65…                 # simulate
 *   node --env-file=.env --import tsx scripts/recoverFundedOrphan.ts \
 *     --pool 68C62WPY… --position 2uYWjuvEFR65… -- --execute     # close + sell + reclaim rent
 *
 * Flags: --slippage-bps <n> (clamped down to HARD_MAX_SLIPPAGE_BPS), --skip-sell (recover
 * the position and leave the token in the wallet), --skip-rent (leave the ATA open),
 * --skip-close (the position is ALREADY closed — do steps 2 and 3 only: sell whatever token
 * the wallet still holds and reclaim the ATA's rent. Added 18 Sep 2026 after the controlled
 * TripleT-SOL validation open: the close withdrew 796.59 TripleT, the sell step had only read
 * the 23.57 that was in the wallet BEFORE the close, and re-running without this flag stopped
 * at "position account does not exist" with the capital parked on-chain).
 */
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";

import {
  WSOL_MINT,
  authorizeExecution,
  closeEmptyTokenAccount,
  dlmmExecutor,
  executeJupiterSwap,
  getConnection,
  getJupiterQuote,
  resolveExitSlippageBps,
  type ExecutionAuthorization,
} from "../src/services/onchainExecutor.js";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

const POOL = arg("pool");
const POSITION = arg("position");
const SKIP_SELL = argv.includes("--skip-sell");
const SKIP_CLOSE = argv.includes("--skip-close");
const SKIP_RENT = argv.includes("--skip-rent");
const SLIPPAGE_BPS = arg("slippage-bps") ? Number(arg("slippage-bps")) : undefined;

if (!POOL || !POSITION) {
  console.error("--pool <pubkey> and --position <pubkey> are both required.");
  process.exit(1);
}

const sol = (lamports: number | bigint | string): string => (Number(lamports) / 1e9).toFixed(9);

/** Every SPL/Token-2022 account the wallet holds with a non-zero balance. */
async function tokenBalances(conn: Connection, owner: PublicKey) {
  const out: { mint: string; amount: bigint; decimals: number; tokenProgram: string }[] = [];
  for (const programId of [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ]) {
    const accounts = await conn.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey(programId),
    });
    for (const a of accounts.value) {
      const info = a.account.data.parsed.info;
      const amount = BigInt(info.tokenAmount.amount);
      if (amount > 0n) {
        out.push({
          mint: info.mint,
          amount,
          decimals: info.tokenAmount.decimals,
          tokenProgram: programId,
        });
      }
    }
  }
  return out;
}

/**
 * Reads the position account DIRECTLY rather than through the SDK's wallet listing, and
 * verifies that it really belongs to `owner` on `POOL` before anyone acts on it. A
 * position created with a throwaway keypair is invisible to `getPositionsByUserAndLbPair`,
 * which is exactly how the 10 Sep 2026 orphan stayed hidden for four hours.
 */
async function readOrphan(conn: Connection, owner: PublicKey, poolAddress: string, positionAddress: string) {
  const pubkey = new PublicKey(positionAddress);
  const info = await conn.getAccountInfo(pubkey, "confirmed");
  if (info === null) return { pubkey, info: null, position: null };

  const data = info.data;
  const lbPairOnAccount = new PublicKey(data.subarray(8, 40)).toBase58();
  const ownerOnAccount = new PublicKey(data.subarray(40, 72)).toBase58();
  if (lbPairOnAccount !== poolAddress) {
    throw new Error(
      `position ${positionAddress} belongs to pool ${lbPairOnAccount}, not ${poolAddress}. Refusing to act on it.`,
    );
  }
  if (ownerOnAccount !== owner.toBase58()) {
    throw new Error(
      `position ${positionAddress} is owned by ${ownerOnAccount}, not this wallet. Refusing to act on it.`,
    );
  }

  const pool = await loadPool(conn, poolAddress);
  const position = await pool.getPosition(pubkey);
  return { pubkey, info, position, pool };
}

/**
 * The DLMM SDK is loaded through `createRequire`, not `import()`.
 *
 * Its ESM build top-level-imports an Anchor CJS DIRECTORY
 * (`@coral-xyz/anchor/dist/cjs/utils/bytes`), which Node refuses to resolve from an ES
 * module — and this repo is `"type": "module"`. `import("@meteora-ag/dlmm")` therefore
 * fails with `does not provide an export named 'BN'` before a single RPC call. The CJS
 * build loads fine. `loadDlmmSdk()` in `src/services/onchainExecutor.ts` does the same
 * thing for the same reason.
 */
const createRequire = (await import("node:module")).createRequire;
const dlmmRequire = createRequire(import.meta.url);
async function loadPool(conn: Connection, poolAddress: string) {
  const DLMM = dlmmRequire("@meteora-ag/dlmm");
  return DLMM.create(conn, new PublicKey(poolAddress));
}

/**
 * Builds the SAME close the executor builds and runs it through `simulateTransaction`, so
 * a dry run reports what would come back without signing. Kept in lock-step with
 * `withdrawClaimAndClose` by using the same parameters (100% of every bin, claim and close).
 */
async function simulateClose(conn: Connection, owner: PublicKey, pool: any, position: any) {
  const bins = position.positionData.positionBinData;
  const fromBinId = bins.at(0)?.binId;
  const toBinId = bins.at(-1)?.binId;
  if (fromBinId === undefined || toBinId === undefined) throw new Error("position reports no bins");

  const built: (Transaction | VersionedTransaction)[] = await pool.removeLiquidity({
    user: owner,
    position: position.publicKey,
    fromBinId,
    toBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });

  const before = await conn.getBalance(owner);
  const results: { index: number; err: unknown; lamportsDelta: number | null; tokens: string[] }[] = [];
  for (const [index, tx] of built.entries()) {
    /*
     * Re-deserialise the transaction with THIS module's web3.js before simulating.
     *
     * `@meteora-ag/dlmm` ships a BUNDLE with its own inlined web3.js, so the legacy
     * `Transaction` it hands back is not an instance of the class the top-level
     * `Connection` knows: `'message' in tx` is false, the call falls into the legacy
     * branch, and a config object (which is what carries `sigVerify: false` and the
     * accounts we ask about) throws `Invalid arguments` before anything is simulated.
     * Round-tripping the wire bytes fixes the identity without changing the transaction.
     */
    const wire = (tx as any).serialize({ requireAllSignatures: false, verifySignatures: false });
    const { VersionedTransaction } = await import("@solana/web3.js");
    const versioned = VersionedTransaction.deserialize(wire);
    const sim = await conn.simulateTransaction(versioned, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: "base64", addresses: [owner.toBase58()] },
    });
    const acct = sim.value.accounts?.[0];
    /*
     * `postTokenBalances` is present in the RPC response whenever `accounts` is requested,
     * but it is missing from this web3.js build's `SimulatedTransactionResponse` type, so
     * it is read through a cast rather than declared away.
     */
    const postTokenBalances = (sim.value as any).postTokenBalances ?? [];
    const tokens: string[] = [];
    for (const t of postTokenBalances) {
      if (t.owner === owner.toBase58() && Number(t.uiTokenAmount.amount) > 0) {
        tokens.push(`${t.uiTokenAmount.uiAmountString} ${t.mint}`);
      }
    }
    results.push({
      index: index + 1,
      err: sim.value.err,
      lamportsDelta: acct ? acct.lamports - before : null,
      tokens,
    });
  }
  return results;
}

(async () => {
  const conn = getConnection();
  let auth: ExecutionAuthorization;
  try {
    auth = authorizeExecution();
  } catch (e) {
    console.error(`NOT ARMED: ${(e as Error).message}`);
    process.exit(1);
  }

  const owner = auth.wallet;
  console.log("wallet:", owner.toBase58());
  console.log("pool:", POOL);
  console.log("position:", POSITION);
  console.log("mode:", EXECUTE ? "EXECUTE — will sign and send" : "DRY RUN — simulation only, nothing signed");

  const solBefore = await conn.getBalance(owner);
  const tokensBefore = await tokenBalances(conn, owner);
  console.log(`\nSOL before: ${sol(solBefore)}`);
  for (const t of tokensBefore) console.log(`  token before: ${t.amount} base units of ${t.mint}`);

  const { info, position, pool } = await readOrphan(conn, owner, POOL!, POSITION!);
  if (info === null) {
    if (!SKIP_CLOSE) {
      console.log("\nposition account does not exist — nothing to recover.");
      return;
    }
    /*
     * `--skip-close`, the 18 Sep 2026 shape: the position was ALREADY closed (a previous run,
     * or by hand) and the paired token that close withdrew is still sitting in the wallet.
     * Without this flag the script stops here — correct for an orphan, but it leaves the
     * capital parked, which is the exact residue class this file exists to clear: after the
     * controlled TripleT-SOL validation open, `removeLiquidity` returned 796.59 TripleT to the
     * wallet and the close run's sell step had only known about the 23.57 it read pre-close.
     * Only step 1 is skipped; the sell and the ATA reclaim below are still the engine's own.
     */
    console.log("\n--skip-close: the position account is gone; selling whatever token the wallet still holds.");
  } else {
    console.log(`\nposition account: ${info.lamports} lamports (${sol(info.lamports)} SOL of rent), ${info.data.length} bytes`);
    if (position === null) {
      console.log("position could not be decoded by the SDK — refusing to touch it.");
      process.exit(1);
    }

    const bins = position.positionData.positionBinData;
    const fundedBins = bins.filter((b: any) => BigInt(b.positionLiquidity ?? 0) > 0n);
    console.log(
      `liquidity: ${position.positionData.totalXAmount} X + ${position.positionData.totalYAmount} Y across ` +
        `${fundedBins.length} of ${bins.length} bins | unclaimed fees ${position.positionData.feeX} X / ${position.positionData.feeY} Y`,
    );
    const holdsValue =
      BigInt(position.positionData.totalXAmount ?? 0) > 0n ||
      BigInt(position.positionData.totalYAmount ?? 0) > 0n ||
      BigInt(position.positionData.feeX ?? 0) > 0n ||
      BigInt(position.positionData.feeY ?? 0) > 0n;
    if (!holdsValue) console.log("position holds NO liquidity and NO unclaimed fees — rent only.");
  }

  if (!EXECUTE) {
    if (SKIP_CLOSE) {
      console.log(
        "\nDRY RUN — close skipped (--skip-close). With `--execute` the script would sell the " +
          "wallet's token (the step-2 quote is printed then) and reclaim the empty ATA's rent.",
      );
      return;
    }
    console.log("\n--- simulating the close (removeLiquidity 100% + shouldClaimAndClose) ---");
    try {
      const sims = await simulateClose(conn, owner, pool, position);
      for (const s of sims) {
        console.log(
          `  tx ${s.index}: err=${JSON.stringify(s.err)} lamportsDelta=${s.lamportsDelta === null ? "?" : sol(s.lamportsDelta)}${s.tokens.length ? ` tokens=${s.tokens.join(", ")}` : ""}`,
        );
      }
      if (sims.every((s) => s.err === null)) console.log("  simulation: CLEAN — the close would land.");
      else console.log("  simulation reported an error above — do NOT execute blind.");
    } catch (e) {
      console.log(`  SIMULATION THREW: ${(e as Error).message}`);
    }
    console.log("\nDRY RUN — nothing signed, nothing sent. Re-run with `-- --execute` to recover.");
    return;
  }

  if (SKIP_CLOSE) {
    console.log("\n=== 1. close skipped (--skip-close) ===");
  } else {
    console.log("\n=== 1. closing the funded orphan (withdraw + claim + close) ===");
    const outcome = await dlmmExecutor.closeOrphanPosition(auth, {
      poolAddress: POOL!,
      positionAddress: POSITION!,
    });
    console.log(`state=${outcome.state} liquidityX=${outcome.liquidityX} liquidityY=${outcome.liquidityY} fees=${outcome.unclaimedFeeX}/${outcome.unclaimedFeeY}`);
    for (const s of outcome.signatures) console.log(`  close signature: ${s}`);
    if (outcome.state !== "closed") {
      console.log("Nothing was closed. Stopping before the sell so the wallet is left in a state you can inspect.");
      return;
    }
  }

  const tokenPrograms: Record<string, string> = {};
  for (const t of await tokenBalances(conn, owner)) tokenPrograms[t.mint] = t.tokenProgram;

  if (!SKIP_SELL) {
    const held = (await tokenBalances(conn, owner)).filter((t) => t.mint !== WSOL_MINT);
    console.log("\n=== 2. selling the recovered token back to SOL ===");
    if (held.length === 0) console.log("  no non-wSOL token in the wallet — nothing to sell.");
    for (const t of held) {
      /*
       * EXIT bound, not the entry bound. This leg puts capital BACK into SOL, and the
       * 50 bps entry cap refuses the sale whenever the pool ticks ~2 bins in the seconds
       * between the quote and the landing (bin_step 20 = 0.2%/bin).
       *
       * Observed 19 Sep 2026, controlled CATE-SOL open whose auto-unwind was interrupted:
       * the residual sale died twice on `custom program error: 0x1771`
       * (SlippageToleranceExceeded) at 50 bps, leaving 51.067138 CATE stranded in a wallet
       * the DB had no row for. The engine's OWN residual sale passes `leg: "exit"` for
       * exactly this reason (`executeJupiterSwap`, see the `leg` docstring) — this ops
       * script was the one call site that still resolved the sell through the entry cap.
       */
      const slippage = resolveExitSlippageBps(SLIPPAGE_BPS);
      const quote = await getJupiterQuote({
        inputMint: t.mint,
        outputMint: WSOL_MINT,
        amountLamports: Number(t.amount),
        slippageBps: slippage,
      });
      console.log(
        `  ${t.amount} base units of ${t.mint} -> ${quote.outAmount} lamports (${sol(quote.outAmount)} SOL), slippage ${slippage} bps`,
      );
      const { result } = await executeJupiterSwap(auth, {
        inputMint: t.mint,
        outputMint: WSOL_MINT,
        amountLamports: Number(t.amount),
        // The exit leg, or the sale is bounded by the 50 bps ENTRY cap and refuses.
        leg: "exit",
        ...(SLIPPAGE_BPS === undefined ? {} : { slippageBps: SLIPPAGE_BPS }),
      });
      console.log(`  sold: ${result.signature}`);
    }

    if (!SKIP_RENT) {
      console.log("\n=== 3. reclaiming the now-empty token account's rent ===");
      for (const t of held) {
        const closed = await closeEmptyTokenAccount(auth, {
          mint: t.mint,
          tokenProgram: tokenPrograms[t.mint] ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        });
        console.log(`  ${t.mint}: ${JSON.stringify(closed)}`);
      }
    }
  }

  const solAfter = await conn.getBalance(owner);
  const tokensAfter = await tokenBalances(conn, owner);
  console.log("\n=== result ===");
  console.log(`SOL: ${sol(solBefore)} -> ${sol(solAfter)} (${sol(solAfter - solBefore)} SOL)`);
  for (const t of tokensAfter) console.log(`  token still held: ${t.amount} base units of ${t.mint}`);
  if (tokensAfter.length === 0) console.log("  no token balances left in the wallet.");
  const gone = await conn.getAccountInfo(new PublicKey(POSITION!));
  console.log(`position account still exists: ${gone !== null}`);
})().catch((e) => {
  console.error(`ERR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

// `Keypair` is imported so the signing shape matches the engine's own scripts; the
// helpers actually used above are listed in the header.
void Keypair;
