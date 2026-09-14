/**
 * TVL series measured ON-CHAIN, for backtests that must not stand on `TVL = k x volume`.
 *
 * WHY. `npm run validate:tvl` (14 Sep 2026) showed the volume model is not usable as a gate: at
 * any global k at most 24% of modelled TVLs are within 2x of the chain, the band's rejections in
 * the older windows are mostly false, and k is a statistic of the sample's MIX (the same pools
 * barely move while the median jumps 7-11x). So the backtest reads the pool's real TVL instead:
 *
 *   TVL(T) = reserve_x(T) x price_x(T) + reserve_y(T) x price_y(T)
 *
 *  - reserve(T): post-balance of the LAST transaction touching the reserve account at or before
 *    T (Helius getTransactionsForAddress, blockTime <= T) — exact, and never after T.
 *  - price_x(T): the pool's GeckoTerminal bar (USD, token=base) that CLOSED at or before T — the
 *    same bars the engine trades on. base == token_x was verified on 300 of 307 validation points;
 *    a pool whose latest bar disagrees with Meteora's own token_x price by more than 2.5x is
 *    treated as mis-oriented and gets NO series.
 *  - price_y(T): SOL/USD bar when token_y is wSOL, 1 when it is a stable. Any other pair is not
 *    priced — never guessed — and gets no series.
 *
 * An unreadable sample is stored as null with its reason and excluded; the lookup refuses a sample
 * older than `maxStaleSec`. Nothing here falls back to the volume model.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Bar } from "./historicalData.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const STABLE_SYMBOLS = ["USDC", "USDT", "USDH", "PYUSD", "FDUSD", "DAI", "USD1"];

export interface TvlPoint {
  t: number;
  tvlUsd: number;
}

export interface PoolReserveMeta {
  reserve_x: string;
  reserve_y: string;
  token_x: { address: string; symbol: string; price?: number | null };
  token_y: { address: string; symbol: string; price?: number | null };
}

export type PricingSide = "y-sol" | "y-stable";

export interface SampleRecord {
  t: number;
  tvlUsd: number | null;
  x: number | null;
  y: number | null;
  reason: string | null;
}

export interface SeriesFile {
  pool: string;
  side: PricingSide | null;
  /** Why the pool has no series at all (unpriceable pair, mis-oriented price, unreadable meta). */
  refused: string | null;
  samples: Record<string, SampleRecord>;
}

/* ------------------------------------------------------------------ */
/* Pure                                                                */
/* ------------------------------------------------------------------ */

/** Grid instants aligned to multiples of `cadenceSec` (UTC), inside [start, end). Aligned so every window and run shares one cache. */
export function gridTimes(start: number, end: number, cadenceSec: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(start / cadenceSec) * cadenceSec; t < end; t += cadenceSec) out.push(t);
  return out;
}

