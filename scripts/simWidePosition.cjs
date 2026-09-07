/*
 * PROOF HARNESS — how wide can ONE DLMM position account be?
 *
 * Run by hand and by nothing else. It answers the question that cost 0.4 SOL on
 * 7 Sep 2026: the engine believed a position account held at most 70 bins, and
 * therefore refused ~81% of the scanned universe. 70 is `DEFAULT_BIN_PER_POSITION`
 * (what one `initializePosition` allocates); the account can hold 1400
 * (`POSITION_MAX_LENGTH`), grown by top-level `increasePositionLength` instructions
 * of <=91 bins each.
 *
 * SAFETY — this script cannot spend anything, by construction:
 *   - it SIMULATES only, through raw JSON-RPC with `sigVerify:false`;
 *   - it holds no key and loads no key. It is deliberately plain CommonJS so that
 *     `src/config/env.ts` never loads and `.env` is never read;
 *   - the fee payer is a well-known funded mainnet address used READ-ONLY, because a
 *     simulation still debits rent and would otherwise fail for the wrong reason.
 *
 *   node scripts/simWidePosition.cjs
 *   SIM_WIDTHS=1399,1400,1401 node scripts/simWidePosition.cjs
 *   SIM_RPC=https://your-rpc node scripts/simWidePosition.cjs   # public RPC rate-limits
 *
 * Result on 7 Sep 2026 against SOL-USDC (bin_step 4):
 *   widths 70/100/300/600/1200/1400 -> OK in ONE transaction
 *                                      (1400 bins = 17 ix, 772 bytes, 153k CU)
 *   widths 1401+                    -> custom 6040 InvalidPositionWidth, thrown at
 *                                      increase_position_length.rs:52
 */
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const req = require("module").createRequire(path.join(REPO, "package.json"));

const { Connection, PublicKey, Keypair } = req("@solana/web3.js");
// The CJS build: the ESM one (`dist/index.mjs`) is broken, same reason
// `onchainExecutor.loadDlmmSdk()` uses createRequire.
const dlmmSdk = req("@meteora-ag/dlmm");
const BN = req("bn.js");

const RPC = process.env.SIM_RPC || "https://api.mainnet-beta.solana.com";
const POOL = new PublicKey(process.env.SIM_POOL || "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
const WIDTHS = process.env.SIM_WIDTHS
  ? process.env.SIM_WIDTHS.split(",").map(Number)
  : [70, 100, 300, 600, 1200, 1400, 1401];

/* Read-only. Never signs; a simulation just needs the payer to be genuinely funded. */
const PAYER_CANDIDATES = [
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S",
];
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

async function findFundedPayer(conn) {
  for (const addr of PAYER_CANDIDATES) {
    const info = await conn.getAccountInfo(new PublicKey(addr));
    if (info && info.owner.toBase58() === SYSTEM_PROGRAM && info.lamports > 5e9) {
      return { pubkey: new PublicKey(addr), sol: info.lamports / 1e9 };
    }
  }
  throw new Error("no funded system-owned payer among the candidates");
}

async function rawSimulate(rpc, b64) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [
        b64,
        { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64", commitment: "confirmed" },
      ],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`rpc ${json.error.code}: ${json.error.message}`);
  return json.result.value;
}

(async () => {
  const conn = new Connection(RPC, "confirmed");
  console.log(`RPC        : ${new URL(RPC).host}   (SIMULATION ONLY — nothing is sent)`);

  const payer = await findFundedPayer(conn);
  console.log(`payer      : ${payer.pubkey.toBase58()} (${payer.sol.toFixed(0)} SOL, read-only)`);

  const pool = await dlmmSdk.create(conn, POOL);
  console.log(
    `pool       : ${POOL.toBase58()}  bin_step=${pool.lbPair.binStep}bps  activeId=${pool.lbPair.activeId}`,
  );
  console.log(
    `sdk consts : DEFAULT_BIN_PER_POSITION=${dlmmSdk.DEFAULT_BIN_PER_POSITION} ` +
      `POSITION_MAX_LENGTH=${dlmmSdk.POSITION_MAX_LENGTH} ` +
      `MAX_RESIZE_LENGTH=${dlmmSdk.MAX_RESIZE_LENGTH}\n`,
  );
  console.log("width |  bytes  | ixs | txsize | CU used   | result");
  console.log("------+---------+-----+--------+-----------+--------------------------------");

  for (const width of WIDTHS) {
    const lower = pool.lbPair.activeId - Math.floor(width / 2);
    const upper = lower + width - 1;
    const bytes = dlmmSdk.calculatePositionSize(new BN(width)).toString();
    let line = `${String(width).padStart(5)} | ${String(bytes).padStart(7)} |`;

    try {
      const tx = await pool.createExtendedEmptyPosition(lower, upper, Keypair.generate().publicKey, payer.pubkey);
      tx.feePayer = payer.pubkey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

      const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      line += ` ${String(tx.instructions.length).padStart(3)} | ${String(raw.length).padStart(6)} |`;

      const sim = await rawSimulate(RPC, raw.toString("base64"));
      line += ` ${String(sim.unitsConsumed ?? 0).padStart(9)} |`;

      if (sim.err) {
        const logs = (sim.logs || []).filter((l) => /Error|error|failed/i.test(l)).slice(-1);
        line += ` FAIL ${JSON.stringify(sim.err)} ${logs.join("").slice(0, 100)}`;
      } else {
        line += " OK";
      }
    } catch (e) {
      line += `   - |      - |         - | THREW ${String(e.message).slice(0, 90)}`;
    }
    console.log(line);
  }
})().catch((e) => {
  console.error("HARNESS ERROR:", e.message);
  process.exit(1);
});
