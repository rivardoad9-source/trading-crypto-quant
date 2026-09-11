// ONE-OFF, RUN BY AN OPERATOR: record that a LIVE close's residual token was sold BY HAND,
// and the wallet balance measured once that sale landed — in BOTH books.
//
// Written for the 11 Sep 2026 MANLET-SOL row (`simulated_positions.id = 4`), closed by a
// build that did not yet sweep the paired token. Its `wallet_lamports_after`
// (1.700338862 SOL) was read with ~0.84 SOL of MANLET still unsold AND at `finalized`
// commitment, before the final close transaction (+0.415963 SOL) had finalized — so the
// reconciliation reads it as "$-117.68". The engine itself no longer uses that figure: a
// row with `residual_sweep` NULL is reported NOT SETTLED and excluded. This script is only
// for an operator who wants the trade reconciled, and it records the fix as `operator`, so
// the report can always tell a human's number from the engine's.
//
// THE SECOND BOOK. The first version updated `simulated_positions` only, and the matching
// `live_execution_attempts` row (outcome `opened`) kept `wallet_lamports_after` and
// `cost_lamports` NULL — two books disagreeing about the one trade that actually closed.
// It now updates that row too, but only when exactly ONE row can be matched with confidence
// (see `findAttempt`). Anything less is reported and NOT written.
//
// Nothing here is derived. YOU supply the after-balance, from the chain, and you are
// responsible for it meaning "the wallet once the close AND the manual sale had both
// landed, with nothing else moving SOL in between". For MANLET-SOL the wallet-flow
// reconstruction gives 2.961020 SOL after the 08:58:25Z sale — check that against an
// explorer before using it.
//
// DRY RUN IS THE DEFAULT; writing needs `--execute`. It touches the DATABASE only — no key,
// no RPC, no transaction. Back up the database first (`cp data/flowmetrix.db data/backups/`).
// Idempotent: re-running with the same balance changes nothing and says so.
//
//   node scripts/settleResidualByHand.cjs --id 4 --after-lamports 2961019685
//   node scripts/settleResidualByHand.cjs --id 4 --after-lamports 2961019685 --execute
//   (optional) --db <path>  default: DATABASE_PATH from .env, else ./data/flowmetrix.db
//
// It REFUSES: a row that is not LIVE, not closed, or already settled by the engine
// (`swept` / `dust`) — a measured engine figure is never overwritten by hand.
const fs = require('fs');
const path = require('path');

/**
 * The window, either side of the position's `opened_at`, inside which an `opened` attempt
 * is accepted by the FALLBACK match. The attempt row is written by `openLivePosition` the
 * moment the open confirms and the position row immediately after, so they are seconds
 * apart; 15 minutes tolerates a slow bookkeeping path without reaching the next cycle's
 * attempt (the screener runs every 30 minutes).
 */
const FALLBACK_WINDOW_MINUTES = 15;

/**
 * Finds the `live_execution_attempts` row describing this position's OPEN.
 *
 *  1. By `position_address`, with `outcome = 'opened'`. The address is unique per position
 *     and is written on both rows, so a match here is exact.
 *  2. Only when the position row has NO address: same `pool_address` AND `pair_name`, with
 *     `attempted_at` within FALLBACK_WINDOW_MINUTES of `opened_at`. The pool is required
 *     because pair names collide (memecoin tickers do); the name is required as a second,
 *     human-readable check; the window because one pool can be attempted many times.
 *
 * Exactly ONE candidate is a match. Zero or several is `null` with the reason — a guess
 * would write a cost onto the wrong attempt, which is worse than leaving it unmeasured.
 */
