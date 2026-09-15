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
import type { TvlPoint } from "./onchainTvl.js";

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
  /**
   * `rejected.tvlBand` split by side. The band rejected 79 of W2's and 71 of W3's candidates
   * in the 14 Sep run; whether they were too SMALL or too LARGE decides what would fix it
   * (a deeper dead-cohort walk finds small pools; it cannot shrink a SOL-USDC-scale one).
   */
  tvlBandDetail: { belowMin: number; aboveMax: number; unknown?: number };
}

/**
 * How far the candidate list reaches. Stored with the partial file and the dataset, so a run
 * asking for a wider reach than the cache was built with re-picks instead of silently hitting
 * a narrower cache.
 */
export interface IngestParams {
  candidatesCap: number;
  survivorPages: number;
  cohortPages: number;
}

/** What the 14 Sep run hardcoded; a cache without recorded params was built with these pages. */
export const LEGACY_INGEST_PAGES = { survivorPages: 12, cohortPages: 40 } as const;

/** Defaults of `--candidates` / `--survivor-pages` / `--cohort-pages` on the per-window path. */
export const DEFAULT_INGEST_PARAMS: IngestParams = { candidatesCap: 200, ...LEGACY_INGEST_PAGES };

/** True when a list built with `have` already reaches at least as far as `want` asks. */
export function ingestCovers(have: IngestParams, want: IngestParams): boolean {
  return (
    have.candidatesCap >= want.candidatesCap &&
    have.survivorPages >= want.survivorPages &&
    have.cohortPages >= want.cohortPages
  );
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
  /**
   * ON-CHAIN TVL for the band instead of `k x median daily volume` (see `onchainTvl.ts`). Null
   * means unknown and REJECTS the candidate (counted under `tvlBand`, detail `unknown`) — never a
   * fall back to the volume model the validation refuted. Absent = the volume model, unchanged.
   */
  tvlOf?: (address: string) => number | null;
}): WindowSelection {
  const rejected: WindowSelection["rejected"] = { bornAfterWindow: 0, noBarsInWindow: 0, tvlBand: 0, belowTopN: 0 };
  const tvlBandDetail: WindowSelection["tvlBandDetail"] = input.tvlOf ? { belowMin: 0, aboveMax: 0, unknown: 0 } : { belowMin: 0, aboveMax: 0 };
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
      const measured = input.tvlOf ? input.tvlOf(c.pool.address) : null;
      if (input.tvlOf && measured === null) {
        rejected.tvlBand++;
        tvlBandDetail.unknown = (tvlBandDetail.unknown ?? 0) + 1;
        continue;
      }
      const modelledTvl = measured ?? input.tvlBand.k * median(daily);
      if (modelledTvl < input.tvlBand.minUsd || modelledTvl > input.tvlBand.maxUsd) {
        rejected.tvlBand++;
        if (modelledTvl < input.tvlBand.minUsd) tvlBandDetail.belowMin++;
        else tvlBandDetail.aboveMax++;
        continue;
      }
    }
    ranked.push({ ...c, inWindowFeesUsd: c.pool.feeRate * volume, inWindowBars: inWindow.length });
  }

  ranked.sort((a, b) => b.inWindowFeesUsd - a.inWindowFeesUsd || a.pool.address.localeCompare(b.pool.address));
  const selected = ranked.slice(0, Math.max(0, input.n));
  rejected.belowTopN = ranked.length - selected.length;
  return { selected, rejected, tvlBandDetail };
}

/* ------------------------------------------------------------------ */
/* Resume-able ingest                                                  */
/* ------------------------------------------------------------------ */

export interface WindowIngestDeps {
  buildUniverse(windowDaysBack: number, pages: { survivorPages: number; cohortPages: number }): Promise<UniverseResult>;
  fetchBars(address: string, barsWanted: number): Promise<Bar[]>;
  log(line: string): void;
  nowMs(): number;
}

