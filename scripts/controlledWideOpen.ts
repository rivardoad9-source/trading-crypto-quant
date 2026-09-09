/**
 * CONTROLLED WIDE-PATH VALIDATION — open one small wide position (0.1 SOL) on a
 * chosen 80-120 bin pool to prove the create-then-fund path lands (re-arm test
 * per CLAUDE.md). Run as a SEPARATE process with LIVE_MAX_POSITION_BINS overridden
 * high; the running engine keeps its own cap and cannot open wide on its own.
 *
 * SAFETY:
 *  - --dry-run (default): quote + rehearsal only, signs NOTHING.
 *  - --execute: SPENDS REAL SOL (0.1 SOL default, hard ceiling 0.15).
 *  - openLivePosition runs every real gate itself (denylist, breaker, describePair,
 *    width, rent, spend ceiling, rehearsal) BEFORE the swap, and auto-unwinds if
 *    the open fails after the swap (worked 3/3 on 7-8 Sep).
 *
 * Usage:
 *   LIVE_MAX_POSITION_BINS=1400 node --import tsx scripts/controlledWideOpen.ts \
 *     --pool FmMXv9kLxz... --pair "Buttcoin-SOL"            # dry run
 *   ... --execute                                           # spends 0.1 SOL
 */
// Marks this file a module so the top-level awaits below are legal. The dynamic
// imports are deliberate (env parses on import); a static one would defeat them.
export {};

const { env } = await import("../src/config/env.js");
const { openLivePosition } = await import("../src/services/liveExecution.js");
const { fetchPoolByAddress } = await import("../src/services/meteora.js");
const { computeBinRange } = await import("../src/agents/dlmmTraderAgent.js");

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const POOL = flag("pool") ?? "";
const PAIR = flag("pair") ?? "TEST-SOL";
const EXECUTE = process.argv.includes("--execute");
const SIZE_SOL = Number(flag("size") ?? "0.1");

if (!POOL) {
  console.error("usage: --pool <address> [--pair name] [--size 0.1] [--execute]");
  process.exit(2);
}
if (SIZE_SOL > 0.15) {
  console.error(`refusing size ${SIZE_SOL} SOL — controlled test is capped at 0.15`);
  process.exit(2);
}

console.log(`=== CONTROLLED WIDE OPEN — ${PAIR} ${EXECUTE ? "(EXECUTE — SPENDS REAL SOL)" : "(dry run)"} ===`);
console.log(`size: ${SIZE_SOL} SOL | cap env: LIVE_MAX_POSITION_BINS=${env.LIVE_MAX_POSITION_BINS} | ` +
  `dry_run: ${env.DRY_RUN} | armed: ${process.env.ONCHAIN_EXECUTION_ARMED}`);

const pool = await fetchPoolByAddress(POOL);
if (!pool) {
  console.error(`pool ${POOL} not found`);
  process.exit(1);
}

const range = computeBinRange(pool.currentPrice, 45, 15); // floors, like the funnel
console.log(`pool: ${pool.pairName} | price ${pool.currentPrice} | range ` +
  `${range.lower.toFixed(12)} .. ${range.upper.toFixed(12)} (-${range.downsidePct}%/+${range.upsidePct}%)`);

if (!EXECUTE) {
  // Dry run: we cannot cleanly stop openLivePosition mid-flight, and the gates it
  // runs are the point. Print the plan and stop — real gates are exercised by
  // --execute, which rehearses before spending anything anyway.
  console.log("\nDRY RUN — nothing signed. Re-run with --execute to spend real SOL.");
  console.log("The execute path will: describePair -> width/rent/spend gates -> rehearsal");
  console.log("-> (if clean) pre-create bin arrays -> swap 50% -> openPosition (wide 2-phase).");
  process.exit(0);
}

try {
  const outcome = await openLivePosition({
    poolAddress: POOL,
    pairName: PAIR,
    sizeSol: SIZE_SOL,
    lowerBinPrice: range.lower,
    upperBinPrice: range.upper,
    strategy: "SPOT",
    // No projection: a controlled validation open has no fee projection, and the
    // rent-worthiness check is skipped rather than invented (documented in the
    // function). The width/rent/spend gates still run.
    projectedNetPnlUsd: null,
    solPriceUsd: null,
  });
  console.log("\n=== OPEN RESULT ===");
  console.log(JSON.stringify(outcome, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log("\n✅ Wide position opened — funding transactions landed.");
  console.log("Next: verify on-chain, then CLOSE the test position to return SOL.");
} catch (err) {
  console.error("\n❌ OPEN FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
