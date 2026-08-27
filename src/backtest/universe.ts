import { z } from "zod";
import { env } from "../config/env.js";
import { ENDPOINTS } from "../config/constants.js";
import { getJson } from "../services/http.js";

/**
 * Point-in-time pool universe construction.
 *
 * The naive approach — take today's top-ranked pools and replay them — is
 * survivorship-biased by construction: a pool can only be sampled if it survived to
 * the present and still ranks. Every rug, drain and slow death is invisible.
 *
 * The fix rests on one verified fact: Meteora's pool listing is NOT pruned. It
 * returns ~123k pools including ones created 600+ days ago that now report tvl = 0
 * and volume = 0. Dead pools are therefore reachable — they are simply not near the
 * top of a volume sort.
 *
 * Two cohorts are combined:
 *
 *  1. SURVIVORS — today's high-volume pools (what the biased harness would pick).
 *  2. DEAD/DORMANT — pools created before the window whose *lifetime* volume shows
 *     they were once genuinely active, but whose current volume has collapsed.
 *
 * `cumulative_metrics.volume` makes cohort 2 findable without an extra request per
 * pool, and `pool_created_at` is sortable, so the cohort that existed during the
 * window can be walked directly.
 */

const TokenSchema = z
  .object({
    address: z.string(),
    symbol: z.string().default(""),
    is_verified: z.boolean().default(false),
  })
  .passthrough();

const UniversePoolSchema = z
  .object({
    address: z.string(),
    name: z.string(),
    token_x: TokenSchema,
    token_y: TokenSchema,
    created_at: z.number().default(0),
    pool_config: z.object({ bin_step: z.number().default(0), base_fee_pct: z.number().default(0) }).passthrough(),
    tvl: z.number().default(0),
    current_price: z.number().default(0),
    volume: z.object({ "24h": z.number().default(0) }).passthrough(),
    fees: z.object({ "24h": z.number().default(0) }).passthrough(),
    cumulative_metrics: z
      .object({ volume: z.number().default(0), fees: z.number().default(0) })
      .passthrough()
      .default({ volume: 0, fees: 0 }),
    is_blacklisted: z.boolean().default(false),
  })
  .passthrough();

const ResponseSchema = z.object({
  total: z.number(),
  data: z.array(UniversePoolSchema),
});

export type Cohort = "survivor" | "dead-or-dormant";

export interface UniversePool {
  address: string;
  pairName: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseMint: string;
  quoteMint: string;
  createdAtMs: number;
  binStep: number;
  /** Base fee as a fraction (0.0004 === 0.04%). */
  feeRate: number;
  tvlTodayUsd: number;
  volume24hTodayUsd: number;
  lifetimeVolumeUsd: number;
  bothTokensVerified: boolean;
  isBlacklisted: boolean;
  cohort: Cohort;
}

function toUniversePool(raw: z.infer<typeof UniversePoolSchema>, cohort: Cohort): UniversePool {
  return {
    address: raw.address,
    pairName: raw.name,
    baseSymbol: raw.token_x.symbol,
    quoteSymbol: raw.token_y.symbol,
    baseMint: raw.token_x.address,
    quoteMint: raw.token_y.address,
    createdAtMs: raw.created_at,
    binStep: raw.pool_config.bin_step,
    feeRate: raw.pool_config.base_fee_pct / 100,
    tvlTodayUsd: raw.tvl,
    volume24hTodayUsd: raw.volume["24h"] ?? 0,
    lifetimeVolumeUsd: raw.cumulative_metrics.volume,
    bothTokensVerified: raw.token_x.is_verified && raw.token_y.is_verified,
    isBlacklisted: raw.is_blacklisted,
    cohort,
  };
}

async function fetchPage(
  page: number,
  pageSize: number,
  sortBy: string,
): Promise<z.infer<typeof ResponseSchema>> {
  const url =
    `${env.METEORA_API_URL}${ENDPOINTS.METEORA_POOLS}` +
    `?page=${page}&page_size=${pageSize}&sort_by=${encodeURIComponent(sortBy)}`;
  return ResponseSchema.parse(await getJson<unknown>(url));
}

