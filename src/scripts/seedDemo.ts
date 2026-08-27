/**
 * Seeds clearly-marked demo positions so the dashboard can be exercised without
 * waiting for live cycles. Every seeded row carries a "[DEMO]" thesis.
 *
 * Run:   npm run seed:demo
 * Clear: npm run db:reset
 */
import { randomUUID } from "node:crypto";
import { db, initDatabase, closeDatabase } from "../database/db.js";
import { insertPosition, setPostMortem, upsertResearchLog } from "../database/repositories.js";
import { impermanentLossFraction } from "../services/meteora.js";
import { localDateString } from "../agents/researcherAgent.js";

initDatabase();

const SOL_USD = 100;
const NOTIONAL = SOL_USD * 1.0;

interface Seed {
  pair: string;
  strategy: "SPOT" | "BID_ASK" | "CURVE";
  entry: number;
  exit: number | null;
  feeUsd: number;
  confidence: number;
  thesis: string;
  /** Hours ago the position opened. */
  openedHoursAgo: number;
  closedHoursAgo: number | null;
  status: "ACTIVE" | "CLOSED_PROFIT" | "CLOSED_LOSS" | "CLOSED_OUT_OF_RANGE" | "CLOSED_TIMEOUT";
  rangePct: [number, number];
  /** Anti-rug screen result recorded at entry. */
  top10Pct: number;
  postMortem?: string;
}

const seeds: Seed[] = [
  {
    pair: "SOL-USDC",
    strategy: "SPOT",
    entry: 101.2,
    exit: null,
    feeUsd: 1.42,
    confidence: 78,
    thesis: "[DEMO] Deep liquidity, 0.9% fee/TVL over 24h, tight bin step 4 favours SPOT.",
    openedHoursAgo: 6,
    closedHoursAgo: null,
    status: "ACTIVE",
    rangePct: [4, 6],
    top10Pct: 11.4,
  },
  {
    pair: "JUP-SOL",
    strategy: "CURVE",
    entry: 0.00842,
    exit: null,
    feeUsd: 0.61,
    confidence: 64,
    thesis: "[DEMO] Mean-reverting pair with steady volume; CURVE concentrates near spot.",
    openedHoursAgo: 2,
    closedHoursAgo: null,
    status: "ACTIVE",
    rangePct: [3, 3],
    top10Pct: 18.2,
  },
  {
    pair: "WIF-SOL",
    strategy: "BID_ASK",
    entry: 0.0121,
    exit: 0.01268,
    feeUsd: 6.9,
    confidence: 71,
    thesis: "[DEMO] Elevated volatility, BID_ASK captures depth at both edges.",
    openedHoursAgo: 30,
    closedHoursAgo: 22,
    status: "CLOSED_PROFIT",
    rangePct: [8, 10],
    top10Pct: 21.7,
    postMortem:
      "[DEMO] Wide BID_ASK bins kept the position active through the whole volatility burst, so fee income outran a modest 0.6% impermanent loss.",
  },
  {
    pair: "BONK-SOL",
    strategy: "SPOT",
    entry: 0.0000212,
    exit: 0.0000241,
    feeUsd: 2.1,
    confidence: 55,
    thesis: "[DEMO] Fee spike looked organic; price ran past the upper bin.",
    openedHoursAgo: 26,
    closedHoursAgo: 19,
    status: "CLOSED_OUT_OF_RANGE",
    rangePct: [6, 6],
    top10Pct: 23.9,
    postMortem:
      "[DEMO] A +13.7% move cleared the upper bin after 7h and fee accrual stopped, so a wider upside band was needed for a trending meme pair.",
  },
  {
    pair: "PYTH-USDC",
    strategy: "SPOT",
    entry: 0.412,
    // Chosen so impermanent loss genuinely exceeds fee income: a "loss" row whose
    // net PnL came out positive would make the win-rate card lie.
    exit: 0.24,
    feeUsd: 0.35,
    confidence: 48,
    thesis: "[DEMO] Volume faded after entry; impermanent loss outran fee income.",
    openedHoursAgo: 50,
    closedHoursAgo: 44,
    status: "CLOSED_LOSS",
    rangePct: [9, 9],
    top10Pct: 19.1,
    postMortem:
      "[DEMO] Volume collapsed right after entry so only $0.35 of fees accrued against a $3.54 impermanent loss, confirming fee/TVL alone is a poor entry signal without volume persistence.",
  },
  {
    pair: "JTO-SOL",
    strategy: "CURVE",
    entry: 0.0231,
    exit: 0.0233,
    feeUsd: 3.4,
    confidence: 60,
    thesis: "[DEMO] Held to the 24h age cap with modest fee accrual.",
    openedHoursAgo: 74,
    closedHoursAgo: 50,
    status: "CLOSED_TIMEOUT",
    rangePct: [5, 5],
    top10Pct: 14.6,
    postMortem:
      "[DEMO] Price barely moved for 24h so the age cap closed a still-healthy position, suggesting the timeout should not fire while a position remains in range and profitable.",
  },
];

