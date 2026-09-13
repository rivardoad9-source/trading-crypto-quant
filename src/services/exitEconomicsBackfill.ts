/**
 * Backfill of `exit_economics` for the live trades that closed before the table existed.
 *
 * It re-derives each row from what was already stored — the close / sweep / ATA-close
 * signatures, the exit price, the deposit — by reading the transactions from the chain.
 * Nothing is estimated that the chain cannot answer: a trade whose residual was sold by
 * hand has no sweep to measure, and says so.
 *
 * IDEMPOTENT: `insertExitEconomicsIfAbsent` keys on position_id, so a second run adds
 * nothing and a live measurement written at close is never overwritten by a backfill.
 */
import { WSOL_MINT } from "../config/constants.js";
import {
  measureExitEconomics,
  measureFailedOpenRoundTrip,
  type ExitEconomicsRow,
  type MetaReader,
} from "./exitEconomics.js";

/** The stored columns the backfill reads, from the DB or from `exports/trades.csv`. */
export interface ClosedLivePositionRecord {
  position_id: string;
  pool_address: string;
  pair_name: string;
  virtual_sol_amount: number;
  entry_tvl: number | null;
  exit_price: number | null;
  residual_sweep: string | null;
  close_signature: string | null;
  sweep_signature: string | null;
  ata_close_signature: string | null;
}

export interface FailedOpenRecord {
  /** `attempt-<id>` — failed opens have no position row. */
  positionId: string;
  poolAddress: string;
  pairName: string;
  mint: string;
  swapSignature: string;
  unwindSignature: string;
  entryTvlUsd: number | null;
}

/** Default location of failed opens recorded outside the DB (see the file's `_why`). */
export const KNOWN_FAILED_OPENS_PATH = "docs/incidents/known-failed-opens.json";

/** Reads that file. Throws on a malformed one — a silently empty list would drop observations. */
export function parseKnownFailedOpens(json: string): FailedOpenRecord[] {
  const parsed = JSON.parse(json) as { failedOpens?: unknown };
  if (!Array.isArray(parsed.failedOpens)) throw new Error("known failed opens: no failedOpens array");
  return parsed.failedOpens.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    for (const k of ["positionId", "poolAddress", "pairName", "mint", "swapSignature", "unwindSignature"]) {
      if (typeof r[k] !== "string" || r[k] === "") throw new Error(`known failed opens[${i}]: ${k} missing`);
    }
    return {
      positionId: r.positionId as string,
      poolAddress: r.poolAddress as string,
      pairName: r.pairName as string,
      mint: r.mint as string,
      swapSignature: r.swapSignature as string,
      unwindSignature: r.unwindSignature as string,
      entryTvlUsd: typeof r.entryTvlUsd === "number" ? r.entryTvlUsd : null,
    };
  });
}

export interface BackfillDeps {
  readMeta: MetaReader;
  /** Pool facts that do not change: bin step and the two mints. Null when unreadable. */
  readPool(poolAddress: string): Promise<{ binStep: number; baseMint: string; quoteMint: string } | null>;
  readTransferFeeBps(mint: string): Promise<number>;
  insert(row: ExitEconomicsRow): boolean;
}

export interface BackfillResult {
  rows: ExitEconomicsRow[];
  inserted: number;
  skipped: number;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 160);

export async function runExitEconomicsBackfill(
  positions: readonly ClosedLivePositionRecord[],
  failedOpens: readonly FailedOpenRecord[],
  deps: BackfillDeps,
  options: { write: boolean } = { write: true },
): Promise<BackfillResult> {
  const rows: ExitEconomicsRow[] = [];

  for (const p of positions) {
    let binStep: number | null = null;
    let mint: string | null = null;
    let poolNote: string | null = null;
    try {
      const pool = await deps.readPool(p.pool_address);
      if (pool) {
        binStep = pool.binStep;
        mint = pool.baseMint === WSOL_MINT ? pool.quoteMint : pool.baseMint;
      } else poolNote = "pool unreadable: bin_step and mint unmeasured";
    } catch (err) {
      poolNote = `pool unreadable (${errText(err)}): bin_step and mint unmeasured`;
    }
    const row = await measureExitEconomics(
      {
        positionId: p.position_id,
        pairName: p.pair_name,
        mint,
        binStep,
        notionalLamports: p.virtual_sol_amount > 0 ? Math.round(p.virtual_sol_amount * 1e9) : null,
        tvlUsdAtExit: null,
        entryTvlUsd: p.entry_tvl,
        poolPriceAtExit: p.exit_price !== null && p.exit_price > 0 ? p.exit_price : null,
        residualSweep: p.residual_sweep,
        // Every pre-13-Sep sweep went through Jupiter; the rung was not recorded.
        sweepRoute: p.residual_sweep === "swept" ? "jupiter" : null,
        sweepSlippageBpsUsed: null,
        closeSignature: p.close_signature,
        sweepSignature: p.sweep_signature,
        ataCloseSignature: p.ata_close_signature,
        source: "backfill",
      },
      deps.readMeta,
    );
    if (poolNote) row.notes.unshift(poolNote);
    row.notes.push("tvl at exit was not recorded before this table existed; entry_tvl_usd is the entry figure");
    rows.push(row);
  }

  for (const f of failedOpens) {
    let binStep: number | null = null;
    let feeBps: number | null = null;
    const pre: string[] = [];
    try {
      binStep = (await deps.readPool(f.poolAddress))?.binStep ?? null;
      if (binStep === null) pre.push("pool unreadable: bin_step unmeasured");
    } catch (err) {
      pre.push(`pool unreadable (${errText(err)}): bin_step unmeasured`);
    }
    try {
      feeBps = await deps.readTransferFeeBps(f.mint);
    } catch (err) {
      pre.push(`transfer fee unreadable (${errText(err)})`);
    }
    const row = await measureFailedOpenRoundTrip(
      {
        positionId: f.positionId,
        pairName: f.pairName,
        mint: f.mint,
        binStep,
        entryTvlUsd: f.entryTvlUsd,
        swapSignature: f.swapSignature,
        unwindSignature: f.unwindSignature,
        transferFeeBps: feeBps,
      },
      deps.readMeta,
    );
    row.notes.unshift(...pre);
    rows.push(row);
  }

  let inserted = 0;
  if (options.write) for (const row of rows) if (deps.insert(row)) inserted++;
  return { rows, inserted, skipped: options.write ? rows.length - inserted : 0 };
}

/** Minimal RFC-4180 reader for `exports/trades.csv` (quoted fields, embedded commas/newlines). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  const [header, ...body] = records;
  if (!header) return [];
  return body
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** Closed LIVE rows out of an exported trades CSV. Empty strings become null. */
export function closedLiveFromCsv(records: Array<Record<string, string>>): ClosedLivePositionRecord[] {
  const nz = (v: string | undefined) => (v === undefined || v === "" ? null : v);
  const num = (v: string | undefined) => (nz(v) === null ? null : Number(v));
  return records
    .filter((r) => r.execution_mode === "LIVE" && (r.status ?? "").startsWith("CLOSED") && nz(r.close_signature))
    .map((r) => ({
      position_id: r.position_id!,
      pool_address: r.pool_address!,
      pair_name: r.pair_name!,
      virtual_sol_amount: Number(r.virtual_sol_amount),
      entry_tvl: num(r.entry_tvl),
      exit_price: num(r.exit_price),
      residual_sweep: nz(r.residual_sweep),
      close_signature: nz(r.close_signature),
      sweep_signature: nz(r.sweep_signature),
      ata_close_signature: nz(r.ata_close_signature),
    }));
}