export interface WindowDataset extends HistoricalDataset {
  window: { start: string; end: string; startSec: number; endSec: number };
  selection: {
    candidates: number;
    rejected: WindowSelection["rejected"];
    n: number;
    k: number | null;
    /** Absent on datasets written before 14 Sep's work order #3. */
    tvlBandDetail?: WindowSelection["tvlBandDetail"];
    /** Candidates whose bars could not be fetched; they never reach the selection. */
    fetchFailed?: number;
    ingest?: IngestParams;
    /** "model" (k x volume) on every dataset written before on-chain TVL existed. */
    tvlBasis?: "model" | "onchain";
    tvlCadenceSec?: number;
    /** Candidates that got no on-chain series, by reason (unpriceable pair, mis-oriented price...). */
    tvlRefusals?: Record<string, number>;
  };
  /** On-chain TVL samples of the selected pools, sorted by t, including one cadence before the window. */
  tvlSeries?: Record<string, TvlPoint[]>;
}

/**
 * The params a cached file was built with. Legacy files predate recording them; they were
 * built with the then-default cap `n x 3` (96 at n = 32) and the 12 / 40 pages. A walk that
 * came back short of its cap left fewer candidates, so the cap is the larger of the two.
 */
const recordedIngest = (recorded: IngestParams | undefined, candidateCount: number, n: number): IngestParams =>
  recorded ?? { candidatesCap: Math.max(candidateCount, n * 3), ...LEGACY_INGEST_PAGES };

export interface WindowFunnel {
  candidates: number;
  used: number;
  fetchFailed: number;
  rejected: WindowSelection["rejected"];
  tvlBandDetail: WindowSelection["tvlBandDetail"] | null;
  coverage: { withData: number; n: number };
  /** candidates = used + rejections + fetch failures; false means a bug or a torn cache, and is printed. */
  reconciles: boolean;
  /** The listing walk returned fewer candidates than the cap: the pages bound, not the cap. */
  walkExhausted: boolean | null;
  /** Null when the universe reached `n`: nothing binds. */
  binding: null | { brake: WindowBrake; count: number; short: number };
}

export type WindowBrake = "bornAfterWindow" | "noBarsInWindow" | "tvlBand" | "fetchFailed";

/**
 * The window's funnel, reconciled: candidates = used + every rejection + fetch failures.
 *
 * When the universe is short of `n`, `binding` names the brake that removed the most
 * candidates — the one a larger reach would have to get past — with its count. It is a
 * FINDING about the sample; a thin window's zero trades are never a statement about the
 * strategy. `belowTopN` is never the binding brake of a short window: a window short of `n`
 * rejected nobody for rank.
 */
export function windowFunnel(dataset: WindowDataset, spec: WindowSpec): WindowFunnel {
  const sel = dataset.selection;
  const fetchFailed = sel.fetchFailed ?? 0;
  const used = dataset.pools.length;
  const coverage = universeCoverage(dataset.pools, sel.n, spec);
  const r = sel.rejected;
  const reconciles = used + r.bornAfterWindow + r.noBarsInWindow + r.tvlBand + r.belowTopN + fetchFailed === sel.candidates;
  let binding: WindowFunnel["binding"] = null;
  if (coverage.withData < sel.n) {
    const brakes: Array<[WindowBrake, number]> = [
      ["tvlBand", r.tvlBand],
      ["noBarsInWindow", r.noBarsInWindow],
      ["bornAfterWindow", r.bornAfterWindow],
      ["fetchFailed", fetchFailed],
    ];
    brakes.sort((a, b) => b[1] - a[1]);
    const [brake, count] = brakes[0]!;
    binding = { brake, count, short: sel.n - coverage.withData };
  }
  return {
    candidates: sel.candidates,
    used,
    fetchFailed,
    rejected: r,
    tvlBandDetail: sel.tvlBandDetail ?? null,
    coverage,
    reconciles,
    walkExhausted: sel.ingest ? sel.candidates < sel.ingest.candidatesCap : null,
    binding,
  };
}

export const BRAKE_LABEL: Record<WindowBrake, string> = {
  bornAfterWindow: "lahir sesudah window",
  noBarsInWindow: "<24 bar di window",
  tvlBand: "band TVL (modelled)",
  fetchFailed: "fetch bar gagal",
};

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
  /** Absent on partial files written before work order #3 (see `recordedIngest`). */
  ingest?: IngestParams;
  /** Present only in partial files written before bars moved to per-pool files; migrated on read. */
  bars?: Record<string, Bar[]>;
  solUsdBars?: Bar[] | null;
}

