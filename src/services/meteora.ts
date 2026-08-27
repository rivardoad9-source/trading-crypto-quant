import { z } from "zod";
import { env } from "../config/env.js";
import { ENDPOINTS } from "../config/constants.js";
import { getJson } from "./http.js";

/* ------------------------------------------------------------------ */
/* Raw API shapes                                                      */
/* ------------------------------------------------------------------ */

const TokenSchema = z.object({
  address: z.string(),
  name: z.string().default(""),
  symbol: z.string().default(""),
  decimals: z.number().default(0),
  is_verified: z.boolean().default(false),
  holders: z.number().default(0),
  freeze_authority_disabled: z.boolean().default(false),
  price: z.number().default(0),
  market_cap: z.number().default(0),
});

const BucketSchema = z
  .object({
    "30m": z.number().default(0),
    "1h": z.number().default(0),
    "24h": z.number().default(0),
  })
  .passthrough();

const RawPoolSchema = z
  .object({
    address: z.string(),
    name: z.string(),
    token_x: TokenSchema,
    token_y: TokenSchema,
    created_at: z.number().default(0),
    pool_config: z
      .object({
        bin_step: z.number().default(0),
        base_fee_pct: z.number().default(0),
      })
      .passthrough(),
    tvl: z.number().default(0),
    current_price: z.number().default(0),
    apr: z.number().default(0),
    apy: z.number().default(0),
    volume: BucketSchema,
    fees: BucketSchema,
    is_blacklisted: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
  })
  .passthrough();

const PoolsResponseSchema = z.object({
  total: z.number(),
  pages: z.number(),
  current_page: z.number(),
  page_size: z.number(),
  data: z.array(RawPoolSchema),
});

export type RawPool = z.infer<typeof RawPoolSchema>;

/* ------------------------------------------------------------------ */
/* Normalised domain model                                             */
/* ------------------------------------------------------------------ */

export interface DlmmPool {
  address: string;
  pairName: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseMint: string;
  quoteMint: string;
  binStep: number;
  baseFeePct: number;
  tvlUsd: number;
  currentPrice: number;
  volume24hUsd: number;
  volume1hUsd: number;
  fees24hUsd: number;
  /**
   * Fee-to-TVL as a RATIO over 24h (0.008 === 0.8%).
   *
   * Computed locally as fees.24h / tvl. The upstream `fee_tvl_ratio.24h` field is
   * expressed in PERCENT (0.4877 means 0.4877%), so comparing it directly against a
   * ratio threshold like 0.008 would pass essentially every pool. Do not swap this
   * for the API field without rescaling by 100.
   */
  feeTvlRatio24h: number;
  /** Annualised from the 24h fee ratio, expressed as a percentage. */
  estimatedAprPct: number;
  bothTokensVerified: boolean;
  isBlacklisted: boolean;
  ageHours: number;
  tags: string[];
}

function toDomain(raw: RawPool): DlmmPool {
  const tvl = raw.tvl;
  const fees24h = raw.fees["24h"] ?? 0;

  // Guard against the tvl === 0 pools the upstream feed is full of; dividing by
  // them yields ratios in the billions and poisons any ranking built on them.
  const feeTvlRatio24h = tvl > 0 ? fees24h / tvl : 0;

  const createdAtMs = raw.created_at;
  const ageHours =
    createdAtMs > 0 ? Math.max(0, (Date.now() - createdAtMs) / (1000 * 60 * 60)) : Number.NaN;

  return {
    address: raw.address,
    pairName: raw.name,
    baseSymbol: raw.token_x.symbol,
    quoteSymbol: raw.token_y.symbol,
    baseMint: raw.token_x.address,
    quoteMint: raw.token_y.address,
    binStep: raw.pool_config.bin_step,
    baseFeePct: raw.pool_config.base_fee_pct,
    tvlUsd: tvl,
    currentPrice: raw.current_price,
    volume24hUsd: raw.volume["24h"] ?? 0,
    volume1hUsd: raw.volume["1h"] ?? 0,
    fees24hUsd: fees24h,
    feeTvlRatio24h,
    estimatedAprPct: feeTvlRatio24h * 365 * 100,
    bothTokensVerified: raw.token_x.is_verified && raw.token_y.is_verified,
    isBlacklisted: raw.is_blacklisted,
    ageHours,
    tags: raw.tags,
  };
}

/* ------------------------------------------------------------------ */
/* Fetchers                                                            */
/* ------------------------------------------------------------------ */

