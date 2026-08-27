import cron from "node-cron";
import { CRON } from "./config/constants.js";
import { env, hasDeepSeek, hasTelegram } from "./config/env.js";
import { closeDatabase, initDatabase } from "./database/db.js";
import { runMacroResearcher } from "./agents/researcherAgent.js";
import { runDlmmTradingCycle } from "./agents/dlmmTraderAgent.js";
import { runDailySnapshot } from "./agents/snapshotJob.js";
import { startApiServer, stopApiServer } from "./api/server.js";

/**
 * Serialises cron jobs. A 10-minute DLMM cycle that overruns must not overlap the
 * next tick — overlapping ticks would double-accrue fees on the same interval.
 */
function withLock(name: string, task: () => Promise<unknown>): () => Promise<void> {
  let running = false;

  return async () => {
    if (running) {
      console.warn(`[cron] ${name} still running; skipping this tick`);
      return;
    }
    running = true;
    try {
      await task();
    } catch (err) {
      console.error(`[cron] ${name} threw:`, err);
    } finally {
      running = false;
    }
  };
}

function banner(): void {
  const mode = env.DRY_RUN ? "DRY-RUN (paper trading, zero capital)" : "LIVE";
  console.log("");
  console.log("  FlowMetrix / Meteora AI Engine");
  console.log("  ------------------------------");
  console.log(`  mode        : ${mode}`);
  console.log(`  timezone    : ${env.TZ}`);
  console.log(`  api port    : ${env.PORT}`);
  console.log(`  deepseek    : ${hasDeepSeek ? "configured" : "NOT configured (agents disabled)"}`);
  console.log(`  telegram    : ${hasTelegram ? "configured" : "not configured (alerts logged only)"}`);
  console.log(`  position    : ${env.VIRTUAL_SOL_PER_POSITION} SOL virtual, max ${env.MAX_CONCURRENT_POSITIONS} concurrent`);
  console.log(`  exits       : TP ${env.TAKE_PROFIT_PCT}% / SL ${env.STOP_LOSS_PCT}% / age ${env.MAX_POSITION_AGE_HOURS}h`);
  console.log("");
}

async function main(): Promise<void> {
  banner();
  initDatabase();

  await startApiServer();

  const tasks = [
    cron.schedule(CRON.DAILY_MACRO, withLock("macro", runMacroResearcher), { timezone: env.TZ }),
    cron.schedule(CRON.DLMM_LOOP, withLock("dlmm", runDlmmTradingCycle), { timezone: env.TZ }),
    cron.schedule(CRON.DAILY_SNAPSHOT, withLock("snapshot", () => runDailySnapshot()), {
      timezone: env.TZ,
    }),
  ];

  console.log(`[cron] macro    ${CRON.DAILY_MACRO}    (${env.TZ})`);
  console.log(`[cron] dlmm     ${CRON.DLMM_LOOP}   (${env.TZ})`);
  console.log(`[cron] snapshot ${CRON.DAILY_SNAPSHOT}   (${env.TZ})`);

  // Run one cycle immediately so a fresh start has data rather than waiting 10 minutes.
  void withLock("dlmm:boot", runDlmmTradingCycle)();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[main] ${signal} received, shutting down…`);
    for (const t of tasks) t.stop();
    await stopApiServer();
    closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});
