import cron from "node-cron";
import { CRON, DLMM_BASE_CADENCE_MIN, DLMM_POST_NEWS_FAST_MIN } from "./config/constants.js";
import { env, hasDeepSeek, hasTelegram, isLiveTradingEnabled } from "./config/env.js";
import { closeDatabase, initDatabase } from "./database/db.js";
import { runMacroResearcher } from "./agents/researcherAgent.js";
import { runDlmmTradingCycle, runFastPositionMonitor } from "./agents/dlmmTraderAgent.js";
import { runDailySnapshot } from "./agents/snapshotJob.js";
import { startApiServer, stopApiServer } from "./api/server.js";
import { startTelegramCommands, stopTelegramCommands } from "./services/telegramCommands.js";
import { liveMicroCapital } from "./config/liveConfig.js";
import { InsufficientGasReserveError, runLivePreflight } from "./services/livePreflight.js";
import { describeExecutionGuard } from "./services/executionGuard.js";
import { describeNewsBlackout } from "./services/newsBlackout.js";
import {
  decideScreenerRun,
  minutesOfHourInZone,
  readPostNewsFastWindow,
} from "./services/screenerCadence.js";
import { describeReconciliation, reconcilePositions } from "./services/reconciliation.js";
import {
  describeLiveExecutionBlockers,
  isLiveExecutionActive,
} from "./services/liveExecution.js";
import { fetchSolPriceUsd } from "./services/marketData.js";
import { getClosedPositions, getLifetimeStats } from "./database/repositories.js";
import { describeStartingBalance } from "./config/startingBalance.js";

/**
 * Serialises cron jobs. A DLMM cycle that overruns its window must not overlap the
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
  for (const line of describeStartingBalance()) console.log(`  ${line}`);
  if (liveMicroCapital.enabled) {
    console.log(
      `  live profile: ARMED — ${liveMicroCapital.maxPositionSol} SOL x ` +
        `${liveMicroCapital.maxConcurrentPositions}, ${liveMicroCapital.minReserveSol} SOL reserved ` +
        // Follows the ENGINE, not the build. This said "this build still signs
        // nothing", which was true when written and false from the day live execution
        // landed - the most reassuring line in the banner, printed while real SOL was
        // at risk. Same class of stale label as the Telegram alerts.
        `(${isLiveTradingEnabled ? "SIGNS REAL TRANSACTIONS" : "sizing + friction only; signs nothing"})`,
    );
  }
  console.log("");
}

/**
 * Live-capital startup gate. Runs BEFORE the database, the API and every scheduler,
 * so a refusal leaves nothing half-started. Entirely inert unless LIVE_MICRO_CAPITAL
 * is on — the paper engine never reaches the network here.
 */
