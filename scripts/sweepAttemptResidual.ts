/**
 * OPS SCRIPT, RUN BY AN OPERATOR: sell back the paired token that a FAILED live open left in
 * the wallet when there is NO funded position to close.
 *
 * WHY THIS EXISTS (15 Sep 2026 21:33:47 WIB, real money)
 * ------------------------------------------------------
 * The engine tried to open `LEVERCAT-SOL` on pool `42JnUXw5…`. The balancing swap confirmed
 * (0.9 SOL -> 40 053.97 LEVERCAT) and the funding of the wide position was rejected at
 * preflight ("landed 2 of its transactions and then failed … 2/2: rejected at preflight"), so
 * the position account was NEVER created on-chain. `openLivePosition` recorded the attempt as
 * `outcome='failed'`, `unwind='orphan'` — because it only knows that an address was allocated,
 * not whether the account ever landed — and the auto-unwind did NOT put the capital back
 * (`rescue_signature` NULL). Result: 0.913 SOL gone from the wallet, 40 053.97 LEVERCAT sitting
 * there unmonitored, and TWO brakes holding new entries (StrandedCapitalError + the failed-cost
 * breaker reading the 0.913 SOL as spent).
 *
 * THE SHAPES AND WHO RECOVERS THEM
 * --------------------------------
 *   funded position on-chain  -> `scripts/recoverFundedOrphan.ts`   (close + sell + rent)
 *   no position, token only   -> THIS SCRIPT                        (sell + rent)
 *   empty position account    -> `scripts/closeOrphanPosition.cjs`  (close only)
 * Both first two paths REFUSE the other's shape: this one aborts if the position account exists.
 *
 * It adds NO signing code of its own. `sweepResidualPairedToken` + `defaultResidualSweepDeps`
 * are the engine's own close-path sweep (dust floor, Jupiter quote, fresh-quote retry); a
 * hand-rolled second sell path is how a recovery tool drifts from the code it recovers.
 *
 * DRY RUN IS THE DEFAULT and it is honest: it resolves the paired mint from the pool, READS the
 * wallet balance and fetches a real Jupiter quote. Nothing is signed. Spending needs `--execute`.
 *
 * It WRITES NOTHING to the database: recording the episode's real cost on the attempt row is
 * `scripts/settleRecoveredAttempt.cjs` (it verifies the chain proof itself), a deliberate
 * second step so a sale that lands can never be conflated with a recovery that was recorded.
 *
 *   node --env-file=.env --import tsx scripts/sweepAttemptResidual.ts --id 10
 *   node --env-file=.env --import tsx scripts/sweepAttemptResidual.ts --id 10 --execute
 *
 * Flags: `--id <live_execution_attempts.id>` (required), `--slippage-bps <n>` (default: the
 * exit cap), `--skip-rent`, `--db <path>`.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { PublicKey } from "@solana/web3.js";

import {
  authorizeExecution,
  closeEmptyTokenAccount,
  getConnection,
  type ExecutionAuthorization,
} from "../src/services/onchainExecutor.js";
import {
  defaultResidualSweepDeps,
  isSettledSweep,
  sweepResidualPairedToken,
} from "../src/services/liveExecution.js";

const require = createRequire(import.meta.url);

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const SKIP_RENT = argv.includes("--skip-rent");
const RENT_ONLY = argv.includes("--rent-only");
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function envDatabasePath(): string {
  try {
    const line = fs
      .readFileSync(path.resolve(".env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("DATABASE_PATH="));
    return line ? line.slice("DATABASE_PATH=".length).trim() : "data/flowmetrix.db";
  } catch {
    return "data/flowmetrix.db";
  }
}

const ATTEMPT_ID = Number(arg("id"));
if (!Number.isInteger(ATTEMPT_ID) || ATTEMPT_ID <= 0) {
  console.error("--id <live_execution_attempts.id> is required (an integer row id).");
  process.exit(1);
}
const DB = path.resolve(arg("db") ?? envDatabasePath());

interface AttemptRow {
  id: number;
  attempted_at: string;
  pair_name: string;
  pool_address: string;
  token_mint: string | null;
  outcome: string;
  unwind: string | null;
  position_address: string | null;
  cost_lamports: number | null;
  wallet_lamports_after: number | null;
}

function readAttempt(): AttemptRow {
  const Database = require("better-sqlite3");
  const db = new Database(DB, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        "SELECT id, attempted_at, pair_name, pool_address, token_mint, outcome, unwind, " +
          "position_address, cost_lamports, wallet_lamports_after FROM live_execution_attempts " +
          "WHERE id = ?",
      )
      .get(ATTEMPT_ID) as AttemptRow | undefined;
    if (!row) {
      console.error(`No live_execution_attempts row with id=${ATTEMPT_ID} in ${DB}`);
      process.exit(1);
    }
    return row;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const row = readAttempt();
  console.log(`attempt id ${row.id} (${row.attempted_at} UTC) — ${row.pair_name}`);
  console.log(`  outcome=${row.outcome} unwind=${row.unwind ?? "NULL"}`);
  console.log(`  cost_lamports=${row.cost_lamports ?? "NULL"} wallet_after=${row.wallet_lamports_after ?? "NULL"}`);
  console.log(`  pool=${row.pool_address} position=${row.position_address ?? "NULL"}`);
  console.log(`  mode: ${EXECUTE ? "EXECUTE — this signs and spends nothing extra, it SELLS" : "DRY RUN — read-only"}`);

  if (row.outcome !== "failed") {
    console.error(`Refusing: row is '${row.outcome}', this tool is only for a failed open.`);
    process.exit(1);
  }
  if (!row.position_address) {
    console.error("Refusing: row has no position_address — nothing stranded by an open.");
    process.exit(1);
  }

  const connection = getConnection();

  // Shape check: a FUNDED position needs recoverFundedOrphan.ts, not this.
  const positionInfo = await connection.getAccountInfo(new PublicKey(row.position_address));
  if (positionInfo !== null) {
    console.error(
      `Refusing: position ${row.position_address} EXISTS on-chain (dataSize=${positionInfo.data.length}). ` +
        "Use scripts/recoverFundedOrphan.ts — it closes the position AND sells; this script only sells.",
    );
    process.exit(1);
  }
  console.log(`position account: absent on-chain (verified) — token-only shape.`);

  const auth: ExecutionAuthorization = await authorizeExecution();
  const deps = defaultResidualSweepDeps(auth, row.pool_address);

  const mint = await deps.resolvePairedMint();
  const balance = await deps.readBalance(mint);
  console.log(`\npaired mint: ${mint}`);
  if (balance === null) {
    console.error("Refusing: the wallet token balance could not be READ (no quote on a guess).");
    process.exit(1);
  }
  console.log(`wallet balance: ${balance} base units`);
  if (balance === 0n) {
    console.log("Nothing to sell (balance 0) — the sweep would record 'dust'.");
  }
  const estimated = balance > 0n ? await deps.quoteToSol(mint, balance) : 0;
  console.log(`quote now: ~${(estimated / 1e9).toFixed(6)} SOL out for that balance`);

  if (!EXECUTE && !RENT_ONLY) {
    console.log("\nDRY RUN — nothing signed, nothing sent. Re-run with `--execute` to sell.");
    return;
  }

  let sweepSettled = false;
  if (RENT_ONLY) {
    console.log("\n--rent-only: skipping the sweep (the token sale is a separate step).");
  } else {
    const sweep = await sweepResidualPairedToken(
      { pairName: row.pair_name, positionAddress: row.position_address },
      deps,
    );
    console.log(`\nsweep state: ${sweep.state}${sweep.error ? ` — ${sweep.error}` : ""}`);
    console.log(`  amount=${sweep.amount ?? "NULL"} est=${sweep.estimatedLamports ?? "NULL"} sig=${sweep.signature ?? "NULL"}`);

    if (!isSettledSweep(sweep)) {
      console.error("Sweep did NOT settle — capital still in the token. Nothing else attempted.");
      process.exit(1);
    }
    sweepSettled = true;
  }

  if (!SKIP_RENT) {
    // The token may live under either token program, and picking the wrong one yields the
    // OTHER program's ATA (usually 'absent'), so both are tried. Rent only comes back from
    // the one that actually holds the emptied account.
    for (const tokenProgram of [SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      try {
        const outcome = await closeEmptyTokenAccount(auth, { mint, tokenProgram });
        console.log(`  ata close via ${tokenProgram.slice(0, 4)}…: ${JSON.stringify(outcome)}`);
        if (outcome.state !== "absent") break;
      } catch (err) {
        console.log(`  ata close via ${tokenProgram.slice(0, 4)}… failed: ${String(err)}`);
      }
    }
  }

  const after = await connection.getBalance(auth.wallet);
  console.log(`\nwallet now: ${(after / 1e9).toFixed(9)} SOL`);
  if (sweepSettled) {
    console.log("Next step: record the real cost on the attempt row →");
    console.log(`  node scripts/settleRecoveredAttempt.cjs --id ${row.id} --after-lamports ${after} -- --execute`);
  }
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
