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

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const NETWORK = "solana";

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

async function geckoGet<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const waitFor = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (waitFor > 0) await sleep(waitFor);

    lastRequestAt = Date.now();

    try {
      return await getJson<T>(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("429") || attempt === MAX_RATE_LIMIT_RETRIES) throw err;

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
    `${GECKO_BASE}/networks/${NETWORK}/pools/${poolAddress}/ohlcv/hour` +
    `?aggregate=1&limit=${MAX_BARS_PER_REQUEST}&currency=usd&token=base` +
    (beforeTimestamp === undefined ? "" : `&before_timestamp=${beforeTimestamp}`);

  const res = await geckoGet<OhlcvResponse>(url);
  const rows = res.data?.attributes?.ohlcv_list ?? [];

  return rows
    .filter((r) => r.length >= 6 && r.every((n) => Number.isFinite(n)))
    .map((r) => ({ t: r[0]!, o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]!, v: r[5]! }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Fetches hourly OHLCV, paginating backwards when the window exceeds the 1000-bar
 * per-request cap (anything beyond ~41 days). Returns oldest-first, deduplicated.
 * Pagination stops when a page comes back empty or stops yielding older bars — that
 * is the pool's inception, not an error.
 */
export async function fetchHourlyBars(poolAddress: string, limit = 1000): Promise<Bar[]> {
  const wanted = Math.max(1, limit);
  const byTimestamp = new Map<number, Bar>();

  let before: number | undefined;
  const maxPages = Math.ceil(wanted / MAX_BARS_PER_REQUEST) + 1;

  for (let page = 0; page < maxPages; page++) {
    const bars = await fetchOnePage(poolAddress, before);
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

  const survivorList = universe.pools
    .filter((p) => p.cohort === "survivor" && !p.isBlacklisted)
    .sort((a, b) => b.volume24hTodayUsd - a.volume24hTodayUsd);

  const deadList = universe.pools
    .filter((p) => p.cohort === "dead-or-dormant")
    .sort((a, b) => b.lifetimeVolumeUsd - a.lifetimeVolumeUsd);

  // Dead pools are short-lived by nature, so the bar-count floor must be low or the
  // very failures we are trying to capture get filtered back out.
  const minBars = Math.max(30, Math.floor(windowDays * 24 * 0.15));
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