export interface BarFile {
  /** How deep the fetch that produced this file asked to go, in hourly bars. */
  requestedBars: number;
  /** When that fetch ran (unix seconds); absent on files written before work order #3. */
  fetchedAtSec?: number;
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

/**
 * `extended`: a cached candidate list was built with a narrower reach than asked for, so the
 * universe was rebuilt and its new pools ADDED to the old list. The old candidates stay —
 * their bars are already on disk, and a wider reach must never mean a smaller sample.
 */
export type CacheOutcome = "hit" | "resumed" | "extended" | "fresh";

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

/**
 * Whether a bar file already reaches back to `neededFromSec`.
 *
 * A COUNT comparison alone (`requestedBars >= barsWanted`) refetched every pool the day after
 * a run: the oldest window start is fixed, but "hours from now back to it" grows by 24 a day,
 * so every file on disk read as too shallow and a 2-3 hour ingest restarted from zero. What
 * matters is the TIME the request reached: its fetch time (the last bar, for files written
 * before `fetchedAtSec` was stored) minus the hours it asked for. An empty file with no fetch
 * time falls back to the count rule — there is nothing to date it by.
 */
export function barFileReaches(file: BarFile, barsWanted: number, neededFromSec: number): boolean {
  if (file.requestedBars >= barsWanted) return true;
  const fetchedAt = file.fetchedAtSec ?? file.bars[file.bars.length - 1]?.t;
  if (fetchedAt === undefined) return false;
  return fetchedAt - file.requestedBars * 3600 <= neededFromSec;
}

async function barsFor(
  address: string,
  barsWanted: number,
  neededFromSec: number,
  nowSec: number,
  cacheDir: string | undefined,
  fetchBars: WindowIngestDeps["fetchBars"],
): Promise<{ bars: Bar[]; fromCache: boolean }> {
  const path = barFilePath(address, cacheDir);
  const hit = readJson<BarFile>(path);
  if (hit && Array.isArray(hit.bars) && barFileReaches(hit, barsWanted, neededFromSec)) return { bars: hit.bars, fromCache: true };
  const bars = await fetchBars(address, barsWanted);
  writeJson(path, { requestedBars: barsWanted, fetchedAtSec: nowSec, bars } satisfies BarFile);
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
  /** Listing pages walked for today's survivors / the creation-ordered dead cohort. Default: the 14 Sep 12 / 40. */
  survivorPages?: number;
  cohortPages?: number;
  solUsdPool: string;
  refresh: boolean;
  cacheDir?: string;
  barsWanted?: number;
  /** The oldest instant the bar files must reach (see `barFileReaches`). Default: this window's start. */
  barsFromSec?: number;
  /**
   * One k for every window, fitted where it CAN be fitted: today's survivors of all ages.
   *
   * Fitting k per window from the candidates born before that window ends selects only the
   * OLD survivors for an old window — pools whose volume today is a fraction of their TVL —
   * and produced k = 2.6 and 4.3 for the two older windows against 0.195 for the newest,
   * zero trades in both. The harness's TVL model assumes one k across time; this keeps it.
   * A cached dataset selected with a different k is re-selected (from its files, no network).
   */
  kOverride?: number | null;
  /** The strategy's TVL band; `k` is fitted from the candidates' TODAY figures. */
  tvlBand?: { minUsd: number; maxUsd: number };
  /**
   * Select and gate on TVL MEASURED ON-CHAIN (see `onchainTvl.ts`) instead of `k x volume`.
   * `seriesFor` returns the pool's samples at `times` (fetching what its cache lacks), or a
   * refusal. The band uses the median in-window sample; the dataset carries the in-window series
   * for the engine. A cached dataset selected on the other basis or cadence is re-selected.
   */
  onchainTvl?: {
    cadenceSec: number;
    seriesFor(address: string, times: number[], createdAtSec: number | null): Promise<{ points: TvlPoint[]; refused: string | null }>;
  };
  deps: WindowIngestDeps;
}): Promise<{ dataset: WindowDataset; cache: CacheOutcome; cachePath: string }> {
  const { window: w, deps } = input;
  const cachePath = windowCachePath(w, input.cacheDir);
  const partialPath = `${cachePath}.partial.json`;

  const want: IngestParams = {
    candidatesCap: input.candidatesCap,
    survivorPages: input.survivorPages ?? LEGACY_INGEST_PAGES.survivorPages,
    cohortPages: input.cohortPages ?? LEGACY_INGEST_PAGES.cohortPages,
  };
  const pages = { survivorPages: want.survivorPages, cohortPages: want.cohortPages };

  if (!input.refresh) {
    const hit = readJson<WindowDataset>(cachePath);
    const kMatches = input.kOverride == null || hit?.selection?.k === input.kOverride;
    const reaches = hit?.selection != null && ingestCovers(recordedIngest(hit.selection.ingest, hit.selection.candidates, input.n), want);
    const basisMatches =
      (hit?.selection?.tvlBasis ?? "model") === (input.onchainTvl ? "onchain" : "model") &&
      (!input.onchainTvl || hit?.selection?.tvlCadenceSec === input.onchainTvl.cadenceSec);
    if (hit && Array.isArray(hit.pools) && kMatches && reaches && basisMatches) return { dataset: hit, cache: "hit", cachePath };
  }

  let partial = input.refresh ? null : readJson<PartialFile>(partialPath);
  let outcome: CacheOutcome = partial !== null ? "resumed" : "fresh";
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

  if (partial) {
    const have = recordedIngest(partial.ingest, partial.candidates.length, input.n);
    if (!ingestCovers(have, want)) {
      deps.log(
        `[window ${day(w.start)}→${day(w.end)}] cached list reaches cap ${have.candidatesCap} / pages ${have.survivorPages}+${have.cohortPages}; ` +
          `asked cap ${want.candidatesCap} / pages ${want.survivorPages}+${want.cohortPages} — rebuilding the universe and ADDING to the list…`,
      );
      const universe = await deps.buildUniverse(daysBack, pages);
      const known = new Set(partial.candidates.map((p) => p.address));
      const added = pickCandidates(universe.pools, w, want.candidatesCap).filter((p) => !known.has(p.address));
      partial.candidates = [...partial.candidates, ...added];
      partial.ingest = {
        candidatesCap: Math.max(have.candidatesCap, want.candidatesCap),
        survivorPages: Math.max(have.survivorPages, want.survivorPages),
        cohortPages: Math.max(have.cohortPages, want.cohortPages),
      };
      writeJson(partialPath, partial);
      outcome = "extended";
      deps.log(`[window ${day(w.start)}] ${known.size} candidates kept from cache, +${added.length} new`);
    }
  }

  if (!partial) {
    deps.log(`[window ${day(w.start)}→${day(w.end)}] building candidate universe (${daysBack} days back)…`);
    const universe = await deps.buildUniverse(daysBack, pages);
    const candidates = pickCandidates(universe.pools, w, input.candidatesCap);
    partial = { window: w, candidates, failed: {}, ingest: want };
    writeJson(partialPath, partial);
  }

  const nowSec = Math.floor(deps.nowMs() / 1000);
  const barsFromSec = input.barsFromSec ?? w.start;
  const solUsdBars = (await barsFor(input.solUsdPool, barsWanted, barsFromSec, nowSec, input.cacheDir, deps.fetchBars)).bars.filter(
    (b) => b.t >= w.start && b.t < w.end,
  );

  const total = partial.candidates.length;
  // Only the in-window slice of each candidate stays in memory.
  const inWindowBars = new Map<string, Bar[]>();
  let fromDisk = 0;
  let fetched = 0;
  const startedMs = deps.nowMs();
  for (const [i, pool] of partial.candidates.entries()) {
    const tag = `[window ${day(w.start)}] ${String(i + 1).padStart(3)}/${total} ${pool.pairName.padEnd(18)}`;
    // A failure recorded by an earlier run is retried: it was a fact about the network then.
    if (resumed && partial.failed[pool.address]) delete partial.failed[pool.address];
    try {
      const { bars, fromCache } = await barsFor(pool.address, barsWanted, barsFromSec, nowSec, input.cacheDir, deps.fetchBars);
      const slice = bars.filter((b) => b.t >= w.start && b.t < w.end);
      inWindowBars.set(pool.address, slice);
      if (fromCache) fromDisk++;
      else fetched++;
      const elapsedMin = (deps.nowMs() - startedMs) / 60_000;
      deps.log(`${tag} ${slice.length} bars in window${fromCache ? " (cached)" : ""} · fetched ${fetched} / cached ${fromDisk} · ${elapsedMin.toFixed(1)} min`);
    } catch (err) {
      partial.failed[pool.address] = err instanceof Error ? err.message : String(err);
      deps.log(`${tag} FAILED: ${partial.failed[pool.address]}`);
      writeJson(partialPath, partial);
    }
  }
  writeJson(partialPath, partial);
  const failed = partial.failed;
  const fetchFailed = partial.candidates.filter((p) => failed[p.address] !== undefined).length;

  /*
   * ON-CHAIN TVL, only for candidates that can still be selected (born before the window ends,
   * a day of bars in it): every sample is two RPC calls, and the other rejections are free. The
   * grid starts one cadence BEFORE the window so the first bars have a sample at or before them.
   */
  const tvlPoints = new Map<string, TvlPoint[]>();
  const tvlRefusals: Record<string, number> = {};
  if (input.onchainTvl) {
    const cadence = input.onchainTvl.cadenceSec;
    const times: number[] = [];
    for (let t = Math.ceil((w.start - cadence) / cadence) * cadence; t < w.end; t += cadence) times.push(t);
    const eligible = partial.candidates.filter(
      (p) => !(p.createdAtMs > 0 && p.createdAtMs / 1000 >= w.end) && (inWindowBars.get(p.address)?.length ?? 0) >= 24,
    );
    for (const [i, pool] of eligible.entries()) {
      const r = await input.onchainTvl.seriesFor(pool.address, times, pool.createdAtMs > 0 ? Math.floor(pool.createdAtMs / 1000) : null);
      if (r.refused) tvlRefusals[r.refused] = (tvlRefusals[r.refused] ?? 0) + 1;
      else tvlPoints.set(pool.address, r.points);
      deps.log(
        `[window ${day(w.start)}] tvl ${String(i + 1).padStart(3)}/${eligible.length} ${pool.pairName.padEnd(18)} ` +
          (r.refused ? `NO SERIES: ${r.refused}` : `${r.points.length}/${times.length} samples`),
      );
    }
  }
  const tvlOf = input.onchainTvl
    ? (address: string): number | null => {
        const pts = tvlPoints.get(address)?.filter((p) => p.t >= w.start && p.t < w.end) ?? [];
        if (pts.length === 0) return null;
        const sorted = pts.map((p) => p.tvlUsd).sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)]!;
      }
    : undefined;

  const k = input.onchainTvl ? null : (input.kOverride ?? kFromCandidates(partial.candidates));
  const selection = selectWindowUniverse({
    candidates: partial.candidates
      .filter((p) => inWindowBars.has(p.address))
      .map((pool) => ({ pool, bars: inWindowBars.get(pool.address)! })),
    window: w,
    n: input.n,
    tvlBand: input.tvlBand && (k !== null || tvlOf) ? { ...input.tvlBand, k: k ?? 0 } : undefined,
    tvlOf,
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
    selection: {
      candidates: total,
      rejected: selection.rejected,
      n: input.n,
      k,
      tvlBandDetail: selection.tvlBandDetail,
      fetchFailed,
      ingest: partial.ingest ?? want,
      tvlBasis: input.onchainTvl ? "onchain" : "model",
      ...(input.onchainTvl ? { tvlCadenceSec: input.onchainTvl.cadenceSec, tvlRefusals } : {}),
    },
    ...(input.onchainTvl
      ? { tvlSeries: Object.fromEntries(selection.selected.map(({ pool }) => [pool.address, tvlPoints.get(pool.address) ?? []])) }
      : {}),
  };
  writeJson(cachePath, dataset);
  return { dataset, cache: outcome, cachePath };
}

/** Pools in the universe that have at least a day of bars in the window, over the pools asked for. */
export function universeCoverage(pools: readonly PoolHistory[], n: number, w: WindowSpec): { withData: number; n: number } {
  const withData = pools.filter((p) => p.bars.filter((b) => b.t >= w.start && b.t < w.end).length >= 24).length;
  return { withData, n };
}
