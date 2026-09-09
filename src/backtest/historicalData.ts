import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getJson } from "../services/http.js";
import { buildPointInTimeUniverse, type UniversePool } from "./universe.js";

/**
 * Historical ingestion for the backtest.
 *
 * Price and volume come from GeckoTerminal (free, no API key), which serves up to
 * 1000 hourly OHLCV bars per request and paginates further back with
 * `before_timestamp`.
 *
 * The pool universe comes from `universe.ts`, which deliberately includes pools that
 * are dead today. See BACKTEST_CAVEATS for what is measured and what is modelled.
 */

const GECKO_FREE_BASE = "https://api.geckoterminal.com/api/v2";
/**
 * CoinGecko Pro fronts the same GeckoTerminal data under /onchain, and is the only
 * way to read OHLCV older than the free tier's window. Read straight from
 * `process.env` rather than the Zod schema, the same way FRED_API_KEY is, so it stays
 * genuinely optional and its absence is never a boot failure.
 *
 * NOTE: this path has not been exercised in this repository — no key is configured.
 * It is the documented request shape, not a verified one. The keyless path below is
 * the one every existing result was produced with and is unchanged.
 */
const GECKO_PRO_BASE = "https://pro-api.coingecko.com/api/v3/onchain";
const NETWORK = "solana";

const proApiKey = (): string | null => {
  const key = process.env.COINGECKO_PRO_API_KEY?.trim();
  return key ? key : null;
};

const geckoBase = (): string => (proApiKey() ? GECKO_PRO_BASE : GECKO_FREE_BASE);

/**
 * How far back hourly OHLCV is actually available.
 *
 * MEASURED against the live free endpoint on 2026-09-01: paginating back yields
 * about 4,996 hourly bars per pool (~208 days, reaching early February 2026) and
 * every deeper `before_timestamp` answers HTTP 401 — the upstream's "this range needs
 * a paid plan" response, not an auth fault, since the same request without
 * `before_timestamp` succeeds. Daily aggregation is capped at the same depth, so
 * switching timeframe does not buy history. A window longer than this cannot be
 * simulated without a paid key, and the runner must say so rather than quietly
 * returning a shorter series.
 */
export const FREE_TIER_HISTORY_DAYS = 208;

/** Wrapped SOL / USDC — used as the SOL/USD reference series. */
export const SOL_USDC_POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";

export const CACHE_PATH = ".cache/historical_data.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const BACKTEST_CAVEATS = [
  "MODELLED TVL — the load-bearing assumption. No free provider serves historical TVL for Meteora DLMM pools, so TVL at each bar is estimated as k x trailing-24h-volume, with k fitted per pool where observable and otherwise from the live cross-sectional median. Every entry filter (MIN_TVL_USD, fee/TVL bounds) runs against that estimate, not a measurement. A snapshot cannot be substituted: a rugged pool reads about $0 TVL today, so a snapshot filter would reject every dead pool and silently restore the survivorship bias.",
  "Fee income is modelled as feeRate x barVolume x (positionValue / modelledTVL), a pro-rata share of the whole pool. DLMM concentration multipliers are not credited, so fees are a conservative lower bound.",
  "Bar volume is the pool's total USD volume and is credited only for bars whose close sits inside the range.",
  "Exits happen on an hourly close, so price can gap past the bin edge before the position closes. Forced exits are charged slippage, and positions whose liquidity vanished are marked to the worst forward price rather than the unobtainable exit-bar price.",
  "The unbiased universe is a SAMPLE of Meteora's ~123k pools, not the whole of it. It combines today's volume leaders with pools created around the window whose lifetime volume shows real past activity but whose current volume has collapsed. Sampling deeper would surface more failures, so the residual bias still points optimistic.",
  "Forward bars are consulted only to decide whether an exit was executable at all — whether there was anyone left to sell to. They never inform an entry or exit decision, which would be look-ahead bias in the strategy itself.",
];

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One hourly bar. Prices and volume are USD. */
export interface Bar {
  /** Unix seconds, bar open time. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume in USD for this bar. */
  v: number;
}

