/** Cron expressions are evaluated in env.TZ (default Asia/Jakarta). */
export const CRON = {
  /** Daily macro research report at 07:00 WIB. */
  DAILY_MACRO: "0 7 * * *",
  /**
   * The screener's TICK: every 5 minutes. The tick is NOT the cadence — see
   * `DLMM_BASE_CADENCE_MIN` and `src/services/screenerCadence.ts`.
   *
   * Every tick that actually reaches the screener spends a deepseek-reasoner call, whose
   * chain-of-thought dominates the token bill; at 10 minutes the screener burned three
   * times the tokens for entries the anti-churn gates mostly refuse anyway
   * (POOL_COOLDOWN_HOURS is measured in hours, not minutes). This clock only governs when
   * a NEW entry may be considered — open positions are marked by FAST_MONITOR below and
   * are unaffected.
   *
   * A 5-minute tick on a 20-minute base cadence costs what the 20-minute clock cost: the
   * off-cadence ticks return before touching the screener, the upstreams or DeepSeek. It
   * buys the one thing a fixed clock cannot have — a bounded window right after a macro
   * release where the engine may run every 5 minutes instead of arriving up to 20 minutes
   * late. See `DLMM_POST_NEWS_FAST_MIN`.
   */
  DLMM_TICK: "*/5 * * * *",
  /**
   * The wallet-vs-capital and wallet-vs-book checks, hourly, LIVE ONLY.
   *
   * Deliberately slower than every other clock in this object. Both quantities move
   * slowly — a wallet is eroded by fees and rent, a book steps on a close — and each
   * run costs an RPC balance read and a SOL/USD quote, which is the same endpoint the
   * dashboard's health widget already rate-limits itself against. Hourly is often
   * enough that a `LIVE_CAPITAL_SOL` gone stale is caught within one screener cadence
   * of it mattering, and rare enough that it cannot become the reason a provider starts
   * answering 429.
   *
   * It is not the enforcement. `openLivePosition` re-reads the balance and refuses at
   * the spend; this is the clock that tells an operator BEFORE an entry is refused.
   */
  CAPITAL_HEALTH: "7 * * * *",
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

/**
 * The screener's NORMAL cadence, in minutes, measured against the tick above.
 *
 * A tick whose minute-of-hour is not a multiple of this returns immediately, so the heavy
 * cycle runs three times an hour (minutes 0, 20 and 40 of every hour) and spends exactly
 * three deepseek-reasoner calls an hour. Only `DLMM_POST_NEWS_FAST_MIN` widens it,
 * deliberately, in a bounded window. Not an env var: `liveConfig.ts` must not grow a
 * clock of its own, or "V1.1" would name two configurations depending on a flag.
 *
 * CHANGED 19 Sep 2026 (operator's call): 30 -> 20 minutes. The V1.1 baseline asserted
 * "twice an hour"; the operator chose to pay a 50% higher screener bill to arrive at most
 * 20 minutes late instead of 30. The TICK is untouched at 5 minutes and 20 is a multiple
 * of 5, so every mark is still hit by a tick exactly: the tick/cadence split, the
 * off-cadence early return and the post-news fast window are all unchanged, only the base
 * moved. The new value is pinned in `v11Baseline.test.ts`, `screenerCadence.test.ts` and
 * `deepseekBudget.test.ts`.
 */
export const DLMM_BASE_CADENCE_MIN = 20;

/**
 * How long after a macro-news window closes the screener runs on the 5-minute tick
 * instead of the 20-minute base cadence.
 *
 * WHY FAST AFTER, AND NEVER DURING. The release itself is the worst moment to open a
 * range — that is what the entry blackout exists for (SOL crosses several bins in
 * seconds, the same drift `ActiveBinRaceError` refuses an entry over). The window AFTER
 * it is the opposite: SOL has just been re-priced a few per cent, ranges have been
 * rewritten, and fee flow is at its highest — the conditions this strategy is built for.
 * A 20-minute clock can still spend the whole move waiting for its next tick.
 *
 * WHY BOUNDED, AND WHY 90. Every tick that reaches the screener is a DeepSeek call, so an
 * unbounded fast cadence would be a permanent 6x token bill for a condition that is
 * interesting for about an hour. 90 minutes is the operator's call (10 Sep 2026): it
 * covers the release reaction and the first range reset, and hands the engine back to its
 * normal clock before the fast stretch can become the way it always trades.
 */
export const DLMM_POST_NEWS_FAST_MIN = 90;

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
 * FALLBACK starting balance for the dashboard and Telegram /status.
 *
 * The engine deploys zero capital, so "balance" is a simulation baseline plus realised
 * PnL, never a custodial figure. This is only the default: the effective value is
 * resolved at boot by `src/config/startingBalance.ts`, which prefers an explicit
 * STARTING_BALANCE_USD or a live wallet seed. Read it through
 * `getStartingBalanceUsd()` — importing this constant directly pins a caller to $1,000
 * while the rest of the process reports against the operator's real funding.
 */
export const DEFAULT_STARTING_BALANCE_USD = 1000;

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