/** Close of the last bar that had CLOSED at or before `t` (bar.t + 1h <= t): no look-ahead. */
export function closedBarPrice(bars: readonly Bar[], t: number): number | null {
  let lo = 0;
  let hi = bars.length - 1;
  let best: Bar | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t + 3600 <= t) {
      best = bars[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best && best.c > 0 && Number.isFinite(best.c) ? best.c : null;
}

/** How a pool's TVL can be priced, or why it cannot. */
export function classifyPricing(meta: PoolReserveMeta): { side: PricingSide } | { refused: string } {
  if (meta.token_y.address === WSOL_MINT) return { side: "y-sol" };
  if (STABLE_SYMBOLS.includes(meta.token_y.symbol.toUpperCase())) return { side: "y-stable" };
  return { refused: `token_y ${meta.token_y.symbol} is neither wSOL nor a stable: not priced` };
}

/**
 * Tolerance of the orientation check. Wide on purpose: the cached bar can be a day or two older than
 * Meteora's current price and a memecoin moves tens of percent in that time, while a MIS-oriented
 * pool is off by the whole price ratio (83x on the one SOL-USDC pool validation caught).
 */
export const ORIENTATION_TOLERANCE = 2.5;

/**
 * The orientation check: GeckoTerminal's base price must describe token_x. Compared against
 * Meteora's own current token_x price where one exists; `null` means it could not be checked
 * (a dead pool with no current price), which is allowed and counted, not assumed correct.
 */
export function orientationCheck(latestBaseUsd: number | null, metaTokenXPrice: number | null | undefined): "ok" | "unchecked" | "mismatch" {
  if (latestBaseUsd === null || !(metaTokenXPrice! > 0)) return "unchecked";
  return Math.abs(Math.log2(latestBaseUsd / metaTokenXPrice!)) <= Math.log2(ORIENTATION_TOLERANCE) ? "ok" : "mismatch";
}

export function tvlFromSample(input: { x: number; y: number; side: PricingSide; baseUsd: number | null; solUsd: number | null }): number | null {
  if (!(input.x >= 0) || !(input.y >= 0) || input.baseUsd === null) return null;
  const yUsd = input.side === "y-stable" ? 1 : input.solUsd;
  if (yUsd === null || !(yUsd > 0)) return null;
  const v = input.x * input.baseUsd + input.y * yUsd;
  return Number.isFinite(v) ? v : null;
}

/** Last point at or before `t`, refused when older than `maxStaleSec`. Points must be sorted by t. */
export function lookupTvl(points: readonly TvlPoint[], t: number, maxStaleSec: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let best: TvlPoint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= t) {
      best = points[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best && t - best.t <= maxStaleSec ? best.tvlUsd : null;
}

export function seriesPoints(file: SeriesFile, from: number, to: number): TvlPoint[] {
  return Object.values(file.samples)
    .filter((s): s is SampleRecord & { tvlUsd: number } => s.tvlUsd !== null && s.tvlUsd > 0 && s.t >= from && s.t < to)
    .map((s) => ({ t: s.t, tvlUsd: s.tvlUsd }))
    .sort((a, b) => a.t - b.t);
}

export function medianTvl(points: readonly TvlPoint[]): number | null {
  if (points.length === 0) return null;
  const s = points.map((p) => p.tvlUsd).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/* ------------------------------------------------------------------ */
/* I/O                                                                 */
/* ------------------------------------------------------------------ */

export interface OnchainTvlDeps {
  poolMeta(address: string): Promise<PoolReserveMeta | null>;
  /** Reserve balance (human units) at or before T; null when no tx or no balance. Throws on transport failure. */
  reserveAt(account: string, t: number): Promise<number | null>;
  log(line: string): void;
}

export const seriesFilePath = (address: string, cacheDir = ".cache"): string => `${cacheDir}/tvl_series/${address}.json`;

const readJson = <T>(p: string): T | null => {
  const full = resolve(process.cwd(), p);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, "utf8")) as T;
  } catch {
    return null;
  }
};
const writeJson = (p: string, data: unknown): void => {
  const full = resolve(process.cwd(), p);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(`${full}.tmp`, JSON.stringify(data), "utf8");
  renameSync(`${full}.tmp`, full);
};

async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/**
 * Ensures the pool's series holds every instant in `times`, fetching only what the cache lacks.
 * Transport failures are NOT cached (retried next run); settled answers — a value, "no tx before
 * T", "balance absent" — are. Returns the file, whose `refused` says when the pool has no series.
 */
