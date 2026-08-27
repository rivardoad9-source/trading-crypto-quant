import { chatCompletion, isDeepSeekAvailable } from "../services/deepseek.js";
import {
  describeSnapshotGaps,
  fetchMarketSnapshot,
  type MarketSnapshot,
} from "../services/marketData.js";
import { sendDailyResearch, sendError } from "../services/telegram.js";
import { upsertResearchLog } from "../database/repositories.js";
import { env } from "../config/env.js";

const SYSTEM_PROMPT = `You are a Senior Crypto Macro & On-Chain Quantitative Analyst.

Rules:
- No greetings, no preamble, no closing pleasantries. Output the report only.
- Professional analytical register. Dense. Maximum 300 words total.
- Use ONLY the data provided in the user message. If a metric is listed as
  UNAVAILABLE, say so explicitly in one short clause — never estimate, recall from
  memory, or invent a number for it.
- Output exactly these four Markdown sections, in this order, with these headings:

## 1. Macro & Geopolitics
## 2. Institutional & On-Chain Flows
## 3. Hottest Chain & Narrative
## 4. Market Verdict & Actionable Bias

Section 4 must open with exactly one of: RISK-ON, RISK-OFF, or SIDEWAYS — followed
by the implication for concentrated liquidity provision (LPing) on Solana DLMM
pools, including whether wide or tight bin ranges are favoured.`;

/** Formats the snapshot into a compact, unambiguous prompt payload. */
export function buildResearchPrompt(snapshot: MarketSnapshot): string {
  const lines: string[] = [];
  const n = (v: number | null | undefined, digits = 2): string =>
    v === null || v === undefined || !Number.isFinite(v) ? "UNAVAILABLE" : v.toFixed(digits);

  lines.push(`DATA SNAPSHOT (captured ${snapshot.capturedAt}, timezone ${env.TZ})`);
  lines.push("");

  lines.push("[TradFi Macro]");
  lines.push(`- DXY (broad dollar index): ${n(snapshot.tradfi.dxy)}`);
  lines.push(`- US 10Y Treasury yield: ${n(snapshot.tradfi.us10yYieldPct)}%`);
  lines.push(`- S&P 500: ${n(snapshot.tradfi.sp500)}`);
  lines.push("");

  lines.push("[Institutional Flows]");
  lines.push(`- BTC spot ETF net flow: ${n(snapshot.tradfi.btcEtfNetFlowUsd, 0)}`);
  lines.push(`- ETH spot ETF net flow: ${n(snapshot.tradfi.ethEtfNetFlowUsd, 0)}`);
  lines.push("");

  lines.push("[Crypto Market]");
  if (snapshot.global) {
    lines.push(`- Total market cap: $${(snapshot.global.totalMarketCapUsd / 1e9).toFixed(1)}B`);
    lines.push(`- 24h volume: $${(snapshot.global.totalVolume24hUsd / 1e9).toFixed(1)}B`);
    lines.push(`- Market cap change 24h: ${n(snapshot.global.marketCapChange24hPct)}%`);
    lines.push(`- BTC dominance: ${n(snapshot.global.btcDominancePct)}%`);
    lines.push(`- ETH dominance: ${n(snapshot.global.ethDominancePct)}%`);
  } else {
    lines.push("- UNAVAILABLE");
  }
  lines.push("");

  lines.push("[Spot Prices]");
  if (snapshot.prices) {
    lines.push(
      `- BTC: $${n(snapshot.prices.btcUsd)} (${n(snapshot.prices.btcChange24hPct)}% 24h)`,
    );
    lines.push(
      `- ETH: $${n(snapshot.prices.ethUsd)} (${n(snapshot.prices.ethChange24hPct)}% 24h)`,
    );
    lines.push(
      `- SOL: $${n(snapshot.prices.solUsd)} (${n(snapshot.prices.solChange24hPct)}% 24h)`,
    );
  } else {
    lines.push("- UNAVAILABLE");
  }
  lines.push("");

  lines.push("[Sentiment]");
  lines.push(
    snapshot.fearGreed
      ? `- Fear & Greed Index: ${snapshot.fearGreed.value} (${snapshot.fearGreed.classification})`
      : "- UNAVAILABLE",
  );
  lines.push("");

  lines.push("[Trending DEX Tokens — DEXScreener boosted]");
  if (snapshot.trending.length > 0) {
    for (const t of snapshot.trending) {
      lines.push(`- ${t.chainId}: ${t.symbol} — ${t.description}`);
    }
  } else {
    lines.push("- UNAVAILABLE");
  }
  lines.push("");

  const gaps = describeSnapshotGaps(snapshot);
  if (gaps.length > 0) {
    lines.push(`UNAVAILABLE METRICS (do not invent values for these): ${gaps.join(", ")}`);
  }

  return lines.join("\n");
}

/** Pulls the RISK-ON / RISK-OFF / SIDEWAYS verdict out of section 4. */
export function extractBias(markdown: string): string | null {
  const match = /\b(RISK-ON|RISK-OFF|SIDEWAYS)\b/i.exec(markdown);
  return match ? match[1]!.toUpperCase() : null;
}

/** Local calendar date in env.TZ, as YYYY-MM-DD. */
export function localDateString(date = new Date()): string {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export interface ResearchResult {
  reportDate: string;
  markdown: string;
  bias: string | null;
  gaps: string[];
}

/**
 * Daily macro + on-chain research pipeline: ingest -> DeepSeek -> SQLite -> Telegram.
 * Exported for manual triggering as well as cron.
 */
export async function runMacroResearcher(): Promise<ResearchResult | null> {
  const reportDate = localDateString();
  console.log(`[researcher] starting run for ${reportDate}`);

  if (!isDeepSeekAvailable()) {
    console.warn("[researcher] skipped: DEEPSEEK_API_KEY is not configured.");
    return null;
  }

  try {
    const snapshot = await fetchMarketSnapshot();
    const gaps = describeSnapshotGaps(snapshot);
    if (gaps.length > 0) console.warn(`[researcher] missing inputs: ${gaps.join(", ")}`);

    const markdown = await chatCompletion({
      system: SYSTEM_PROMPT,
      user: buildResearchPrompt(snapshot),
      reasoning: false,
      temperature: 0.3,
      maxTokens: 900,
    });

    const bias = extractBias(markdown);

    upsertResearchLog({
      reportDate,
      rawMacroJson: JSON.stringify(snapshot),
      markdownOutput: markdown,
      sentimentBias: bias,
    });

    await sendDailyResearch(reportDate, markdown);

    console.log(`[researcher] done for ${reportDate} (bias: ${bias ?? "n/a"})`);
    return { reportDate, markdown, bias, gaps };
  } catch (err) {
    console.error(`[researcher] failed:`, err);
    await sendError("runMacroResearcher", err);
    return null;
  }
}
