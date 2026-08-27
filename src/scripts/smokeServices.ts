/** Manual smoke test for the external data layer. Run: npm run smoke */
import { fetchLivePools, screenPools, defaultThresholds } from "../services/meteora.js";
import { fetchMarketSnapshot, describeSnapshotGaps } from "../services/marketData.js";
import { isDeepSeekAvailable } from "../services/deepseek.js";
import { isTelegramEnabled } from "../services/telegram.js";

async function main(): Promise<void> {
  console.log("--- market snapshot ---");
  const snap = await fetchMarketSnapshot();
  console.log("fear&greed:", snap.fearGreed);
  console.log("prices:", snap.prices);
  console.log("btc dominance:", snap.global?.btcDominancePct?.toFixed(2));
  console.log("trending:", snap.trending.map((t) => t.symbol).join(", "));
  console.log("gaps:", describeSnapshotGaps(snap).join(" | "));

  console.log("\n--- meteora screener ---");
  const pools = await fetchLivePools({ pageSize: 200, pages: 3 });
  const th = defaultThresholds();
  console.log(`fetched ${pools.length} pools; thresholds`, th);

  const result = screenPools(pools, th);
  console.log("rejected:", result.rejected);
  console.log(`candidates: ${result.candidates.length}`);

  for (const c of result.candidates.slice(0, 5)) {
    console.log(
      `  ${c.pairName.padEnd(20)} tvl=$${c.tvlUsd.toFixed(0).padStart(10)} ` +
        `vol24=$${c.volume24hUsd.toFixed(0).padStart(11)} ` +
        `fee/tvl=${(c.feeTvlRatio24h * 100).toFixed(3)}% ` +
        `apr≈${c.estimatedAprPct.toFixed(0)}% score=${c.score.toFixed(0)}`,
    );
  }

  console.log("\n--- integrations ---");
  console.log("deepseek configured:", isDeepSeekAvailable());
  console.log("telegram configured:", isTelegramEnabled());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
