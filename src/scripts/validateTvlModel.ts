/**
 * Modelled TVL vs TVL measured on-chain, per window.
 *
 *   npm run validate:tvl
 *   npm run validate:tvl -- --end=2026-09-13 --windows=3 --days=91 --per-window=40 --samples=3 --ks=0.131,0.195,0.491
 *
 * For every candidate pool of each cached window (`.cache/historical_data_window_*.partial.json`,
 * INCLUDING the ones the modelled TVL band rejected — selecting only survivors of the model would
 * validate the model on its own output), at `--samples` instants inside the window:
 *
 *   real TVL      = reserve_x(T) x ratio(T) + reserve_y(T), priced through SOL or a stable
 *                   reserve(T) = post-balance of the last tx touching that reserve at or before T
 *                   (Helius getTransactionsForAddress, blockTime <= T); ratio(T) = Meteora 1h close
 *   modelled TVL  = k x trailing-24h volume from the cached GeckoTerminal bars (what the engine uses)
 *
 * READ-ONLY: RPC reads and public HTTP only. Signs nothing. Every chain reading is cached in
 * `.cache/tvl_truth/` so a rerun costs nothing; an unreadable reading is excluded and counted,
 * never replaced by a guess.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { env } from "../config/env.js";
import type { Bar } from "../backtest/historicalData.js";
import { SOL_USDC_POOL } from "../backtest/historicalData.js";
import { trailing24hVolume } from "../backtest/engine.js";
import type { UniversePool } from "../backtest/universe.js";
import { barFilePath, windowCachePath, windowsEndingAt } from "../backtest/windowUniverse.js";
import {
  STABLE_SYMBOLS,
  WSOL,
  evaluateKVariant,
  impliedK,
  impliedKByGroup,
  samePoolKDrift,
  postBalanceOf,
  quantile as quantileOf,
  spearman,
  tvlFromReserves,
  type TvlObservation,
} from "../backtest/tvlValidation.js";
import { describeTvlRpc, readTvlRpcUrlArg, resolveTvlRpc, type TvlRpc } from "../backtest/tvlRpc.js";

const SUMMARY_PATH = "backtest_tvl_validation_summary.json";
const REPORT_PATH = "backtest_tvl_validation_report.txt";
const TRUTH_DIR = ".cache/tvl_truth";

const flags = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(a);
  if (m) flags.set(m[1]!.toLowerCase(), m[2] ?? "true");
}
const num = (k: string, d: number) => (flags.has(k) ? Number(flags.get(k)) : d);

/*
 * Same flag as `backtest:integrity`: the chain reads can go to a key of their own instead of the
 * one the live engine reads from `.env`. Resolved before any request; the URL is never printed.
 */
