import { z } from "zod";
import { ENDPOINTS, SOL_USDC_POOL_ADDRESS, WSOL_MINT } from "../config/constants.js";
import { env } from "../config/env.js";
import { getJson, getJsonSafe } from "./http.js";
import { realizedVolatilityPctPerHour } from "./statistics.js";

/* ------------------------------------------------------------------ */
/* Fear & Greed                                                        */
/* ------------------------------------------------------------------ */

const FearGreedSchema = z.object({
  data: z
    .array(
      z.object({
        value: z.string(),
        value_classification: z.string(),
        timestamp: z.string(),
      }),
    )
    .min(1),
});

export interface FearGreed {
  value: number;
  classification: string;
  timestamp: string;
}

export async function fetchFearGreed(): Promise<FearGreed | null> {
  try {
    const parsed = FearGreedSchema.parse(await getJson<unknown>(ENDPOINTS.FEAR_GREED));
    const entry = parsed.data[0]!;
    return {
      value: Number(entry.value),
      classification: entry.value_classification,
      timestamp: new Date(Number(entry.timestamp) * 1000).toISOString(),
    };
  } catch (err) {
    console.warn(`[marketData] fear&greed unavailable: ${(err as Error).message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Global crypto market (CoinGecko)                                    */
/* ------------------------------------------------------------------ */

export interface GlobalMarket {
  totalMarketCapUsd: number;
  totalVolume24hUsd: number;
  btcDominancePct: number;
  ethDominancePct: number;
  marketCapChange24hPct: number;
}

export async function fetchGlobalMarket(): Promise<GlobalMarket | null> {
  const raw = await getJsonSafe<{ data?: Record<string, unknown> } | null>(
    ENDPOINTS.COINGECKO_GLOBAL,
    null,
  );
  const d = raw?.data;
  if (!d) return null;

  const cap = d.total_market_cap as Record<string, number> | undefined;
  const vol = d.total_volume as Record<string, number> | undefined;
  const dom = d.market_cap_percentage as Record<string, number> | undefined;

  return {
    totalMarketCapUsd: cap?.usd ?? 0,
    totalVolume24hUsd: vol?.usd ?? 0,
    btcDominancePct: dom?.btc ?? 0,
    ethDominancePct: dom?.eth ?? 0,
    marketCapChange24hPct: (d.market_cap_change_percentage_24h_usd as number) ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Spot prices                                                         */
/* ------------------------------------------------------------------ */

export interface SpotPrices {
  solUsd: number;
  btcUsd: number;
  ethUsd: number;
  solChange24hPct: number;
  btcChange24hPct: number;
  ethChange24hPct: number;
}

const COINGECKO_IDS = "solana,bitcoin,ethereum";

export async function fetchSpotPrices(): Promise<SpotPrices | null> {
  const url =
    `${ENDPOINTS.COINGECKO_SIMPLE_PRICE}?ids=${COINGECKO_IDS}` +
    `&vs_currencies=usd&include_24hr_change=true`;

  const raw = await getJsonSafe<Record<string, { usd?: number; usd_24h_change?: number }> | null>(
    url,
    null,
  );
  if (!raw) return null;

  return {
    solUsd: raw.solana?.usd ?? 0,
    btcUsd: raw.bitcoin?.usd ?? 0,
    ethUsd: raw.ethereum?.usd ?? 0,
    solChange24hPct: raw.solana?.usd_24h_change ?? 0,
    btcChange24hPct: raw.bitcoin?.usd_24h_change ?? 0,
    ethChange24hPct: raw.ethereum?.usd_24h_change ?? 0,
  };
}

/**
 * SOL/USD is needed to convert a virtual SOL position into USD. CoinGecko is the
 * primary source; a failure returns null and callers must not silently substitute
 * a made-up price.
 */
/*
 * SOL/USD had exactly one source, CoinGecko. When it rate-limited, position sizing had
 * no price and the engine refused to open anything at all — correct (it must never
 * fabricate a size) but it meant one third-party API could stop trading completely.
 * These are the fallbacks. All keyless, all verified reachable.
 */

/**
 * Plausibility band for a SOL quote.
 *
 * Deliberately absurd bounds rather than a tight market range: this rejects garbage
 * (0, negative, a parse artefact like 1e30) without asserting a view on what SOL is
 * worth, which would silently reject real prices in a violent move. It matters because
 * a bad quote here is permanent — position notional is fixed at entry, so a wrong SOL
 * price is baked into that trade's PnL forever.
 */
const SOL_PRICE_MIN_USD = 0.01;
const SOL_PRICE_MAX_USD = 100_000;

function usableSolPrice(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < SOL_PRICE_MIN_USD || n > SOL_PRICE_MAX_USD) return null;
  return n;
}

export interface SolPriceSource {
  name: string;
  fetch: () => Promise<number | null>;
}

/** CoinGecko stays first: it is the only one that also feeds BTC/ETH and 24h changes. */
const coingeckoSol: SolPriceSource = {
  name: "coingecko",
  fetch: async () => {
    const prices = await fetchSpotPrices();
    return usableSolPrice(prices?.solUsd);
  },
};

const jupiterSol: SolPriceSource = {
  name: "jupiter",
  fetch: async () => {
    const raw = await getJsonSafe<Record<string, { usdPrice?: number }> | null>(
      `${ENDPOINTS.JUPITER_PRICE}?ids=${WSOL_MINT}`,
      null,
    );
    return usableSolPrice(raw?.[WSOL_MINT]?.usdPrice);
  },
};

const dexscreenerSol: SolPriceSource = {
  name: "dexscreener",
  fetch: async () => {
    const raw = await getJsonSafe<{ pairs?: Array<{ priceUsd?: string }> } | null>(
      `${ENDPOINTS.DEXSCREENER_PAIRS}/${SOL_USDC_POOL_ADDRESS}`,
      null,
    );
    return usableSolPrice(raw?.pairs?.[0]?.priceUsd);
  },
};

export const SOL_PRICE_SOURCES: SolPriceSource[] = [coingeckoSol, jupiterSol, dexscreenerSol];

/**
 * First usable SOL/USD quote, in source order.
 *
 * Still returns null when every source fails — callers must keep refusing to size a
 * position rather than inventing one. A fallback being used is logged, because trading
 * on a degraded price path is something the operator should be able to see in the log.
 */
export async function fetchSolPriceUsdFrom(sources: SolPriceSource[]): Promise<number | null> {
  for (const [index, source] of sources.entries()) {
    let price: number | null = null;
    try {
      price = await source.fetch();
    } catch (err) {
      // getJsonSafe already swallows HTTP errors; this catches a malformed payload.
      console.warn(`[marketData] SOL price via ${source.name} threw: ${(err as Error).message}`);
    }

    /*
     * Re-validated here, not just inside each source. The chain must not trust what a
     * source hands back: a future source that forgets usableSolPrice would otherwise
     * feed 0 or NaN straight into position sizing, and notional is fixed at entry, so
     * that price is baked into the trade's PnL permanently.
     */
    const usable = usableSolPrice(price);
    if (usable !== null) {
      if (index > 0) {
        console.warn(`[marketData] SOL/USD served by fallback source "${source.name}"`);
      }
      return usable;
    }

    if (price !== null) {
      console.warn(
        `[marketData] rejected an implausible SOL quote from ${source.name}: ${String(price)}`,
      );
    }
  }

  console.error("[marketData] SOL/USD unavailable from every source — no position can be sized");
  return null;
}

export async function fetchSolPriceUsd(): Promise<number | null> {
  return fetchSolPriceUsdFrom(SOL_PRICE_SOURCES);
}

/* ------------------------------------------------------------------ */
/* Trending DEX tokens (DEXScreener)                                   */
/* ------------------------------------------------------------------ */

export interface TrendingToken {
  chainId: string;
  tokenAddress: string;
  symbol: string;
  description: string;
}

const BoostSchema = z.array(
  z
    .object({
      chainId: z.string(),
      tokenAddress: z.string(),
      description: z.string().default(""),
    })
    .passthrough(),
);

export async function fetchTrendingTokens(limit = 5): Promise<TrendingToken[]> {
  const raw = await getJsonSafe<unknown>(ENDPOINTS.DEXSCREENER_BOOSTS, []);
  const parsed = BoostSchema.safeParse(raw);
  if (!parsed.success) return [];

  return parsed.data.slice(0, limit).map((t) => ({
    chainId: t.chainId,
    tokenAddress: t.tokenAddress,
    // The boosts feed carries no symbol; the first word of the description is the
    // closest honest stand-in rather than inventing a ticker.
    symbol: t.description.split(/[\s,.]+/)[0]?.slice(0, 16) || t.tokenAddress.slice(0, 6),
    description: t.description.slice(0, 160),
  }));
}

/* ------------------------------------------------------------------ */
/* Pool price change (volatility gate)                                 */
/* ------------------------------------------------------------------ */

interface DexScreenerPair {
  pairAddress: string;
  priceChange?: { h24?: number; h6?: number; h1?: number };
}

/**
 * 24h price change per pool, as a percentage (4.71 means +4.71%).
 *
 * The Meteora pool listing carries no price-change field, so this comes from
 * DexScreener, which accepts comma-separated pair addresses and answers in a single
 * request — one call for the whole candidate set rather than one per pool.
 *
 * A pool missing from the response is simply absent from the map. Callers must decide
 * what an unknown change means; treating it as 0 would quietly pass a pool that might
 * have just tripled.
 */
export interface PoolPriceChange {
  h1: number | null;
  h24: number | null;
}

export async function fetchPoolPriceChanges(
  poolAddresses: string[],
): Promise<Map<string, PoolPriceChange>> {
  const result = new Map<string, PoolPriceChange>();
  if (poolAddresses.length === 0) return result;

  // DexScreener caps the batch; chunk defensively.
  const CHUNK = 25;

  for (let i = 0; i < poolAddresses.length; i += CHUNK) {
    const batch = poolAddresses.slice(i, i + CHUNK);
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${batch.join(",")}`;

    const raw = await getJsonSafe<{ pairs?: DexScreenerPair[] } | null>(url, null);
    for (const pair of raw?.pairs ?? []) {
      if (!pair.pairAddress) continue;
      const h1 = pair.priceChange?.h1;
      const h24 = pair.priceChange?.h24;
      result.set(pair.pairAddress, {
        h1: typeof h1 === "number" && Number.isFinite(h1) ? h1 : null,
        h24: typeof h24 === "number" && Number.isFinite(h24) ? h24 : null,
      });
    }
  }

  return result;
}

/**
 * Realized hourly volatility for a pool, from GeckoTerminal hourly closes.
 *
 * The Meteora listing carries no return series, so this is the only way to measure
 * the volatility the research identified as a 5.8x big-loss driver. One request per
 * pool, so it runs on the final shortlist only — never the whole screen.
 *
 * Returns null when the series is unavailable or too short. Callers must fail closed:
 * "not measured" is not "calm".
 */
export async function fetchRealizedVolatilityPctPerHour(
  poolAddress: string,
  bars = 24,
): Promise<number | null> {
  const url =
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}` +
    `/ohlcv/hour?aggregate=1&limit=${bars + 1}&currency=usd&token=base`;

  const raw = await getJsonSafe<{
    data?: { attributes?: { ohlcv_list?: number[][] } };
  } | null>(url, null);

  const rows = raw?.data?.attributes?.ohlcv_list ?? [];
  if (rows.length < 2) return null;

  // GeckoTerminal returns newest-first; the volatility calc wants chronological order.
  const closes = [...rows]
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
    .map((r) => r[4] ?? 0)
    .filter((c) => c > 0);

  return realizedVolatilityPctPerHour(closes);
}

/* ------------------------------------------------------------------ */
/* TradFi macro                                                        */
/* ------------------------------------------------------------------ */

/**
 * DXY, US Treasury yields, S&P 500 and spot-ETF net flows have no free keyless
 * feed. Farside (the PRD's ETF source) returns HTTP 403 to programmatic clients.
 *
 * Rather than fabricate numbers, each field is nullable and every gap is listed in
 * `unavailable`, which the researcher agent injects into the prompt so the model is
 * told explicitly not to invent values it was not given.
 *
 * Set FRED_API_KEY (free, https://fred.stlouisfed.org/docs/api/api_key.html) to
 * populate DXY, the 10Y yield and the S&P 500 from FRED.
 */
export interface TradFiMacro {
  dxy: number | null;
  us10yYieldPct: number | null;
  sp500: number | null;
  btcEtfNetFlowUsd: number | null;
  ethEtfNetFlowUsd: number | null;
  unavailable: string[];
  sources: string[];
}

const FRED_SERIES = {
  dxy: "DTWEXBGS", // Nominal Broad U.S. Dollar Index
  us10yYieldPct: "DGS10", // 10-Year Treasury Constant Maturity Rate
  sp500: "SP500",
} as const;

async function fetchFredLatest(seriesId: string, apiKey: string): Promise<number | null> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=5`;

  const raw = await getJsonSafe<{ observations?: Array<{ value: string }> } | null>(url, null);
  for (const obs of raw?.observations ?? []) {
    const n = Number(obs.value);
    if (Number.isFinite(n)) return n; // FRED uses "." for missing days
  }
  return null;
}

