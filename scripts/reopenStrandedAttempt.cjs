// ONE-OFF, RUN BY AN OPERATOR: re-open a failed live attempt whose engine verdict says the
// stranded token was recovered, when the CHAIN says otherwise.
//
// WHY THIS EXISTS (18 Sep 2026, KNOTS-SOL attempt id 11 — the fourth time this pool did it)
// ---------------------------------------------------------------------------------------
// The failed-open path (`openLivePosition`'s catch) classifies the attempt `clean` whenever the
// auto-unwind swap was SUBMITTED — `classifyUnwind`: `rescueSignature !== null -> "clean"`.
// But the sale amount comes from a balance read taken after the orphan withdrawal was sent, and
// a node that has not yet seen the withdrawal answers with the PRE-withdrawal balance. The swap
// then sells exactly that much and leaves the rest behind:
//
//   attempt id 11: 3,979.209942 KNOTS bought; the withdrawal returned 1,763.991215 more back to
//   the wallet; the unwind sold 2,157.005388 (the stale figure) -> 1,763.991215 KNOTS (~0.37 SOL)
//   sat in the wallet, the row was written `unwind='clean'`, and `cost_lamports` counted the
//   unsold token as pure loss (0.461917 SOL instead of 0.095 SOL of real cost).
//
// The consequence is not only the stranded token: `cost_lamports` feeds `FailedCostBreakerError`,
// so a 0.46 SOL "loss" that was never a loss shut entries for 24 h against a 0.15 SOL budget.
//
// That row is invisible to every recovery path there is, because they all trust `unwind`:
// `retryResidualSweep.ts` selects `unwind='orphan'`, `healAttemptResidual` refuses anything else,
// `planSettlement` refuses anything else. A wrong verdict therefore does not page a human — it
// makes the incident look settled. This script is the one place that can put it back.
//
// WHAT IT PROVES BEFORE IT TOUCHES THE ROW. It asks the chain, not the engine: the position
// account must be GONE (a funded one belongs to `scripts/recoverFundedOrphan.ts`) and the wallet
// must still HOLD the paired token. Both facts come from `settleRecoveredAttempt.cjs`'s own
// `chainIsClean`, so this script cannot disagree with the tool that will sell the token next:
//
//   * chain clean                  -> REFUSED (the engine was right; nothing to re-open)
//   * position still exists        -> REFUSED (recoverFundedOrphan.ts's job)
//   * wallet still holds the token -> PROCEED: unwind 'clean' -> 'orphan'
//
// It writes ONE column and nothing else. It does not sell, it does not settle a cost — the
// engine's own self-heal (`scripts/retryResidualSweep.ts --attempt-id`, run every 2 min) then
// sells the balance and settles `cost_lamports` from the measured wallet, which is what releases
// the breaker with a number that is true.
//
// DRY RUN IS THE DEFAULT; writing needs `--execute`. Database + chain reads only — no key, no
// transaction. Back up the database first (`cp data/flowmetrix.db data/backups/`).
//
//   node scripts/reopenStrandedAttempt.cjs --id 11
//   node scripts/reopenStrandedAttempt.cjs --id 11 -- --execute
const fs = require('fs');
const path = require('path');

const { chainIsClean } = require('./settleRecoveredAttempt.cjs');