let tvlRpc: TvlRpc;
try {
  tvlRpc = resolveTvlRpc(readTvlRpcUrlArg(process.argv.slice(2)), env.SOLANA_RPC_URL);
} catch (err) {
  console.error("[tvl] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
console.log(describeTvlRpc(tvlRpc));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = <T>(p: string): T | null => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(tvlRpc.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    // The RPC URL carries the provider key: never echo it, only the method, status and host.
    if (res.status === 429) throw new Error(`${method} HTTP 429 from ${tvlRpc.host} — rate limited; give the validation its own key with --tvl-rpc-url`);
    if (!res.ok) throw new Error(`${method} HTTP ${res.status} from ${tvlRpc.host}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }
}

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).pathname}`);
    return (await res.json()) as T;
  }
}

interface PoolMeta {
  reserve_x: string;
  reserve_y: string;
  token_x: { address: string; symbol: string };
  token_y: { address: string; symbol: string };
}

const metaCache = new Map<string, PoolMeta | null>();
async function poolMeta(address: string): Promise<PoolMeta | null> {
  if (metaCache.has(address)) return metaCache.get(address)!;
  const path = `${TRUTH_DIR}/meta_${address}.json`;
  let meta = readJson<PoolMeta>(path);
  if (!meta) {
    try {
      meta = await getJson<PoolMeta>(`https://dlmm.datapi.meteora.ag/pools/${address}`);
      if (meta?.reserve_x) writeFileSync(path, JSON.stringify(meta));
    } catch {
      meta = null;
    }
  }
  metaCache.set(address, meta?.reserve_x ? meta : null);
  return metaCache.get(address)!;
}

/** Reserve balance at T: post-balance of the last tx touching it at or before T. Null = unreadable. */
async function reserveAt(account: string, t: number): Promise<{ amount: number; txTime: number } | null> {
  const res = await rpc<{ data: Array<{ blockTime: number }> }>("getTransactionsForAddress", [
    account,
    {
      transactionDetails: "full",
      sortOrder: "desc",
      limit: 1,
      filters: { blockTime: { lte: t } },
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  const tx = res.data[0] as Parameters<typeof postBalanceOf>[0] & { blockTime: number };
  if (!tx) return null;
  const amount = postBalanceOf(tx, account);
  return amount === null ? null : { amount, txTime: tx.blockTime };
}

async function ratioAt(address: string, t: number): Promise<number | null> {
  const hour = Math.floor(t / 3600) * 3600;
  const body = await getJson<{ data: Array<{ timestamp: number; close: number }> }>(
    `https://dlmm.datapi.meteora.ag/pools/${address}/ohlcv?timeframe=1h&start_time=${hour - 6 * 3600}&end_time=${hour + 3600}`,
  );
  const before = body.data.filter((b) => b.timestamp <= t).sort((a, b) => b.timestamp - a.timestamp)[0];
  return before && before.close > 0 ? before.close : null;
}

interface Truth {
  pool: string;
  t: number;
  realTvlUsd: number | null;
  x: number | null;
  y: number | null;
  ratio: number | null;
  solUsd: number | null;
  staleSec: number | null;
  error: string | null;
}

async function truthAt(pool: UniversePool, t: number, solBars: Bar[]): Promise<Truth> {
  const path = `${TRUTH_DIR}/${pool.address}_${t}.json`;
  const hit = readJson<Truth>(path);
  if (hit) return hit;
  const out: Truth = { pool: pool.address, t, realTvlUsd: null, x: null, y: null, ratio: null, solUsd: null, staleSec: null, error: null };
  try {
    const meta = await poolMeta(pool.address);
    if (!meta) throw new Error("pool meta unreadable");
    const [rx, ry, ratio] = await Promise.all([reserveAt(meta.reserve_x, t), reserveAt(meta.reserve_y, t), ratioAt(pool.address, t)]);
    const solBar = solBars.filter((b) => b.t <= t).at(-1);
    out.solUsd = solBar ? solBar.c : null;
    out.x = rx?.amount ?? null;
    out.y = ry?.amount ?? null;
    out.ratio = ratio;
    if (rx && ry) out.staleSec = t - Math.min(rx.txTime, ry.txTime);
    if (out.x === null || out.y === null) throw new Error("reserve balance unreadable (no tx before T, or balance absent)");
    if (out.ratio === null) throw new Error("pool ratio at T unavailable");
    out.realTvlUsd = tvlFromReserves({
      x: out.x,
      y: out.y,
      ratioYPerX: out.ratio,
      xIsSol: meta.token_x.address === WSOL,
      yIsSol: meta.token_y.address === WSOL,
      xIsStable: STABLE_SYMBOLS.includes(meta.token_x.symbol.toUpperCase()),
      yIsStable: STABLE_SYMBOLS.includes(meta.token_y.symbol.toUpperCase()),
      solUsd: out.solUsd,
    });
    if (out.realTvlUsd === null) throw new Error("neither side is SOL or a stable: not priced");
  } catch (err) {
    out.error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  }
  // Only a SETTLED answer is cached; a transient network failure is retried next run.
  if (out.realTvlUsd !== null || /no tx before T|not priced|meta unreadable/.test(out.error ?? "")) {
    writeFileSync(path, JSON.stringify(out));
  }
  return out;
}

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : v.toFixed(d));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(0)}%`);

/**
 * The measurement validates itself first: reconstructed TVL at NOW against Meteora's own `tvl`
 * field for the same pools. If the reserve-x-price method disagrees with the API today, every
 * historical number it produces is suspect, and the run says so before any comparison.
 */
async function selfCheck(pools: UniversePool[], solBars: Bar[]): Promise<Array<{ pair: string; reconstructed: number | null; api: number | null; ratio: number | null }>> {
  const rows: Array<{ pair: string; reconstructed: number | null; api: number | null; ratio: number | null }> = [];
  const now = Math.floor(Date.now() / 1000) - 120;
  for (const pool of pools) {
    const meta = await getJson<PoolMeta & { tvl: number; token_x: { price?: number }; token_y: { price?: number } }>(
      `https://dlmm.datapi.meteora.ag/pools/${pool.address}`,
    ).catch(() => null);
    // SOL/USD as Meteora prices it in the same response, so the check compares method, not price feeds.
    const solSide = meta ? (meta.token_x.address === WSOL ? meta.token_x : meta.token_y.address === WSOL ? meta.token_y : null) : null;
    const solNow = solSide?.price ?? solBars.at(-1)?.c ?? null;
    let reconstructed: number | null = null;
    if (meta) {
      const [rx, ry, ratio] = await Promise.all([reserveAt(meta.reserve_x, now), reserveAt(meta.reserve_y, now), ratioAt(pool.address, now)]);
      if (rx && ry && ratio) {
        reconstructed = tvlFromReserves({
          x: rx.amount,
          y: ry.amount,
          ratioYPerX: ratio,
          xIsSol: meta.token_x.address === WSOL,
          yIsSol: meta.token_y.address === WSOL,
          xIsStable: STABLE_SYMBOLS.includes(meta.token_x.symbol.toUpperCase()),
          yIsStable: STABLE_SYMBOLS.includes(meta.token_y.symbol.toUpperCase()),
          solUsd: solNow,
        });
      }
    }
    const api = meta?.tvl ?? null;
    rows.push({ pair: pool.pairName, reconstructed, api, ratio: reconstructed && api ? reconstructed / api : null });
  }
  return rows;
}

