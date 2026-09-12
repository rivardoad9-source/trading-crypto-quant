// OPS SCRIPT, RUN BY AN OPERATOR: record what a FAILED live attempt ACTUALLY cost, after the
// capital it stranded has been recovered — instead of deleting the attempt to clear the breaker.
//
// WHY THIS EXISTS (12 Sep 2026)
// -----------------------------
// `FailedCostBreakerError` (src/services/liveExecution.ts:897) refuses new entries while the
// SOL that left the wallet on failed attempts exceeds `LIVE_MAX_FAILED_COST_SOL` over
// `LIVE_FAILED_COST_WINDOW_HOURS`. It reads `SUM(cost_lamports) WHERE outcome = 'failed'`
// (`sumFailedAttemptCost`).
//
// That number is written the moment an open fails, when the wallet really has lost the money:
// on 12 Sep 2026 attempt id 2 recorded 1.802543 SOL and it was true — the swap had spent, the
// deposit had half-landed and the auto-unwind had failed. Ten minutes later the operator closed
// the funded position by hand and sold the residual token: 1.787727 SOL came back, and the
// episode's REAL cost was 0.014816 SOL. Nothing in the schema could say that, so the breaker
// kept reading 1.802543 SOL and kept entries shut until the 24 h window aged out.
//
// The repository already has `clearLiveExecutionAttempts()` for this — "releasing the hold IS
// forgetting the spend" — but deleting the row forgets the incident too. This script keeps the
// row (the failure stays visible, with its reason text) and REPLACES the provisional cost with
// the MEASURED one.
//
// IT REFUSES TO RUN without proof that the recovery happened: the position account must be gone
// from the chain and the wallet must no longer hold the paired token. Without that check this
// would be a way to talk the breaker down while capital is still stranded.
//
// DRY RUN IS THE DEFAULT; writing needs `--execute`. Database only — no key, no transaction.
// Back up the database first (`cp data/flowmetrix.db /tmp/`).
//
//   node scripts/settleRecoveredAttempt.cjs --id 2 --after-lamports 2946203635
//   node scripts/settleRecoveredAttempt.cjs --id 2 --after-lamports 2946203635 -- --execute
//
// `cost_lamports` is DERIVED (row.wallet_lamports_before − after), never passed in: the operator
// supplies the balance they measured, which is the part that cannot be inferred.
const fs = require('fs');
const path = require('path');

function envDatabasePath() {
  try {
    const line = fs.readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('DATABASE_PATH='));
    return line ? line.slice('DATABASE_PATH='.length).trim() : undefined;
  } catch {
    return undefined;
  }
}

async function chainIsClean(poolAddress, positionAddress, mint, walletAddress) {
  const bs58 = require('bs58').default ?? require('bs58');
  const { Connection, PublicKey } = require('@solana/web3.js');
  const env = Object.fromEntries(
    fs
      .readFileSync('.env', 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  const conn = new Connection(env.SOLANA_RPC_URL || env.HELIUS_RPC_URL, 'confirmed');
  const owner = new PublicKey(walletAddress ?? env.SOLANA_WALLET_ADDRESS);
  const problems = [];

  const account = await conn.getAccountInfo(new PublicKey(positionAddress));
  if (account !== null) {
    problems.push(`position ${positionAddress} STILL EXISTS on-chain (${account.lamports} lamports)`);
  }

  if (mint) {
    const accounts = await conn.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });
    const held = accounts.value.find(
      (a) => a.account.data.parsed.info.mint === mint && Number(a.account.data.parsed.info.tokenAmount.amount) > 0,
    );
    if (held) {
      problems.push(`wallet still holds ${held.account.data.parsed.info.tokenAmount.uiAmountString} of ${mint}`);
    }
  }
  return problems;
}

