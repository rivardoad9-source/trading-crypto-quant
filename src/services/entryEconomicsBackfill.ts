/**
 * Backfill for `entry_economics` — the entry side of `exitEconomicsBackfill`.
 *
 * Same contract: every candidate is measured from what the engine already stored (the swap
 * and open signatures, the pool price recorded at the entry decision, the sized notional),
 * nothing is guessed, and a leg that cannot be read stays null with a note. Insert-if-absent
 * on `position_id`, so running it twice writes once.
 *
 * The only time-sensitive field is the LANDING price: it is only a landing reference when it
 * is read shortly after the swap, so the caller passes a freshness budget and a late read
 * records null plus the reason instead of pretending to be one.
 */
import { measureEntryEconomics, type EntryEconomicsRow, type MetaReader } from "./entryEconomics.js";

/** How young a candidate must be for a pool read to count as a landing price. */
export const LANDING_PRICE_MAX_AGE_MS = 20 * 60 * 1000;

export interface EntryMeasurementCandidate {
  positionId: string;
  pairName: string;
  poolAddress: string;
  mint: string | null;
  notionalLamports: number | null;
  tvlUsdAtEntry: number | null;
  poolPriceAtEntry: number | null;
  swapSignature: string | null;
  openSignature: string | null;
  /** Set on a failed open: the rescue unwind that closed the half-open round trip. */
  unwindSignature?: string | null;
  /** Set on a failed open with no stored unwind signature: the attempt's recorded wallet delta. */
  recordedCostLamports?: number | null;
  /** Epoch ms of the attempt, when known — used only to decide landing-price freshness. */
  attemptedAtMs?: number | null;
}

export interface EntryBackfillDeps {
  readMeta: MetaReader;
  readPool(address: string): Promise<{ binStep: number; tvlUsd: number; currentPrice?: number | null } | null>;
  insert(row: EntryEconomicsRow): boolean;
  now?: () => number;
}

export interface EntryBackfillResult {
  rows: EntryEconomicsRow[];
  inserted: number;
  skipped: number;
}

export async function runEntryEconomicsBackfill(
  candidates: readonly EntryMeasurementCandidate[],
  deps: EntryBackfillDeps,
  options: { write: boolean; landingPriceMaxAgeMs?: number } = { write: true },
): Promise<EntryBackfillResult> {
  const now = deps.now ?? (() => Date.now());
  const maxAge = options.landingPriceMaxAgeMs ?? LANDING_PRICE_MAX_AGE_MS;
  const result: EntryBackfillResult = { rows: [], inserted: 0, skipped: 0 };

  for (const candidate of candidates) {
    let binStep: number | null = null;
    let tvlUsdAtEntry = candidate.tvlUsdAtEntry;
    let poolPriceAfterEntry: number | null = null;
    let landingPriceNote: string | null = null;

    const ageMs =
      candidate.attemptedAtMs === undefined || candidate.attemptedAtMs === null
        ? null
        : now() - candidate.attemptedAtMs;
    const fresh = ageMs !== null && ageMs >= 0 && ageMs <= maxAge;

    if (!candidate.poolAddress) {
      landingPriceNote = "pool address unknown: landing price and bin step not read";
    } else {
      /*
       * The pool is read either way: `bin_step` is a property of the pool and does not age.
       * The price and the TVL DO age — a read weeks after the entry is not a landing price
       * and not the entry TVL — so they are only used inside the freshness budget and the
       * refusal is written down instead of silently passing a stale number off as measured.
       */
      try {
        const pool = await deps.readPool(candidate.poolAddress);
        if (pool) {
          binStep = pool.binStep;
          if (ageMs === null) {
            landingPriceNote = "entry time unknown: landing price not read (cannot tell if it is still a landing)";
          } else if (!fresh) {
            landingPriceNote =
              `landing price not read: measured ${Math.round(ageMs / 60_000)} min after the entry, ` +
              `past the ${Math.round(maxAge / 60_000)} min freshness budget`;
            if (tvlUsdAtEntry === null) {
              landingPriceNote += "; TVL read now is not the entry TVL";
            }
          } else {
            if (tvlUsdAtEntry === null) tvlUsdAtEntry = pool.tvlUsd;
            const price = pool.currentPrice;
            if (typeof price === "number" && Number.isFinite(price) && price > 0) poolPriceAfterEntry = price;
            else landingPriceNote = "pool price after entry unusable (missing or non-positive)";
          }
        } else {
          landingPriceNote = "pool unreadable after entry: landing concession unmeasured";
        }
      } catch (err) {
        landingPriceNote = `pool unreadable after entry (${err instanceof Error ? err.message : String(err)}): landing concession unmeasured`;
      }
    }

    const row = await measureEntryEconomics(
      {
        positionId: candidate.positionId,
        pairName: candidate.pairName,
        mint: candidate.mint,
        binStep,
        notionalLamports: candidate.notionalLamports,
        tvlUsdAtEntry,
        poolPriceAtEntry: candidate.poolPriceAtEntry,
        swapSignature: candidate.swapSignature,
        openSignature: candidate.openSignature,
        unwindSignature: candidate.unwindSignature ?? null,
        recordedCostLamports: candidate.recordedCostLamports ?? null,
        poolPriceAfterEntry,
        landingPriceNote,
        source: "backfill",
      },
      deps.readMeta,
    );

    result.rows.push(row);
    if (!options.write) continue;
    if (deps.insert(row)) result.inserted += 1;
    else result.skipped += 1;
  }

  return result;
}
