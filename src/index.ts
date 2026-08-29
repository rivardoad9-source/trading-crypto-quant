import cron from "node-cron";
import { CRON } from "./config/constants.js";
import { env, hasDeepSeek, hasTelegram } from "./config/env.js";
import { closeDatabase, initDatabase } from "./database/db.js";
import { runMacroResearcher } from "./agents/researcherAgent.js";
import { runDlmmTradingCycle, runFastPositionMonitor } from "./agents/dlmmTraderAgent.js";
import { runDailySnapshot } from "./agents/snapshotJob.js";
import { startApiServer, stopApiServer } from "./api/server.js";
import { startTelegramCommands, stopTelegramCommands } from "./services/telegramCommands.js";

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
  startTelegramCommands();

  const tasks = [
    cron.schedule(CRON.DAILY_MACRO, withLock("macro", runMacroResearcher), { timezone: env.TZ }),
    /*
     * The screener skips its own monitor stage: the 1-minute loop below owns position
     * marking, and a second pass on the 10-minute clock would only re-measure what was
     * already measured 60 seconds ago. If the fast monitor is switched off, this stage
     * comes back so positions are never left unmonitored.
     */
    cron.schedule(
      CRON.DLMM_LOOP,
      withLock("dlmm", () => runDlmmTradingCycle({ skipMonitor: env.FAST_MONITOR_ENABLED })),
      { timezone: env.TZ },
    ),
    cron.schedule(CRON.DAILY_SNAPSHOT, withLock("snapshot", () => runDailySnapshot()), {
      timezone: env.TZ,
    }),
  ];

  if (env.FAST_MONITOR_ENABLED) {
    /*
     * Its own cron job with its own lock, so a screener cycle that overruns its
     * 10-minute window cannot delay an exit. The two contend only for positionMutex,
     * and a fast tick that loses that race skips rather than queues.
     */
    tasks.push(
      cron.schedule(CRON.FAST_MONITOR, withLock("fast-monitor", runFastPositionMonitor), {
        timezone: env.TZ,
      }),
    );
    console.log(`[cron] monitor  ${CRON.FAST_MONITOR}      (${env.TZ})`);
  } else {
    console.warn("[cron] fast monitor DISABLED — exits are only checked on the 10m screener tick");
  }

  console.log(`[cron] macro    ${CRON.DAILY_MACRO}    (${env.TZ})`);
  console.log(`[cron] dlmm     ${CRON.DLMM_LOOP}   (${env.TZ})`);
  console.log(`[cron] snapshot ${CRON.DAILY_SNAPSHOT}   (${env.TZ})`);

  // Run one cycle immediately so a fresh start has data rather than waiting 10 minutes.
  void withLock("dlmm:boot", runDlmmTradingCycle)();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[main] ${signal} received, shutting down…`);
    for (const t of tasks) t.stop();
    stopTelegramCommands();
    await stopApiServer();
    closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  /*
   * Since Node 15 an unhandled rejection TERMINATES the process. Every cron job is
   * wrapped in withLock, which catches — but one stray floating promise anywhere in a
   * dependency or a future handler would kill a 24/7 engine outright, and the only
   * evidence would be the process being gone.
   *
   * Logged and swallowed rather than rethrown: this engine is paper-trading with no
   * capital at risk, so staying up with a loud log beats exiting silently. The next
   * cron tick re-runs the work from a clean state.
   */
  process.on("unhandledRejection", (reason) => {
    console.error("[main] UNHANDLED REJECTION — engine kept alive:", reason);
  });

  /*
   * uncaughtException is different: state may be genuinely corrupt, so this exits
   * rather than limping on. It closes the database first so the WAL is checkpointed
   * instead of left for recovery, and a process manager (systemd/pm2) restarts it.
   */
  process.on("uncaughtException", (err) => {
    console.error("[main] UNCAUGHT EXCEPTION — shutting down:", err);
    try {
      closeDatabase();
    } catch {
      /* already closing, or never opened */
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});
