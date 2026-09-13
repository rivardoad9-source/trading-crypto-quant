/**
 * A universe chosen FROM INSIDE each backtest window.
 *
 * WHY. `backtest:integrity` built one universe from pools that are active around TODAY,
 * then cut the older window out of the same set. Most of those pools did not exist three
 * months earlier, so window 2 had 7 pools and 0 trades — a property of the sample, reported
 * as an empty window. A window can only be judged on pools that were trading in it.
 *
 * Meteora's listing reports volume TODAY and over the pool's LIFETIME, never over a past
 * window, so in-window activity has to be measured from the OHLCV itself:
 *
 *   1. candidates = today's volume leaders + the creation-ordered walk back to the window's
 *      start (the dead cohort), keeping only pools created BEFORE the window ends, capped
 *      by lifetime volume so the fetch cost is bounded;
 *   2. each candidate's bars are fetched and cached as they arrive (a resumed run skips
 *      the ones already fetched);
 *   3. ranked by fee earned INSIDE the window (feeRate x in-window volume), after dropping
 *      pools whose modelled TVL in the window sits outside the strategy's band — a pure
 *      volume ranking fills up with SOL-USDC-scale pools MAX_TVL_USD rejects outright, the
 *      same trap `survivorTvlBand` exists for;
 *   4. the top N become the window's universe.
 *
 * Selection is pure (`selectWindowUniverse`); the I/O is injected so it is testable offline.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Bar, HistoricalDataset, PoolHistory } from "./historicalData.js";
import type { UniversePool, UniverseResult } from "./universe.js";

export interface WindowSpec {
  /** Unix seconds, inclusive. */
  start: number;
  /** Unix seconds, exclusive. */
  end: number;
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export const windowCachePath = (w: WindowSpec, dir = ".cache"): string =>
  `${dir}/historical_data_window_${day(w.start)}_${day(w.end)}.json`;

/** `count` windows of `days`, newest first, ending at `nowSeconds`. */
export function windowsEndingAt(nowSeconds: number, days: number, count: number): WindowSpec[] {
  const span = days * 86_400;
  return Array.from({ length: count }, (_, i) => ({ end: nowSeconds - i * span, start: nowSeconds - (i + 1) * span }));
}

export interface WindowCandidate {
  pool: UniversePool;
  bars: Bar[];
}

