/**
 * npm run entrycosts:backfill              # live host: reads the DB, writes what is missing
 * npm run entrycosts:backfill -- --dry-run # prints, writes nothing
 *
 * Measures the ENTRY leg of every live open that has a stored swap signature, plus the two
 * failed opens (swap in + rescue unwind). Read-only against the chain (getTransaction) and
 * Meteora's API. Signs nothing. Writes only `entry_economics`, insert-if-absent, so it is
 * safe to re-run and safe to schedule — that is how the sample grows without waiting for a
 * close: every new open is picked up on the next sweep.
 */
import { initDatabase, db } from "../database/db.js";
import { insertEntryEconomicsIfAbsent } from "../database/repositories.js";
import { getTransactionMeta } from "../services/solana.js";
import { fetchPoolByAddress } from "../services/meteora.js";
import { metaReaderWithRetry } from "../services/exitEconomics.js";
import {
  runEntryEconomicsBackfill,
  type EntryMeasurementCandidate,
} from "../services/entryEconomicsBackfill.js";

const LAMPORTS = 1_000_000_000;

interface OpenRow {
  position_id: string;
  pair_name: string | null;
  pool_address: string;
  entry_price: number | null;
  entry_tvl: number | null;
  virtual_sol_amount: number | null;
  swap_signature: string | null;
  open_signature: string | null;
  token_mint: string | null;
  attempted_at: string | null;
}

interface FailedRow {
  id: number;
  pool_address: string;
  pair_name: string | null;
  token_mint: string | null;
  swap_signature: string | null;
  rescue_signature: string | null;
  attempted_at: string | null;
  cost_lamports: number | null;
}

/** Epoch ms for a stored 'YYYY-MM-DD HH:MM:SS' UTC stamp; null when unparsable. */
function storedUtcToMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function loadCandidates(): EntryMeasurementCandidate[] {
  const opens = db
    .prepare(
      `SELECT p.position_id, p.pair_name, p.pool_address, p.entry_price, p.entry_tvl,
              p.virtual_sol_amount, p.swap_signature, p.open_signature,
              a.token_mint, a.attempted_at
         FROM simulated_positions p
         LEFT JOIN live_execution_attempts a
                ON a.id = (SELECT MAX(x.id) FROM live_execution_attempts x
                            WHERE x.position_address = p.position_address)
        WHERE p.execution_mode = 'LIVE' AND p.swap_signature IS NOT NULL
        ORDER BY p.opened_at`,
    )
    .all() as OpenRow[];

  const candidates: EntryMeasurementCandidate[] = opens.map((r) => ({
    positionId: r.position_id,
    pairName: r.pair_name ?? r.pool_address.slice(0, 8),
    poolAddress: r.pool_address,
    mint: r.token_mint,
    notionalLamports: r.virtual_sol_amount === null ? null : Math.round(r.virtual_sol_amount * LAMPORTS),
    tvlUsdAtEntry: r.entry_tvl,
    poolPriceAtEntry: r.entry_price,
    swapSignature: r.swap_signature,
    openSignature: r.open_signature,
    attemptedAtMs: storedUtcToMs(r.attempted_at),
  }));

  /*
   * Failed opens. Two shapes, because the table tells them apart:
   *  - a stored rescue signature splits the legs (swap in, unwind out) -> per-leg measurement;
   *  - no rescue signature (the engine only recorded the wallet delta) -> one round-trip number,
   *    with the notional derived inside the service from the swap-in size.
   */
  const failed = db
    .prepare(
      `SELECT id, pool_address, pair_name, token_mint, swap_signature, rescue_signature,
              attempted_at, cost_lamports
         FROM live_execution_attempts
        WHERE outcome = 'failed' AND swap_signature IS NOT NULL`,
    )
    .all() as FailedRow[];

  for (const f of failed) {
    candidates.push({
      positionId: `attempt-${f.id}`,
      pairName: f.pair_name ?? f.pool_address.slice(0, 8),
      poolAddress: f.pool_address,
      mint: f.token_mint,
      notionalLamports: null,
      tvlUsdAtEntry: null,
      poolPriceAtEntry: null,
      swapSignature: f.swap_signature,
      openSignature: null,
      unwindSignature: f.rescue_signature,
      recordedCostLamports: f.rescue_signature ? null : f.cost_lamports,
      attemptedAtMs: storedUtcToMs(f.attempted_at),
    });
  }

  return candidates;
}

function alreadyMeasured(): Set<string> {
  const rows = db.prepare(`SELECT position_id FROM entry_economics`).all() as Array<{ position_id: string }>;
  return new Set(rows.map((r) => r.position_id));
}

async function main(): Promise<void> {
  initDatabase();
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const all = loadCandidates();
  const done = alreadyMeasured();
  const candidates = force ? all : all.filter((c) => !done.has(c.positionId));
  console.log(
    `[entrycosts] ${all.length} live entry candidates, ${done.size} already measured, ` +
      `${candidates.length} to measure${dryRun ? " (dry run)" : ""}`,
  );
  if (candidates.length === 0) return;

  const result = await runEntryEconomicsBackfill(
    candidates,
    {
      readMeta: metaReaderWithRetry(getTransactionMeta, 3, 1_500),
      async readPool(address) {
        const pool = await fetchPoolByAddress(address, { quiet: true });
        return pool ? { binStep: pool.binStep, tvlUsd: pool.tvlUsd, currentPrice: pool.currentPrice } : null;
      },
      insert: insertEntryEconomicsIfAbsent,
    },
    { write: !dryRun },
  );

  for (const r of result.rows) {
    const bps = (v: number | null) => (v === null ? "null" : v.toFixed(1).padStart(7));
    console.log(
      `${r.positionId.slice(0, 14).padEnd(14)} ${r.pairName.padEnd(14)} ` +
        `in ${r.swapInLamports ?? "—"} lamports → ${r.tokensReceived ?? "—"} base units ` +
        `(expected ${r.expectedTokens ?? "—"})\n` +
        `    concession ${bps(r.entryConcessionBps)} bps · cost/notional ${bps(r.entryCostBps)} bps · ` +
        `fee ${r.entryFeeLamports ?? "null"}\n` +
        `    notes: ${r.notes.join(" | ")}`,
    );
  }
  console.log(
    dryRun
      ? "[entrycosts] dry run — nothing written"
      : `[entrycosts] inserted ${result.inserted}, already present ${result.skipped}`,
  );
}

main().catch((err) => {
  console.error("[entrycosts] backfill failed:", err);
  process.exit(1);
});