async function main(): Promise<void> {
  mkdirSync(resolve(process.cwd(), TRUTH_DIR), { recursive: true });
  const end = flags.get("end") ?? "2026-09-13";
  const endSec = Date.parse(`${end}T00:00:00Z`) / 1000;
  const days = num("days", 91);
  const specs = windowsEndingAt(endSec, days, num("windows", 3));
  const perWindow = num("per-window", 40);
  const samples = num("samples", 3);
  const ks = (flags.get("ks") ?? "0.131,0.195,0.491").split(",").map(Number).filter((k) => k > 0);
  const band = { minUsd: env.MIN_TVL_USD, maxUsd: env.MAX_TVL_USD };
  const feeGate = { min: env.MIN_FEE_TVL_RATIO, max: env.MAX_FEE_TVL_RATIO };

  const solFile = readJson<{ bars: Bar[] }>(barFilePath(SOL_USDC_POOL));
  const solBars = solFile?.bars ?? [];
  if (solBars.length === 0) console.warn("[tvl] no cached SOL/USD bars: SOL-priced pools will be unpriced");

  const checkPools = (readJson<{ candidates: UniversePool[] }>(`${windowCachePath(specs[0]!)}.partial.json`)?.candidates ?? [])
    .filter((p) => p.tvlTodayUsd > 0)
    .slice(0, num("self-check", 8));
  const check = await selfCheck(checkPools, solBars);
  const checkRatios = check.map((c) => c.ratio).filter((r): r is number => r !== null);
  console.log("[tvl] self-check (reconstructed NOW / Meteora API tvl):");
  for (const c of check) console.log(`   ${c.pair.padEnd(16)} rekonstruksi ${fmt(c.reconstructed, 0)} · API ${fmt(c.api, 0)} · rasio ${fmt(c.ratio, 3)}`);

  const observations: TvlObservation[] = [];
  const exclusions: Record<string, number> = {};
  const excl = (w: string, why: string) => (exclusions[`${w}: ${why}`] = (exclusions[`${w}: ${why}`] ?? 0) + 1);
  const perWindowMeta: Array<{ label: string; start: string; end: string; candidates: number; sampledPools: number; observations: number }> = [];

  for (const [wi, spec] of specs.entries()) {
    const label = `W${wi + 1}`;
    const partial = readJson<{ candidates: UniversePool[] }>(`${windowCachePath(spec)}.partial.json`);
    if (!partial) {
      console.warn(`[tvl] ${label}: no candidate list at ${windowCachePath(spec)}.partial.json — run the per-window ingest with --end=${end}`);
      perWindowMeta.push({ label, start: day(spec.start), end: day(spec.end), candidates: 0, sampledPools: 0, observations: 0 });
      continue;
    }
    // Candidates with a day of bars in the window, deterministic order (address), capped.
    const usable: Array<{ pool: UniversePool; bars: Bar[] }> = [];
    for (const pool of partial.candidates) {
      const file = readJson<{ bars: Bar[] }>(barFilePath(pool.address));
      const inWin = (file?.bars ?? []).filter((b) => b.t >= spec.start && b.t < spec.end);
      if (inWin.length < 48) {
        excl(label, "<48 bars in window");
        continue;
      }
      usable.push({ pool, bars: file!.bars });
    }
    usable.sort((a, b) => a.pool.address.localeCompare(b.pool.address));
    const chosen = usable.slice(0, perWindow);
    let count = 0;
    for (const [pi, { pool, bars }] of chosen.entries()) {
      const inWin = bars.filter((b) => b.t >= spec.start && b.t < spec.end);
      for (let s = 0; s < samples; s++) {
        // Evenly spaced inside the pool's OWN in-window span, never before its first day of bars.
        const bar = inWin[Math.min(inWin.length - 1, 24 + Math.floor(((inWin.length - 25) * (s + 0.5)) / samples))]!;
        const idx = bars.indexOf(bar);
        const vol = trailing24hVolume(bars, idx);
        if (vol === null || !(vol > 0)) {
          excl(label, "no trailing 24h volume at T");
          continue;
        }
        const truth = await truthAt(pool, bar.t, solBars);
        if (truth.realTvlUsd === null || !(truth.realTvlUsd > 0)) {
          excl(label, truth.error ?? "real TVL null");
          continue;
        }
        const kToday = pool.tvlTodayUsd > 0 && pool.volume24hTodayUsd > 0 ? pool.tvlTodayUsd / pool.volume24hTodayUsd : null;
        observations.push({
          pool: pool.address,
          pairName: pool.pairName,
          window: label,
          t: bar.t,
          feeRate: pool.feeRate,
          vol24hUsd: vol,
          realTvlUsd: truth.realTvlUsd,
          perPoolKToday: kToday,
        });
        count++;
      }
      console.log(`[tvl] ${label} ${String(pi + 1).padStart(2)}/${chosen.length} ${pool.pairName.padEnd(16)} obs ${count}`);
    }
    perWindowMeta.push({ label, start: day(spec.start), end: day(spec.end), candidates: partial.candidates.length, sampledPools: chosen.length, observations: count });
  }

  /* ---- report ---- */
  const out: string[] = [];
  const h = (t: string) => out.push("", "═".repeat(96), t, "═".repeat(96));
  h("VALIDASI MODEL TVL — modelled (k x vol24h) vs TVL on-chain (reserve x harga di waktu T)");
  out.push(
    `Band TVL ${band.minUsd}-${band.maxUsd} · gate fee/TVL ${feeGate.min}-${feeGate.max} · k diuji: ${ks.join(", ")} + per-pool k HARI INI`,
    "Catatan struktural: dengan satu k global, fee/TVL modelled = feeRate / k (volume saling coret).",
    `Self-check metode (TVL rekonstruksi SEKARANG / tvl API Meteora, ${checkRatios.length} pool): median ${fmt(quantileOf(checkRatios, 0.5), 3)} · min ${fmt(checkRatios.length ? Math.min(...checkRatios) : null, 3)} · max ${fmt(checkRatios.length ? Math.max(...checkRatios) : null, 3)}`,
    "",
    ...perWindowMeta.map((m) => `${m.label} ${m.start} -> ${m.end}: kandidat ${m.candidates}, pool disampel ${m.sampledPools}, observasi ${m.observations}`),
  );
  const windows = [...perWindowMeta.map((m) => m.label), "SEMUA"];
  for (const w of windows) {
    const obs = w === "SEMUA" ? observations : observations.filter((o) => o.window === w);
    h(`${w} — ${obs.length} observasi dari ${new Set(obs.map((o) => o.pool)).size} pool`);
    if (obs.length === 0) {
      out.push("(tidak ada observasi — sampel kosong, bukan hasil)");
      continue;
    }
    const ik = impliedK(obs);
    out.push(`k yang diimplikasikan chain (TVL nyata / vol24h): p25 ${fmt(ik.p25, 3)} · median ${fmt(ik.median, 3)} · p75 ${fmt(ik.p75, 3)} (n ${ik.n})`);
    out.push(
      "",
      "k             | n   | log2(model/nyata) p10 / p25 / med / p75 / p90 | dlm 2x | med |err| | band: in-in / out-out / salah-terima / salah-tolak | Spearman TVL | Spearman fee/TVL | top10 fee/TVL | gate fee/TVL lolos model / nyata / setuju",
    );
    for (const k of [...ks, "per-pool-today" as const]) {
      const e = evaluateKVariant(obs, k, band, feeGate);
      const l = e.errors.log2Ratio;
      out.push(
        `${String(k).padEnd(13)} | ${String(e.n).padEnd(3)} | ${fmt(l.p10)} / ${fmt(l.p25)} / ${fmt(l.median)} / ${fmt(l.p75)} / ${fmt(l.p90)} | ${pct(e.errors.within2x)} | ${pct(e.errors.medianAbsPctError)} | ` +
          `${e.band.bothIn} / ${e.band.bothOut} / ${e.band.falseAccept} / ${e.band.falseReject} | ${fmt(e.spearmanTvl)} | ${fmt(e.spearmanFeeTvl)} | ${pct(e.top10OverlapFeeTvl)} | ` +
          `${e.feeTvlGate.modelledPass} / ${e.feeTvlGate.realPass} / ${e.feeTvlGate.agree}`,
      );
    }
    out.push(`Spearman vol24h vs TVL nyata (seberapa volume menjelaskan urutan TVL): ${fmt(spearman(obs.map((o) => o.vol24hUsd), obs.map((o) => o.realTvlUsd)))}`);
  }
  h("WAKTU vs KOMPOSISI — kenapa k global pindah antar window / antar daftar kandidat");
  const quoteGroup = (o: TvlObservation) => (/-(USDC|USDT|USDH|PYUSD|FDUSD|DAI|USD1)$/i.test(o.pairName) ? "quote USD" : "quote SOL/lain");
  for (const w of perWindowMeta.map((m) => m.label)) {
    const g = impliedKByGroup(observations.filter((o) => o.window === w), quoteGroup);
    out.push(`${w} k nyata per grup: ` + Object.entries(g).map(([name, v]) => `${name} n${v.n} median ${fmt(v.median, 3)} (IQR ${fmt(v.p25, 3)}-${fmt(v.p75, 3)})`).join(" | "));
  }
  const labels = perWindowMeta.map((m) => m.label);
  const drifts: Array<{ newer: string; older: string; pools: number; medianLog2OlderOverNewer: number | null }> = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const d = samePoolKDrift(observations, labels[i]!, labels[j]!);
      drifts.push({ newer: labels[i]!, older: labels[j]!, ...d });
      out.push(`pool SAMA ${labels[i]} -> ${labels[j]}: ${d.pools} pool · median log2(k lama / k baru) ${fmt(d.medianLog2OlderOverNewer)} (0 = k pool itu tidak berubah)`);
    }
  }
  out.push("Kalau pool yang sama hampir tidak berubah tapi median global berubah besar, yang berubah adalah KOMPOSISI sampel, bukan pasar.");

  h("EKSKLUSI (tidak diukur, tidak ditebak)");
  const ex = Object.entries(exclusions).sort((a, b) => b[1] - a[1]);
  out.push(...(ex.length ? ex.map(([k, v]) => `${v}x  ${k}`) : ["(tidak ada)"]));

  const report = out.join("\n");
  console.log(report);
  writeFileSync(resolve(process.cwd(), REPORT_PATH), report, "utf8");
  writeFileSync(
    resolve(process.cwd(), SUMMARY_PATH),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        end,
        days,
        band,
        feeGate,
        ks,
        selfCheck: check,
        windows: perWindowMeta,
        results: windows.map((w) => {
          const obs = w === "SEMUA" ? observations : observations.filter((o) => o.window === w);
          return { window: w, impliedK: impliedK(obs), variants: [...ks, "per-pool-today" as const].map((k) => evaluateKVariant(obs, k, band, feeGate)) };
        }),
        composition: {
          byQuote: Object.fromEntries(perWindowMeta.map((m) => [m.label, impliedKByGroup(observations.filter((o) => o.window === m.label), quoteGroup)])),
          samePoolDrift: drifts,
        },
        exclusions,
        observations,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[tvl] wrote ${REPORT_PATH} and ${SUMMARY_PATH}`);
}

function day(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error("[tvl] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
