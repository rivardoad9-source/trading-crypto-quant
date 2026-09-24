/**
 * UJI UANG NYATA: buka 0,1 SOL lewat jalur produksi `openLivePosition`, lalu TUTUP
 * lewat jalur produksi `closeLivePosition` (zap-out 1 tx) dan ukur efeknya ke wallet.
 *
 * Ini harness operator, bukan bagian engine: tidak ada baris DB yang dibuat/diubah,
 * dan `--execute` adalah satu-satunya jalan menghabiskan SOL.
 *
 * SAFETY:
 *  - default = dry run (baca pool + rentang bin, nol tanda tangan).
 *  - --execute: size default 0,1 SOL, ceiling keras 0,15 SOL.
 *  - saldo wallet dibaca SEBELUM & SESUDAH, ditulis ke JSON supaya bisa dipulihkan
 *    kalau prosesnya mati di tengah.
 *
 * Pakai:
 *   node --import tsx scripts/zapRoundTrip.ts --pool <pool> [--pair X-SOL] [--size 0.1] [--execute]
 */
export {};

const flag = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const POOL = flag("pool") ?? "";
const PAIR_ARG = flag("pair");
const SIZE_SOL = Number(flag("size") ?? "0.1");
const EXECUTE = process.argv.includes("--execute");
const CLOSE_ONLY = process.argv.includes("--close-only");
const HOLD_SECONDS = Number(flag("hold") ?? "20");
const DOWN_PCT = Number(flag("down") ?? "45");
const UP_PCT = Number(flag("up") ?? "15");
const OUT = flag("out") ?? "/tmp/zap_round_trip.json";

if (!POOL) {
  console.error("usage: --pool <address> [--pair name] [--size 0.1] [--hold 20] [--execute]");
  process.exit(2);
}
if (SIZE_SOL > 0.15) {
  console.error(`refusing size ${SIZE_SOL} SOL — harness ini dibatasi 0.15`);
  process.exit(2);
}

const { env } = await import("../src/config/env.js");
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const { openLivePosition, closeLivePosition } = await import("../src/services/liveExecution.js");
const { fetchPoolByAddress } = await import("../src/services/meteora.js");
const { computeBinRange } = await import("../src/agents/dlmmTraderAgent.js");

const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");

/** Alamat wallet diturunkan dari kunci, jadi harness nggak butuh env tambahan. */
async function walletAddress(): Promise<string> {
  const raw = (env.SOLANA_PRIVATE_KEY ?? "").trim();
  const secret = raw.startsWith("[")
    ? Uint8Array.from(JSON.parse(raw) as number[])
    : ((await import("bs58")).default.decode(raw) as Uint8Array);
  return Keypair.fromSecretKey(secret).publicKey.toBase58();
}

const WALLET = await walletAddress();

async function walletSol(): Promise<number> {
  return (await conn.getBalance(new PublicKey(WALLET))) / LAMPORTS_PER_SOL;
}

const pool = await fetchPoolByAddress(POOL);
if (!pool) {
  console.error(`pool ${POOL} tidak ditemukan`);
  process.exit(1);
}
const PAIR = PAIR_ARG ?? pool.pairName;
const range = computeBinRange(pool.currentPrice, DOWN_PCT, UP_PCT);

console.log(`=== ZAP ROUND-TRIP ${PAIR} ${EXECUTE ? "(EXECUTE — SPENDS REAL SOL)" : "(dry run)"} ===`);
console.log(`pool ${POOL} | harga ${pool.currentPrice} | binStep ${pool.binStep}`);
console.log(`range ${range.lower.toFixed(12)} .. ${range.upper.toFixed(12)} (-${range.downsidePct}%/+${range.upsidePct}%)`);
console.log(`size ${SIZE_SOL} SOL | cap bins ${env.LIVE_MAX_POSITION_BINS} | dryRun ${env.DRY_RUN} | armed ${process.env.ONCHAIN_EXECUTION_ARMED}`);

if (!EXECUTE) {
  console.log("\nDRY RUN — nol tanda tangan. Jalankan dengan --execute buat pakai SOL beneran.");
  process.exit(0);
}