export interface FetchPoolsOptions {
  /** Pools per page (upstream accepts at least 200). */
  pageSize?: number;
  /** How many pages to walk. Total pools scanned = pageSize * pages. */
  pages?: number;
  /**
   * Upstream sort, `<field>:<asc|desc>`. Defaults to volume because sorting by
   * fee_tvl_ratio_24h upstream returns zero-TVL junk at the top.
   */
  sortBy?: string;
}

export async function fetchLivePools(options: FetchPoolsOptions = {}): Promise<DlmmPool[]> {
  const pageSize = options.pageSize ?? 200;
  const pages = options.pages ?? 3;
  const sortBy = options.sortBy ?? "volume_24h:desc";

  const collected: DlmmPool[] = [];

  for (let page = 1; page <= pages; page++) {
    const url =
      `${env.METEORA_API_URL}${ENDPOINTS.METEORA_POOLS}` +
      `?page=${page}&page_size=${pageSize}&sort_by=${encodeURIComponent(sortBy)}`;

    const parsed = PoolsResponseSchema.parse(await getJson<unknown>(url));
    collected.push(...parsed.data.map(toDomain));

    if (parsed.data.length < pageSize) break; // last page
  }

  return collected;
}

/** Fetches a single pool's live state, used by the position monitor. */
export async function fetchPoolByAddress(address: string): Promise<DlmmPool | null> {
  const url = `${env.METEORA_API_URL}${ENDPOINTS.METEORA_POOLS}/${address}`;
  try {
    const raw = await getJson<unknown>(url);
    // The endpoint returns the pool object directly, but tolerate a wrapper.
    const candidate =
      typeof raw === "object" && raw !== null && "data" in raw
        ? (raw as { data: unknown }).data
        : raw;
    return toDomain(RawPoolSchema.parse(candidate));
  } catch (err) {
    console.warn(
      `[meteora] pool ${address} lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Quantitative screening                                              */
/* ------------------------------------------------------------------ */

export interface ScreenerThresholds {
  minVolume24hUsd: number;
  minFeeTvlRatio24h: number;
  maxFeeTvlRatio24h: number;
  minTvlUsd: number;
  /** Upper TVL bound — above it fee income is too thin to cover costs. */
  maxTvlUsd: number;
  /** Pools younger than this are rejected outright. */
  minPoolAgeHours: number;
  requireVerifiedTokens: boolean;
}

export const defaultThresholds = (): ScreenerThresholds => ({
  minVolume24hUsd: env.MIN_24H_VOLUME_USD,
  minFeeTvlRatio24h: env.MIN_FEE_TVL_RATIO,
  maxFeeTvlRatio24h: env.MAX_FEE_TVL_RATIO,
  minTvlUsd: env.MIN_TVL_USD,
  maxTvlUsd: env.MAX_TVL_USD,
  minPoolAgeHours: env.MIN_POOL_AGE_HOURS,
  requireVerifiedTokens: true,
});

export interface ScreenedPool extends DlmmPool {
  /** Ranking score: (fee/TVL) * 24h volume. Higher is better. */
  score: number;
}

export interface ScreenResult {
  candidates: ScreenedPool[];
  scanned: number;
  rejected: Record<string, number>;
}

/**
 * Applies the hard quantitative filters from the PRD, then ranks survivors by
 * (fee/TVL) * volume so that both fee efficiency and raw activity matter.
 */
export function screenPools(
  pools: DlmmPool[],
  thresholds: ScreenerThresholds = defaultThresholds(),
): ScreenResult {
  const rejected: Record<string, number> = {
    blacklisted: 0,
    unverifiedToken: 0,
    lowTvl: 0,
    lowVolume: 0,
    lowFeeRatio: 0,
    feeRatioOutlier: 0,
    badPrice: 0,
    highTvl: 0,
    tooYoung: 0,
    ageUnknown: 0,
  };

  const survivors: ScreenedPool[] = [];

  for (const pool of pools) {
    if (pool.isBlacklisted) {
      rejected.blacklisted = (rejected.blacklisted ?? 0) + 1;
      continue;
    }
    if (thresholds.requireVerifiedTokens && !pool.bothTokensVerified) {
      rejected.unverifiedToken = (rejected.unverifiedToken ?? 0) + 1;
      continue;
    }
    if (!(pool.currentPrice > 0) || !Number.isFinite(pool.currentPrice)) {
      rejected.badPrice = (rejected.badPrice ?? 0) + 1;
      continue;
    }
    if (pool.tvlUsd < thresholds.minTvlUsd) {
      rejected.lowTvl = (rejected.lowTvl ?? 0) + 1;
      continue;
    }
    // Above the sweet spot fees are too thin: the >$500k bucket averaged 0.00% net.
    if (pool.tvlUsd > thresholds.maxTvlUsd) {
      rejected.highTvl = (rejected.highTvl ?? 0) + 1;
      continue;
    }
    /*
     * Age gate. An unknown age is rejected, not waved through: pools under 48h old
     * carried a 7.3x lift in the rate of losses worse than -10%, and "not measured"
     * must never resolve to "fine".
     */
    if (!Number.isFinite(pool.ageHours)) {
      rejected.ageUnknown = (rejected.ageUnknown ?? 0) + 1;
      continue;
    }
    if (pool.ageHours < thresholds.minPoolAgeHours) {
      rejected.tooYoung = (rejected.tooYoung ?? 0) + 1;
      continue;
    }
    if (pool.volume24hUsd < thresholds.minVolume24hUsd) {
      rejected.lowVolume = (rejected.lowVolume ?? 0) + 1;
      continue;
    }
    if (pool.feeTvlRatio24h < thresholds.minFeeTvlRatio24h) {
      rejected.lowFeeRatio = (rejected.lowFeeRatio ?? 0) + 1;
      continue;
    }
    // Reject implausible yields before they dominate the ranking. See MAX_FEE_TVL_RATIO.
    if (pool.feeTvlRatio24h > thresholds.maxFeeTvlRatio24h) {
      rejected.feeRatioOutlier = (rejected.feeRatioOutlier ?? 0) + 1;
      continue;
    }

    survivors.push({ ...pool, score: pool.feeTvlRatio24h * pool.volume24hUsd });
  }

  survivors.sort((a, b) => b.score - a.score);

  return { candidates: survivors, scanned: pools.length, rejected };
}

/* ------------------------------------------------------------------ */
/* Token identification                                                */
/* ------------------------------------------------------------------ */

/** Mints that act as the quote leg and never need an anti-rug screen. */
export const QUOTE_MINTS: ReadonlySet<string> = new Set([
  "So11111111111111111111111111111111111111112", // Wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/**
 * The mint worth screening for rug risk: the non-quote leg.
 *
 * Returns null when both legs are known quote assets (e.g. SOL-USDC) — there is
 * nothing to screen, which is a pass, not a failure.
 */
export function riskMintOf(pool: Pick<DlmmPool, "baseMint" | "quoteMint">): string | null {
  const baseIsQuote = QUOTE_MINTS.has(pool.baseMint);
  const quoteIsQuote = QUOTE_MINTS.has(pool.quoteMint);

  if (baseIsQuote && quoteIsQuote) return null;
  if (baseIsQuote) return pool.quoteMint;
  if (quoteIsQuote) return pool.baseMint;

  // Neither leg is a recognised quote asset; screen the base leg.
  return pool.baseMint;
}

/* ------------------------------------------------------------------ */
/* Position maths                                                      */
/* ------------------------------------------------------------------ */

/** A DLMM position stops earning once price leaves [lower, upper]. */
export function isOutOfRange(price: number, lower: number, upper: number): boolean {
  return price < lower || price > upper;
}

/**
 * Fraction of a rebalance window the price actually spent in range. DLMM only
 * accrues fees while active, so an out-of-range position earns nothing.
 */
export function inRangeFactor(price: number, lower: number, upper: number): number {
  return isOutOfRange(price, lower, upper) ? 0 : 1;
}

/**
 * Fees earned by a position over `hours`, assuming the position's liquidity is a
 * constant share of pool TVL and the pool's 24h fee rate persists.
 *
 * fee = positionValue * feeTvlRatio24h * (hours / 24)
 *
 * This is deliberately a *pool-level* approximation: without per-bin liquidity
 * depth it is not possible to model concentration multipliers accurately, so a
 * concentrated range is NOT credited with extra fees here. Treat the result as a
 * conservative lower bound.
 */
export function estimateFeeYieldUsd(
  positionValueUsd: number,
  feeTvlRatio24h: number,
  hours: number,
  active: boolean,
): number {
  if (!active || hours <= 0) return 0;
  return positionValueUsd * feeTvlRatio24h * (hours / 24);
}

/**
 * Impermanent loss for a 50/50-equivalent LP against holding, using the standard
 * constant-product formula. `priceRatio` is currentPrice / entryPrice.
 *
 * IL_fraction = 2*sqrt(r)/(1+r) - 1   (a negative number, or 0 when r === 1)
 */
export function impermanentLossFraction(priceRatio: number): number {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return 0;
  return (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
}

/**
 * Return of the LP position itself against the capital deployed, excluding fees.
 *
 *   V_t / V_0 = sqrt(r)   =>   return = sqrt(r) - 1
 *
 * THIS IS NOT impermanentLossFraction. That one measures how far the LP trails a
 * buy-and-hold of the same two assets; this one measures what actually happened to
 * the money. They diverge sharply on large moves — a token that halves gives
 * -5.7% against holding but -29.3% against capital — so an account balance must be
 * marked with this function, never with the divergence figure.
 *
 * At r -> 0 (a rug) this tends to -100%, which is the correct total loss.
 */
export function lpValueReturnFraction(priceRatio: number): number {
  if (!Number.isFinite(priceRatio) || priceRatio < 0) return 0;
  if (priceRatio === 0) return -1;
  return Math.sqrt(priceRatio) - 1;
}

export interface PositionValuation {
  currentPrice: number;
  priceRatio: number;
  /**
   * Change in the LP position's value against the capital deployed, excluding fees:
   * notional x (sqrt(r) - 1). This is what moves the account balance.
   */
  positionValueChangeUsd: number;
  /**
   * How far the LP trailed simply holding both tokens. DIAGNOSTIC ONLY — it is not
   * part of net PnL. Reporting this as PnL understates real losses badly: a token
   * that halves reads -5.7% here but -29.3% against capital.
   */
  divergenceVsHoldUsd: number;
  feeYieldUsd: number;
  /** feeYield + positionValueChange. The actual profit or loss on deployed capital. */
  netPnlUsd: number;
  netPnlPct: number;
  inRange: boolean;
}

/**
 * Values a simulated position. `accruedFeeUsd` is the running total carried on the
 * row, so callers pass the previously stored value plus this interval's accrual.
 */
export function valuePosition(params: {
  positionValueUsd: number;
  entryPrice: number;
  currentPrice: number;
  lowerBinPrice: number;
  upperBinPrice: number;
  accruedFeeUsd: number;
}): PositionValuation {
  const { positionValueUsd, entryPrice, currentPrice, lowerBinPrice, upperBinPrice, accruedFeeUsd } =
    params;

  const priceRatio = entryPrice > 0 ? currentPrice / entryPrice : 1;
  const inRange = !isOutOfRange(currentPrice, lowerBinPrice, upperBinPrice);

  // Net PnL is driven by the LP's value against capital, NOT by divergence-vs-hold.
  // The two diverge sharply on large moves and only the former is real money.
  const positionValueChangeUsd = positionValueUsd * lpValueReturnFraction(priceRatio);
  const divergenceVsHoldUsd = positionValueUsd * impermanentLossFraction(priceRatio);

  const netPnlUsd = accruedFeeUsd + positionValueChangeUsd;

  return {
    currentPrice,
    priceRatio,
    positionValueChangeUsd,
    divergenceVsHoldUsd,
    feeYieldUsd: accruedFeeUsd,
    netPnlUsd,
    netPnlPct: positionValueUsd > 0 ? (netPnlUsd / positionValueUsd) * 100 : 0,
    inRange,
  };
}

/* ------------------------------------------------------------------ */
/* Friction                                                            */
/* ------------------------------------------------------------------ */

export interface BreakevenAssessment {
  /** Estimated fees over 24h at the pool's current rate. */
  expectedFee24hUsd: number;
  /** Gas for open + close, plus the slippage a forced exit would cost. */
  roundTripCostUsd: number;
  /** expectedFee24h / roundTripCost. Higher is safer. */
  coverageRatio: number;
  passes: boolean;
}

/**
 * Rejects pools whose plausible fee income cannot clear the cost of getting in and
 * out several times over.
 *
 * A 30-day unbiased backtest showed gas plus slippage ($74.80) exceeding every dollar
 * of fees earned ($55.25) on a $100 account: the strategy was paying more to trade
 * than LPing returned. This gate is the direct fix.
 */
export function assessBreakeven(params: {
  notionalUsd: number;
  feeTvlRatio24h: number;
  gasCostRoundTripUsd: number;
  slippagePct: number;
  minCoverageRatio: number;
}): BreakevenAssessment {
  const { notionalUsd, feeTvlRatio24h, gasCostRoundTripUsd, slippagePct, minCoverageRatio } =
    params;

  const expectedFee24hUsd = notionalUsd * feeTvlRatio24h;
  const slippageUsd = notionalUsd * (slippagePct / 100);
  const roundTripCostUsd = gasCostRoundTripUsd + slippageUsd;

  const coverageRatio = roundTripCostUsd > 0 ? expectedFee24hUsd / roundTripCostUsd : Infinity;

  return {
    expectedFee24hUsd,
    roundTripCostUsd,
    coverageRatio,
    passes: coverageRatio >= minCoverageRatio,
  };
}