export async function fetchTradFiMacro(): Promise<TradFiMacro> {
  const apiKey = process.env.FRED_API_KEY?.trim();

  const result: TradFiMacro = {
    dxy: null,
    us10yYieldPct: null,
    sp500: null,
    btcEtfNetFlowUsd: null,
    ethEtfNetFlowUsd: null,
    unavailable: [],
    sources: [],
  };

  if (apiKey) {
    const [dxy, us10y, sp500] = await Promise.all([
      fetchFredLatest(FRED_SERIES.dxy, apiKey),
      fetchFredLatest(FRED_SERIES.us10yYieldPct, apiKey),
      fetchFredLatest(FRED_SERIES.sp500, apiKey),
    ]);
    result.dxy = dxy;
    result.us10yYieldPct = us10y;
    result.sp500 = sp500;
    if (dxy !== null || us10y !== null || sp500 !== null) result.sources.push("FRED");
  }

  if (result.dxy === null) result.unavailable.push("DXY");
  if (result.us10yYieldPct === null) result.unavailable.push("US 10Y yield");
  if (result.sp500 === null) result.unavailable.push("S&P 500");

  // No keyless programmatic source; Farside blocks non-browser clients (HTTP 403).
  result.unavailable.push("BTC spot ETF net flow", "ETH spot ETF net flow");

  return result;
}