export interface PoolHistory {
  address: string;
  pairName: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseMint: string;
  quoteMint: string;
  /**
   * TVL as observed TODAY. Used only to calibrate the TVL model — the simulation
   * itself uses a modelled point-in-time TVL, because a dead pool reads about $0 now
   * and a snapshot filter would reject exactly the pools this harness exists to
   * include.
   */
  tvlTodayUsd: number;
  /**
   * Pool creation time in unix ms, 0 when upstream did not report one.
   *
   * Carried so the backtest can apply the live MIN_POOL_AGE_HOURS gate at each bar
   * instead of only knowing the pool's age today. A missing value is NOT the same as
   * a young pool and NOT the same as an old one — the gate rejects it, mirroring the
   * live screener's `ageUnknown` bucket.
   */
  createdAtMs: number;
  /** Pool base fee as a fraction (0.0004 === 0.04%). */
  feeRate: number;
  binStep: number;
  /** True when the quote leg is a USD stablecoin, so USD prices are already the pair ratio. */
  quoteIsUsd: boolean;
  /** "survivor" or "dead-or-dormant" — the survivorship-bias control. */
  cohort: string;
  lifetimeVolumeUsd: number;
  bars: Bar[];
}

export interface HistoricalDataset {
  fetchedAt: string;
  windowDays: number;
  pools: PoolHistory[];
  /** SOL/USD hourly series, used to size positions and to derive SOL-quoted pair ratios. */
  solUsdBars: Bar[];
}

/* ------------------------------------------------------------------ */
/* GeckoTerminal                                                       */
/* ------------------------------------------------------------------ */

