/** Cron expressions are evaluated in env.TZ (default Asia/Jakarta). */
export const CRON = {
  /** Daily macro research report at 07:00 WIB. */
  DAILY_MACRO: "0 7 * * *",
  /** DLMM screener + position monitor every 10 minutes. */
  DLMM_LOOP: "*/10 * * * *",
  /** Roll up closed trades into daily_pnl_snapshots just before midnight. */
  DAILY_SNAPSHOT: "55 23 * * *",
} as const;

export const MAX_CANDIDATE_POOLS = 3;

/** Meteora DLMM charges fees per swap; APR figures from the API are 24h-based. */
export const HOURS_PER_YEAR = 24 * 365;

export const HTTP_TIMEOUT_MS = 20_000;
export const HTTP_RETRIES = 2;

export const POSITION_STATUS = {
  ACTIVE: "ACTIVE",
  CLOSED_PROFIT: "CLOSED_PROFIT",
  CLOSED_LOSS: "CLOSED_LOSS",
  CLOSED_OUT_OF_RANGE: "CLOSED_OUT_OF_RANGE",
  CLOSED_TIMEOUT: "CLOSED_TIMEOUT",
} as const;

export type PositionStatus = (typeof POSITION_STATUS)[keyof typeof POSITION_STATUS];

export const CLOSED_STATUSES: PositionStatus[] = [
  POSITION_STATUS.CLOSED_PROFIT,
  POSITION_STATUS.CLOSED_LOSS,
  POSITION_STATUS.CLOSED_OUT_OF_RANGE,
  POSITION_STATUS.CLOSED_TIMEOUT,
];

/**
 * Closes that count towards the per-pool circuit breaker.
 *
 * Deliberately narrower than CLOSED_STATUSES: a timeout is a neutral outcome (the
 * position simply aged out while still in range) and a profit obviously is not a
 * failure. Only a stop-loss or a range exit says the pool moved against the range we
 * chose, which is the pattern the lockout is meant to interrupt.
 *
 * Note that with the default STOP_LOSS_PCT the stop is nearly unreachable, so in
 * practice the run is built almost entirely out of CLOSED_OUT_OF_RANGE.
 */
export const FAILURE_STATUSES: PositionStatus[] = [
  POSITION_STATUS.CLOSED_LOSS,
  POSITION_STATUS.CLOSED_OUT_OF_RANGE,
];

export function isFailureStatus(status: string): boolean {
  return (FAILURE_STATUSES as string[]).includes(status);
}

export const STRATEGY_TYPES = ["SPOT", "BID_ASK", "CURVE"] as const;
export type StrategyType = (typeof STRATEGY_TYPES)[number];

/** External data sources. */
export const ENDPOINTS = {
  FEAR_GREED: "https://api.alternative.me/fng/?limit=1",
  DEXSCREENER_BOOSTS: "https://api.dexscreener.com/token-boosts/top/v1",
  DEXSCREENER_SEARCH: "https://api.dexscreener.com/latest/dex/search",
  COINGECKO_SIMPLE_PRICE: "https://api.coingecko.com/api/v3/simple/price",
  COINGECKO_GLOBAL: "https://api.coingecko.com/api/v3/global",
  /** Appended to env.METEORA_API_URL. Supports ?page, ?page_size, ?sort_by=<field>:<asc|desc>. */
  METEORA_POOLS: "/pools",
} as const;