export interface WindowSelection {
  selected: Array<WindowCandidate & { inWindowFeesUsd: number; inWindowBars: number }>;
  /** Why each candidate was not selected, keyed by reason. */
  rejected: Record<"bornAfterWindow" | "noBarsInWindow" | "tvlBand" | "belowTopN", number>;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/**
 * Picks the top `n` candidates by in-window fees.
 *
 * A pool born at or after the window's END cannot have traded in it and is refused before
 * its bars are even looked at — the property the whole module exists for. A pool needs at
 * least 24 in-window bars (one trailing-volume window) to count as having traded there.
 *
 * `tvlBand` with `k` filters on MODELLED in-window TVL, `k x median daily volume`, the same
 * model every entry gate runs on; omitted, no band is applied.
 */
export function selectWindowUniverse(input: {
  candidates: readonly WindowCandidate[];
  window: WindowSpec;
  n: number;
  tvlBand?: { minUsd: number; maxUsd: number; k: number };
}): WindowSelection {
  const rejected: WindowSelection["rejected"] = { bornAfterWindow: 0, noBarsInWindow: 0, tvlBand: 0, belowTopN: 0 };
  const ranked: WindowSelection["selected"] = [];

  for (const c of input.candidates) {
    if (c.pool.createdAtMs > 0 && c.pool.createdAtMs / 1000 >= input.window.end) {
      rejected.bornAfterWindow++;
      continue;
    }
    const inWindow = c.bars.filter((b) => b.t >= input.window.start && b.t < input.window.end);
    if (inWindow.length < 24) {
      rejected.noBarsInWindow++;
      continue;
    }
    const volume = inWindow.reduce((s, b) => s + b.v, 0);
    if (input.tvlBand) {
      const daily: number[] = [];
      for (let i = 0; i + 24 <= inWindow.length; i += 24) {
        daily.push(inWindow.slice(i, i + 24).reduce((s, b) => s + b.v, 0));
      }
      const modelledTvl = input.tvlBand.k * median(daily);
      if (modelledTvl < input.tvlBand.minUsd || modelledTvl > input.tvlBand.maxUsd) {
        rejected.tvlBand++;
        continue;
      }
    }
    ranked.push({ ...c, inWindowFeesUsd: c.pool.feeRate * volume, inWindowBars: inWindow.length });
  }

  ranked.sort((a, b) => b.inWindowFeesUsd - a.inWindowFeesUsd || a.pool.address.localeCompare(b.pool.address));
  const selected = ranked.slice(0, Math.max(0, input.n));
  rejected.belowTopN = ranked.length - selected.length;
  return { selected, rejected };
}

/* ------------------------------------------------------------------ */
/* Resume-able ingest                                                  */
/* ------------------------------------------------------------------ */

export interface WindowIngestDeps {
  buildUniverse(windowDaysBack: number): Promise<UniverseResult>;
  fetchBars(address: string, barsWanted: number): Promise<Bar[]>;
  log(line: string): void;
  nowMs(): number;
}

export interface WindowDataset extends HistoricalDataset {
  window: { start: string; end: string; startSec: number; endSec: number };
  selection: { candidates: number; rejected: WindowSelection["rejected"]; n: number; k: number | null };
}

/**
 * TVL / 24h volume, median over candidates that report both today. It is TODAY's ratio
 * applied to a past window — the same assumption every modelled-TVL gate already makes —
 * and it is stored with the dataset so the report can name it.
 */
export function kFromCandidates(pools: readonly UniversePool[]): number | null {
  /*
   * SURVIVORS only, as `calibrateTvlModel` does everywhere else. The first per-window run
   * fitted k over every candidate and got 1.4-1.8 (a median over SOL-USDC-scale pools whose
   * TVL dwarfs a day of volume) against ~0.13 elsewhere — which put every pool's modelled
   * fee/TVL under the entry floor and produced three windows of zero trades.
   */
  const usable = (p: UniversePool) => p.tvlTodayUsd > 0 && p.volume24hTodayUsd > 0;
  const survivors = pools.filter((p) => p.cohort === "survivor" && usable(p));
  const basis = survivors.length > 0 ? survivors : pools.filter(usable);
  const ks = basis.map((p) => p.tvlTodayUsd / p.volume24hTodayUsd);
  return ks.length === 0 ? null : median(ks);
}

/**
 * The candidate list: at most half the cap from each cohort, so the dead cohort is never
 * crowded out. Ranking everything by lifetime volume — the first version — took 95 of 96
 * candidates from long-lived majors and left the survivorship control with one dead pool.
 * Survivors are ranked by today's volume, the dead by lifetime volume (today's is ~0).
 */
export function pickCandidates(pools: readonly UniversePool[], window: WindowSpec, cap: number): UniversePool[] {
  const eligible = pools.filter((p) => !p.isBlacklisted && !(p.createdAtMs > 0 && p.createdAtMs / 1000 >= window.end));
  const byAddress = (a: UniversePool, b: UniversePool) => a.address.localeCompare(b.address);
  const survivors = eligible
    .filter((p) => p.cohort === "survivor")
    .sort((a, b) => b.volume24hTodayUsd - a.volume24hTodayUsd || byAddress(a, b));
  const dead = eligible
    .filter((p) => p.cohort !== "survivor")
    .sort((a, b) => b.lifetimeVolumeUsd - a.lifetimeVolumeUsd || byAddress(a, b));
  const half = Math.ceil(cap / 2);
  const takeDead = Math.min(dead.length, cap - Math.min(survivors.length, half));
  const takeSurvivors = Math.min(survivors.length, cap - takeDead);
  return [...survivors.slice(0, takeSurvivors), ...dead.slice(0, takeDead)];
}

interface PartialFile {
  window: WindowSpec;
  candidates: UniversePool[];
  failed: Record<string, string>;
  /** Present only in partial files written before bars moved to per-pool files; migrated on read. */
  bars?: Record<string, Bar[]>;
  solUsdBars?: Bar[] | null;
}

interface BarFile {
  /** How deep the fetch that produced this file asked to go, in hourly bars. */
  requestedBars: number;
  bars: Bar[];
}

const readJson = <T>(path: string): T | null => {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, "utf8")) as T;
  } catch {
    return null;
  }
};

