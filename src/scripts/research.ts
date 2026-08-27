/**
 * Quantitative research on Meteora DLMM pool inefficiency.
 *
 *   npm run research
 *
 * Three stages:
 *   1. Failure & opportunity analysis over every enumerated entry point.
 *   2. A Pool Quality Score fitted on the FIRST half of the window only.
 *   3. Out-of-sample validation on the SECOND half, which the fit never saw.
 *
 * The split is strictly by time. Any parameter chosen after looking at the second
 * half would invalidate the whole exercise, so the score's thresholds are derived
 * from in-sample statistics alone and then applied unchanged.
 */
import { getJson } from "../services/http.js";
import { env } from "../config/env.js";
import { loadHistoricalData } from "../backtest/historicalData.js";
import { calibrateTvlModel } from "../backtest/tvlModel.js";
import {
  bucketBy,
  enumerateOpportunities,
  simulateBook,
  summarise,
  type BucketStats,
  type Opportunity,
} from "../backtest/research.js";
import { renderTable } from "../backtest/report.js";
import type { DlmmPool } from "../services/meteora.js";

const pct = (n: number, d = 2): string => `${n.toFixed(d)}%`;
const num = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : "inf");

function statsTable(title: string, rows: BucketStats[]): void {
  console.log(`\n  ${title}`);
  console.log(
    renderTable(
      [
        { header: "Bucket" },
        { header: "n", align: "right" },
        { header: "Mean net", align: "right" },
        { header: "Median net", align: "right" },
        { header: "Win rate", align: "right" },
        { header: "Big loss", align: "right" },
        { header: "Mean fees", align: "right" },
        { header: "Mean pos value", align: "right" },
      ],
      rows
        .filter((r) => r.n > 0)
        .map((r) => [
          r.label,
          String(r.n),
          pct(r.meanNetPct),
          pct(r.medianNetPct),
          pct(r.winRatePct, 1),
          pct(r.bigLossRatePct, 1),
          pct(r.meanFeesPct),
          pct(r.meanPositionValuePct),
        ]),
    )
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
}

/* ------------------------------------------------------------------ */
/* Pool Quality Score                                                  */
/* ------------------------------------------------------------------ */

export interface ScoreWeights {
  yieldSustainability: number;
  volatilityPenalty: number;
  liquidityBuffer: number;
}

export const SCORE_WEIGHTS: ScoreWeights = {
  yieldSustainability: 0.45,
  volatilityPenalty: 0.35,
  liquidityBuffer: 0.20,
};

/** Reference constants, all fixed from in-sample statistics. */
export interface ScoreParams {
  /** Fee/TVL per 24h that earns a full yield score. */
  targetFeeTvl: number;
  /** Turnover above which volume looks like a transient spike rather than a base rate. */
  turnoverKnee: number;
  /** Realized hourly volatility (%) that zeroes the volatility component. */
  volCeilingPct: number;
  /** 24h price gain (%) that zeroes the volatility component. */
  pumpCeilingPct: number;
  /** TVL at which the liquidity buffer is considered full. */
  tvlFullUsd: number;
  /** TVL below which the liquidity buffer is zero. */
  tvlFloorUsd: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Pool Quality Score, 0–100.
 *
 *   S = 100 x [ w_y x Y  +  w_v x (1 - P)  +  w_l x L ]
 *
 * Y — YIELD SUSTAINABILITY
 *     Y = min(1, feeTvl / targetFeeTvl) x turnoverDiscount
 *     turnoverDiscount = 1 / (1 + max(0, turnover - knee))
 *
 *     Economic logic: raw fee/TVL is a snapshot and rewards exactly the pools whose
 *     denominator just collapsed. Turnover (24h volume / TVL) says how much of that
 *     yield came from churning a thin pool. A pool earning its fees on liquidity that
 *     turns over a sane number of times keeps earning; one turning over 50x is
 *     mid-event and its yield disappears with the event.
 *
 * P — VOLATILITY PENALTY
 *     P = max( rvol / volCeiling , max(0, priceChange24h) / pumpCeiling )
 *
 *     Economic logic: a DLMM position is short volatility. It earns a fixed fee rate
 *     and pays convexity — the more the price moves, the more of the position converts
 *     into whichever asset is falling. Realized volatility captures the continuous
 *     part; the 24h gain captures the discrete "already pumped" part, which is the
 *     asymmetric one because a pump mean-reverts into the LP's inventory. The worse of
 *     the two governs, so a pool cannot hide a pump behind a calm average.
 *
 * L — LIQUIDITY DEPTH BUFFER
 *     L = clamp01( log10(TVL / tvlFloor) / log10(tvlFull / tvlFloor) )
 *
 *     Economic logic: depth is what determines whether the position can be exited at
 *     the quoted price at all, and it is the direct defence against a single wallet
 *     moving the pool. Its benefit is logarithmic, not linear — the step from $10k to
 *     $50k matters far more than $500k to $1M.
 */
export function poolQualityScore(
  features: {
    feeTvlRatio24h: number;
    volTvlRatio: number;
    realizedVol24hPct: number;
    priceChange24hPct: number;
    tvlUsd: number;
  },
  params: ScoreParams,
  weights: ScoreWeights = SCORE_WEIGHTS,
): number {
  const turnoverDiscount = 1 / (1 + Math.max(0, features.volTvlRatio - params.turnoverKnee));
  const yieldScore = clamp01(features.feeTvlRatio24h / params.targetFeeTvl) * turnoverDiscount;

  const volPenalty = clamp01(
    Math.max(
      features.realizedVol24hPct / params.volCeilingPct,
      Math.max(0, features.priceChange24hPct) / params.pumpCeilingPct,
    ),
  );

  const liquidity =
    features.tvlUsd <= params.tvlFloorUsd
      ? 0
      : clamp01(
          Math.log10(features.tvlUsd / params.tvlFloorUsd) /
            Math.log10(params.tvlFullUsd / params.tvlFloorUsd),
        );

  return (
    100 *
    (weights.yieldSustainability * yieldScore +
      weights.volatilityPenalty * (1 - volPenalty) +
      weights.liquidityBuffer * liquidity)
  );
}

/* ------------------------------------------------------------------ */

async function fetchPoolCreationTimes(addresses: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};

  for (const address of addresses) {
    try {
      const raw = await getJson<{ created_at?: number }>(
        `${env.METEORA_API_URL}/pools/${address}`,
      );
      if (typeof raw.created_at === "number" && raw.created_at > 0) {
        out[address] = raw.created_at;
      }
    } catch {
      /* age simply stays unknown for this pool */
    }
  }

  return out;
}

async function main(): Promise<void> {
  const dataset = await loadHistoricalData({ poolCount: 16, deadPoolCount: 10, windowDays: 30 });

  const survivors = dataset.pools.filter((p) => p.cohort === "survivor");
  const tvlModel = calibrateTvlModel(
    survivors.map(
      (p) =>
        ({
          address: p.address,
          tvlUsd: p.tvlTodayUsd,
          volume24hUsd: p.bars.slice(-24).reduce((s, b) => s + b.v, 0),
        }) as DlmmPool,
    ),
  );

  console.log("[research] fetching pool creation times for the age feature…");
  const ages = await fetchPoolCreationTimes(dataset.pools.map((p) => p.address));
  console.log(`[research] ages known for ${Object.keys(ages).length}/${dataset.pools.length} pools`);

  const all = enumerateOpportunities(
    dataset.pools,
    dataset.solUsdBars,
    tvlModel,
    undefined,
    ages,
  );

  const times = all.map((o) => o.entryTime);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tSplit = tMin + (tMax - tMin) / 2;

  const inSample = all.filter((o) => o.entryTime < tSplit);
  const outSample = all.filter((o) => o.entryTime >= tSplit);

  console.log("");
  console.log("═".repeat(96));
  console.log("  FLOWMETRIX — MARKET INEFFICIENCY RESEARCH (Meteora DLMM)");
  console.log("═".repeat(96));
  console.log(
    `  Enumerated entries : ${all.length} across ${dataset.pools.length} pools ` +
      `(${survivors.length} survivors + ${dataset.pools.length - survivors.length} dead/dormant)`,
  );
  console.log(
    `  In-sample  (fit)   : ${inSample.length} entries, ` +
      `${new Date(tMin * 1000).toISOString().slice(0, 10)} → ${new Date(tSplit * 1000).toISOString().slice(0, 10)}`,
  );
  console.log(
    `  Out-of-sample      : ${outSample.length} entries, ` +
      `${new Date(tSplit * 1000).toISOString().slice(0, 10)} → ${new Date(tMax * 1000).toISOString().slice(0, 10)}`,
  );
  console.log(`  Baseline (all)     : mean net ${pct(summarise("", all).meanNetPct)}`);

  /* ================================================================ */
  console.log("\n" + "─".repeat(96));
  console.log("  1 · FAILURE & OPPORTUNITY ANALYSIS  (in-sample only)");
  console.log("─".repeat(96));

  statsTable(
    "By modelled TVL",
    bucketBy(inSample, (o) => o.tvlUsd, [25_000, 50_000, 150_000, 500_000], (n) =>
      n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n.toFixed(0)}`,
    ),
  );

  statsTable(
    "By 24h volume",
    bucketBy(inSample, (o) => o.vol24hUsd, [50_000, 250_000, 1_000_000], (n) =>
      `$${(n / 1000).toFixed(0)}k`,
    ),
  );

  statsTable(
    "By turnover (24h volume / TVL)",
    bucketBy(inSample, (o) => o.volTvlRatio, [1, 3, 10, 30], (n) => `${n}x`),
  );

  statsTable(
    "By fee/TVL per 24h",
    bucketBy(inSample, (o) => o.feeTvlRatio24h, [0.01, 0.03, 0.08, 0.2], (n) => pct(n * 100, 0)),
  );

  statsTable(
    "By realized hourly volatility",
    bucketBy(inSample, (o) => o.realizedVol24hPct, [2, 5, 10, 20], (n) => pct(n, 0)),
  );

  statsTable(
    "By 24h price change",
    bucketBy(inSample, (o) => o.priceChange24hPct, [-20, 0, 25, 75, 150], (n) => pct(n, 0)),
  );

  statsTable(
    "By 1h price change",
    bucketBy(inSample, (o) => o.priceChange1hPct, [-5, 0, 5, 15], (n) => pct(n, 0)),
  );

  const withAge = inSample.filter((o) => o.poolAgeHours !== null);
  if (withAge.length > 0) {
    statsTable(
      "By pool age",
      bucketBy(withAge, (o) => o.poolAgeHours ?? 0, [48, 168, 720], (n) => `${(n / 24).toFixed(0)}d`),
    );
  }

  statsTable(
    "By entry hour (UTC)",
    bucketBy(inSample, (o) => o.entryHourUtc, [4, 8, 12, 16, 20], (n) => `${n}:00`),
  );

  /* ---- cluster of failure ---- */
  console.log("\n  CLUSTER OF FAILURE — conditions preceding a loss worse than 10%");

  const clusters: Array<{ name: string; test: (o: Opportunity) => boolean }> = [
    { name: "turnover > 10x", test: (o) => o.volTvlRatio > 10 },
    { name: "turnover > 30x", test: (o) => o.volTvlRatio > 30 },
    { name: "24h change > +75%", test: (o) => o.priceChange24hPct > 75 },
    { name: "24h change > +150%", test: (o) => o.priceChange24hPct > 150 },
    { name: "1h change > +10%", test: (o) => o.priceChange1hPct > 10 },
    { name: "realized vol > 10%/h", test: (o) => o.realizedVol24hPct > 10 },
    { name: "TVL < $50k", test: (o) => o.tvlUsd < 50_000 },
    { name: "pool age < 48h", test: (o) => o.poolAgeHours !== null && o.poolAgeHours < 48 },
    {
      name: "vol > 10x AND pumped > 75%",
      test: (o) => o.volTvlRatio > 10 && o.priceChange24hPct > 75,
    },
    {
      name: "rvol > 10%/h AND TVL < $50k",
      test: (o) => o.realizedVol24hPct > 10 && o.tvlUsd < 50_000,
    },
  ];

  const base = summarise("all", inSample);

  console.log(
    renderTable(
      [
        { header: "Condition" },
        { header: "n", align: "right" },
        { header: "Mean net", align: "right" },
        { header: "vs baseline", align: "right" },
        { header: "Big-loss rate", align: "right" },
        { header: "Lift", align: "right" },
      ],
      clusters
        .map((c) => {
          const s = summarise(c.name, inSample.filter(c.test));
          if (s.n === 0) return null;
          return [
            c.name,
            String(s.n),
            pct(s.meanNetPct),
            pct(s.meanNetPct - base.meanNetPct),
            pct(s.bigLossRatePct, 1),
            `${num(s.bigLossRatePct / Math.max(base.bigLossRatePct, 1e-9), 2)}x`,
          ];
        })
        .filter((r): r is string[] => r !== null),
    )
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  console.log(
    `\n  Baseline: mean net ${pct(base.meanNetPct)}, big-loss rate ${pct(base.bigLossRatePct, 1)} over ${base.n} entries.`,
  );

  /* ================================================================ */
  console.log("\n" + "─".repeat(96));
  console.log("  2 · POOL QUALITY SCORE  (parameters fixed from in-sample statistics)");
  console.log("─".repeat(96));

  const params: ScoreParams = {
    targetFeeTvl: 0.03,
    turnoverKnee: 3,
    volCeilingPct: 12,
    pumpCeilingPct: 100,
    tvlFullUsd: 500_000,
    tvlFloorUsd: 20_000,
  };

  console.log("\n  S = 100 x [ 0.45 x Y  +  0.35 x (1 - P)  +  0.20 x L ]");
  console.log("    Y = min(1, feeTvl / 0.03) x 1/(1 + max(0, turnover - 3))");
  console.log("    P = clamp01( max( rvol/12% , max(0, chg24h)/100% ) )");
  console.log("    L = clamp01( log10(TVL/$20k) / log10($500k/$20k) )");

  const score = (o: Opportunity): number => poolQualityScore(o, params);

  const scoreBuckets = (rows: Opportunity[]): BucketStats[] =>
    bucketBy(rows, score, [30, 40, 50, 60], (n) => n.toFixed(0));

  statsTable("Outcome by score decile band — IN-SAMPLE", scoreBuckets(inSample));

  /* ================================================================ */
  console.log("\n" + "─".repeat(96));
  console.log("  3 · OUT-OF-SAMPLE VALIDATION  (second half, never used for fitting)");
  console.log("─".repeat(96));

  statsTable("Outcome by score band — OUT-OF-SAMPLE", scoreBuckets(outSample));

  /* ---- tradeable book: score threshold, both periods ---- */
  const rowFmt = (label: string, is: ReturnType<typeof simulateBook>, oos: ReturnType<typeof simulateBook>) => [
    label,
    String(is.trades),
    pct(is.winRatePct, 1),
    is.profitFactor === null ? "—" : num(is.profitFactor),
    pct(is.maxDrawdownPct, 1),
    String(oos.trades),
    pct(oos.winRatePct, 1),
    oos.profitFactor === null ? "—" : num(oos.profitFactor),
    pct(oos.maxDrawdownPct, 1),
  ];

  const bookHeaders = [
    { header: "Rule" },
    { header: "IS trades", align: "right" as const },
    { header: "IS win", align: "right" as const },
    { header: "IS PF", align: "right" as const },
    { header: "IS maxDD", align: "right" as const },
    { header: "OOS trades", align: "right" as const },
    { header: "OOS win", align: "right" as const },
    { header: "OOS PF", align: "right" as const },
    { header: "OOS maxDD", align: "right" as const },
  ];

  /*
   * Ranked by the LIVE engine's rule (fee/TVL x volume), not by the score. Ranking and
   * filtering on the same quantity would make every threshold pick the identical book
   * and the test would prove nothing. This asks the real question: does the score add
   * anything on top of the ranking already in production?
   */
  const liveRank = (o: Opportunity): number => o.feeTvlRatio24h * o.vol24hUsd;

  const baselineIs = simulateBook(inSample, liveRank);
  const baselineOos = simulateBook(outSample, liveRank);

  console.log("\n  A · SCORE THRESHOLD — tradeable book, one position at a time");
  console.log(
    renderTable(
      bookHeaders,
      [
        rowFmt("no filter", baselineIs, baselineOos),
        ...[35, 40, 45, 50, 55].map((t) =>
          rowFmt(
            `score >= ${t}`,
            simulateBook(inSample, liveRank, (o) => score(o) >= t),
            simulateBook(outSample, liveRank, (o) => score(o) >= t),
          ),
        ),
      ],
    )
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );

  /* ---- the avoid-rules, which is what actually replicated ---- */
  const avoidRules: Array<{ name: string; keep: (o: Opportunity) => boolean }> = [
    { name: "drop rvol > 20%/h", keep: (o) => o.realizedVol24hPct <= 20 },
    { name: "drop age < 48h", keep: (o) => o.poolAgeHours === null || o.poolAgeHours >= 48 },
    { name: "drop 1h chg > +10%", keep: (o) => o.priceChange1hPct <= 10 },
    { name: "drop TVL < $50k", keep: (o) => o.tvlUsd >= 50_000 },
    { name: "drop vol24h < $50k", keep: (o) => o.vol24hUsd >= 50_000 },
    {
      name: "ALL FOUR combined",
      keep: (o) =>
        o.realizedVol24hPct <= 20 &&
        (o.poolAgeHours === null || o.poolAgeHours >= 48) &&
        o.priceChange1hPct <= 10 &&
        o.tvlUsd >= 50_000,
    },
  ];

  console.log("\n  B · FAILURE-CLUSTER EXCLUSIONS — tradeable book, same rules both periods");
  console.log(
    renderTable(
      bookHeaders,
      [
        rowFmt("no filter", baselineIs, baselineOos),
        ...avoidRules.map((r) =>
          rowFmt(
            r.name,
            simulateBook(inSample, liveRank, r.keep),
            simulateBook(outSample, liveRank, r.keep),
          ),
        ),
      ],
    )
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );

  /*
   * The books above hold 15–33 trades. At that size a profit factor is dominated by
   * one or two positions and proves nothing. The rules are therefore also tested at
   * the OBSERVATION level, where n runs into the thousands and a shift in the
   * big-loss rate is actually measurable.
   */
  console.log("\n  C · OBSERVATION-LEVEL REPLICATION — thousands of entries, not a 15-trade book");
  console.log(
    renderTable(
      [
        { header: "Rule" },
        { header: "IS n", align: "right" },
        { header: "IS mean net", align: "right" },
        { header: "IS big-loss", align: "right" },
        { header: "OOS n", align: "right" },
        { header: "OOS mean net", align: "right" },
        { header: "OOS big-loss", align: "right" },
        { header: "Replicates" },
      ],
      (() => {
        const bIs = summarise("", inSample);
        const bOos = summarise("", outSample);

        const rows: string[][] = [
          [
            "no filter (baseline)",
            String(bIs.n),
            pct(bIs.meanNetPct),
            pct(bIs.bigLossRatePct, 1),
            String(bOos.n),
            pct(bOos.meanNetPct),
            pct(bOos.bigLossRatePct, 1),
            "—",
          ],
        ];

        for (const r of avoidRules) {
          const sIs = summarise("", inSample.filter(r.keep));
          const sOos = summarise("", outSample.filter(r.keep));
          // A rule replicates only if it cuts the big-loss rate in BOTH halves.
          const cuts =
            sIs.bigLossRatePct < bIs.bigLossRatePct && sOos.bigLossRatePct < bOos.bigLossRatePct;
          rows.push([
            r.name,
            String(sIs.n),
            pct(sIs.meanNetPct),
            pct(sIs.bigLossRatePct, 1),
            String(sOos.n),
            pct(sOos.meanNetPct),
            pct(sOos.bigLossRatePct, 1),
            cuts ? "YES" : "no",
          ]);
        }
        return rows;
      })(),
    )
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );

  console.log("");
  console.log("─".repeat(96));
  console.log("  CAVEATS");
  console.log("─".repeat(96));
  console.log(
    [
      `  • ${all.length} entries come from only ${dataset.pools.length} pools. Observations from the same`,
      "    pool are heavily autocorrelated, so the EFFECTIVE sample is closer to the pool count",
      "    than to the row count. Treat every number here as directional, not significant.",
      "  • Outcomes inherit the modelled-TVL assumption: fee income scales with an estimated",
      "    denominator, so any bucket cut on TVL is partly a cut on the model itself.",
      "  • The score's constants were chosen from in-sample statistics before the out-of-sample",
      "    period was inspected, but they were chosen BY HAND from those statistics — a genuine",
      "    fit procedure with cross-validation would be stronger.",
      "  • One 30-day window is one market regime. Consistency across two halves of the same",
      "    month is far weaker evidence than consistency across different months.",
    ].join("\n"),
  );
  console.log("");
}

main().catch((err) => {
  console.error("[research] failed:", err);
  process.exit(1);
});
