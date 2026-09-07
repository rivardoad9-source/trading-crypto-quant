// One-off: close the orphaned empty DLMM position account 6MdbD6... (STONK-SOL pool)
// to recover its 0.2657 SOL rent. Position has ZERO liquidity (funding never landed),
// so plain closePosition2 is valid — no removeLiquidity step needed.
const fs = require('fs');
const bs58 = require('bs58').default;
const {
  Connection, PublicKey, ComputeBudgetProgram, Keypair,
} = require('@solana/web3.js');

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const POOL = 'zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX';
const POSITION = '6MdbD6GjaM49fm7fQTwnvyZUVfbjgogbAkVuVEu5MURs';

(async () => {
  const conn = new Connection(env.SOLANA_RPC_URL, 'confirmed');

  // Wallet keypair (base58 or JSON-array secret in SOLANA_PRIVATE_KEY). Never printed.
  let secret;
  try { secret = bs58.decode(env.SOLANA_PRIVATE_KEY.trim()); }
  catch { secret = Uint8Array.from(JSON.parse(env.SOLANA_PRIVATE_KEY)); }
  const wallet = Keypair.fromSecretKey(secret);
  console.log('wallet:', wallet.publicKey.toBase58());

  const before = await conn.getBalance(wallet.publicKey);
  console.log('SOL before:', (before / 1e9).toFixed(6));

  // CJS build: require() returns the DLMM class directly (no ESM directory-import issue).
  const DLMM = require('@meteora-ag/dlmm');
  const pool = await DLMM.create(conn, new PublicKey(POOL));

  const { userPositions } = await pool.getPositionsByUserAndLbPair(wallet.publicKey);
  const pos = userPositions.find((p) => p.publicKey.toBase58() === POSITION);
  if (!pos) {
    console.log('POSITION NOT FOUND under wallet — nothing to close (already gone?).');
    process.exit(1);
  }
  console.log('position found:', pos.publicKey.toBase58());

  const tx = await pool.closePosition({ owner: wallet.publicKey, position: pos });
  // Modest priority fee so the close doesn't sit in the queue.
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }));
  tx.sign(wallet);

  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  console.log('submitted:', sig);
  const res = await conn.confirmTransaction({
    signature: sig,
    blockhash: tx.recentBlockhash,
    lastValidBlockHeight: tx.lastValidBlockHeight,
  }, 'confirmed');
  if (res.value.err) { console.error('CONFIRM ERROR:', res.value.err); process.exit(1); }
  console.log('CONFIRMED ✓');

  const after = await conn.getBalance(wallet.publicKey);
  console.log('SOL after:', (after / 1e9).toFixed(6));
  console.log('recovered:', ((after - before) / 1e9).toFixed(6), 'SOL');

  const gone = await conn.getAccountInfo(new PublicKey(POSITION));
  console.log('position account still exists:', gone !== null);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
