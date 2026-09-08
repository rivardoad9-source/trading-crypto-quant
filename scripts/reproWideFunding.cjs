/*
 * PROOF HARNESS — why has the WIDE path never completed a live open?
 *
 * Run by hand and by nothing else. It answers the question that cost ~0.10 SOL over
 * three real-money incidents on 7-8 Sep 2026 (STONK-SOL 371 bins, SOLCAT-SOL 77,
 * ZCAT-SOL 95): the funding transactions built by `addLiquidityByStrategyChunkable`
 * carried `InitializeBinArray` instructions for arrays that `preCreateMissingBinArrays`
 * had just verified EXIST, and then died on a compute meter of ~399,700 CU.
 *
 * The standing hypothesis was that the SDK expands the bin range beyond
 * [minBinId, maxBinId], touching arrays outside the probe coverage. This harness
 * FALSIFIES that. It prints, for a real pool and a real width:
 *
 *   1. the arrays the probe covers, and which of them exist on-chain right now;
 *   2. every instruction in every funding transaction the SDK builds, with each
 *      `initializeBinArray` decoded back to its index and cross-referenced against (1);
 *   3. whether the SDK attached any `SetComputeUnitLimit` at all.
 *
 * Expected output on any pool whose arrays already exist: the SDK emits an init for
 * EVERY covered array (all of them already existing, none of them missed by the probe)
 * and attaches NO compute-budget instruction, so `resolveComputeUnitLimit` falls back
 * to the ONCHAIN_COMPUTE_UNIT_LIMIT floor while the SDK's own sizing constants for the
 * same work are DEFAULT_ADD_LIQUIDITY_CU (1,000,000) plus 350,000 per array.
 *
 * SAFETY — this script cannot spend anything, by construction:
 *   - it BUILDS transactions and never signs, simulates or sends one;
 *   - it holds no key and loads no key. Plain CommonJS so `src/config/env.ts` never
 *     loads and `.env` is never read;
 *   - the position pubkey is a throwaway `Keypair.generate().publicKey`. That is sound
 *     and is itself part of the finding: `chunkDepositWithRebalanceEndpoint` uses the
 *     position ONLY as an account meta and never fetches it, so the funding
 *     transactions can be built before the account exists.
 *
 *   node scripts/reproWideFunding.cjs
 *   REPRO_WIDTH=95  node scripts/reproWideFunding.cjs
 *   REPRO_POOL=<pool> REPRO_RPC=https://your-rpc node scripts/reproWideFunding.cjs
 */
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const req = require("module").createRequire(path.join(REPO, "package.json"));

const { Connection, PublicKey, Keypair, ComputeBudgetProgram } = req("@solana/web3.js");
// The CJS build, for the same reason `onchainExecutor.loadDlmmSdk()` uses createRequire.
const dlmmSdk = req("@meteora-ag/dlmm");
const DLMM = dlmmSdk.default ?? dlmmSdk;
const BN = req("bn.js");

const RPC = process.env.REPRO_RPC || "https://api.mainnet-beta.solana.com";
// SOL-USDC (bin_step 4) by default: liquid, so every array in range already exists,
// which is precisely the condition under which the SDK should emit no inits at all.
const POOL = new PublicKey(
  process.env.REPRO_POOL || "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
);
const WIDTH = Number(process.env.REPRO_WIDTH || 95);
const WSOL = "So11111111111111111111111111111111111111112";

/* The Anchor discriminator for `initialize_bin_array`, read from the shipped IDL. */
const INIT_BIN_ARRAY_DISC = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]);

function decodeInitBinArrayIndex(ix) {
  // 8-byte discriminator, then the i64 `index` little-endian.
  if (ix.data.length < 16) return null;
  if (!ix.data.subarray(0, 8).equals(INIT_BIN_ARRAY_DISC)) return null;
  return ix.data.readBigInt64LE(8).toString();
}