export async function ensureTvlSeries(input: {
  address: string;
  bars: readonly Bar[];
  solUsdBars: readonly Bar[];
  times: readonly number[];
  deps: OnchainTvlDeps;
  concurrency?: number;
  cacheDir?: string;
}): Promise<{ file: SeriesFile; fetched: number; failed: number }> {
  const path = seriesFilePath(input.address, input.cacheDir);
  const file: SeriesFile = readJson<SeriesFile>(path) ?? { pool: input.address, side: null, refused: null, samples: {} };
  if (file.refused) return { file, fetched: 0, failed: 0 };

  const meta = await input.deps.poolMeta(input.address);
  if (!meta) {
    // Not persisted as a refusal: an unreadable API is a fact about the network, not the pool.
    return { file: { ...file, refused: "pool meta unreadable" }, fetched: 0, failed: 0 };
  }
  const pricing = classifyPricing(meta);
  if ("refused" in pricing) {
    file.refused = pricing.refused;
    writeJson(path, file);
    return { file, fetched: 0, failed: 0 };
  }
  const orientation = orientationCheck(input.bars.at(-1)?.c ?? null, meta.token_x.price);
  if (orientation === "mismatch") {
    file.refused = `GeckoTerminal base price disagrees with Meteora token_x price by more than ${ORIENTATION_TOLERANCE}x (base is not token_x)`;
    writeJson(path, file);
    return { file, fetched: 0, failed: 0 };
  }
  file.side = pricing.side;

  const missing = input.times.filter((t) => file.samples[String(t)] === undefined);
  let fetched = 0;
  let failed = 0;
  await pool(missing, input.concurrency ?? 6, async (t) => {
    const baseUsd = closedBarPrice(input.bars, t);
    const solUsd = closedBarPrice(input.solUsdBars, t);
    try {
      const [x, y] = await Promise.all([input.deps.reserveAt(meta.reserve_x, t), input.deps.reserveAt(meta.reserve_y, t)]);
      let reason: string | null = null;
      let tvlUsd: number | null = null;
      if (x === null || y === null) reason = "no reserve balance at or before T";
      else {
        tvlUsd = tvlFromSample({ x, y, side: pricing.side, baseUsd, solUsd });
        if (tvlUsd === null) reason = baseUsd === null ? "no closed price bar before T" : "no SOL/USD before T";
      }
      file.samples[String(t)] = { t, tvlUsd, x, y, reason };
      fetched++;
    } catch {
      failed++;
    }
    if ((fetched + failed) % 50 === 0) writeJson(path, file);
  });
  writeJson(path, file);
  return { file, fetched, failed };
}

/** Real deps: Helius for reserves, Meteora datapi for the reserve accounts and token_x price. */
export function heliusTvlDeps(rpcUrl: string, log: (line: string) => void = console.log, cacheDir = ".cache"): OnchainTvlDeps {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async poolMeta(address) {
      const path = `${cacheDir}/tvl_truth/meta_${address}.json`;
      const cached = readJson<PoolReserveMeta>(path);
      if (cached?.reserve_x) return cached;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${address}`);
          if (res.status === 429 || res.status >= 500) {
            await sleep(2000 * (attempt + 1));
            continue;
          }
          if (!res.ok) return null;
          const meta = (await res.json()) as PoolReserveMeta;
          if (!meta?.reserve_x) return null;
          writeJson(path, meta);
          return meta;
        } catch {
          await sleep(1000 * (attempt + 1));
        }
      }
      return null;
    },
    async reserveAt(account, t) {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransactionsForAddress",
            params: [account, { transactionDetails: "full", sortOrder: "desc", limit: 1, filters: { blockTime: { lte: t } }, encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
          }),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < 6) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        // The RPC URL carries the provider key: the error names the method and status only.
        if (!res.ok) throw new Error(`getTransactionsForAddress HTTP ${res.status}`);
        const body = (await res.json()) as { result?: { data: unknown[] }; error?: { message: string } };
        if (body.error) throw new Error(`getTransactionsForAddress: ${body.error.message}`);
        const tx = body.result?.data?.[0] as
          | { transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } }; meta?: { postTokenBalances?: Array<{ accountIndex: number; uiTokenAmount: { uiAmountString?: string; amount: string; decimals: number } }> } }
          | undefined;
        if (!tx) return null;
        const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey));
        for (const b of tx.meta?.postTokenBalances ?? []) {
          if (keys[b.accountIndex] !== account) continue;
          const v = Number(b.uiTokenAmount.uiAmountString ?? Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals);
          return Number.isFinite(v) ? v : null;
        }
        return null;
      }
    },
    log,
  };
}