function envDatabasePath() {
  try {
    const line = fs.readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('DATABASE_PATH='));
    return line ? line.slice('DATABASE_PATH='.length).trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Which of `chainIsClean`'s problems say the position itself is still there. */
const POSITION_STILL_EXISTS = /STILL EXISTS/;
/** ...and which say the wallet still holds the paired token. */
const WALLET_HOLDS = /wallet still holds/;

/**
 * Whether a row may be re-opened, and why not. PURE — the chain problems are passed in, so the
 * whole decision is readable without an RPC.
 */
function planReopen(row, problems) {
  const refusals = [];
  if (row.outcome !== 'failed') refusals.push(`the row is not a failed attempt (outcome ${row.outcome})`);
  const unwind = row.unwind === null || row.unwind === undefined ? 'NULL' : String(row.unwind);
  if (unwind === 'orphan') {
    refusals.push("unwind is already 'orphan' — the self-heal owns this row, nothing to re-open");
  }
  if (!row.position_address) {
    refusals.push('the row names no position address, so the chain cannot be asked about it');
  }
  if (problems.some((p) => POSITION_STILL_EXISTS.test(p))) {
    refusals.push(`the position is still on-chain (${problems.find((p) => POSITION_STILL_EXISTS.test(p))}) — a funded orphan is scripts/recoverFundedOrphan.ts's job`);
  }
  const held = problems.filter((p) => WALLET_HOLDS.test(p));
  if (problems.length === 0) {
    refusals.push("the chain is clean: no position and no paired token left — the engine's verdict is correct");
  }
  if (problems.length > 0 && held.length === 0) {
    refusals.push(`the chain reports a problem this script cannot act on: ${problems.join('; ')}`);
  }
  return { refusals, stranded: held.join('; '), unwind };
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
  const dbPath = path.resolve(arg('db') ?? envDatabasePath() ?? './data/flowmetrix.db');
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error('--id <live_execution_attempts.id> is required (an integer row id).');
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: !EXECUTE });
  const row = db.prepare(`SELECT * FROM live_execution_attempts WHERE id = ?`).get(id);
  if (!row) {
    console.error(`No live_execution_attempts row with id ${id}.`);
    process.exit(1);
  }

  const sol = (l) => (typeof l === 'number' ? (l / 1e9).toFixed(9) : 'NULL');
  console.log(`live_execution_attempts ${row.id} ${row.pair_name} — outcome ${row.outcome}, attempted ${row.attempted_at}`);
  console.log(`  unwind                   ${row.unwind}`);
  console.log(`  cost_lamports            ${row.cost_lamports ?? 'NULL'}${typeof row.cost_lamports === 'number' ? ` (${sol(row.cost_lamports)} SOL)` : ''}`);
  console.log(`  wallet_lamports_before   ${sol(row.wallet_lamports_before)} SOL`);
  console.log(`  wallet_lamports_after    ${sol(row.wallet_lamports_after)} SOL (as recorded)`);
  console.log(`  position_address         ${row.position_address ?? 'NULL'}`);
  console.log(`  token_mint               ${row.token_mint ?? 'NULL'}`);
  console.log('  -> asking the chain (the engine\'s own proof, scripts/settleRecoveredAttempt.cjs)');

  chainIsClean(row.pool_address, row.position_address, row.token_mint)
    .then((problems) => {
      console.log(
        problems.length === 0
          ? '  -> chain: position account gone, wallet holds none of the token (CLEAN)'
          : problems.map((p) => `  -> chain: ${p}`).join('\n'),
      );
      const plan = planReopen(row, problems);
      if (plan.refusals.length > 0) {
        console.error(`REFUSED: ${plan.refusals.join('; ')}.`);
        db.close();
        process.exit(1);
      }

      console.log(`  -> ${plan.stranded} — the engine called this row '${plan.unwind}' while the token is still in the wallet.`);
      console.log(`  -> unwind '${plan.unwind}' -> 'orphan', cost_lamports left alone (the self-heal settles it from the measured wallet after the sale).`);
      console.log(`  -> next: scripts/retryResidualSweep.ts --attempt-id ${row.id} (or the 2-minute self-heal cron) sells it and writes the real cost, which is what releases the failed-cost breaker.`);

      if (!EXECUTE) {
        console.log('DRY RUN — nothing written. Re-run with `-- --execute` to re-open the row.');
        db.close();
        return;
      }

      const changed = db
        .prepare(
          `UPDATE live_execution_attempts
              SET unwind = 'orphan'
            WHERE id = ? AND outcome = 'failed' AND COALESCE(unwind, 'unknown') <> 'orphan'`,
        )
        .run(id).changes;
      console.log(`WRITTEN: live_execution_attempts ${changed} row(s).`);
      db.close();
      if (changed !== 1) {
        console.error('Nothing was written — the row changed underneath us (already re-opened?).');
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`ERR: ${err.message}`);
      db.close();
      process.exit(1);
    });
}

if (require.main === module) main();

module.exports = { planReopen };
