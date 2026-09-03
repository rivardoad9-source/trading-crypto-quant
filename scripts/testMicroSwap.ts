/**
 * ISOLATED mainnet proof-of-concept: swap a micro amount of SOL to USDC.
 *
 * NOT part of the engine. Nothing imports this file; it is run by hand, and
 * `src/tests/onchainExecutor.test.ts` fails the build if the engine's import graph
 * ever reaches the executor it uses.
 *
 * It exists to answer one question that no unit test can: do the wallet loader, the
 * signer, the priority-fee handler and RPC submission actually work together against
 * real mainnet? Everything else about the on-chain path can be tested offline. This
 * cannot, because a signature is only meaningful to a cluster that accepts it.
 *
 *   npm run test:swap                 # dry run: quote only, signs nothing
 *   npm run test:swap -- --execute    # SPENDS REAL SOL
 *
 * Defaults to 0.01 SOL (~$1) and refuses anything above ONCHAIN_MAX_LAMPORTS_PER_TX.
 * A dry run is the default because the opposite default — execute unless told not to —
 * makes a mistyped command cost money.
 */
import {
  HARD_MAX_SLIPPAGE_BPS,
  USDC_MINT,
  WSOL_MINT,
  authorizeExecution,
  executeJupiterSwap,
  getConnection,
  getJupiterQuote,
  onchainConfig,
  planPriorityFee,
  resolveSlippageBps,
  type ExecutionAuthorization,
} from "../src/services/onchainExecutor.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_DECIMALS = 6;

interface Args {
  execute: boolean;
  amountSol: number;
  slippageBps: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const amount = flag("amount");
  const slippage = flag("slippage");

  return {
    execute: argv.includes("--execute"),
    amountSol: amount === undefined ? 0.01 : Number(amount),
    slippageBps: slippage === undefined ? undefined : Number(slippage),
  };
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)}${value}`);
}

async function reportQuote(amountLamports: number, slippageBps: number): Promise<void> {
  const quote = await getJupiterQuote({
    inputMint: WSOL_MINT,
    outputMint: USDC_MINT,
    amountLamports,
    slippageBps,
  });

  const out = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
  const min = Number(quote.otherAmountThreshold) / 10 ** USDC_DECIMALS;

  console.log("\nQuote (read-only, nothing signed):");
  line("in", `${(amountLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  line("out (expected)", `${out.toFixed(6)} USDC`);
  line("out (minimum)", `${min.toFixed(6)} USDC  <- enforced on-chain`);
  line("slippage", `${quote.slippageBps} bps (cap ${HARD_MAX_SLIPPAGE_BPS})`);
  line("price impact", `${(Number(quote.priceImpactPct) * 100).toFixed(4)}%`);
  line("route hops", String(quote.routePlan?.length ?? 0));
}

async function reportPriorityFee(): Promise<void> {
  const plan = await planPriorityFee(0);
  console.log("\nPriority fee (attempt 0):");
  line("micro-lamports/CU", String(plan.microLamportsPerCu));
  line("compute units", String(plan.computeUnitLimit));
  line("priority cost", `${(plan.estimatedLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
  line("source", plan.source === "sampled" ? "live p75 sample" : "configured floor");
}

async function reportWallet(auth: ExecutionAuthorization): Promise<number> {
  const lamports = await getConnection().getBalance(auth.wallet, "confirmed");
  console.log("\nWallet:");
  line("address", auth.wallet.toBase58());
  line("balance", `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  line("per-tx ceiling", `${(auth.maxLamportsPerTx / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  return lamports;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("\n  Micro-swap proof of concept — SOL -> USDC via Jupiter");
  console.log("  ----------------------------------------------------");
  line("mode", args.execute ? "EXECUTE (spends real SOL)" : "DRY RUN (quote only)");
  line("amount", `${args.amountSol} SOL`);
  line("rpc", new URL(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com").host);

  if (!Number.isFinite(args.amountSol) || args.amountSol <= 0) {
    console.error("\n[swap] --amount must be a positive number of SOL.\n");
    process.exitCode = 1;
    return;
  }

  const amountLamports = Math.floor(args.amountSol * LAMPORTS_PER_SOL);

  if (amountLamports > onchainConfig.maxLamportsPerTx) {
    console.error(
      `\n[swap] ${args.amountSol} SOL exceeds ONCHAIN_MAX_LAMPORTS_PER_TX ` +
        `(${(onchainConfig.maxLamportsPerTx / LAMPORTS_PER_SOL).toFixed(4)} SOL). ` +
        `Raise the ceiling deliberately if that is really what you want.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // The quote and the fee probe need no wallet and no arming, so a dry run works on a
  // machine that holds no key at all. That is the point: the read-only half should be
  // verifiable before anyone puts a private key on the box.
  await reportPriorityFee();
  await reportQuote(amountLamports, Math.min(args.slippageBps ?? HARD_MAX_SLIPPAGE_BPS, HARD_MAX_SLIPPAGE_BPS));

  if (!args.execute) {
    console.log(
      "\n  DRY RUN complete. Nothing was signed or sent.\n" +
        "  To execute for real: npm run test:swap -- --execute\n",
    );
    return;
  }

  /* ---- from here on, real funds ---- */

  let auth: ExecutionAuthorization;
  try {
    auth = authorizeExecution();
  } catch (err) {
    console.error(`\n[swap] ${(err as Error).message}`);
    console.error(
      "[swap] Set ONCHAIN_EXECUTION_ARMED=true and SOLANA_PRIVATE_KEY in .env to execute.\n",
    );
    process.exitCode = 1;
    return;
  }

  const balance = await reportWallet(auth);

  // Leave room for rent and the fee itself; a swap that empties the wallet cannot be
  // followed by the transaction that unwinds it.
  const headroom = amountLamports + 5_000_000;
  if (balance < headroom) {
    console.error(
      `\n[swap] balance ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL is below the ` +
        `${(headroom / LAMPORTS_PER_SOL).toFixed(6)} SOL needed for this swap plus fee headroom.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const slippageBps = resolveSlippageBps(auth, args.slippageBps);
  console.log(`\nExecuting… (slippage ${slippageBps} bps)\n`);

  try {
    const { result, quote } = await executeJupiterSwap(auth, {
      inputMint: WSOL_MINT,
      outputMint: USDC_MINT,
      amountLamports,
      slippageBps,
      onAttempt: ({ attempt, signature, plan }) =>
        console.log(
          `  attempt ${attempt + 1}: sig ${signature} @ ${plan.microLamportsPerCu} µlamports/CU`,
        ),
    });

    console.log("\n  CONFIRMED");
    line("signature", result.signature);
    line("slot", result.slot === null ? "unknown" : String(result.slot));
    line("builds", String(result.buildAttempts));
    line("priority fee", `${result.priorityMicroLamports} micro-lamports/CU`);
    line("received (min)", `${(Number(quote.otherAmountThreshold) / 1e6).toFixed(6)} USDC`);
    console.log(`\n  https://solscan.io/tx/${result.signature}\n`);
  } catch (err) {
    console.error(`\n[swap] FAILED: ${(err as Error).message}`);
    const sig = (err as { signature?: string | null }).signature;
    if (sig) {
      console.error(
        `[swap] A signature exists: ${sig}\n` +
          `[swap] CHECK IT ON-CHAIN BEFORE RETRYING — it may have landed.\n` +
          `[swap] https://solscan.io/tx/${sig}\n`,
      );
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[swap] fatal:", err);
  process.exitCode = 1;
});