// Mode pemulihan: tutup posisi yang sudah ada (dipakai kalau open sukses tapi close gagal).
if (CLOSE_ONLY) {
  const posAddr = flag("position");
  if (!posAddr) {
    console.error("--close-only butuh --position <pubkey>");
    process.exit(1);
  }
  const beforeClose = await walletSol();
  console.log(`\nCLOSE-ONLY | posisi ${posAddr} | wallet SEBELUM: ${beforeClose.toFixed(6)} SOL`);
  const closeOutcome = await closeLivePosition({
    poolAddress: POOL,
    positionAddress: posAddr,
    pairName: PAIR,
  });
  console.log("\n=== CLOSE OUTCOME ===");
  console.log(JSON.stringify(closeOutcome, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const afterClose = await walletSol();
  console.log(`\nwallet SESUDAH: ${afterClose.toFixed(6)} SOL | net ${(afterClose - beforeClose).toFixed(6)} SOL`);
  const stillThere = await conn.getAccountInfo(new PublicKey(posAddr));
  console.log(`posisi masih ada di chain? ${stillThere ? "YA — MASIH NYANGKUT" : "tidak ✅"}`);
  process.exit(0);
}

const before = await walletSol();
console.log(`\nwallet SEBELUM: ${before.toFixed(6)} SOL`);

const outcome = await openLivePosition({
  poolAddress: POOL,
  pairName: PAIR,
  sizeSol: SIZE_SOL,
  lowerBinPrice: range.lower,
  upperBinPrice: range.upper,
  strategy: "SPOT",
  projectedNetPnlUsd: null,
  solPriceUsd: null,
});
console.log("\n=== OPEN OUTCOME ===");
console.log(JSON.stringify(outcome, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const record: Record<string, unknown> = {
  pair: PAIR,
  pool: POOL,
  sizeSol: SIZE_SOL,
  openedAt: new Date().toISOString(),
  walletSolBefore: before,
  open: outcome,
};
const { writeFileSync } = await import("node:fs");
writeFileSync(OUT, JSON.stringify(record, null, 2));

const posInfo = await conn.getAccountInfo(new PublicKey(outcome.positionAddress));
const afterOpen = await walletSol();
console.log(`\nCHAIN: posisi ${outcome.positionAddress} ${posInfo ? `ADA (lamports ${posInfo.lamports}, owner ${posInfo.owner.toBase58()})` : "TIDAK ADA!"}`);
console.log(`wallet SETELAH OPEN: ${afterOpen.toFixed(6)} SOL (delta ${(afterOpen - before).toFixed(6)})`);

console.log(`\nmenahan posisi ${HOLD_SECONDS}s sebelum ditutup (biar fee beneran terakrual)…`);
await sleep(HOLD_SECONDS * 1000);

const closeOutcome = await closeLivePosition({
  poolAddress: POOL,
  positionAddress: outcome.positionAddress,
  pairName: PAIR,
});
console.log("\n=== CLOSE OUTCOME ===");
console.log(JSON.stringify(closeOutcome, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(`\n>>> ROUTE: ${closeOutcome.route} | fallback: ${closeOutcome.routeFallbackReason ?? "-"}`);
console.log(`>>> signature: ${closeOutcome.signatures.join(", ")}`);

const posGone = await conn.getAccountInfo(new PublicKey(outcome.positionAddress));
const afterClose = await walletSol();
console.log(`\nCHAIN: posisi ${posGone ? "MASIH ADA (!!)" : "SUDAH HILANG ✅"}`);
console.log(`wallet SETELAH CLOSE: ${afterClose.toFixed(6)} SOL`);
console.log(`net round-trip: ${(afterClose - before).toFixed(6)} SOL (${(((afterClose - before) / before) * 100).toFixed(3)}%)`);

record["closedAt"] = new Date().toISOString();
record["walletSolAfterOpen"] = afterOpen;
record["close"] = closeOutcome;
record["walletSolAfterClose"] = afterClose;
record["netSol"] = afterClose - before;
writeFileSync(OUT, JSON.stringify(record, null, 2));
console.log(`\nringkasan ditulis ke ${OUT}`);