/** Written to a temp name then renamed, so an interrupted write never leaves a torn cache. */
const writeJson = (path: string, data: unknown): void => {
  const full = resolve(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(`${full}.tmp`, JSON.stringify(data), "utf8");
  renameSync(`${full}.tmp`, full);
};

export type CacheOutcome = "hit" | "resumed" | "fresh";

/**
 * One file per pool, shared by every window and every run.
 *
 * WHY NOT ONE FILE (14 Sep 2026). The first version kept every candidate's bars in the
 * window's partial file and rewrote it after each pool, while also memoising all bars in
 * memory across windows. On a 6 GB box the run was killed for low memory at pool 28 of 96,
 * with a 17 MB partial file re-serialised every ~30 s. Per-pool files keep each write small,
 * let the process drop a pool's full history as soon as its window slice is taken, and turn
 * "resume" into "the file exists".
 */
export const barFilePath = (address: string, cacheDir = ".cache"): string => `${cacheDir}/window_bars/${address}.json`;

async function barsFor(
  address: string,
  barsWanted: number,
  cacheDir: string | undefined,
  fetchBars: WindowIngestDeps["fetchBars"],
): Promise<{ bars: Bar[]; fromCache: boolean }> {
  const path = barFilePath(address, cacheDir);
  const hit = readJson<BarFile>(path);
  if (hit && Array.isArray(hit.bars) && hit.requestedBars >= barsWanted) return { bars: hit.bars, fromCache: true };
  const bars = await fetchBars(address, barsWanted);
  writeJson(path, { requestedBars: barsWanted, bars } satisfies BarFile);
  return { bars, fromCache: false };
}

/**
 * Loads a window's dataset: the final cache when present (and not `refresh`), otherwise the
 * ingest, resuming from `<cache>.partial.json` and the per-pool bar files. Progress is
 * printed per pool. `barsWanted` defaults to this window's depth; a caller ingesting several
 * windows passes the OLDEST window's depth so one fetch serves them all.
 */
export async function loadWindowDataset(input: {
  window: WindowSpec;
  n: number;
  candidatesCap: number;
  solUsdPool: string;
  refresh: boolean;
  cacheDir?: string;
  barsWanted?: number;
  /** The strategy's TVL band; `k` is fitted from the candidates' TODAY figures. */
  tvlBand?: { minUsd: number; maxUsd: number };
  deps: WindowIngestDeps;
}): Promise<{ dataset: WindowDataset; cache: CacheOutcome; cachePath: string }> {
  const { window: w, deps } = input;
  const cachePath = windowCachePath(w, input.cacheDir);
  const partialPath = `${cachePath}.partial.json`;

  if (!input.refresh) {
    const hit = readJson<WindowDataset>(cachePath);
    if (hit && Array.isArray(hit.pools)) return { dataset: hit, cache: "hit", cachePath };
  }

  let partial = input.refresh ? null : readJson<PartialFile>(partialPath);
  const resumed = partial !== null;
  const daysBack = Math.ceil((deps.nowMs() / 1000 - w.start) / 86_400);
  const barsWanted = input.barsWanted ?? Math.ceil(daysBack * 24 * 1.05);

  if (partial?.bars) {
    // Migrate an old-format partial: its bars become per-pool files, and it shrinks to a list.
    for (const [address, bars] of Object.entries(partial.bars)) {
      if (!existsSync(resolve(process.cwd(), barFilePath(address, input.cacheDir)))) {
        writeJson(barFilePath(address, input.cacheDir), { requestedBars: barsWanted, bars } satisfies BarFile);
      }
    }
    delete partial.bars;
    delete partial.solUsdBars;
    writeJson(partialPath, partial);
  }

  if (!partial) {
    deps.log(`[window ${day(w.start)}→${day(w.end)}] building candidate universe (${daysBack} days back)…`);
    const universe = await deps.buildUniverse(daysBack);
    const candidates = pickCandidates(universe.pools, w, input.candidatesCap);
    partial = { window: w, candidates, failed: {} };
    writeJson(partialPath, partial);
  }

  const solUsdBars = (await barsFor(input.solUsdPool, barsWanted, input.cacheDir, deps.fetchBars)).bars.filter(
    (b) => b.t >= w.start && b.t < w.end,
  );

  const total = partial.candidates.length;
  // Only the in-window slice of each candidate stays in memory.
  const inWindowBars = new Map<string, Bar[]>();
  for (const [i, pool] of partial.candidates.entries()) {
    const tag = `[window ${day(w.start)}] ${String(i + 1).padStart(3)}/${total} ${pool.pairName.padEnd(18)}`;
    // A failure recorded by an earlier run is retried: it was a fact about the network then.
    if (resumed && partial.failed[pool.address]) delete partial.failed[pool.address];
    try {
      const { bars, fromCache } = await barsFor(pool.address, barsWanted, input.cacheDir, deps.fetchBars);
      const slice = bars.filter((b) => b.t >= w.start && b.t < w.end);
      inWindowBars.set(pool.address, slice);
      deps.log(`${tag} ${slice.length} bars in window${fromCache ? " (cached)" : ""}`);
    } catch (err) {
      partial.failed[pool.address] = err instanceof Error ? err.message : String(err);
      deps.log(`${tag} FAILED: ${partial.failed[pool.address]}`);
      writeJson(partialPath, partial);
    }
  }
  writeJson(partialPath, partial);

  const k = kFromCandidates(partial.candidates);
  const selection = selectWindowUniverse({
    candidates: partial.candidates
      .filter((p) => inWindowBars.has(p.address))
      .map((pool) => ({ pool, bars: inWindowBars.get(pool.address)! })),
    window: w,
    n: input.n,
    tvlBand: input.tvlBand && k !== null ? { ...input.tvlBand, k } : undefined,
  });

  const pools: PoolHistory[] = selection.selected.map(({ pool, bars }) => ({
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
    quoteIsUsd: ["USDC", "USDT", "USDH", "PYUSD", "FDUSD", "DAI"].includes(pool.quoteSymbol.toUpperCase()),
    cohort: pool.cohort,
    lifetimeVolumeUsd: pool.lifetimeVolumeUsd,
    bars,
  }));

  const dataset: WindowDataset = {
    fetchedAt: new Date(deps.nowMs()).toISOString(),
    windowDays: (w.end - w.start) / 86_400,
    pools,
    solUsdBars,
    window: { start: day(w.start), end: day(w.end), startSec: w.start, endSec: w.end },
    selection: { candidates: total, rejected: selection.rejected, n: input.n, k },
  };
  writeJson(cachePath, dataset);
  return { dataset, cache: resumed ? "resumed" : "fresh", cachePath };
}

/** Pools in the universe that have at least a day of bars in the window, over the pools asked for. */
export function universeCoverage(pools: readonly PoolHistory[], n: number, w: WindowSpec): { withData: number; n: number } {
  const withData = pools.filter((p) => p.bars.filter((b) => b.t >= w.start && b.t < w.end).length >= 24).length;
  return { withData, n };
}
