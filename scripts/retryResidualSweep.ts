/**
 * OPS SCRIPT / CRON FALLBACK: retry the residual-token sweep that a close could not finish.
 *
 * WHY THIS EXISTS (12 Sep 2026, real money)
 * -----------------------------------------
 * 11 Sep the engine's take-profit closed MANLET-SOL correctly and then left ~0.84 SOL of the
 * exit value sitting in the wallet as the paired token: `closePosition` withdraws, claims and
 * closes, it does not SELL. A human sold it 37 minutes later. The build that ships
 * `closeLivePosition` now sweeps the residual automatically (proven live 12 Sep 21:15 WIB on
 * EMBER-SOL: sold 4 498 666 263 base units -> ~0.788 SOL and reclaimed the empty ATA's rent).
 *
 * But the sweep is best-effort by design — it never throws, it pages the operator and leaves
 * `residual_sweep` saying so. When it FAILS (a quote that cannot be priced, an RPC hiccup, an
 * ambiguous swap), the capital is parked in a token that nothing retries: the engine has
 * already closed the row and moved on. This script is that missing retry.
 *
 * It adds NO signing code of its own. It calls the engine's own
 * `sweepResidualPairedToken` with the engine's own `defaultResidualSweepDeps`, which is the
 * same function the close path uses — dust floor, Jupiter quote, the fresh-quote swap that
 * re-quotes a stale quote, and the same alert on failure. A second, hand-rolled sell path is
 * how a recovery tool drifts away from the code it is supposed to be recovering.
 *
 * WHAT IT WILL RETRY
 * ------------------
 * `simulated_positions` rows that are LIVE, closed within `--max-age-hours` (default 48), and
 * whose `residual_sweep` is `failed` or `unmeasured` — the two states the current build
 * writes when it knows the sweep did not settle. A row the engine settled (`swept`, `dust`) is
 * never touched, and neither is one a human already reconciled (`operator`). Rows closed
 * before the sweep existed have `residual_sweep` NULL and are deliberately NOT retried: their
 * token was handled by hand and the chain sweep reports them; retrying them here would be
 * guessing at history.
 *
 * WHAT IT REFUSES (both guards are about not racing a live open)
 * ------------------------------------------------------------
 * * an ACTIVE position on the SAME pool — the wallet's balance of that token may be an open's
 *   own deposit in flight, and selling it would break the open;
 * * any `live_execution_attempts` row for that pool in the last 15 minutes — an attempt means
 *   something is happening on that pool right now, and this tool is for AFTER the dust settles.
 *
 * DRY RUN IS THE DEFAULT, and the dry run is honest: it resolves the mint, READS the wallet
 * balance and fetches a real Jupiter quote, so the operator sees the amount and the value
 * before anything is signed. Spending needs `-- --execute`.
 *
 *   node --env-file=.env --import tsx scripts/retryResidualSweep.ts                    # list + plan
 *   node --env-file=.env --import tsx scripts/retryResidualSweep.ts --id 7             # plan one row
 *   node --env-file=.env --import tsx scripts/retryResidualSweep.ts --id 7 -- --execute
 *   node --env-file=.env --import tsx scripts/retryResidualSweep.ts -- --execute        # all eligible
 *
 * Flags: `--id <n>`, `--max-age-hours <n>` (default 48), `--max-rows <n>` (default 2), `--db <path>`.
 *
 * It WRITES the database only after a sale confirmed: `residual_sweep = 'swept'`,
 * `sweep_signature`, the measured `wallet_lamports_after` (and `ata_close_signature` when the
 * emptied token account was closed). 'swept' is the engine's own word for "the paired token is
 * back in SOL and this balance was measured after it landed", which is exactly what happened —
 * the alternative, a new state string, would make the reconciliation treat a settled trade as
 * unsettled. Precedent for an ops script writing this table: `settleResidualByHand.cjs`.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/*
 * `better-sqlite3` is a CJS native module, and this repo is `"type": "module"`, so it is
 * loaded through createRequire — same as `fm_chain_sweep.mjs` and for the same reason.
 */
const require = createRequire(import.meta.url);

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
  type ResidualSweep,
} from "../src/services/liveExecution.js";

