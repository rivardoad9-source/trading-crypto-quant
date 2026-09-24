/**
 * READ-ONLY: tabel kandidat screener engine + hitungan gate EV (buat latihan manual LP).
 * Bukan bagian produksi; hapus kalau nggak perlu.
 */
const { fetchLivePools, screenPools, defaultThresholds } = await import(
  "../src/services/meteora.js"
);
import { WSOL_MINT } from "../src/config/constants.js";
import { env } from "../src/config/env.js";

async function solPriceUsd(): Promise<number> {
  try {
    const r = await fetch(
      "https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112",
      { signal: AbortSignal.timeout(8000) },
    );
    const j = (await r.json()) as { data?: Record<string, { price?: string }> };
    const p = Number(j.data?.["So11111111111111111111111111111111111111112"]?.price);
    return Number.isFinite(p) && p > 0 ? p : 111;
  } catch {
    return 111;
  }
}

const sol = await solPriceUsd();
const notionalSol = Number(process.env.NOTIONAL_SOL ?? 1.8);
const notionalUsd = notionalSol * sol;
const gasRoundTripUsd = 0.008 * sol; // floor gas open+close (0.008 SOL), lihat onchainExecutor
const slipPct = env.FORCED_EXIT_SLIPPAGE_PCT;
const minCov = env.MIN_FEE_COST_COVERAGE;

const pools = await fetchLivePools({ pageSize: 200, pages: 3 });
const res = screenPools(pools, defaultThresholds());
console.log(`scanned ${res.scanned} | lolos filter ${res.candidates.length}`);
console.log(`ditolak: ${JSON.stringify(res.rejected)}`);
console.log(
  `\nnotional=${notionalSol} SOL ($${notionalUsd.toFixed(2)} @ $${sol.toFixed(2)}/SOL) | gas RT $${gasRoundTripUsd.toFixed(3)} | slippage exit ${slipPct}% | butuh coverage ${minCov}x\n`,
);

const solSide = res.candidates.filter((p) => p.quoteMint === WSOL_MINT || p.baseMint === WSOL_MINT);
console.log(`kandidat yang ada sisi SOL: ${solSide.length}/${res.candidates.length}\n`);

const rows = solSide
  .sort((a, b) => b.score - a.score)
  .map((p) => {
    const fee24 = notionalUsd * p.feeTvlRatio24h;
    const cost = gasRoundTripUsd + notionalUsd * (slipPct / 100);
    return {
      pair: p.pairName,
      pool: p.address,
      tvl: Math.round(p.tvlUsd),
      vol24: Math.round(p.volume24hUsd),
      feeTvlPct: +(p.feeTvlRatio24h * 100).toFixed(2),
      fee24Usd: +fee24.toFixed(2),
      cover: +(fee24 / cost).toFixed(2),
      lulus: fee24 / cost >= minCov ? "YA" : "tidak",
      binStep: p.binStep,
      ageH: Math.round(p.ageHours),
      score: Math.round(p.score),
    };
  });

for (const r of rows) console.log(JSON.stringify(r));
console.log(`\nTOTAL kandidat sisi SOL: ${rows.length}`);
