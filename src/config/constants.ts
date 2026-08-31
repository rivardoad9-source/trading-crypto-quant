/** Cron expressions are evaluated in env.TZ (default Asia/Jakarta). */
export const CRON = {
  /** Daily macro research report at 07:00 WIB. */
  DAILY_MACRO: "0 7 * * *",
  /**
   * DLMM screener every 30 minutes: 600-pool scan, GeckoTerminal volume, DeepSeek.
   *
   * Every tick spends a deepseek-reasoner call, whose chain-of-thought dominates the
   * token bill; at 10 minutes the screener burned three times the tokens for entries
   * the anti-churn gates mostly refuse anyway (POOL_COOLDOWN_HOURS is measured in
   * hours, not minutes). This clock only governs when a NEW entry may be considered —
   * open positions are marked by FAST_MONITOR below and are unaffected.
   */
  DLMM_LOOP: "*/30 * * * *",
  /**
   * Position monitor every 60 seconds.
   *
   * Deliberately far faster than the screener, and independent of it. Exit thresholds
   * are only as tight as the interval that tests them: at 10 minutes the dry run
   * overshot a -8% stop-loss to -13.84%. This loop touches only open positions, so it
   * carries none of the screener's rate-limited upstreams and none of its LLM cost —
   * slowing the screener must never slow this.
   */
  FAST_MONITOR: "* * * * *",
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
  /** Emergency manual close via the Telegram /close_all command. */
  CLOSED_MANUAL: "CLOSED_MANUAL",
} as const;

export type PositionStatus = (typeof POSITION_STATUS)[keyof typeof POSITION_STATUS];

export const CLOSED_STATUSES: PositionStatus[] = [
  POSITION_STATUS.CLOSED_PROFIT,
  POSITION_STATUS.CLOSED_LOSS,
  POSITION_STATUS.CLOSED_OUT_OF_RANGE,
  POSITION_STATUS.CLOSED_TIMEOUT,
  POSITION_STATUS.CLOSED_MANUAL,
];

/**
 * Closes that count towards the per-pool circuit breaker.
 *
 * Deliberately narrower than CLOSED_STATUSES: a timeout is a neutral outcome (the
 * position simply aged out while still in range), a manual close is the operator's
 * decision rather than the pool's, and a profit obviously is not a failure. Only a
 * stop-loss or a range exit says the pool moved against the range we chose, which is
 * the pattern the lockout is meant to interrupt.
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

/**
 * Closes the anti-churn gates are allowed to see.
 *
 * CLOSED_MANUAL is excluded outright — it is the operator flattening the book with
 * Telegram /close_all, which says nothing about the pool. Two concrete reasons:
 *
 *  - Cooldown: benching every pool for POOL_COOLDOWN_HOURS after a /close_all would
 *    silently disable trading for hours immediately after an operator intervention,
 *    which is exactly when they are most likely to want it running again.
 *  - Lockout: the breaker is meant to measure what the POOL did to us. Letting a manual
 *    close either trip it or clear it would let the operator move the breaker by
 *    accident in whichever direction they happened to act.
 */
export const COOLDOWN_STATUSES: PositionStatus[] = CLOSED_STATUSES.filter(
  (s) => s !== POSITION_STATUS.CLOSED_MANUAL,
);

/**
 * The dashboard's (and Telegram /status) notional starting balance. The engine
 * deploys zero capital, so "balance" is a simulation baseline plus realised PnL,
 * not a custodial figure.
 */
export const STARTING_BALANCE_USD = 1000;

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
  /** Keyless Solana-native price oracle. Fallback when CoinGecko rate-limits. */
  JUPITER_PRICE: "https://lite-api.jup.ag/price/v3",
  /** One pair per path segment: .../pairs/solana/<poolAddress>. */
  DEXSCREENER_PAIRS: "https://api.dexscreener.com/latest/dex/pairs/solana",
} as const;

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * A deep SOL/USDC pool, used only as a last-resort price quote.
 *
 * Same pool the backtest uses for its SOL/USD bars, so the live engine and the harness
 * cannot end up quoting SOL from two different markets.
 */
export const SOL_USDC_POOL_ADDRESS = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