async function preflight(): Promise<void> {
  if (!liveMicroCapital.enabled) return;

  /*
   * Configuration blockers before the funding gate, because these are the silent
   * ones: a spend ceiling below the position size does not misbehave, it lets every
   * entry pass the screen and the LLM and then fail on the last step, so the operator
   * watches a healthy-looking engine that never opens anything. Refusing here costs a
   * restart; discovering it later costs a day of scanning.
   */
  const blockers = describeLiveExecutionBlockers();
  if (blockers.length > 0) {
    console.error("\n[main] LIVE EXECUTION is armed but cannot work as configured:\n");
    for (const b of blockers) console.error(`  - ${b}`);
    console.error("\n[main] refusing to start.\n");
    process.exit(1);
  }

  if (isLiveExecutionActive()) {
    console.warn(
      "\n[main] *** LIVE EXECUTION ARMED — THIS ENGINE WILL SPEND REAL SOL ***\n" +
        `[main]     position size : ${liveMicroCapital.maxPositionSol} SOL x ` +
        `${liveMicroCapital.maxConcurrentPositions}\n` +
        "[main]     every entry swaps half the SOL into the pool's other token, then\n" +
        "[main]     opens a real DLMM position. Exits close it on-chain.\n",
    );
    /*
     * Printed rather than assumed. A denylist that is silently empty because of a typo
     * in `.env` is worse than no denylist at all, because it is believed - and the
     * whole reason this line exists is that an operator entry was the only thing
     * standing between the engine and a pool that had already cost money twice.
     */
    console.warn(`[main]     ${describeExecutionGuard()}`);
    /*
     * Same reasoning, one gate along: the news blackout reads a file this repository
     * does not write, so "armed" and "actually fed a calendar" are different facts and
     * only the boot line can tell them apart. A gate believed to be running while its
     * calendar is missing is the failure this line exists to make impossible.
     */
    console.warn(`[main]     ${describeNewsBlackout()}`);
  }

  // Best-effort, and only to render the envelope summary. A missing price must not
  // itself block a start: the balance floor is denominated in SOL, not USD.
  const solPriceUsd = await fetchSolPriceUsd().catch(() => null);

  try {
    // The seed only applies on a clean slate, so the preflight needs the trade count.
    const existingTrades = getClosedPositions(1, 0).length;
    // And when it refuses, the realised PnL is what turns "not seeded" into the exact
    // STARTING_BALANCE_USD the operator can paste to align the book with the wallet.
    const realisedPnlUsd = getLifetimeStats().realizedPnlUsd;
    await runLivePreflight({ solPriceUsd, existingTrades, realisedPnlUsd });
  } catch (err) {
    if (err instanceof InsufficientGasReserveError) {
      console.error(`\n${err.message}\n`);
      console.error("[main] refusing to start. Top the wallet up, or unset LIVE_MICRO_CAPITAL.\n");
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  banner();
  await preflight();
  initDatabase();

  await startApiServer();
  startTelegramCommands();

  /*
   * Reconcile the book against the wallet at boot, and say so out loud.
   *
   * A live position's PnL in the database is the paper valuation model's opinion of a
   * real position — `closeLivePosition` returns signatures and never amounts — and the
   * model cannot see swap slippage, priority fees or unrecoverable bin-array rent. Every
   * one of those makes the wallet poorer than the row claims, so the drift is systematic
   * and one-directional. It went unmeasured for the entire live run.
   *
   * Printed here rather than only served on a route, because the failure this guards
   * against is nobody looking. Swallowed on error: reporting is not a reason to refuse
   * a start, and the route remains the authority.
   */
  if (isLiveExecutionActive()) {
    try {
      console.log(`[main]     ${describeReconciliation(reconcilePositions())}`);
    } catch (err) {
      console.warn(
        `[main] wallet reconciliation unavailable: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const tasks = [
    cron.schedule(CRON.DAILY_MACRO, withLock("macro", runMacroResearcher), { timezone: env.TZ }),
    /*
     * The screener skips its own monitor stage: the 1-minute loop below owns position
     * marking, and a second pass on the screener's clock would only re-measure what was
     * already measured 60 seconds ago. If the fast monitor is switched off, this stage
     * comes back so positions are never left unmonitored — note that would then be the
     * only exit check, on the 30-minute screener clock.
     */
    /*
     * The screener's clock is a TICK, not a cadence. It fires every 5 minutes, and each
     * tick decides whether this is a real screener run: the 30-minute base cadence
     * normally, or every 5 minutes for DLMM_POST_NEWS_FAST_MIN after a macro-news window
     * closes (where a re-priced SOL and rewritten ranges are worth arriving at quickly).
     * The rule lives in services/screenerCadence.ts so it is unit-tested rather than read
     * off a cron string, and off-cadence ticks return before touching the network, the
     * upstreams or DeepSeek — so the token bill is the 30-minute clock's, not the 5's.
     */
    cron.schedule(
      CRON.DLMM_TICK,
      withLock("dlmm", async () => {
        const now = new Date();
        const live = isLiveExecutionActive();
        const decision = decideScreenerRun({
          now,
          minutesOfHour: minutesOfHourInZone(now, env.TZ),
          live,
          // Paper mode is deliberately handed null: a dry run keeps the base cadence
          // (and its byte-identical cycle) rather than chasing a re-pricing it cannot
          // trade. Same reasoning as the news gate and the width filter.
          fastWindow: live ? readPostNewsFastWindow(now) : null,
        });

        if (!decision.run) return;
        if (decision.fast) console.log(decision.reason);
        await runDlmmTradingCycle({ skipMonitor: env.FAST_MONITOR_ENABLED });
      }),
      { timezone: env.TZ },
    ),
    cron.schedule(CRON.DAILY_SNAPSHOT, withLock("snapshot", () => runDailySnapshot()), {
      timezone: env.TZ,
    }),
  ];

  if (env.FAST_MONITOR_ENABLED) {
    /*
     * Its own cron job with its own lock, so a screener cycle that overruns its
     * window cannot delay an exit. The two contend only for positionMutex, and a fast
     * tick that loses that race skips rather than queues.
     */
    tasks.push(
      cron.schedule(CRON.FAST_MONITOR, withLock("fast-monitor", runFastPositionMonitor), {
        timezone: env.TZ,
      }),
    );
    console.log(`[cron] monitor  ${CRON.FAST_MONITOR}      (${env.TZ})`);
  } else {
    console.warn("[cron] fast monitor DISABLED — exits are only checked on the 30m screener tick");
  }

  console.log(`[cron] macro    ${CRON.DAILY_MACRO}    (${env.TZ})`);
  console.log(
    `[cron] dlmm     ${CRON.DLMM_TICK} tick (every ${DLMM_BASE_CADENCE_MIN}m; ` +
      `every 5m for ${DLMM_POST_NEWS_FAST_MIN}m after a news window)   (${env.TZ})`,
  );
  console.log(`[cron] snapshot ${CRON.DAILY_SNAPSHOT}   (${env.TZ})`);

  // Run one cycle immediately so a fresh start has data rather than waiting 30 minutes.
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
