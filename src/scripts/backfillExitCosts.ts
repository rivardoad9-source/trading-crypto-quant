/**
 * npm run exitcosts:backfill                                   # live host: reads the DB
 * npm run exitcosts:backfill -- --from=csv:exports/trades.csv   # anywhere: reads the export
 * npm run exitcosts:backfill -- --dry-run                       # prints, writes nothing
 *
 * Read-only against the chain (getTransaction, getAccountInfo) and Meteora's API. Signs
 * nothing. Writes only `exit_economics`, insert-if-absent, so it is safe to re-run.
 */
import { readFileSync } from "node:fs";

import { initDatabase, db } from "../database/db.js";
import { insertExitEconomicsIfAbsent } from "../database/repositories.js";
import { getTransactionMeta } from "../services/solana.js";
import { fetchPoolByAddress } from "../services/meteora.js";
import { readTokenExtensions } from "../services/tokenExtensions.js";
import { metaReaderWithRetry } from "../services/exitEconomics.js";
import {
  KNOWN_FAILED_OPENS_PATH,
  parseKnownFailedOpens,
  closedLiveFromCsv,
  parseCsv,
  runExitEconomicsBackfill,
  type ClosedLivePositionRecord,
  type FailedOpenRecord,
} from "../services/exitEconomicsBackfill.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  initDatabase();
  const from = arg("from") ?? "db";
  const dryRun = process.argv.includes("--dry-run");

  let positions: ClosedLivePositionRecord[];
  let failedOpens: FailedOpenRecord[];
  if (from.startsWith("csv:")) {
    positions = closedLiveFromCsv(parseCsv(readFileSync(from.slice(4), "utf8")));
    failedOpens = parseKnownFailedOpens(readFileSync(arg("failed-opens") ?? KNOWN_FAILED_OPENS_PATH, "utf8"));
  } else {
    positions = db
      .prepare(
        `SELECT position_id, pool_address, pair_name, virtual_sol_amount, entry_tvl, exit_price,
                residual_sweep, close_signature, sweep_signature, ata_close_signature
           FROM simulated_positions
          WHERE execution_mode = 'LIVE' AND status LIKE 'CLOSED%' AND close_signature IS NOT NULL`,
      )
      .all() as ClosedLivePositionRecord[];
    const attempts = db
      .prepare(
        `SELECT id, pool_address, pair_name, token_mint, swap_signature, rescue_signature
           FROM live_execution_attempts
          WHERE outcome = 'failed' AND swap_signature IS NOT NULL AND rescue_signature IS NOT NULL
            AND token_mint IS NOT NULL`,
      )
      .all() as Array<{ id: number; pool_address: string; pair_name: string | null; token_mint: string; swap_signature: string; rescue_signature: string }>;
    failedOpens = attempts.map((a) => ({
      positionId: `attempt-${a.id}`,
      poolAddress: a.pool_address,
      pairName: a.pair_name ?? a.pool_address.slice(0, 8),
      mint: a.token_mint,
      swapSignature: a.swap_signature,
      unwindSignature: a.rescue_signature,
      entryTvlUsd: null,
    }));
  }

  console.log(`[exitcosts] ${positions.length} closed live positions + ${failedOpens.length} failed opens from ${from}`);

  const result = await runExitEconomicsBackfill(
    positions,
    failedOpens,
    {
      readMeta: metaReaderWithRetry(getTransactionMeta, 3, 1_500),
      async readPool(address) {
        const pool = await fetchPoolByAddress(address, { quiet: true });
        return pool ? { binStep: pool.binStep, baseMint: pool.baseMint, quoteMint: pool.quoteMint } : null;
      },
      readTransferFeeBps: async (mint) => (await readTokenExtensions(mint)).transferFeeBps,
      insert: insertExitEconomicsIfAbsent,
    },
    { write: !dryRun },
  );

  for (const r of result.rows) {
    console.log(
      `${r.positionId.slice(0, 12).padEnd(12)} ${r.pairName.padEnd(12)} bin ${String(r.binStep ?? "—").padStart(3)} ` +
        `in ${r.sweepInAmount ?? "—"} out ${r.sweepOutLamports ?? "—"} expected ${r.expectedOutLamports ?? "—"} ` +
        `cost ${r.exitCostBps === null ? "null" : r.exitCostBps.toFixed(1)} bps ` +
        `concession ${r.sweepConcessionBps === null ? "null" : r.sweepConcessionBps.toFixed(1)} bps ` +
        `fee ${r.exitFeeLamports ?? "null"}\n    notes: ${r.notes.join(" | ")}`,
    );
  }
  console.log(
    dryRun
      ? "[exitcosts] dry run — nothing written"
      : `[exitcosts] inserted ${result.inserted}, already present ${result.skipped}`,
  );
}

main().catch((err) => {
  console.error("[exitcosts] backfill failed:", err);
  process.exit(1);
});
