/**
 * Universe per window: a past window is judged on pools that were trading IN it.
 *
 * `backtest:integrity`'s window 2 once had 7 pools and 0 trades because its universe was
 * chosen from pools active around today. These tests pin the three things that fix it —
 * a pool born after a window never enters it, selection ranks by in-window activity, the
 * ingest resumes from its cache — and that the flag being OFF leaves the old run untouched.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  barFilePath,
  kFromCandidates,
  loadWindowDataset,
  pickCandidates,
  selectWindowUniverse,
  universeCoverage,
  windowCachePath,
  windowsEndingAt,
  type WindowCandidate,
} from "../backtest/windowUniverse.js";
import type { Bar } from "../backtest/historicalData.js";
import type { UniversePool } from "../backtest/universe.js";

const DAY = 86_400;
const NOW = 1_789_300_000; // 13 Sep 2026-ish
const W = { start: NOW - 91 * DAY, end: NOW };

const cacheDir = mkdtempSync(join(tmpdir(), "flowmetrix-window-"));
after(() => {
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    // Windows may hold it; not a test result.
  }
});

function pool(address: string, over: Partial<UniversePool> = {}): UniversePool {
  return {
    address,
    pairName: `${address}-SOL`,
    baseSymbol: address,
    quoteSymbol: "SOL",
    baseMint: `${address}mint`,
    quoteMint: "So11111111111111111111111111111111111111112",
    createdAtMs: (NOW - 400 * DAY) * 1000,
    binStep: 100,
    feeRate: 0.01,
    tvlTodayUsd: 100_000,
    volume24hTodayUsd: 500_000,
    lifetimeVolumeUsd: 10_000_000,
    bothTokensVerified: true,
    isBlacklisted: false,
    cohort: "survivor",
    ...over,
  };
}

/** Hourly bars from `from` to `to` (unix seconds) at `volume` per bar. */
function bars(from: number, to: number, volume: number): Bar[] {
  const out: Bar[] = [];
  for (let t = from; t < to; t += 3600) out.push({ t, o: 1, h: 1, l: 1, c: 1, v: volume });
  return out;
}

