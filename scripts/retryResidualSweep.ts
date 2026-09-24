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
 *
 * FAILED OPENS TOO (15 Sep 2026, LEVERCAT-SOL — the third time)
 * -------------------------------------------------------------
 * A failed open whose auto-unwind could not sell leaves the token in the wallet, a
 * `live_execution_attempts` row with `outcome='failed'`, `unwind='orphan'`, and NO position row —
 * so this tool never saw it, and ids 2, 5 and 10 were each recovered by a human. Those rows are
 * now selected as well (same `--max-age-hours`), decided by `src/services/attemptResidualHeal.ts`:
 * busy pool skipped; the position account must be ABSENT (a funded one is
 * `recoverFundedOrphan.ts`'s job); the pool's paired mint must be the row's; the sale is the SAME
 * `sweepResidualPairedToken` + `defaultResidualSweepDeps`; and the row is rewritten only through
 * `settleRecoveredAttempt.cjs`'s own proof (`chainIsClean`), refusals (`planSettlement`) and write
 * (`writeSettlement`) — `cost_lamports = wallet_lamports_before - balance now`, `unwind='clean'`.
 * It replaces the hand-run `scripts/sweepAttemptResidual.ts` (c93e413): one sell path.
 *
 *   node --env-file=.env --import tsx scripts/retryResidualSweep.ts --attempt-id 10              # plan one
 *   node --env-file=.env --import tsx scripts/retryResidualSweep.ts --attempt-id 10 -- --execute
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
  quoteResidualFromPool,
  sweepResidualPairedToken,
  RESIDUAL_DUST_LAMPORTS,
  type ResidualSweep,
} from "../src/services/liveExecution.js";
import { healAttemptResidual, type AttemptRowForHeal } from "../src/services/attemptResidualHeal.js";

/** The settle script's own proof, refusal rules and write — reused, not re-implemented. */
const settle = require("./settleRecoveredAttempt.cjs") as {
  chainIsClean(pool: string, position: string, mint: string | null, wallet: string, conn: unknown): Promise<string[]>;
  planSettlement(row: AttemptRowForHeal, afterLamports: number): { refusals: string[]; cost: number | null };
  writeSettlement(db: unknown, id: number, cost: number, after: number, extras: { rescueSignature: string | null; ataCloseSignature: string | null }): number;
};

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
const ONLY_ATTEMPT_ID = arg("attempt-id") ? Number(arg("attempt-id")) : null;
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
    let estimated: number;
    try {
      estimated = await deps.quoteToSol(mint, balance);
    } catch (err) {
      /*
       * THE SWEEP ANSWERS THIS CASE ITSELF (21 Sep 2026): Jupiter may have no route for a
       * transfer-fee crumb while the pool the position just left still prices it — the sweep
       * settles exactly that as `dust` (the TIGRINO-SOL 15 base units). The plan must not report
       * as a broken row a crumb the sweep will settle, so it prices it the same way. Nothing is
       * signed on this path either way.
       */
      const poolQuote = await quoteResidualFromPool(deps, mint, balance);
      console.log(
        `PLAN ${label} mint=${mint} ${balance} base units — Jupiter has no route ` +
          `(${(err as Error).message})` +
          (poolQuote === null
            ? ", and the pool could not price it — re-run with -- --execute to try again"
            : `; the pool quotes ${sol(poolQuote)} SOL — ${
                poolQuote < RESIDUAL_DUST_LAMPORTS
                  ? "the sweep settles this as dust, nothing to sell"
                  : "re-run with -- --execute to sell it back"
              }`),
      );
      return;
    }
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

/* ------------------------------------------------------------------ */
/* Failed opens: attempt-level orphans                                 */
/* ------------------------------------------------------------------ */

