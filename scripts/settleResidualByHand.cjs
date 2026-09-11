// ONE-OFF, RUN BY AN OPERATOR: record that a LIVE close's residual token was sold BY HAND,
// and the wallet balance measured once that sale landed.
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
// Nothing here is derived. YOU supply the after-balance, from the chain, and you are
// responsible for it meaning "the wallet once the close AND the manual sale had both
// landed, with nothing else moving SOL in between". For MANLET-SOL the wallet-flow
// reconstruction gives 2.961020 SOL after the 08:58:25Z sale — check that against an
// explorer before using it.
//
// DRY RUN IS THE DEFAULT; writing needs `--execute`. It touches the DATABASE only — no key,
// no RPC, no transaction. Back up the database first (`cp data/flowmetrix.db data/backups/`).
//
//   node scripts/settleResidualByHand.cjs --id 4 --after-lamports 2961020000
//   node scripts/settleResidualByHand.cjs --id 4 --after-lamports 2961020000 --execute
//   (optional) --db <path>  default: DATABASE_PATH from .env, else ./data/flowmetrix.db
//
// It REFUSES: a row that is not LIVE, not closed, or already settled by the engine
// (`swept` / `dust`) — a measured engine figure is never overwritten by hand.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function envDatabasePath() {
  try {
    const line = fs.readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('DATABASE_PATH='));
    return line ? line.slice('DATABASE_PATH='.length).trim() : undefined;
  } catch {
    return undefined;
  }
}

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
const row = db.prepare(
  `SELECT id, pair_name, execution_mode, status, closed_at, realized_pnl_usd,
          entry_sol_price_usd, wallet_lamports_before, wallet_lamports_after,
          residual_sweep, close_signature
     FROM simulated_positions WHERE id = ?`,
).get(id);

if (!row) {
  console.error(`No simulated_positions row with id ${id}.`);
  process.exit(1);
}

const sol = (l) => (typeof l === 'number' ? (l / 1e9).toFixed(9) : 'NULL');
console.log(`row ${row.id} ${row.pair_name} — ${row.status}, closed ${row.closed_at}, close ${row.close_signature}`);
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

console.log(`  -> wallet_lamports_after  ${sol(afterLamports)} SOL, residual_sweep = 'operator'`);
if (typeof row.wallet_lamports_before === 'number') {
  const deltaSol = (afterLamports - row.wallet_lamports_before) / 1e9;
  const usd = typeof row.entry_sol_price_usd === 'number' ? deltaSol * row.entry_sol_price_usd : null;
  console.log(
    `  -> chain delta ${deltaSol.toFixed(9)} SOL` +
      (usd === null ? '' : ` = $${usd.toFixed(2)} at entry SOL/USD, against model $${row.realized_pnl_usd}`),
  );
}

if (!EXECUTE) {
  console.log('DRY RUN — nothing written. Re-run with --execute to write it.');
  process.exit(0);
}

const info = db.prepare(
  `UPDATE simulated_positions
      SET wallet_lamports_after = ?, residual_sweep = 'operator'
    WHERE id = ? AND execution_mode = 'LIVE' AND closed_at IS NOT NULL
      AND (residual_sweep IS NULL OR residual_sweep NOT IN ('swept', 'dust'))`,
).run(afterLamports, id);
console.log(info.changes === 1 ? 'WRITTEN.' : `NOT WRITTEN (${info.changes} rows changed).`);
db.close();