async function main() {
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
    console.error('--id <live_execution_attempts.id> is required.');
    process.exit(1);
  }
  if (!Number.isSafeInteger(afterLamports) || afterLamports <= 0) {
    console.error('--after-lamports <integer> is required: the MEASURED post-recovery wallet balance.');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: !EXECUTE });
  const row = db.prepare(`SELECT * FROM live_execution_attempts WHERE id = ?`).get(id);
  if (!row) {
    console.error(`No live_execution_attempts row with id ${id}.`);
    process.exit(1);
  }

  const sol = (l) => (typeof l === 'number' ? (l / 1e9).toFixed(9) : 'NULL');
  console.log(
    `live_execution_attempts ${row.id} ${row.pair_name} — outcome ${row.outcome}, stage ${row.stage}, ` +
      `attempted ${row.attempted_at}`,
  );
  console.log(`  wallet_lamports_before   ${sol(row.wallet_lamports_before)} SOL`);
  console.log(`  wallet_lamports_after    ${sol(row.wallet_lamports_after)} SOL (current)`);
  console.log(`  cost_lamports            ${row.cost_lamports ?? 'NULL'} (current)`);
  console.log(`  unwind                   ${row.unwind}`);

  const refusals = [];
  if (row.outcome !== 'failed') refusals.push(`the row is not a failed attempt (outcome ${row.outcome})`);
  if (!['orphan', 'unknown'].includes(String(row.unwind))) {
    refusals.push(`unwind is '${row.unwind}', so no stranded capital is recorded against this row`);
  }
  if (!Number.isSafeInteger(row.wallet_lamports_before)) {
    refusals.push('wallet_lamports_before is missing, so the cost cannot be derived');
  }
  if (!row.position_address) refusals.push('the row names no position address to verify against the chain');
  if (afterLamports > (row.wallet_lamports_before ?? 0)) {
    refusals.push(
      `the measured balance (${sol(afterLamports)}) is HIGHER than the pre-attempt balance ` +
        `(${sol(row.wallet_lamports_before)}) — that is a top-up, not a recovery`,
    );
  }
  if (refusals.length > 0) {
    console.error(`REFUSED: ${refusals.join('; ')}.`);
    process.exit(1);
  }

  const cost = Math.round(row.wallet_lamports_before - afterLamports);
  console.log(`  -> cost_lamports ${cost} (${sol(cost)} SOL of real cost), unwind 'clean',`);
  console.log(`     wallet_lamports_after ${sol(afterLamports)} SOL`);

  for (const problem of await chainIsClean(row.pool_address, row.position_address, row.token_mint)) {
    console.error(`REFUSED: ${problem}. The recovery is not finished — this row is telling the truth.`);
    process.exit(1);
  }
  console.log('  -> chain check: position account gone, no paired token left. Recovery is real.');

  const window = Number(
    (fs.readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('LIVE_FAILED_COST_WINDOW_HOURS=')) ?? '')
      .split('=')[1] ?? 24,
  );
  const budget = Number(
    (fs.readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('LIVE_MAX_FAILED_COST_SOL=')) ?? '')
      .split('=')[1] ?? 0.05,
  );
  const spent = () =>
    db
      .prepare(
        `SELECT COALESCE(SUM(cost_lamports), 0) AS lamports FROM live_execution_attempts
          WHERE outcome = 'failed' AND datetime(attempted_at) >= datetime('now', ?)`,
      )
      .get(`-${window} hours`).lamports;
  console.log(
    `  -> breaker before: ${sol(spent())} SOL spent on failed attempts in ${window}h ` +
      `(budget ${budget} SOL) -> ${spent() / 1e9 > budget ? 'ENTRIES SHUT' : 'entries allowed'}`,
  );

  if (!EXECUTE) {
    console.log('DRY RUN — nothing written. Re-run with `-- --execute` to write it.');
    db.close();
    return;
  }

  const changed = db
    .prepare(
      `UPDATE live_execution_attempts
          SET cost_lamports = ?, wallet_lamports_after = ?, unwind = 'clean'
        WHERE id = ? AND outcome = 'failed' AND COALESCE(unwind, 'unknown') IN ('orphan', 'unknown')`,
    )
    .run(cost, afterLamports, id);
  console.log(`WRITTEN: ${changed.changes} row(s).`);
  console.log(
    `  -> breaker after: ${sol(spent())} SOL spent on failed attempts in ${window}h ` +
      `(budget ${budget} SOL) -> ${spent() / 1e9 > budget ? 'ENTRIES SHUT' : 'entries allowed'}`,
  );
  db.close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`ERR: ${e.message}`);
    process.exit(1);
  });
}