function findAttempt(db, position) {
  if (position.position_address) {
    const rows = db
      .prepare(
        `SELECT * FROM live_execution_attempts
          WHERE outcome = 'opened' AND position_address = ?`,
      )
      .all(position.position_address);
    if (rows.length === 1) return { attempt: rows[0], via: 'position_address', reason: null };
    return {
      attempt: null,
      via: 'position_address',
      reason: `${rows.length} 'opened' attempts carry position_address ${position.position_address}`,
    };
  }

  const rows = db
    .prepare(
      `SELECT * FROM live_execution_attempts
        WHERE outcome = 'opened' AND pool_address = ? AND pair_name = ?
          AND ABS(julianday(attempted_at) - julianday(?)) * 1440 <= ?`,
    )
    .all(position.pool_address, position.pair_name, position.opened_at, FALLBACK_WINDOW_MINUTES);
  if (rows.length === 1) return { attempt: rows[0], via: 'pool+pair+window', reason: null };
  return {
    attempt: null,
    via: 'pool+pair+window',
    reason:
      `${rows.length} 'opened' attempts on pool ${position.pool_address} (${position.pair_name}) ` +
      `within ${FALLBACK_WINDOW_MINUTES} min of ${position.opened_at}`,
  };
}

/** What the attempt row WILL look like. Cost follows `attemptCostLamports`: null if a read is missing. */
function planAttemptUpdate(attempt, afterLamports) {
  const before = attempt.wallet_lamports_before;
  const cost = typeof before === 'number' ? Math.round(before - afterLamports) : null;
  // The residual was sold back to SOL (by a human): nothing of value is left holding the
  // token the balancing swap bought, which is what `clean` asserts.
  const unwind = attempt.unwind === 'none' || attempt.unwind === 'unknown' || attempt.unwind === null
    ? 'clean'
    : attempt.unwind;
  const unchanged =
    attempt.wallet_lamports_after === afterLamports &&
    attempt.cost_lamports === cost &&
    attempt.unwind === unwind;
  return { walletLamportsAfter: afterLamports, costLamports: cost, unwind, unchanged };
}

function envDatabasePath() {
  try {
    const line = fs.readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('DATABASE_PATH='));
    return line ? line.slice('DATABASE_PATH='.length).trim() : undefined;
  } catch {
    return undefined;
  }
}