function label(ix, programId) {
  if (ix.programId.equals(ComputeBudgetProgram.programId)) return "ComputeBudget";
  if (ix.programId.equals(programId)) {
    const idx = decodeInitBinArrayIndex(ix);
    if (idx !== null) return `DLMM initializeBinArray(index=${idx})`;
    return "DLMM (other — rebalanceLiquidity / init bitmap)";
  }
  return `other program ${ix.programId.toBase58()}`;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const pool = await DLMM.create(connection, POOL);
  const programId = pool.program.programId;

  const activeId = pool.lbPair.activeId;
  // Bracket the active bin the way computeBinRange does: a two-sided range.
  const minBinId = activeId - Math.floor((WIDTH - 1) / 2);
  const maxBinId = minBinId + WIDTH - 1;

  console.log(`pool          ${POOL.toBase58()}`);
  console.log(`bin step      ${pool.lbPair.binStep}`);
  console.log(`active bin    ${activeId}`);
  console.log(`range         [${minBinId}, ${maxBinId}]  (${WIDTH} bins)`);
  console.log("");

  /* ---- 1. The probe, exactly as preCreateMissingBinArrays runs it ---------- */
  const covered = [
    ...dlmmSdk.getBinArrayIndexesCoverage(new BN(minBinId), new BN(maxBinId)),
  ].map((raw) => {
    const index = new BN(raw);
    const [pubkey] = dlmmSdk.deriveBinArray(POOL, index, programId);
    return { index: index.toString(), pubkey };
  });
  const infos = await connection.getMultipleAccountsInfo(covered.map((c) => c.pubkey));
  const existing = new Set();
  covered.forEach((c, i) => {
    if (infos[i] !== null) existing.add(c.index);
  });

  console.log("PROBE (getBinArrayIndexesCoverage + getMultipleAccountsInfo)");
  console.log(
    `  covered arrays : ${covered.length}  [${covered.map((c) => c.index).join(", ")}]`,
  );
  console.log(`  exist on-chain : ${existing.size}`);
  console.log(`  MISSING        : ${covered.length - existing.size}`);
  console.log("");

  /* ---- 2. What the SDK actually builds ------------------------------------ */
  const throwaway = Keypair.generate().publicKey;
  const solIsX = pool.tokenX.publicKey.toBase58() === WSOL;
  const sol = new BN(900_000_000); // 0.9 SOL, the live deposit size
  const paired = new BN(1_000_000);

  const txs = await pool.addLiquidityByStrategyChunkable({
    positionPubKey: throwaway,
    user: throwaway,
    totalXAmount: solIsX ? sol : paired,
    totalYAmount: solIsX ? paired : sol,
    strategy: { minBinId, maxBinId, strategyType: dlmmSdk.StrategyType.Spot },
    slippage: 0.5,
  });

  console.log(`SDK addLiquidityByStrategyChunkable -> ${txs.length} transaction(s)`);
  console.log("");

  const initsEmitted = [];
  let anyComputeBudget = false;

  txs.forEach((tx, i) => {
    console.log(`  tx ${i + 1}/${txs.length}  (${tx.instructions.length} instructions)`);
    for (const ix of tx.instructions) {
      const name = label(ix, programId);
      if (ix.programId.equals(ComputeBudgetProgram.programId)) anyComputeBudget = true;
      const idx = ix.programId.equals(programId) ? decodeInitBinArrayIndex(ix) : null;
      if (idx !== null) {
        initsEmitted.push(idx);
        const verdict = existing.has(idx)
          ? "  <-- ALREADY EXISTS ON-CHAIN. Probe saw it. SDK inits it anyway."
          : "  <-- genuinely missing";
        console.log(`      ${name}${verdict}`);
      } else {
        console.log(`      ${name}`);
      }
    }
    console.log("");
  });

  /* ---- 3. Verdict --------------------------------------------------------- */
  const emittedSet = new Set(initsEmitted);
  const outsideProbe = [...emittedSet].filter((i) => !covered.some((c) => c.index === i));
  const redundant = initsEmitted.filter((i) => existing.has(i));

  console.log("VERDICT");
  console.log(
    `  initializeBinArray emitted        : ${initsEmitted.length} (${emittedSet.size} distinct)`,
  );
  console.log(`  ...for arrays that ALREADY EXIST  : ${redundant.length}`);
  console.log(
    `  ...for arrays OUTSIDE probe range : ${outsideProbe.length}  ${
      outsideProbe.length === 0
        ? "<-- range-expansion hypothesis FALSIFIED"
        : `<-- ${outsideProbe.join(", ")}`
    }`,
  );
  console.log(
    `  SetComputeUnitLimit from the SDK  : ${anyComputeBudget ? "yes" : "NO — none at all"}`,
  );
  console.log("");
  console.log(
    `  SDK's own sizing for this work    : ${
      1_000_000 * txs.length + 350_000 * initsEmitted.length
    } CU ` +
      `(DEFAULT_ADD_LIQUIDITY_CU 1,000,000 x ${txs.length} + 350,000 x ${initsEmitted.length})`,
  );
  console.log(
    "  What the engine enforced instead  : 400,000 CU floor (ONCHAIN_COMPUTE_UNIT_LIMIT),",
  );
  console.log(
    "                                      399,700 usable after 2 x 150 CU of ComputeBudget ix",
  );

  /* ---- 4. What the engine sends AFTER the fix ----------------------------- */
  console.log("");
  console.log("AFTER THE FIX (partitionFundingInstructions + fundingComputeUnits)");
  let totalKeptInits = 0;
  txs.forEach((tx, i) => {
    let keptInits = 0;
    let removed = 0;
    for (const ix of tx.instructions) {
      const idx = ix.programId.equals(programId) ? decodeInitBinArrayIndex(ix) : null;
      if (idx === null) continue;
      if (existing.has(idx)) removed += 1;
      else keptInits += 1;
    }
    totalKeptInits += keptInits;
    const budget = Math.min(1_000_000 + keptInits * 350_000, 1_400_000);
    console.log(
      `  tx ${i + 1}/${txs.length}: drop ${removed} redundant init(s), keep ${keptInits}, ` +
        `budget ${budget.toLocaleString("en-US")} CU`,
    );
  });
  console.log("");
  console.log(
    `  compute reclaimed by dropping no-op inits : ` +
      `${((initsEmitted.length - totalKeptInits) * 202_242).toLocaleString("en-US")} CU ` +
      `(${initsEmitted.length - totalKeptInits} x 202,242 measured)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
