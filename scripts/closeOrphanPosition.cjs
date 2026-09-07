// Closes an EMPTY DLMM position account and recovers its rent.
//
// Kept as the template for any future orphan the engine leaves behind - a
// funded-but-empty position account, which `DlmmPartialExecutionError` names when an
// open fails between creating the account and funding it.
//
// DRY RUN IS THE DEFAULT, and spending requires `-- --execute`. That is the same shape
// `scripts/testMicroSwap.ts` uses, and it is not decoration: this file loads a private
// key and signs, it is run by hand under time pressure after something has already gone
// wrong, and the first version signed and sent the moment it was invoked. A template is
// copied, so its defaults propagate.
//
//   node scripts/closeOrphanPosition.cjs --position <pubkey> --pool <pubkey> --owner <pubkey>
//   node scripts/closeOrphanPosition.cjs --position <pubkey> --pool <pubkey> --owner <pubkey> -- --execute
//
// It REFUSES to close a position holding liquidity: `closePosition` is only valid on an
// empty one, and running it against a funded position is a different operation
// (`removeLiquidity` with `shouldClaimAndClose`) that the engine performs itself.
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

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
}

// Defaults are the 7 Sep 2026 orphan, kept so the worked example stays runnable.
const POOL = arg('pool', 'zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX');
const POSITION = arg('position', '6MdbD6GjaM49fm7fQTwnvyZUVfbjgogbAkVuVEu5MURs');

(async () => {
  const conn = new Connection(env.SOLANA_RPC_URL, 'confirmed');

  /*
   * The secret key is loaded ONLY when actually executing. A dry run inspects the
   * position from the PUBLIC address, so it can be run anywhere - on a laptop, in a
   * review - without the key being present, let alone decoded into memory. The engine
   * follows the same split: `getWalletBalanceSol` takes SOLANA_WALLET_ADDRESS and never
   * derives a pubkey from the secret.
   */
  let signer = null;
  let owner;

  if (EXECUTE) {
    let secret;
    try { secret = bs58.decode(env.SOLANA_PRIVATE_KEY.trim()); }
    catch { secret = Uint8Array.from(JSON.parse(env.SOLANA_PRIVATE_KEY)); }
    signer = Keypair.fromSecretKey(secret);   // never printed, never returned
    owner = signer.publicKey;
  } else {
    const address = arg('owner', env.SOLANA_WALLET_ADDRESS);
    if (!address) {
      console.error('DRY RUN needs a public owner address.');
      console.error('Set SOLANA_WALLET_ADDRESS in .env, or pass --owner <pubkey>.');
      process.exit(1);
    }
    owner = new PublicKey(address);
  }

  console.log('wallet:', owner.toBase58());
  console.log('mode:', EXECUTE ? 'EXECUTE - will sign and send' : 'DRY RUN - nothing will be sent');

  const before = await conn.getBalance(owner);
  console.log('SOL before:', (before / 1e9).toFixed(6));

  // CJS build: require() returns the DLMM class directly (no ESM directory-import issue).
  const DLMM = require('@meteora-ag/dlmm');
  const pool = await DLMM.create(conn, new PublicKey(POOL));

  const { userPositions } = await pool.getPositionsByUserAndLbPair(owner);
  const pos = userPositions.find((p) => p.publicKey.toBase58() === POSITION);
  if (!pos) {
    console.log('POSITION NOT FOUND under wallet — nothing to close (already gone?).');
    process.exit(1);
  }
  console.log('position found:', pos.publicKey.toBase58());

  // Refuse a position that still holds liquidity. `closePosition` does not withdraw:
  // on a funded position it either fails or, worse, succeeds against an account the
  // engine still believes it owns. Withdrawing is `removeLiquidity` with
  // shouldClaimAndClose, which is what the engine's own close path does.
  const funded = (pos.positionData.positionBinData || []).filter(
    (b) => b.positionLiquidity !== '0' && b.positionLiquidity !== 0,
  );
  if (funded.length > 0) {
    console.error(`REFUSING: position still holds liquidity in ${funded.length} bin(s).`);
    console.error('This script only closes EMPTY accounts. Close it through the engine.');
    process.exit(1);
  }
  console.log('position is empty: safe to close');

  if (!EXECUTE) {
    console.log('\nDRY RUN - nothing signed, nothing sent.');
    console.log('Re-run with `-- --execute` to actually close and recover the rent.');
    return;
  }

  const tx = await pool.closePosition({ owner, position: pos });
  // Modest priority fee so the close doesn't sit in the queue.
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }));
  tx.sign(signer);

  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  // Printed BEFORE confirming: on an ambiguous failure this is the only handle on a
  // transaction that may still land, and re-running blind is how one gets sent twice.
  console.log('submitted:', sig);
  console.log('If this run dies from here on, CHECK THIS SIGNATURE ON-CHAIN BEFORE RETRYING.');
  const res = await conn.confirmTransaction({
    signature: sig,
    blockhash: tx.recentBlockhash,
    lastValidBlockHeight: tx.lastValidBlockHeight,
  }, 'confirmed');
  if (res.value.err) { console.error('CONFIRM ERROR:', res.value.err); process.exit(1); }
  console.log('CONFIRMED ✓');

  const after = await conn.getBalance(owner);
  console.log('SOL after:', (after / 1e9).toFixed(6));
  console.log('recovered:', ((after - before) / 1e9).toFixed(6), 'SOL');

  const gone = await conn.getAccountInfo(new PublicKey(POSITION));
  console.log('position account still exists:', gone !== null);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