const isoAgo = (hours: number): string =>
  new Date(Date.now() - hours * 3_600_000).toISOString().replace("T", " ").slice(0, 19);

for (const s of seeds) {
  const id = randomUUID();
  const lower = s.entry * (1 - s.rangePct[0] / 100);
  const upper = s.entry * (1 + s.rangePct[1] / 100);

  insertPosition({
    positionId: id,
    poolAddress: `Demo${randomUUID().replace(/-/g, "").slice(0, 40)}`,
    pairName: s.pair,
    strategyType: s.strategy,
    entryPrice: s.entry,
    lowerBinPrice: lower,
    upperBinPrice: upper,
    virtualSolAmount: 1.0,
    entryTvl: 60_000 + Math.round(s.confidence * 900),
    entry24hVolume: 400_000 + Math.round(s.confidence * 12_000),
    confidenceScore: s.confidence,
    reasoningLog: s.thesis,
    entrySolPriceUsd: SOL_USD,
    top10HolderPct: s.top10Pct,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    safetyVerdict: "PASS",
    estGasCostUsd: 0.0011,
    estPriorityMicroLamports: 0,
  });

  const mark = s.exit ?? s.entry * 1.008;
  const il = NOTIONAL * impermanentLossFraction(mark / s.entry);
  const net = s.feeUsd + il;

  if (s.status === "ACTIVE") {
    db.prepare(
      `UPDATE simulated_positions
          SET opened_at = ?, last_checked_at = ?, current_price = ?,
              unclaimed_fee_usd = ?, impermanent_loss_usd = ?, floating_pnl_usd = ?
        WHERE position_id = ?`,
    ).run(isoAgo(s.openedHoursAgo), isoAgo(0), mark, s.feeUsd, il, net, id);
  } else {
    db.prepare(
      `UPDATE simulated_positions
          SET opened_at = ?, closed_at = ?, last_checked_at = ?, status = ?,
              exit_price = ?, current_price = ?, unclaimed_fee_usd = ?,
              impermanent_loss_usd = ?, floating_pnl_usd = 0,
              realized_pnl_usd = ?, realized_pnl_pct = ?, close_reason = ?
        WHERE position_id = ?`,
    ).run(
      isoAgo(s.openedHoursAgo),
      isoAgo(s.closedHoursAgo ?? 0),
      isoAgo(s.closedHoursAgo ?? 0),
      s.status,
      s.exit,
      s.exit,
      s.feeUsd,
      il,
      net,
      (net / NOTIONAL) * 100,
      `[DEMO] ${s.status.replace("CLOSED_", "").toLowerCase()} exit`,
      id,
    );

    if (s.postMortem) setPostMortem(id, s.postMortem);
  }
}

upsertResearchLog({
  reportDate: localDateString(),
  rawMacroJson: JSON.stringify({ demo: true }),
  sentimentBias: "RISK-ON",
  markdownOutput: `## 1. Macro & Geopolitics
[DEMO REPORT] DXY, US 10Y and S&P 500 were UNAVAILABLE for this run; no substitute values assumed.

## 2. Institutional & On-Chain Flows
Spot ETF net flows UNAVAILABLE. BTC dominance holding near 59%, implying capital has not yet rotated down the risk curve.

## 3. Hottest Chain & Narrative
Solana leads DEX activity; boosted-token flow concentrated in meme and AI narratives.

## 4. Market Verdict & Actionable Bias
RISK-ON. Elevated DEX turnover supports fee generation on Solana DLMM pools. Favour tighter bin ranges on liquid majors and avoid wide ranges on low-TVL pairs where impermanent loss dominates fee income.`,
});

const counts = db
  .prepare(
    `SELECT status, COUNT(*) AS n FROM simulated_positions GROUP BY status ORDER BY status`,
  )
  .all() as Array<{ status: string; n: number }>;

console.log("[seed] demo data written:");
for (const c of counts) console.log(`  ${c.status.padEnd(22)} ${c.n}`);
console.log("[seed] clear it again with: npm run db:reset");

closeDatabase();