export interface UniverseOptions {
  windowDays: number;
  /** Pages of today's volume leaders to scan. */
  survivorPages?: number;
  /** Pages of the creation-ordered cohort to scan for dead pools. */
  cohortPages?: number;
  pageSize?: number;
  /**
   * Lifetime volume a now-quiet pool must have accumulated to count as "was once
   * genuinely active" rather than a pool that never traded at all.
   */
  minLifetimeVolumeUsd?: number;
}

export interface UniverseResult {
  pools: UniversePool[];
  survivors: number;
  deadOrDormant: number;
  scanned: number;
  totalUniverseSize: number;
}

/** A pool whose current activity has collapsed relative to its lifetime record. */
function looksDeadOrDormant(p: UniversePool): boolean {
  if (p.volume24hTodayUsd <= 0) return true;
  if (p.tvlTodayUsd <= 0) return true;
  // Lifetime volume dwarfs a full day of current volume by 3 orders of magnitude.
  return p.lifetimeVolumeUsd > 0 && p.volume24hTodayUsd < p.lifetimeVolumeUsd / 1000;
}

/**
 * Builds the candidate universe for a backtest window.
 *
 * Pools created AFTER the window started are kept — a pool that launched mid-window,
 * pumped and rugged is exactly the case the biased harness misses. Pools whose
 * creation postdates the window end are impossible and are dropped.
 */
export async function buildPointInTimeUniverse(options: UniverseOptions): Promise<UniverseResult> {
  const pageSize = options.pageSize ?? 200;
  const survivorPages = options.survivorPages ?? 3;
  const cohortPages = options.cohortPages ?? 12;
  const minLifetimeVolumeUsd = options.minLifetimeVolumeUsd ?? 250_000;

  const windowStartMs = Date.now() - options.windowDays * 24 * 3600 * 1000;

  const byAddress = new Map<string, UniversePool>();
  let scanned = 0;
  let totalUniverseSize = 0;

  /* ---- Cohort 1: today's volume leaders (the survivor set) ---- */
  for (let page = 1; page <= survivorPages; page++) {
    const res = await fetchPage(page, pageSize, "volume_24h:desc");
    totalUniverseSize = res.total;
    scanned += res.data.length;

    for (const raw of res.data) {
      const pool = toUniversePool(raw, "survivor");
      if (pool.createdAtMs > Date.now()) continue;
      byAddress.set(pool.address, pool);
    }
    if (res.data.length < pageSize) break;
  }

  /* ---- Cohort 2: pools created around the window, including dead ones ---- */
  for (let page = 1; page <= cohortPages; page++) {
    const res = await fetchPage(page, pageSize, "pool_created_at:desc");
    totalUniverseSize = res.total;
    scanned += res.data.length;

    let reachedOlderThanWindow = false;

    for (const raw of res.data) {
      const candidate = toUniversePool(raw, "dead-or-dormant");

      // Creation-ordered descending: once well past the window start, stop paging.
      if (candidate.createdAtMs > 0 && candidate.createdAtMs < windowStartMs) {
        reachedOlderThanWindow = true;
      }

      if (byAddress.has(candidate.address)) continue; // already a survivor
      if (candidate.isBlacklisted) continue;
      if (candidate.lifetimeVolumeUsd < minLifetimeVolumeUsd) continue;
      if (!looksDeadOrDormant(candidate)) continue;

      byAddress.set(candidate.address, candidate);
    }

    if (res.data.length < pageSize) break;
    // Keep going a little past the window start so the cohort is fully covered.
    if (reachedOlderThanWindow && page >= 4) break;
  }

  const pools = [...byAddress.values()];

  return {
    pools,
    survivors: pools.filter((p) => p.cohort === "survivor").length,
    deadOrDormant: pools.filter((p) => p.cohort === "dead-or-dormant").length,
    scanned,
    totalUniverseSize,
  };
}