/* ------------------------------------------------------------------ */
/* Aggregate snapshot                                                  */
/* ------------------------------------------------------------------ */

export interface MarketSnapshot {
  capturedAt: string;
  fearGreed: FearGreed | null;
  global: GlobalMarket | null;
  prices: SpotPrices | null;
  trending: TrendingToken[];
  tradfi: TradFiMacro;
}

/** Fetches every research input concurrently. Individual failures degrade to null. */
export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const [fearGreed, global, prices, trending, tradfi] = await Promise.all([
    fetchFearGreed(),
    fetchGlobalMarket(),
    fetchSpotPrices(),
    fetchTrendingTokens(5),
    fetchTradFiMacro(),
  ]);

  return {
    capturedAt: new Date().toISOString(),
    fearGreed,
    global,
    prices,
    trending,
    tradfi,
  };
}

export function describeSnapshotGaps(snapshot: MarketSnapshot): string[] {
  const gaps = [...snapshot.tradfi.unavailable];
  if (!snapshot.fearGreed) gaps.push("Fear & Greed index");
  if (!snapshot.global) gaps.push("global crypto market cap / dominance");
  if (!snapshot.prices) gaps.push("BTC/ETH/SOL spot prices");
  if (snapshot.trending.length === 0) gaps.push("trending DEX tokens");
  return gaps;
}

export const timezone = env.TZ;