function main() {
  const Database = require('better-sqlite3');
  const argv = process.argv.slice(2);
  const EXECUTE = argv.includes('--execute');
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    const value = i >= 0 ? argv[i + 1] : undefined;
    return value && !value.startsWith('--') ? value : undefined;
  };

  const id = Number(arg('id'));
  const afterLamports = Number(arg('after-lamports'));
  const dbPath = path.resolve(arg('db') ?? envDatabasePath() ?? './data/flowmetrix.db');

  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error('--id <simulated_positions.id> is required (an integer row id).');
    process.exit(1);
  }
  if (!Number.isSafeInteger(afterLamports) || afterLamports <= 0) {
    console.error('--after-lamports <integer> is required: the MEASURED wallet balance in lamports.');
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: !EXECUTE });
  const columns = db.prepare(`PRAGMA table_info(simulated_positions)`).all().map((c) => c.name);
  if (!columns.includes('residual_sweep')) {
    // Added by `initDatabase()`'s migration in the build that ships the sweep. Adding it from
    // here would put a schema change outside db.ts, which is where CLAUDE.md says they live.
    console.error('The database has no residual_sweep column yet: deploy and start the build that adds it first.');
    process.exit(1);
  }
  const row = db.prepare(`SELECT * FROM simulated_positions WHERE id = ?`).get(id);

  if (!row) {
    console.error(`No simulated_positions row with id ${id}.`);
    process.exit(1);
  }

  const sol = (l) => (typeof l === 'number' ? (l / 1e9).toFixed(9) : 'NULL');
  console.log(`simulated_positions ${row.id} ${row.pair_name} — ${row.status}, closed ${row.closed_at}, close ${row.close_signature}`);
  console.log(`  model realized_pnl_usd     ${row.realized_pnl_usd}`);
  console.log(`  wallet_lamports_before     ${sol(row.wallet_lamports_before)} SOL`);
  console.log(`  wallet_lamports_after      ${sol(row.wallet_lamports_after)} SOL (current)`);
  console.log(`  residual_sweep             ${row.residual_sweep ?? 'NULL (closed before the sweep existed)'}`);

  const refusals = [];
  if (row.execution_mode !== 'LIVE') refusals.push('the row is not LIVE');
  if (!row.closed_at) refusals.push('the row is not closed');
  if (row.residual_sweep === 'swept' || row.residual_sweep === 'dust') {
    refusals.push(`the engine already settled it (${row.residual_sweep}); its measured figure is not overwritten by hand`);
  }
  if (refusals.length > 0) {
    console.error(`REFUSED: ${refusals.join('; ')}.`);
    process.exit(1);
  }

  const positionUnchanged =
    row.wallet_lamports_after === afterLamports && row.residual_sweep === 'operator';
  console.log(
    positionUnchanged
      ? `  -> unchanged (already wallet_lamports_after ${sol(afterLamports)} SOL, residual_sweep 'operator')`
      : `  -> wallet_lamports_after  ${sol(afterLamports)} SOL, residual_sweep = 'operator'`,
  );
  if (typeof row.wallet_lamports_before === 'number') {
    const deltaSol = (afterLamports - row.wallet_lamports_before) / 1e9;
    const usd = typeof row.entry_sol_price_usd === 'number' ? deltaSol * row.entry_sol_price_usd : null;
    console.log(
      `  -> chain delta ${deltaSol.toFixed(9)} SOL` +
        (usd === null ? '' : ` = $${usd.toFixed(2)} at entry SOL/USD, against model $${row.realized_pnl_usd}`),
    );
  }

  const match = findAttempt(db, row);
  let plan = null;
  if (match.attempt) {
    const a = match.attempt;
    plan = planAttemptUpdate(a, afterLamports);
    console.log(`live_execution_attempts ${a.id} (matched by ${match.via}) — outcome ${a.outcome}, attempted ${a.attempted_at}`);
    console.log(`  wallet_lamports_before     ${sol(a.wallet_lamports_before)} SOL`);
    console.log(`  wallet_lamports_after      ${sol(a.wallet_lamports_after)} SOL (current)`);
    console.log(`  cost_lamports              ${a.cost_lamports ?? 'NULL'} (current)`);
    console.log(`  unwind                     ${a.unwind} (current)`);
    console.log(
      plan.unchanged
        ? '  -> unchanged'
        : `  -> wallet_lamports_after ${sol(plan.walletLamportsAfter)} SOL, cost_lamports ` +
            `${plan.costLamports ?? 'NULL (no before-balance)'}${plan.costLamports !== null && plan.costLamports < 0 ? ' (negative: the trade made SOL)' : ''}, unwind '${plan.unwind}'`,
    );
  } else {
    console.log(`live_execution_attempts: NO CONFIDENT MATCH (${match.reason}) — that table will NOT be written.`);
  }

  if (!EXECUTE) {
    console.log('DRY RUN — nothing written. Re-run with --execute to write it.');
    process.exit(0);
  }

  const write = db.transaction(() => {
    const p = db.prepare(
      `UPDATE simulated_positions
          SET wallet_lamports_after = ?, residual_sweep = 'operator'
        WHERE id = ? AND execution_mode = 'LIVE' AND closed_at IS NOT NULL
          AND (residual_sweep IS NULL OR residual_sweep NOT IN ('swept', 'dust'))`,
    ).run(afterLamports, id);
    let a = { changes: 0 };
    if (match.attempt && plan && !plan.unchanged) {
      a = db.prepare(
        `UPDATE live_execution_attempts
            SET wallet_lamports_after = ?, cost_lamports = ?, unwind = ?
          WHERE id = ? AND outcome = 'opened'`,
      ).run(plan.walletLamportsAfter, plan.costLamports, plan.unwind, match.attempt.id);
    }
    return { position: p.changes, attempt: a.changes };
  });
  const changed = write();
  console.log(
    `WRITTEN: simulated_positions ${changed.position} row(s), live_execution_attempts ${changed.attempt} row(s).`,
  );
  db.close();
}

if (require.main === module) main();

module.exports = { findAttempt, planAttemptUpdate, FALLBACK_WINDOW_MINUTES };
