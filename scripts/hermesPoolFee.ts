/**
 * Read one Meteora DLMM pool's own numbers — binStep, base fee, TVL — without the dashboard.
 *
 * Written 21 Sep 2026 to answer "what does the pool itself charge on a swap" from the source
 * rather than from a report: the exit cost is dominated by the pool's base fee, and the number
 * that matters is `baseFeePct`, which Meteora reports per pool (100 = 1.00%).
 *
 * Usage: node --import tsx scripts/hermesPoolFee.ts <poolAddress>
 */
import { fetchPoolByAddress } from "../src/services/meteora.js";

const addr = process.argv[2];
if (!addr) {
  console.error("usage: node --import tsx scripts/hermesPoolFee.ts <poolAddress>");
  process.exit(2);
}

const pool = await fetchPoolByAddress(addr);
if (pool === null || pool === undefined) {
  console.error(`no pool returned for ${addr}`);
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      address: addr,
      binStep: pool.binStep,
      baseFeePct: pool.baseFeePct,
      tvlUsd: pool.tvlUsd,
      feeTvlRatio24h: pool.feeTvlRatio24h,
    },
    null,
    1,
  ),
);