interface OhlcvResponse {
  data: { attributes: { ohlcv_list: number[][] } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GeckoTerminal's free tier rate-limits aggressively and answers with HTTP 429.
 * Requests are serialised behind a minimum interval, and a 429 is waited out rather
 * than retried immediately — a tight retry loop only deepens the throttle.
 */
const MIN_REQUEST_INTERVAL_MS = 4_000;
const RATE_LIMIT_BACKOFF_MS = 20_000;
const MAX_RATE_LIMIT_RETRIES = 3;

let lastRequestAt = 0;

/**
 * Thrown when upstream refuses a page because it lies outside the plan's historical
 * window. Distinct from a transport failure: the caller keeps the bars it already has
 * and stops paginating, instead of losing the pool.
 */
export class HistoryDepthLimitError extends Error {
  constructor(url: string, status: number) {
    super(`[backtest] history depth limit (HTTP ${status}) at ${url}`);
    this.name = "HistoryDepthLimitError";
  }
}

/**
 * Pulls the HTTP status out of a `getJson` failure message.
 *
 * `getJson` formats failures as `[http] GET <url> failed: <status> <message>`, and the
 * URL is part of that string. A `before_timestamp` is a ten-digit epoch that routinely
 * contains "401", "403" or "429" as a substring, so classifying by `message.includes()`
 * misreads an ordinary rate-limit as a plan boundary and silently truncates that pool's
 * history. Anchoring to the position the status is actually written in is the fix.
 *
 * Returns null for a transport failure, which carries no status and is neither case.
 */
export function parseHttpStatus(message: string): number | null {
  const match = /\sfailed:\s(\d{3})(?:\s|$)/.exec(message);
  return match ? Number(match[1]) : null;
}

async function geckoGet<T>(url: string): Promise<T> {
  const key = proApiKey();
  const config = key ? { headers: { "x-cg-pro-api-key": key } } : undefined;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const waitFor = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (waitFor > 0) await sleep(waitFor);

    lastRequestAt = Date.now();

    try {
      return await getJson<T>(url, config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      const status = parseHttpStatus(message);

      /*
       * 401/403 on an OHLCV page is upstream saying "that range is not on your plan",
       * not "your credentials are wrong" — the identical request without
       * `before_timestamp` succeeds. Classifying it so the caller can stop paginating
       * and keep what it has; treating it as a hard failure loses the whole pool and
       * turns a known data-depth limit into an unexplained crash.
       */
      if (status === 401 || status === 403) {
        throw new HistoryDepthLimitError(url, status);
      }

      if (status !== 429 || attempt === MAX_RATE_LIMIT_RETRIES) throw err;

      const backoff = RATE_LIMIT_BACKOFF_MS * (attempt + 1);
      console.warn(
        `[backtest] rate limited by GeckoTerminal; waiting ${backoff / 1000}s ` +
          `(attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`,
      );
      await sleep(backoff);
    }
  }
  throw new Error(`[backtest] exhausted rate-limit retries for ${url}`);
}

const MAX_BARS_PER_REQUEST = 1000;

async function fetchOnePage(poolAddress: string, beforeTimestamp?: number): Promise<Bar[]> {
  const url =
    `${geckoBase()}/networks/${NETWORK}/pools/${poolAddress}/ohlcv/hour` +
    `?aggregate=1&limit=${MAX_BARS_PER_REQUEST}&currency=usd&token=base` +
    (beforeTimestamp === undefined ? "" : `&before_timestamp=${beforeTimestamp}`);

  const res = await geckoGet<OhlcvResponse>(url);
  const rows = res.data?.attributes?.ohlcv_list ?? [];

  return rows
    .filter((r) => r.length >= 6 && r.every((n) => Number.isFinite(n)))
    .map((r) => ({ t: r[0]!, o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]!, v: r[5]! }))
    .sort((a, b) => a.t - b.t);
}

/** True once the fetcher has hit the plan's historical floor at least once. */
let depthLimitObserved = false;

/** Whether any fetch in this process was cut short by the plan's history window. */
export const historyDepthLimitHit = (): boolean => depthLimitObserved;

/**
 * Fetches hourly OHLCV, paginating backwards when the window exceeds the 1000-bar
 * per-request cap (anything beyond ~41 days). Returns oldest-first, deduplicated.
 * Pagination stops when a page comes back empty or stops yielding older bars — that
 * is the pool's inception, not an error.
 *
 * It also stops, keeping what it has, when upstream refuses a deeper page because the
 * range is outside the plan's historical window (see FREE_TIER_HISTORY_DAYS). That
 * refusal is a property of the data plan, not of the pool, so losing the pool over it
 * would thin the universe for no reason. A refusal on the FIRST page is different —
 * nothing was granted at all, so it propagates as the genuine error it is.
 */
export async function fetchHourlyBars(poolAddress: string, limit = 1000): Promise<Bar[]> {
  const wanted = Math.max(1, limit);
  const byTimestamp = new Map<number, Bar>();

  let before: number | undefined;
  const maxPages = Math.ceil(wanted / MAX_BARS_PER_REQUEST) + 1;

  for (let page = 0; page < maxPages; page++) {
    let bars: Bar[];
    try {
      bars = await fetchOnePage(poolAddress, before);
    } catch (err) {
      if (err instanceof HistoryDepthLimitError && byTimestamp.size > 0) {
        depthLimitObserved = true;
        break;
      }
      throw err;
    }
    if (bars.length === 0) break;

    const oldestBefore = byTimestamp.size === 0 ? Infinity : Math.min(...byTimestamp.keys());
    for (const bar of bars) byTimestamp.set(bar.t, bar);

    const oldestNow = Math.min(...byTimestamp.keys());
    if (byTimestamp.size >= wanted) break;
    if (oldestNow >= oldestBefore) break;

    before = oldestNow;
  }

  return [...byTimestamp.values()].sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

function readCacheFile(path: string): HistoricalDataset | null {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return null;

  try {
    const parsed = JSON.parse(readFileSync(full, "utf8")) as HistoricalDataset;
    const age = Date.now() - new Date(parsed.fetchedAt).getTime();
    if (!Number.isFinite(age) || age > CACHE_TTL_MS) return null;
    if (!Array.isArray(parsed.pools) || parsed.pools.length === 0) return null;
    // Reject a cache written before cohorts existed, or the unbiased run is a lie.
    if (parsed.pools.some((p) => p.cohort === undefined)) return null;
    // Same for creation time: without it the pool-age gate silently rejects everything.
    if (parsed.pools.some((p) => p.createdAtMs === undefined)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCacheFile(path: string, data: HistoricalDataset): void {
  const full = resolve(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(data, null, 2), "utf8");
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                           */
/* ------------------------------------------------------------------ */

export interface IngestOptions {
  poolCount?: number;
  windowDays?: number;
  cachePath?: string;
  force?: boolean;
  /** How many dead/dormant pools to include alongside the survivors. */
  deadPoolCount?: number;
  /** Restricts the survivor cohort to the strategy's target TVL band. */
  survivorTvlBand?: { minUsd: number; maxUsd: number };
  /** Pages of today's volume leaders to scan when building the universe. */
  survivorPages?: number;
  /**
   * Restricts BOTH cohorts to pools the caller is interested in, applied after the
   * universe is built and before any history is fetched.
   *
   * Undefined means "no restriction", so every existing caller ingests exactly the
   * pools it did before — the same inert-default discipline `defaultBacktestConfig()`
   * uses. It exists for arm-versus-arm comparisons (e.g. SOL-quoted against
   * USDC-quoted pools) where each arm must be filled to the SAME pool count; doing
   * that by filtering a shared dataset afterwards would leave the arms with whatever
   * counts happened to fall out of a volume sort.
   *
   * A filtered run MUST use its own `cachePath`: the cache carries no record of the
   * filter, so a filtered dataset read back by an unfiltered caller would silently be
   * a subset of the universe.
   */
  poolFilter?: (pool: UniversePool) => boolean;
  /**
   * Minimum usable bars a pool must have to enter the dataset.
   *
   * Defaults to `max(30, 15% of the window)`, which is right for a short window but
   * wrong for a long one: on a 365-day run it demands 54 days of history and so
   * excludes exactly the short-lived pools the dead cohort exists to capture. Long
   * windows should pass an absolute floor instead.
   */
  minBars?: number;
}

/** Trims bars to the requested trailing window. */
export function trimToWindow(bars: Bar[], windowDays: number, now = Date.now()): Bar[] {
  const cutoff = now / 1000 - windowDays * 24 * 3600;
  return bars.filter((b) => b.t >= cutoff);
}

const USD_QUOTE = new Set(["USDC", "USDT", "USDH", "PYUSD", "FDUSD", "DAI"]);

/**
 * Builds the point-in-time dataset: survivors PLUS pools that died during or after
 * the window. The dead cohort is what makes an unbiased run possible — without it the
 * harness can only ever sample winners.
 */
export async function loadHistoricalData(options: IngestOptions = {}): Promise<HistoricalDataset> {
  const poolCount = options.poolCount ?? 6;
  const deadPoolCount = options.deadPoolCount ?? 8;
  const windowDays = options.windowDays ?? 30;
  const cachePath = options.cachePath ?? CACHE_PATH;

  if (!options.force) {
    const cached = readCacheFile(cachePath);
    if (cached && cached.windowDays >= windowDays) {
      const survivors = cached.pools.filter((p) => p.cohort === "survivor").length;
      const deadCached = cached.pools.filter((p) => p.cohort === "dead-or-dormant").length;
      if (survivors >= poolCount && deadCached >= 1) {
        console.log(
          `[backtest] using cached history from ${cached.fetchedAt} ` +
            `(${survivors} survivors, ${deadCached} dead/dormant)`,
        );
        return cached;
      }
    }
  }

  console.log("[backtest] building point-in-time pool universe (including dead pools)…");
  const universe = await buildPointInTimeUniverse({
    windowDays,
    // A TVL band rejects most of each page, so more pages are needed to fill the cohort.
    survivorPages: options.survivorPages ?? (options.survivorTvlBand ? 12 : 3),
    cohortPages: 30,
    survivorTvlBand: options.survivorTvlBand,
  });

  console.log(
    `[backtest] universe: ${universe.pools.length} candidates from ${universe.scanned} rows ` +
      `scanned of ${universe.totalUniverseSize} total pools ` +
      `(${universe.survivors} survivors, ${universe.deadOrDormant} dead/dormant)`,
  );

  const bars = Math.ceil(windowDays * 24 * 1.05);

  console.log("[backtest] fetching SOL/USD reference series…");
  const solUsdBars = trimToWindow(await fetchHourlyBars(SOL_USDC_POOL, bars), windowDays);
  if (solUsdBars.length === 0) {
    throw new Error("[backtest] SOL/USD reference series is empty; cannot size positions");
  }

  const wanted = options.poolFilter ?? ((): boolean => true);

  const survivorList = universe.pools
    .filter((p) => p.cohort === "survivor" && !p.isBlacklisted && wanted(p))
    .sort((a, b) => b.volume24hTodayUsd - a.volume24hTodayUsd);

  const deadList = universe.pools
    .filter((p) => p.cohort === "dead-or-dormant" && wanted(p))
    .sort((a, b) => b.lifetimeVolumeUsd - a.lifetimeVolumeUsd);

  // Dead pools are short-lived by nature, so the bar-count floor must be low or the
  // very failures we are trying to capture get filtered back out.
  const minBars = options.minBars ?? Math.max(30, Math.floor(windowDays * 24 * 0.15));
  const pools: PoolHistory[] = [];

  async function ingest(list: UniversePool[], want: number, label: string): Promise<void> {
    let taken = 0;
    for (const pool of list) {
      if (taken >= want) break;
      try {
        const history = trimToWindow(await fetchHourlyBars(pool.address, bars), windowDays);
        if (history.length < minBars) continue;

        pools.push({
          address: pool.address,
          pairName: pool.pairName,
          baseSymbol: pool.baseSymbol,
          quoteSymbol: pool.quoteSymbol,
          baseMint: pool.baseMint,
          quoteMint: pool.quoteMint,
          tvlTodayUsd: pool.tvlTodayUsd,
          createdAtMs: pool.createdAtMs,
          feeRate: pool.feeRate,
          binStep: pool.binStep,
          quoteIsUsd: USD_QUOTE.has(pool.quoteSymbol.toUpperCase()),
          cohort: pool.cohort,
          lifetimeVolumeUsd: pool.lifetimeVolumeUsd,
          bars: history,
        });
        taken++;

        console.log(
          `[backtest]   ${label.padEnd(9)} ${pool.pairName.padEnd(18)} ${String(history.length).padStart(4)} bars, ` +
            `tvlNow $${pool.tvlTodayUsd.toFixed(0)}, lifetime $${(pool.lifetimeVolumeUsd / 1e6).toFixed(2)}M`,
        );
      } catch (err) {
        console.warn(`[backtest] skipping ${pool.pairName}: ${(err as Error).message}`);
      }
    }
  }

  await ingest(survivorList, poolCount, "survivor");
  await ingest(deadList, deadPoolCount, "dead");

  if (pools.length === 0) {
    throw new Error("[backtest] no pool yielded usable history; cannot run a backtest");
  }

  const deadIngested = pools.filter((p) => p.cohort === "dead-or-dormant").length;
  if (deadIngested === 0) {
    console.warn(
      "[backtest] WARNING: no dead pool had usable history, so the unbiased run will be " +
        "identical to the biased one and the comparison proves nothing.",
    );
  }

  const dataset: HistoricalDataset = {
    fetchedAt: new Date().toISOString(),
    windowDays,
    pools,
    solUsdBars,
  };

  writeCacheFile(cachePath, dataset);
  console.log(
    `[backtest] cached ${pools.length} pools ` +
      `(${pools.length - deadIngested} survivors, ${deadIngested} dead/dormant) to ${cachePath}`,
  );

  return dataset;
}
