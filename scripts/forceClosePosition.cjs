// Force-close a position account by pubkey even if the SDK's position listing misses it.
const fs = require('fs');
const bs58 = require('bs58').default;
const { Connection, PublicKey, ComputeBudgetProgram, Keypair } = require('@solana/web3.js');
const POOL = process.argv[2], POSITION = process.argv[3];
const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
(async () => {
  const conn = new Connection(env.SOLANA_RPC_URL, 'confirmed');
  let secret; try { secret = bs58.decode(env.SOLANA_PRIVATE_KEY.trim()); } catch { secret = Uint8Array.from(JSON.parse(env.SOLANA_PRIVATE_KEY)); }
  const wallet = Keypair.fromSecretKey(secret);
  const posKey = new PublicKey(POSITION);
  const info = await conn.getAccountInfo(posKey);
  if (!info) { console.log('account already gone — nothing to close.'); process.exit(0); }
  console.log('account exists:', info.lamports / 1e9, 'SOL | owner:', info.owner.toBase58().slice(0, 12) + '...');
  const before = await conn.getBalance(wallet.publicKey);
  const DLMM = require('@meteora-ag/dlmm');
  const pool = await DLMM.create(conn, new PublicKey(POOL));
  const tx = await pool.closePosition({ owner: wallet.publicKey, position: { publicKey: posKey } });
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }));
  tx.sign(wallet);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 2 });
  console.log('submitted:', sig);
  const res = await conn.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight }, 'confirmed');
  if (res.value.err) { console.error('CONFIRM ERROR:', JSON.stringify(res.value.err).slice(0, 200)); process.exit(1); }
  const after = await conn.getBalance(wallet.publicKey);
  console.log('CONFIRMED — SOL:', (before / 1e9).toFixed(6), '->', (after / 1e9).toFixed(6), '| recovered:', ((after - before) / 1e9).toFixed(6));
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