describe("selectWindowUniverse", () => {
  it("never takes a pool born after the window — even one with huge bars later", () => {
    const candidates: WindowCandidate[] = [
      { pool: pool("OLD"), bars: bars(W.start, W.end, 1_000) },
      // Born the day the window ends; a volume-today ranking would put it first.
      { pool: pool("NEWBORN", { createdAtMs: W.end * 1000 }), bars: bars(W.end, W.end + 30 * DAY, 1_000_000) },
      { pool: pool("LATE", { createdAtMs: (W.end + 5 * DAY) * 1000 }), bars: bars(W.start, W.end, 9_999) },
    ];
    const sel = selectWindowUniverse({ candidates, window: W, n: 10 });
    assert.deepEqual(sel.selected.map((s) => s.pool.address), ["OLD"]);
    assert.equal(sel.rejected.bornAfterWindow, 2);
  });

  it("ranks by fees INSIDE the window, not by today's volume", () => {
    const candidates: WindowCandidate[] = [
      { pool: pool("QUIET_THEN", { volume24hTodayUsd: 10_000_000 }), bars: bars(W.start, W.end, 10) },
      { pool: pool("BUSY_THEN", { volume24hTodayUsd: 1 }), bars: bars(W.start, W.end, 5_000) },
      // More volume than QUIET_THEN, less FEE (0.0001 x 500 < 0.01 x 10): volume alone would rank it higher.
      { pool: pool("CHEAP_FEE", { feeRate: 0.0001 }), bars: bars(W.start, W.end, 500) },
    ];
    const sel = selectWindowUniverse({ candidates, window: W, n: 2 });
    assert.deepEqual(sel.selected.map((s) => s.pool.address), ["BUSY_THEN", "QUIET_THEN"]);
    assert.equal(sel.rejected.belowTopN, 1);
  });

  it("needs a day of in-window bars, and filters on MODELLED in-window TVL when given a band", () => {
    const candidates: WindowCandidate[] = [
      { pool: pool("THIN"), bars: bars(W.end - 10 * 3600, W.end, 1_000) },
      { pool: pool("GIANT"), bars: bars(W.start, W.end, 1_000_000) }, // 24M/day x k 0.2 = $4.8M
      { pool: pool("FITS"), bars: bars(W.start, W.end, 10_000) }, // 240k/day x 0.2 = $48k... below 50k
      { pool: pool("FITS2"), bars: bars(W.start, W.end, 20_000) }, // 480k/day x 0.2 = $96k
    ];
    const sel = selectWindowUniverse({ candidates, window: W, n: 10, tvlBand: { minUsd: 50_000, maxUsd: 500_000, k: 0.2 } });
    assert.deepEqual(sel.selected.map((s) => s.pool.address), ["FITS2"]);
    assert.deepEqual(sel.rejected, { bornAfterWindow: 0, noBarsInWindow: 1, tvlBand: 2, belowTopN: 0 });
  });

  it("fits k from today's TVL/volume, and says null rather than guess when nothing reports both", () => {
    assert.equal(kFromCandidates([pool("A", { tvlTodayUsd: 100, volume24hTodayUsd: 1000 })]), 0.1);
    assert.equal(kFromCandidates([pool("A", { tvlTodayUsd: 0 })]), null);
  });

  it("fits k on SURVIVORS only — a dormant pool's tiny volume today must not inflate it", () => {
    const k = kFromCandidates([
      pool("S1", { tvlTodayUsd: 100_000, volume24hTodayUsd: 1_000_000 }),
      pool("D1", { cohort: "dead-or-dormant", tvlTodayUsd: 50_000, volume24hTodayUsd: 10 }),
      pool("D2", { cohort: "dead-or-dormant", tvlTodayUsd: 50_000, volume24hTodayUsd: 10 }),
    ]);
    assert.equal(k, 0.1, "the 5000x dormant ratios are not part of the fit");
  });

  it("never lets one cohort crowd the other out of the candidate cap", () => {
    const survivors = Array.from({ length: 10 }, (_, i) => pool(`S${i}`, { volume24hTodayUsd: 1_000 + i, lifetimeVolumeUsd: 1e12 }));
    const dead = Array.from({ length: 10 }, (_, i) => pool(`D${i}`, { cohort: "dead-or-dormant", lifetimeVolumeUsd: 1_000 + i }));
    const picked = pickCandidates([...survivors, ...dead], W, 6);
    assert.equal(picked.length, 6);
    assert.equal(picked.filter((p) => p.cohort === "survivor").length, 3);
    assert.deepEqual(picked.filter((p) => p.cohort !== "survivor").map((p) => p.address), ["D9", "D8", "D7"]);

    // Too few dead pools: survivors fill the rest; a pool born after the window never counts.
    const fill = pickCandidates([...survivors, dead[0]!, pool("NEW", { cohort: "dead-or-dormant", createdAtMs: W.end * 1000 })], W, 6);
    assert.deepEqual([fill.length, fill.filter((p) => p.cohort !== "survivor").length], [6, 1]);
  });

  it("cuts non-overlapping windows newest first, and names each cache by its dates", () => {
    const ws = windowsEndingAt(NOW, 91, 3);
    assert.equal(ws.length, 3);
    assert.equal(ws[0]!.end, NOW);
    assert.equal(ws[1]!.end, ws[0]!.start);
    assert.equal(ws[2]!.end, ws[1]!.start);
    assert.match(windowCachePath(ws[1]!), /^\.cache\/historical_data_window_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("reports coverage as pools with a day of bars in the window over the pools asked for", () => {
    const p = { ...pool("A"), bars: bars(W.start, W.start + 30 * 3600, 1) } as never;
    const q = { ...pool("B"), bars: bars(W.start, W.start + 5 * 3600, 1) } as never;
    assert.deepEqual(universeCoverage([p, q], 32, W), { withData: 1, n: 32 });
  });
});

describe("loadWindowDataset — cache hit, resume, fresh", () => {
  const makeDeps = (calls: string[], failOn: string | null = null) => ({
    buildUniverse: async () => {
      calls.push("universe");
      return {
        pools: [pool("A"), pool("B", { lifetimeVolumeUsd: 5 }), pool("C", { createdAtMs: (W.end + DAY) * 1000 })],
        survivors: 3,
        deadOrDormant: 0,
        scanned: 3,
        totalUniverseSize: 3,
      };
    },
    fetchBars: async (address: string) => {
      calls.push(`bars:${address}`);
      if (address === failOn) throw new Error("interrupted");
      return bars(W.start, W.end, address === "A" ? 5_000 : 1_000);
    },
    log: () => undefined,
    nowMs: () => NOW * 1000,
  });

  it("ingests fresh, then HITS the cache without a single network call", async () => {
    const calls: string[] = [];
    const first = await loadWindowDataset({ window: W, n: 5, candidatesCap: 10, solUsdPool: "SOLUSDC", refresh: false, cacheDir, deps: makeDeps(calls) });
    assert.equal(first.cache, "fresh");
    assert.deepEqual(first.dataset.pools.map((p) => p.address), ["A", "B"], "C was born after the window");
    assert.ok(existsSync(first.cachePath));
    assert.equal(calls.includes("bars:C"), false, "a pool born after the window is not even fetched");

    const again: string[] = [];
    const second = await loadWindowDataset({ window: W, n: 5, candidatesCap: 10, solUsdPool: "SOLUSDC", refresh: false, cacheDir, deps: makeDeps(again) });
    assert.equal(second.cache, "hit");
    assert.deepEqual(again, []);
    assert.deepEqual(second.dataset.pools.map((p) => p.address), ["A", "B"]);
  });

  it("RESUMES from the partial file after an interrupted run, retrying only what is missing", async () => {
    const w2 = { start: W.start - 91 * DAY, end: W.start };
    const dir = join(cacheDir, "resume");
    const universe = async () => ({
      pools: [pool("A", { createdAtMs: (w2.start - DAY) * 1000 }), pool("B", { createdAtMs: (w2.start - DAY) * 1000 })],
      survivors: 2, deadOrDormant: 0, scanned: 2, totalUniverseSize: 2,
    });
    const firstCalls: string[] = [];
    await loadWindowDataset({
      window: w2, n: 5, candidatesCap: 10, solUsdPool: "SOLUSDC", refresh: false, cacheDir: dir,
      deps: {
        buildUniverse: universe,
        fetchBars: async (a: string) => {
          firstCalls.push(a);
          if (a === "B") throw new Error("429");
          return bars(w2.start, w2.end, 1_000);
        },
        log: () => undefined,
        nowMs: () => NOW * 1000,
      },
    });
    const partialPath = `${windowCachePath(w2, dir)}.partial.json`;
    const partial = JSON.parse(readFileSync(partialPath, "utf8"));
    assert.ok(existsSync(barFilePath("A", dir)), "A's bars are in their own per-pool file");
    assert.equal(partial.bars, undefined, "the partial file is a list, not a bar store");
    assert.equal(partial.failed.B, "429");

    // The run was interrupted before its final cache landed.
    rmSync(windowCachePath(w2, dir));

    const resumedCalls: string[] = [];
    const resumed = await loadWindowDataset({
      window: w2, n: 5, candidatesCap: 10, solUsdPool: "SOLUSDC", refresh: false, cacheDir: dir,
      deps: {
        buildUniverse: async () => {
          throw new Error("a resumed run must not rebuild the universe");
        },
        fetchBars: async (a: string) => {
          resumedCalls.push(a);
          return bars(w2.start, w2.end, 1_000);
        },
        log: () => undefined,
        nowMs: () => NOW * 1000,
      },
    });
    assert.equal(resumed.cache, "resumed");
    assert.deepEqual(resumedCalls, ["B"], "A is not refetched; the failed B is retried");
    assert.deepEqual(resumed.dataset.pools.map((p) => p.address).sort(), ["A", "B"]);
  });
});

describe("one k across windows", () => {
  it("re-selects a cached window whose k differs from the override — from files, no network", async () => {
    const dir = join(cacheDir, "koverride");
    const calls: string[] = [];
    const deps = {
      buildUniverse: async () => ({
        pools: [pool("A", { tvlTodayUsd: 400_000, volume24hTodayUsd: 100_000 })],
        survivors: 1, deadOrDormant: 0, scanned: 1, totalUniverseSize: 1,
      }),
      fetchBars: async (a: string) => {
        calls.push(a);
        return bars(W.start, W.end, 2_000); // 48k/day
      },
      log: () => undefined,
      nowMs: () => NOW * 1000,
    };
    const band = { minUsd: 50_000, maxUsd: 500_000 };
    // k from the candidate = 4: 48k/day x 4 = $192k, inside the band.
    const first = await loadWindowDataset({ window: W, n: 5, candidatesCap: 5, solUsdPool: "S", refresh: false, cacheDir: dir, tvlBand: band, deps });
    assert.equal(first.dataset.selection.k, 4);
    assert.equal(first.dataset.pools.length, 1);

    calls.length = 0;
    // k = 0.5: $24k modelled, below the band — the cached selection is stale and is redone.
    const second = await loadWindowDataset({ window: W, n: 5, candidatesCap: 5, solUsdPool: "S", refresh: false, cacheDir: dir, tvlBand: band, kOverride: 0.5, deps });
    assert.notEqual(second.cache, "hit");
    assert.equal(second.dataset.selection.k, 0.5);
    assert.equal(second.dataset.pools.length, 0);
    assert.deepEqual(calls, [], "re-selection reads the bar files; nothing is refetched");

    const third = await loadWindowDataset({ window: W, n: 5, candidatesCap: 5, solUsdPool: "S", refresh: false, cacheDir: dir, tvlBand: band, kOverride: 0.5, deps });
    assert.equal(third.cache, "hit");
  });
});

describe("an old-format partial file (bars inline) is migrated, not refetched", () => {
  it("moves each pool's bars to its own file and fetches only the pools it never had", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(cacheDir, "migrate");
    const w3 = { start: W.start - 182 * DAY, end: W.start - 91 * DAY };
    const born = (w3.start - DAY) * 1000;
    const partialPath = `${windowCachePath(w3, dir)}.partial.json`;
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(
      partialPath,
      JSON.stringify({
        window: w3,
        candidates: [pool("A", { createdAtMs: born }), pool("B", { createdAtMs: born })],
        bars: { A: bars(w3.start, w3.end, 1_000) },
        failed: {},
        solUsdBars: bars(w3.start, w3.end, 0),
      }),
    );

    const fetched: string[] = [];
    const result = await loadWindowDataset({
      window: w3, n: 5, candidatesCap: 10, solUsdPool: "SOLUSDC", refresh: false, cacheDir: dir,
      deps: {
        buildUniverse: async () => {
          throw new Error("a migrated run must not rebuild the universe");
        },
        fetchBars: async (a: string) => {
          fetched.push(a);
          return bars(w3.start, w3.end, 1_000);
        },
        log: () => undefined,
        nowMs: () => NOW * 1000,
      },
    });
    assert.equal(result.cache, "resumed");
    assert.deepEqual(fetched, ["SOLUSDC", "B"], "A came from the migrated file; SOL/USD and B were never on disk");
    assert.ok(existsSync(barFilePath("A", dir)));
    const after = JSON.parse(readFileSync(partialPath, "utf8"));
    assert.equal(after.bars, undefined);
  });
});

describe("work order #3 — reach as parameters, reuse, funnel", () => {
  it("splits TVL-band rejections into too small / too large", () => {
    const sel = selectWindowUniverse({
      candidates: [
        { pool: pool("SMALL"), bars: bars(W.start, W.end, 100) }, // 2.4k/day x 0.2 = $480
        { pool: pool("HUGE"), bars: bars(W.start, W.end, 1_000_000) },
        { pool: pool("OK"), bars: bars(W.start, W.end, 20_000) },
      ],
      window: W,
      n: 10,
      tvlBand: { minUsd: 50_000, maxUsd: 500_000, k: 0.2 },
    });
    assert.equal(sel.rejected.tvlBand, 2);
    assert.deepEqual(sel.tvlBandDetail, { belowMin: 1, aboveMax: 1 });
  });

  it("a bar file fetched YESTERDAY still reaches a fixed window start — no daily refetch of the whole cache", async () => {
    const { barFileReaches } = await import("../backtest/windowUniverse.js");
    const oldestStart = W.start;
    const fetchedYesterday = NOW - DAY;
    const requested = Math.ceil(((fetchedYesterday - oldestStart) / 3600) * 1.05);
    const wantedToday = Math.ceil(((NOW - oldestStart) / 3600) * 1.05);
    const file = { requestedBars: requested, fetchedAtSec: fetchedYesterday, bars: bars(oldestStart, fetchedYesterday, 1) };
    assert.ok(requested < wantedToday, "the count rule alone would refetch it");
    assert.equal(barFileReaches(file, wantedToday, oldestStart), true);
    // Legacy file without fetchedAtSec: dated by its last bar.
    assert.equal(barFileReaches({ requestedBars: requested, bars: file.bars }, wantedToday, oldestStart), true);
    // A genuinely shallow file is refetched; an empty undated one falls back to the count rule.
    assert.equal(barFileReaches({ requestedBars: 24, fetchedAtSec: NOW, bars: [] }, wantedToday, oldestStart), false);
    assert.equal(barFileReaches({ requestedBars: 10, bars: [] }, wantedToday, oldestStart), false);
    assert.equal(barFileReaches({ requestedBars: wantedToday, bars: [] }, wantedToday, oldestStart), true);
  });

  it("EXTENDS a legacy candidate list when asked for a wider reach — old candidates kept, their bars not refetched", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(cacheDir, "extend");
    const w = { start: W.start - 40 * DAY, end: W.start - 30 * DAY };
    const born = (w.start - DAY) * 1000;
    const partialPath = `${windowCachePath(w, dir)}.partial.json`;
    mkdirSync(dirname(partialPath), { recursive: true });
    // A 14 Sep-shape partial: no recorded ingest params, one candidate, its bars on disk.
    writeFileSync(partialPath, JSON.stringify({ window: w, candidates: [pool("OLD", { createdAtMs: born })], failed: {} }));
    const barsWanted = 5_000;
    mkdirSync(dirname(barFilePath("OLD", dir)), { recursive: true });
    writeFileSync(barFilePath("OLD", dir), JSON.stringify({ requestedBars: barsWanted, bars: bars(w.start, w.end, 1_000) }));
    writeFileSync(barFilePath("SOLUSDC", dir), JSON.stringify({ requestedBars: barsWanted, bars: bars(w.start, w.end, 0) }));

    const pagesSeen: Array<{ survivorPages: number; cohortPages: number }> = [];
    const fetched: string[] = [];
    const result = await loadWindowDataset({
      window: w, n: 5, candidatesCap: 200, survivorPages: 12, cohortPages: 80, solUsdPool: "SOLUSDC", refresh: false, cacheDir: dir, barsWanted,
      deps: {
        buildUniverse: async (_days, pages) => {
          pagesSeen.push(pages);
          return {
            pools: [pool("OLD", { createdAtMs: born }), pool("NEW1", { createdAtMs: born }), pool("NEW2", { createdAtMs: born, cohort: "dead-or-dormant" })],
            survivors: 2, deadOrDormant: 1, scanned: 3, totalUniverseSize: 3,
          };
        },
        fetchBars: async (a: string) => {
          fetched.push(a);
          return bars(w.start, w.end, 1_000);
        },
        log: () => undefined,
        nowMs: () => NOW * 1000,
      },
    });
    assert.equal(result.cache, "extended");
    assert.deepEqual(pagesSeen, [{ survivorPages: 12, cohortPages: 80 }], "the flags reach the listing walk");
    assert.deepEqual(fetched.sort(), ["NEW1", "NEW2"], "OLD and SOL/USD came from disk");
    assert.equal(result.dataset.selection.candidates, 3);
    assert.deepEqual(result.dataset.selection.ingest, { candidatesCap: 200, survivorPages: 12, cohortPages: 80 });
    assert.equal(result.dataset.selection.fetchFailed, 0);

    // The same reach again: a cache hit. A WIDER reach: not a hit.
    const quiet = { buildUniverse: async () => { throw new Error("no rebuild"); }, fetchBars: async () => { throw new Error("no fetch"); }, log: () => undefined, nowMs: () => NOW * 1000 };
    const again = await loadWindowDataset({ window: w, n: 5, candidatesCap: 200, survivorPages: 12, cohortPages: 80, solUsdPool: "SOLUSDC", refresh: false, cacheDir: dir, barsWanted, deps: quiet });
    assert.equal(again.cache, "hit");
    const narrower = await loadWindowDataset({ window: w, n: 5, candidatesCap: 96, solUsdPool: "SOLUSDC", refresh: false, cacheDir: dir, barsWanted, deps: quiet });
    assert.equal(narrower.cache, "hit", "a cache built wider serves a narrower ask");
    await assert.rejects(
      loadWindowDataset({ window: w, n: 5, candidatesCap: 400, solUsdPool: "SOLUSDC", refresh: false, cacheDir: dir, barsWanted, deps: quiet }),
      /no rebuild/,
      "a wider ask than the cache reaches is never served from it",
    );
  });

  it("the funnel reconciles, counts fetch failures, and names the binding brake with its count", async () => {
    const { windowFunnel } = await import("../backtest/windowUniverse.js");
    const dir = join(cacheDir, "funnel");
    const w = { start: W.start - 60 * DAY, end: W.start - 50 * DAY };
    const born = (w.start - DAY) * 1000;
    const universe = [
      pool("GOOD", { createdAtMs: born }),
      pool("BIG1", { createdAtMs: born }),
      pool("BIG2", { createdAtMs: born }),
      pool("THIN", { createdAtMs: born }),
      pool("LATE", { createdAtMs: (w.end + DAY) * 1000, cohort: "dead-or-dormant" }),
      pool("BROKEN", { createdAtMs: born }),
    ];
    const result = await loadWindowDataset({
      window: w, n: 4, candidatesCap: 10, solUsdPool: "SOLUSDC", refresh: false, cacheDir: dir,
      tvlBand: { minUsd: 50_000, maxUsd: 500_000 },
      kOverride: 0.2,
      deps: {
        buildUniverse: async () => ({ pools: universe, survivors: 6, deadOrDormant: 0, scanned: 6, totalUniverseSize: 6 }),
        fetchBars: async (a: string) => {
          if (a === "BROKEN") throw new Error("429");
          if (a === "THIN") return bars(w.end - 5 * 3600, w.end, 20_000);
          return bars(w.start, w.end, a.startsWith("BIG") ? 1_000_000 : 20_000);
        },
        log: () => undefined,
        nowMs: () => NOW * 1000,
      },
    });
    const f = windowFunnel(result.dataset, w);
    // LATE is born after the window: pickCandidates drops it before the cap, so it is not a candidate.
    assert.equal(f.candidates, 5);
    assert.equal(f.used, 1);
    assert.equal(f.fetchFailed, 1);
    assert.equal(f.reconciles, true);
    assert.deepEqual(f.tvlBandDetail, { belowMin: 0, aboveMax: 2 });
    assert.deepEqual(f.binding, { brake: "tvlBand", count: 2, short: 3 });
    assert.equal(f.walkExhausted, true, "5 candidates from a cap of 10");
  });
});

describe("runIntegrity per-window path — flags, profile, halves, answers", () => {
  it("reads --candidates / --survivor-pages / --cohort-pages, defaulting to 200 / 12 / 40", async () => {
    const { readIngestFlags, readEndFlag } = await import("../backtest/runIntegrity.js");
    assert.deepEqual(readIngestFlags(new Map()), { candidatesCap: 200, survivorPages: 12, cohortPages: 40 });
    assert.deepEqual(
      readIngestFlags(new Map([["candidates", "320"], ["survivor-pages", "20"], ["cohort-pages", "120"]])),
      { candidatesCap: 320, survivorPages: 20, cohortPages: 120 },
    );
    assert.throws(() => readIngestFlags(new Map([["cohort-pages", "0"]])), /positive integer/);
    assert.throws(() => readIngestFlags(new Map([["candidates", "1.5"]])), /positive integer/);
    assert.equal(readEndFlag(new Map()), null);
    assert.equal(readEndFlag(new Map([["end", "2026-09-13"]])), Date.parse("2026-09-13T00:00:00Z") / 1000);
    assert.throws(() => readEndFlag(new Map([["end", "13/09/2026"]])), /YYYY-MM-DD/);
  });

  it("an empty half is 'sampel kosong', never a bare 0; answers are per window", async () => {
    const { describeHalf, windowAnswer } = await import("../backtest/runIntegrity.js");
    assert.equal(describeHalf(0, null), "sampel kosong (0 pool)");
    assert.match(describeHalf(11, null), /^11 pool \/ 0 trd \(tipis\)$/);
    assert.equal(windowAnswer(12, "belum bisa diverifikasi"), "BELUM BISA DIVERIFIKASI");
    assert.equal(windowAnswer(null, "lolos"), "BELUM BISA DIVERIFIKASI");
    assert.equal(windowAnswer(12, "lolos"), "YA");
    assert.equal(windowAnswer(-1, "lolos"), "TIDAK");
    assert.equal(windowAnswer(12, "gagal"), "TIDAK");
  });

  it("sizes the account from the LIVE profile via the shared resolver — no hardcoded demo account, no hardcoded pages", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "backtest", "runIntegrity.ts"), "utf8");
    const perWindow = src.slice(src.indexOf("async function runPerWindowUniverse("), src.indexOf("if (process.argv[1]"));
    assert.match(perWindow, /readProfileOverrides\(ctx\.flags\)/);
    assert.match(perWindow, /resolveBacktestProfile\(\{\s*overrides,/);
    assert.equal(perWindow.includes("accountFlags"), false);
    assert.equal(/"300"|"63"/.test(perWindow), false, "the 13 Sep demo account is gone from this path");
    assert.equal(/survivorPages: \d|cohortPages: \d/.test(perWindow), false, "pages come from flags");
  });
});

describe("--per-window-universe is OFF by default", () => {
  it("leaves main's published path untouched unless the flag is given", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "backtest", "runIntegrity.ts"), "utf8");
    const main = src.slice(src.indexOf("async function main("), src.indexOf("async function runPerWindowUniverse("));
    assert.match(main, /const perWindowUniverse = flags\.has\("per-window-universe"\);/);
    // The only reach into the new path is the flagged early return.
    assert.equal((main.match(/runPerWindowUniverse\(/g) ?? []).length, 1);
    assert.match(main, /if \(perWindowUniverse\) \{\s*await runPerWindowUniverse\(/);
    assert.equal(main.includes("loadWindowDataset"), false, "the old path never loads a per-window dataset");
    assert.match(main, /nonOverlappingWindows\(dataset\.pools, dataset\.solUsdBars, days, windowsWanted\)/);
  });
});