function eligibleAttempts(): AttemptRowForHeal[] {
  const Database = require("better-sqlite3");
  const db = new Database(DB, { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, attempted_at, pair_name, pool_address, token_mint, outcome, unwind,
              position_address, wallet_lamports_before
         FROM live_execution_attempts
        WHERE outcome = 'failed' AND unwind = 'orphan'
          AND attempted_at >= datetime('now', ?)
          ${ONLY_ATTEMPT_ID === null ? "" : "AND id = ?"}
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(`-${MAX_AGE_HOURS} hours`, ...(ONLY_ATTEMPT_ID === null ? [] : [ONLY_ATTEMPT_ID]), MAX_ROWS) as AttemptRowForHeal[];
  db.close();
  return rows;
}

/**
 * The same two "do not race a live open" guards, for an attempt row. The row's OWN attempt is
 * excluded from the recent-attempt count: it is finished (its row is written at the very end of
 * the failed open, after recovery and unwind), and counting it would make the self-heal wait out
 * 15 minutes of a moving market for no safety gain. A NEWER attempt on the pool still blocks.
 */
function attemptBusyReason(row: AttemptRowForHeal): string | null {
  const Database = require("better-sqlite3");
  const db = new Database(DB, { readonly: true });
  try {
    const active = db
      .prepare(`SELECT COUNT(*) c FROM simulated_positions WHERE status = 'ACTIVE' AND execution_mode = 'LIVE' AND pool_address = ?`)
      .get(row.pool_address) as { c: number };
    if (active.c > 0) return `an ACTIVE position is open on this pool (${active.c})`;
    const recent = db
      .prepare(`SELECT COUNT(*) c FROM live_execution_attempts WHERE pool_address = ? AND id <> ? AND attempted_at >= datetime('now', ?)`)
      .get(row.pool_address, row.id, `-${BUSY_WINDOW_MINUTES} minutes`) as { c: number };
    if (recent.c > 0) return `the pool was attempted again in the last ${BUSY_WINDOW_MINUTES} min (${recent.c}) — it is busy`;
    return null;
  } finally {
    db.close();
  }
}

/**
 * What else could have moved the wallet since the attempt, making `before - now` not this
 * recovery's cost: another attempt, or a live position opened or closed after it. Entries are held
 * by `StrandedCapitalError` while this row says 'orphan', so on a healthy engine this is empty.
 */
function walletMovedSince(row: AttemptRowForHeal): string | null {
  const Database = require("better-sqlite3");
  const db = new Database(DB, { readonly: true });
  try {
    const attempts = db
      .prepare(`SELECT COUNT(*) c FROM live_execution_attempts WHERE id <> ? AND attempted_at > ?`)
      .get(row.id, row.attempted_at) as { c: number };
    const positions = db
      .prepare(
        `SELECT COUNT(*) c FROM simulated_positions
          WHERE execution_mode = 'LIVE' AND (opened_at > ? OR (closed_at IS NOT NULL AND closed_at > ?))`,
      )
      .get(row.attempted_at, row.attempted_at) as { c: number };
    const parts = [
      attempts.c > 0 ? `${attempts.c} later attempt(s)` : "",
      positions.c > 0 ? `${positions.c} live position(s) opened or closed since` : "",
    ].filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  } finally {
    db.close();
  }
}

async function healAttempt(row: AttemptRowForHeal, auth: ExecutionAuthorization): Promise<void> {
  const conn = getConnection();
  const { PublicKey } = await import("@solana/web3.js");
  const deps = defaultResidualSweepDeps(auth, row.pool_address);
  const label = `attempt id=${row.id} ${row.pair_name} (${row.attempted_at} UTC)`;

  if (!EXECUTE) {
    const busy = attemptBusyReason(row);
    if (busy) return console.log(`SKIPPED ${label} — ${busy}`);
    if (!row.position_address) return console.log(`REFUSED ${label} — no position address to verify`);
    if ((await conn.getAccountInfo(new PublicKey(row.position_address), "confirmed")) !== null) {
      return console.log(`SKIPPED ${label} — position ${row.position_address} EXISTS: use scripts/recoverFundedOrphan.ts`);
    }
    const mint = await deps.resolvePairedMint();
    if (row.token_mint && row.token_mint !== mint) return console.log(`REFUSED ${label} — pool mint ${mint} != row mint ${row.token_mint}`);
    const balance = await deps.readBalance(mint);
    if (balance === null) return console.log(`PLAN ${label} mint=${mint} balance=UNREADABLE (the sweep would page here)`);
    if (balance === 0n) return console.log(`PLAN ${label} mint=${mint} balance=0 — nothing to sell; re-run with -- --execute to settle the row`);
    const estimated = await deps.quoteToSol(mint, balance);
    return console.log(`PLAN ${label} mint=${mint} ${balance} base units ~= ${sol(estimated)} SOL — re-run with -- --execute to sell it back and settle the row`);
  }

  const outcome = await healAttemptResidual(row, {
    busyReason: () => attemptBusyReason(row),
    positionAccountExists: async (address) => (await conn.getAccountInfo(new PublicKey(address), "confirmed")) !== null,
    resolvePairedMint: () => deps.resolvePairedMint(),
    sweep: () => sweepResidualPairedToken({ pairName: row.pair_name, positionAddress: row.position_address ?? "none" }, deps),
    closeTokenAccount: async (mint) => closeEmptyTokenAccount(auth, { mint, tokenProgram: await tokenProgramOf(conn, auth.wallet, mint) }),
    readWalletLamports: async () => {
      try {
        return await conn.getBalance(auth.wallet, "confirmed");
      } catch {
        return null;
      }
    },
    walletMovedSince: () => walletMovedSince(row),
    proof: (mint) => settle.chainIsClean(row.pool_address, row.position_address!, mint, auth.wallet.toBase58(), conn),
    plan: (after) => settle.planSettlement(row, after),
    write: (cost, after, extras) => {
      const Database = require("better-sqlite3");
      const db = new Database(DB, { readonly: false });
      try {
        return settle.writeSettlement(db, row.id, cost, after, extras);
      } finally {
        db.close();
      }
    },
  });

  switch (outcome.kind) {
    case "skipped":
      return console.log(`SKIPPED ${label} — ${outcome.reason}`);
    case "refused":
      return console.log(`REFUSED ${label} — ${outcome.reason}`);
    case "sale-failed":
      return console.log(`FAILED ${label} — sweep '${outcome.sweep.state}': ${outcome.sweep.error ?? "?"} (nothing written; the capital is still in the token)`);
    case "sold-not-recorded":
      return console.log(
        `SOLD-NOT-RECORDED ${label} sweep=${outcome.sweep.state} sig=${outcome.sweep.signature ?? "none"} ` +
          `ata=${outcome.tokenAccount} wallet=${outcome.walletLamports === null ? "UNREAD" : sol(outcome.walletLamports)} — ${outcome.reason}. ` +
          `Settle by hand with scripts/settleRecoveredAttempt.cjs once resolved.`,
      );
    case "recorded":
      return console.log(
        `RECOVERED ${label} sweep=${outcome.sweep.state} sig=${outcome.sweep.signature ?? "none"}` +
          `${outcome.sweep.slippageBps ? ` at ${outcome.sweep.slippageBps} bps` : ""} ata=${outcome.tokenAccount} | ` +
          `wallet ${sol(outcome.walletLamports)} SOL | cost_lamports ${outcome.costLamports} (${sol(outcome.costLamports)} SOL), unwind clean`,
      );
  }
}

(async () => {
  const attempts = ONLY_ID === null ? eligibleAttempts() : [];
  const rows = ONLY_ATTEMPT_ID === null ? eligibleRows() : [];
  if (rows.length === 0 && attempts.length === 0) {
    console.log("NO UNSETTLED ROWS — every live close's residual token is settled, and no failed open holds stranded capital");
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
    `${rows.length} unsettled position row(s), ${attempts.length} failed-open attempt(s) | ` +
      `mode ${EXECUTE ? "EXECUTE — will sign and send" : "DRY RUN — nothing signed"} | db ${DB}`,
  );
  for (const row of rows) {
    try {
      await retryRow(row, auth);
    } catch (err) {
      // One bad row must not stop the others, and must never look like a clean run.
      console.log(`FAILED id=${row.id} ${row.pair_name} — unexpected: ${(err as Error).message}`);
    }
  }
  for (const attempt of attempts) {
    try {
      await healAttempt(attempt, auth);
    } catch (err) {
      console.log(`FAILED attempt id=${attempt.id} ${attempt.pair_name} — unexpected: ${(err as Error).message}`);
    }
  }
})();
