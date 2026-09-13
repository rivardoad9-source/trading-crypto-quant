/**
 * Would the engine open this mint? A read-only oracle for the Token-2022 screen.
 *
 *   node --import tsx scripts/verifyTokenFee.ts <mint> [<mint> ...]
 *
 * Prints the decoded extension reading and the entry-screen verdict for each mint, the
 * same two calls the funnel makes. Nothing is signed and nothing is written.
 *
 * Written after 13 Sep 2026, when `NEARKAT-SOL` was elected with a 300 bps transfer fee
 * and the round trip cost 8.77% of a 0.9 SOL swap. The unit tests prove the DECODER with
 * synthetic bytes; this proves it against the real mint the money was lost on, and gives
 * the operator the same answer for any token before it reaches a cycle.
 */
import { env } from "../src/config/env.js";
import { assessTokenFeeScreen, readTokenExtensions } from "../src/services/tokenExtensions.js";

async function main(): Promise<void> {
  const mints = process.argv.slice(2);
  if (mints.length === 0) {
    console.error("usage: node --import tsx scripts/verifyTokenFee.ts <mint> [<mint> ...]");
    process.exit(2);
  }

  console.log(
    `limit LIVE_MAX_TOKEN_TRANSFER_FEE_BPS=${env.LIVE_MAX_TOKEN_TRANSFER_FEE_BPS}`,
  );

  let refused = 0;
  for (const mint of mints) {
    try {
      const reading = await readTokenExtensions(mint);
      const verdict = await assessTokenFeeScreen(mint, env.LIVE_MAX_TOKEN_TRANSFER_FEE_BPS);
      if (verdict.blocked) refused += 1;
      console.log(
        `${verdict.blocked ? "REFUSED" : "allowed"}  ${mint}  ` +
          `fee=${reading.transferFeeBps}bps hook=${reading.hasTransferHook} ` +
          `nonTransferable=${reading.nonTransferable}` +
          (verdict.reason ? `\n    ${verdict.reason}` : ""),
      );
    } catch (err) {
      refused += 1;
      console.log(
        `UNREADABLE  ${mint}  ${err instanceof Error ? err.message : String(err)} ` +
          `(the funnel treats this as a refusal)`,
      );
    }
  }

  console.log(`${refused}/${mints.length} would be refused.`);
}

void main();