const RETRYABLE = ["failed", "unmeasured"];
/** Any attempt on the pool inside this window means the pool is busy — do not touch it. */
const BUSY_WINDOW_MINUTES = 15;
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

const ONLY_ID = arg("id") ? Number(arg("id")) : null;
const MAX_AGE_HOURS = Number(arg("max-age-hours") ?? 48);
const MAX_ROWS = Number(arg("max-rows") ?? 2);

function envDatabasePath(): string {
  try {
    const line = fs
      .readFileSync(path.join(process.cwd(), ".env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("DATABASE_PATH="));
    return line ? line.slice("DATABASE_PATH=".length).trim() : "data/flowmetrix.db";
  } catch {
    return "data/flowmetrix.db";
  }
}
const DB = path.resolve(arg("db") ?? envDatabasePath());
const sol = (l: number) => (l / 1e9).toFixed(9);

interface Row {
  id: number;
  pair_name: string;
  pool_address: string;
  position_address: string;
  residual_sweep: string;
  closed_at: string;
}

function eligibleRows(): Row[] {
  const Database = require("better-sqlite3");
  const db = new Database(DB, { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, pair_name, pool_address, position_address, residual_sweep, closed_at
         FROM simulated_positions
        WHERE execution_mode = 'LIVE'
          AND closed_at IS NOT NULL
          AND residual_sweep IN (${RETRYABLE.map(() => "?").join(", ")})
          AND closed_at >= datetime('now', ?)
          ${ONLY_ID === null ? "" : "AND id = ?"}
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(
      ...RETRYABLE,
      `-${MAX_AGE_HOURS} hours`,
      ...(ONLY_ID === null ? [] : [ONLY_ID]),
      MAX_ROWS,
    ) as Row[];
  db.close();
  return rows;
}

/** The two "do not race a live open" guards. Returns a reason, or null when it is safe. */
function busyReason(row: Row): string | null {
  const Database = require("better-sqlite3");
  const db = new Database(DB, { readonly: true });
  const active = db
    .prepare(
      `SELECT COUNT(*) c FROM simulated_positions
        WHERE status = 'ACTIVE' AND execution_mode = 'LIVE' AND pool_address = ?`,
    )
    .get(row.pool_address) as { c: number };
  if (active.c > 0) {
    db.close();
    return `an ACTIVE position is open on this pool (${active.c})`;
  }
  const recent = db
    .prepare(
      `SELECT COUNT(*) c FROM live_execution_attempts
        WHERE pool_address = ? AND attempted_at >= datetime('now', ?)`,
    )
    .get(row.pool_address, `-${BUSY_WINDOW_MINUTES} minutes`) as { c: number };
  db.close();
  if (recent.c > 0) {
    return `the pool was attempted in the last ${BUSY_WINDOW_MINUTES} min (${recent.c}) — it is busy`;
  }
  return null;
}

/** The token program that owns the ATA, read from the chain rather than assumed. */
async function tokenProgramOf(
  conn: ReturnType<typeof getConnection>,
  wallet: import("@solana/web3.js").PublicKey,
  mint: string,
): Promise<string> {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const found = await conn.getParsedTokenAccountsByOwner(wallet, {
      mint: new PublicKey(mint),
    });
    const program = (found.value[0]?.account.data as { program?: string } | undefined)?.program;
    return program === "spl-token-2022" ? TOKEN_2022_PROGRAM : SPL_TOKEN_PROGRAM;
  } catch {
    return SPL_TOKEN_PROGRAM;
  }
}

function recordSweep(
  row: Row,
  sweep: ResidualSweep,
  walletLamportsAfter: number | null,
  ataCloseSignature: string | null,
): string {
  const Database = require("better-sqlite3");
  const db = new Database(DB, { readonly: false });
  const changed = db
    .prepare(
      `UPDATE simulated_positions
          SET residual_sweep = ?, sweep_signature = COALESCE(?, sweep_signature),
              wallet_lamports_after = COALESCE(?, wallet_lamports_after),
              ata_close_signature = COALESCE(?, ata_close_signature)
        WHERE id = ? AND residual_sweep IN (${RETRYABLE.map(() => "?").join(", ")})`,
    )
    .run(
      sweep.state,
      sweep.signature,
      walletLamportsAfter,
      ataCloseSignature,
      row.id,
      ...RETRYABLE,
    ).changes;
  db.close();
  return changed === 1 ? "recorded" : "NOT recorded (the row changed underneath us)";
}

async function retryRow(row: Row, auth: ExecutionAuthorization): Promise<void> {
  const conn = getConnection();
  const deps = defaultResidualSweepDeps(auth, row.pool_address);
  const context = { pairName: row.pair_name, positionAddress: row.position_address };
  const label = `id=${row.id} ${row.pair_name} ${row.position_address.slice(0, 8)}… (state ${row.residual_sweep})`;

  const reason = busyReason(row);
  if (reason) {
    console.log(`SKIPPED ${label} — ${reason}`);
    return;
  }

  if (!EXECUTE) {
    // A real preview, not a guess: resolve, read the wallet, quote Jupiter — nothing signed.
    const mint = await deps.resolvePairedMint();
    const balance = await deps.readBalance(mint);
    if (balance === null) {
      console.log(`PLAN ${label} mint=${mint} balance=UNREADABLE (the sweep would page here)`);
      return;
    }
    if (balance === 0n) {
      console.log(`PLAN ${label} mint=${mint} balance=0 — nothing to sell (the sweep writes 'dust')`);
      return;
    }
    const estimated = await deps.quoteToSol(mint, balance);
    console.log(
      `PLAN ${label} mint=${mint} ${balance} base units ~= ${sol(estimated)} SOL — ` +
        `re-run with -- --execute to sell it back`,
    );
    return;
  }

  const sweep = await sweepResidualPairedToken(context, deps);
  if (!isSettledSweep(sweep)) {
    console.log(
      `FAILED ${label} — sweep settled as '${sweep.state}'` +
        (sweep.error ? `: ${sweep.error}` : "") +
        ` (nothing written; the balance is still in the token)`,
    );
    return;
  }

  // The token is back in SOL — or there was nothing worth selling. Close the emptied ATA so
  // its rent comes home too — best effort: a failure here is not worth unwinding a confirmed
  // sale over.
  let ataSignature: string | null = null;
  if (sweep.state === "swept" && sweep.mint) {
    try {
      const tokenProgram = await tokenProgramOf(conn, auth.wallet, sweep.mint);
      const closed = await closeEmptyTokenAccount(auth, { mint: sweep.mint, tokenProgram });
      if (closed.state === "closed") {
        ataSignature = closed.signature;
        console.log(`ATA id=${row.id} closed ${sweep.mint} (rent returned, ${ataSignature})`);
      } else {
        console.log(
          `ATA id=${row.id} left alone (${closed.state}${closed.state === "not-empty" ? ` ${closed.amount}` : ""}) — token is sold`,
        );
      }
    } catch (err) {
      console.log(`ATA id=${row.id} not closed: ${(err as Error).message} — rent stays, token is sold`);
    }
  }

  const after = await conn.getBalance(auth.wallet);
  const recorded = recordSweep(row, sweep, after, ataSignature);
  const outcome =
    sweep.state === "swept"
      ? `SOLD ${label} sig=${sweep.signature} ~${sol(sweep.estimatedLamports ?? 0)} SOL`
      : `DUST ${label} ${sweep.amount ?? "0"} base units — nothing worth selling`;
  console.log(`${outcome} | wallet ${sol(after)} SOL | ${recorded}`);
}

(async () => {
  const rows = eligibleRows();
  if (rows.length === 0) {
    console.log("NO UNSETTLED ROWS — every live close's residual token is settled");
    return;
  }
  const auth = (() => {
    try {
      return authorizeExecution();
    } catch (err) {
      console.error(`NOT ARMED: ${(err as Error).message}`);
      process.exit(1);
    }
  })();
  console.log(
    `${rows.length} unsettled row(s) | mode ${EXECUTE ? "EXECUTE — will sign and send" : "DRY RUN — nothing signed"} | db ${DB}`,
  );
  for (const row of rows) {
    try {
      await retryRow(row, auth);
    } catch (err) {
      // One bad row must not stop the others, and must never look like a clean run.
      console.log(`FAILED id=${row.id} ${row.pair_name} — unexpected: ${(err as Error).message}`);
    }
  }
})();
