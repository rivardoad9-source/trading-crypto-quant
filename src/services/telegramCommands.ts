import type { Context } from "telegraf";
import { env, hasTelegram } from "../config/env.js";
import { getTelegramBot, sanitize, chunk } from "./telegram.js";
import { computeOverview } from "./overview.js";
import { readEngineControlFile, setEnginePaused } from "./engineControl.js";
import { claimLiveFees, isLiveExecutionActive } from "./liveExecution.js";
import { forceCloseAllPositions } from "../agents/dlmmTraderAgent.js";
import { addDaysToDayKey, currentZonedDay } from "./timezone.js";
import {
  aggregateClosedTradesByDate,
  countActivePositions,
  getActivePositions,
  getClosedPositions,
  getLifetimeStats,
  getLatestResearch,
  getPositionById,
} from "../database/repositories.js";

/**
 * Interactive Telegram control commands for the FlowMetrix engine.
 *
 * Every command is restricted to the owner's Telegram user ID(s) via
 * TELEGRAM_ALLOWED_USER_IDS (comma-separated). The gate fails closed: an empty
 * or unset allowlist means nobody can run the commands.
 *
 * Commands:
 *   /status    — balance, PnL, risk metrics, engine state, active positions
 *   /trades    — recent closed trades + lifetime summary
 *   /pnl       — net PnL per day (last 14 days)
 *   /position  — full detail for one position (usage: /position <id>)
 *   /research  — latest macro research report
 *   /close_all — emergency force-close of every active position (paper trading)
 *   /claim     — realise fees on open LIVE positions without closing them
 *   /pause     — stop scanning for new positions (monitoring keeps running)
 *   /resume    — re-enable scanning
 *   /help      — command list
 */

const UNAUTHORIZED_REPLY = "⛔ Unauthorized. This bot's control commands are restricted to its owner.";

const s = (v: string | number): string => sanitize(String(v));

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function fmtNum(n: number | null | undefined, digits = 6): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

function hoursSince(iso: string | null): number {
  if (!iso) return 0;
  const from = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  const ms = Date.now() - from.getTime();
  return Number.isFinite(ms) && ms > 0 ? ms / (1000 * 60 * 60) : 0;
}

/**
 * Escapes every MarkdownV2-special character in the text except intentional
 * **bold** spans, which become *bold* markup. This is the single escaping pass
 * for command replies: dynamic values must NOT be sanitized individually, or a
 * literal `(`/`)` in static text leaks through unescaped (exactly the bug that
 * made /status fail with "can't parse entities").
 */
export function markdownV2(text: string): string {
  return text
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => (i % 2 === 1 ? `*${sanitize(part)}*` : sanitize(part)))
    .join("");
}

/**
 * Pure status report, shared with tests. Fully MarkdownV2-escaped except bold
 * spans written as **...**.
 */
export function buildStatusText(): string {
  const o = computeOverview();
  const active = getActivePositions();
  const mode = o.isDryRun ? "DRY-RUN (paper trading)" : "LIVE";
  const pf = o.profitFactor === null ? "—" : o.profitFactor.toFixed(2);
  const tradeWord = (n: number) => `${n} trade${n === 1 ? "" : "s"}`;

  const lines: string[] = [
    `📊 **FlowMetrix Status** — ${mode}`,
    ``,
    `💵 Balance: ${fmtUsd(o.currentBalanceUSD)} (start ${fmtUsd(o.startingBalanceUSD)})`,
    `📈 Equity: ${fmtUsd(o.currentEquityUSD)}`,
    `🔄 Floating: ${fmtUsd(o.liveFloatingPnLUSD)} (${o.liveFloatingPnLPct.toFixed(2)}%)`,
    `📅 Today: ${fmtUsd(o.todayRealizedPnLUSD)} (${tradeWord(o.todayClosedTrades)})`,
    `🏆 All-time: ${tradeWord(o.totalSimulatedTrades)} · win ${o.winRatePct.toFixed(0)}% · PF ${pf}`,
    `⚠️ Max drawdown: ${o.maxDrawdownPct.toFixed(2)}%`,
    `📌 Active: ${o.activePositionsCount}`,
    `🎛 Engine: ${o.control.pausedByTelegram ? "⏸ **PAUSED** (scanning off)" : "▶️ **RUNNING**"}`,
  ];

  /*
   * The FILE hold, on its own line and never folded into the Engine line above.
   *
   * They are independent sources of the same silence and /resume clears only the
   * Telegram one, so an operator shown a single "PAUSED" would have no way to know
   * which lever lifts it — and one who sees "RUNNING" beside an engine opening nothing
   * would have no way to know anything was holding it at all. That is the situation
   * this whole file-control path exists to make impossible.
   *
   * Always false in paper mode, where the cycle does not read the file.
   */
  if (o.control.pausedByFile) {
    lines.push(
      `🛑 Control file: ⏸ **ENTRIES HELD**` +
        (o.control.fileReason ? ` — ${o.control.fileReason}` : "") +
        ` (clear it on the host; /resume does NOT lift this)`,
    );
  }

  /*
   * Printed only while a window is in force, and on its own line rather than folded
   * into the Engine line above. A news blackout and a Telegram /pause are independent
   * reasons for the same silence: an operator seeing "RUNNING" and no new positions
   * needs to be told which one applies, and /resume does not clear this one.
   *
   * Null in paper mode, where the gate is inert — see `Overview.newsBlackout`.
   */
  if (o.newsBlackout) {
    lines.push(
      `📰 News: ⛔ **BLACKOUT** — ${o.newsBlackout.event} until ${o.newsBlackout.untilWib} ` +
        `(new entries paused; monitoring, exits and fee accrual continue)`,
    );
  }

  if (active.length > 0) {
    lines.push("", `**Active positions:**`);
    for (const row of active) {
      const inRange =
        row.current_price !== null &&
        row.current_price >= row.lower_bin_price &&
        row.current_price <= row.upper_bin_price;
      lines.push(
        `• ${row.pair_name} (${row.strategy_type}) · entry ${fmtNum(row.entry_price)} · now ${fmtNum(
          row.current_price,
        )} · ${inRange ? "in range" : "OUT of range"} · PnL ${fmtUsd(
          row.floating_pnl_usd,
        )} · fees ${fmtUsd(row.unclaimed_fee_usd)} · ${hoursSince(row.opened_at).toFixed(1)}h old`,
      );
    }
  }

  return markdownV2(lines.join("\n"));
}

/** Pure auth check, shared with tests. Empty allowlist denies everyone. */
export function isCommandAuthorized(userId: number | undefined): boolean {
  if (!userId) return false;
  return env.TELEGRAM_ALLOWED_USER_IDS.includes(userId);
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** Pure /trades report: recent closed trades + lifetime summary. */
export function buildTradesText(limit = 10): string {
  const closed = getClosedPositions(limit);
  const stats = getLifetimeStats();

  const lines: string[] = [
    `🧾 **FlowMetrix Trades** (last ${closed.length})`,
    ``,
    `🏆 Lifetime: ${stats.totalClosed} trades · ${stats.wins}W/${stats.losses}L · net ${fmtUsd(
      stats.realizedPnlUsd,
    )}`,
    ``,
  ];

  if (closed.length === 0) {
    lines.push("No closed trades yet.");
  } else {
    for (const row of closed) {
      const dur = row.opened_at
        ? `${hoursSince(row.opened_at).toFixed(1)}h ago`
        : "n/a";
      const reason = row.close_reason ? ` (${row.close_reason})` : "";
      lines.push(
        `• ${row.pair_name} · ${row.status} · PnL ${fmtUsd(row.realized_pnl_usd)} (${pct(
          row.realized_pnl_pct,
        )}) · ${dur}${reason}`,
      );
    }
  }

  return markdownV2(lines.join("\n"));
}

/** Pure /pnl report: net PnL per day for the last N days. */
export function buildPnlText(days = 14): string {
  /*
   * The window is expressed in the SAME zone the day keys are bucketed in.
   *
   * It used to be built from `toISOString()`, i.e. the UTC date, and handed to an
   * aggregation that groups by the API's local day. Between 17:00 UTC and midnight the
   * local date is already tomorrow, so the report silently dropped the current day —
   * every evening, on the host the engine actually runs on.
   */
  const end = currentZonedDay();
  const start = addDaysToDayKey(end, -(days - 1));
  const rows = aggregateClosedTradesByDate(start, end);

  const lines: string[] = [`📅 **FlowMetrix PnL** (last ${days} days)`, ``];

  if (rows.length === 0) {
    lines.push("No closed trades in this window.");
  } else {
    for (const r of rows) {
      lines.push(
        `• ${r.date} · ${r.trades} trade${r.trades === 1 ? "" : "s"} · ${r.wins}W/${r.losses}L · net ${fmtUsd(
          r.netPnlUsd,
        )}`,
      );
    }
  }

  return markdownV2(lines.join("\n"));
}

/** Pure /position report: full detail for one position by id. */
export function buildPositionDetailText(positionId: string): string {
  const row = getPositionById(positionId);
  if (!row) {
    return markdownV2(`**Position not found:** ${positionId}`);
  }

  const inRange =
    row.current_price !== null &&
    row.current_price >= row.lower_bin_price &&
    row.current_price <= row.upper_bin_price;

  const lines: string[] = [
    `📍 **Position ${row.pair_name}**`,
    ``,
    `Status: ${row.status} · ${row.strategy_type}`,
    `Entry: ${fmtNum(row.entry_price)} · Now: ${fmtNum(row.current_price)} · Exit: ${fmtNum(
      row.exit_price,
    )}`,
    `Range: ${fmtNum(row.lower_bin_price)} – ${fmtNum(row.upper_bin_price)} · ${
      inRange ? "in range" : "OUT of range"
    }`,
    `Size: ${row.virtual_sol_amount} SOL (notional ${fmtUsd(
      row.virtual_sol_amount * (row.entry_sol_price_usd ?? 0),
    )})`,
    `Floating PnL: ${fmtUsd(row.floating_pnl_usd)} · Realized: ${fmtUsd(row.realized_pnl_usd)} (${pct(
      row.realized_pnl_pct,
    )})`,
    `Unclaimed fees: ${fmtUsd(row.unclaimed_fee_usd)}`,
    `Confidence: ${row.confidence_score ?? "n/a"} · Safety: ${row.safety_verdict ?? "n/a"}`,
    `Opened: ${row.opened_at ?? "n/a"} · Closed: ${row.closed_at ?? "—"}`,
  ];

  if (row.reasoning_log) lines.push(``, `Thesis: ${row.reasoning_log}`);

  return markdownV2(lines.join("\n"));
}

/** Pure /research report: latest macro research from the researcher agent. */
export function buildResearchText(): string {
  const r = getLatestResearch();
  if (!r) {
    return markdownV2("**No research report yet.**");
  }

  const bias = r.sentiment_bias ? ` · bias ${r.sentiment_bias}` : "";
  const body = (r.markdown_output ?? "").slice(0, 3000);
  const lines = [
    `🔬 **FlowMetrix Research** — ${r.report_date}${bias}`,
    ``,
    body || "*(report body empty)*",
  ];
  return markdownV2(lines.join("\n"));
}

/** Pure /help: command list. */
export function buildHelpText(): string {
  const lines = [
    `🤖 **FlowMetrix Commands**`,
    ``,
    `/status — balance, PnL, risk, active positions`,
    `/trades — recent closed trades + lifetime summary`,
    `/pnl — net PnL per day (last 14 days)`,
    `/position <id> — full detail for one position`,
    `/research — latest macro research report`,
    `/close_all — force-close all active positions`,
    `/claim — claim fees on open LIVE positions without closing them`,
    `/pause — stop scanning for new positions`,
    `/resume — resume scanning`,
    `/help — this list`,
  ];
  return markdownV2(lines.join("\n"));
}

async function deny(ctx: Context, command: string): Promise<void> {
  console.warn(`[telegram] denied /${command} from user ${ctx.from?.id ?? "unknown"}`);
  await ctx.reply(UNAUTHORIZED_REPLY).catch(() => undefined);
}

async function replyMarkdown(ctx: Context, text: string): Promise<void> {
  for (const part of chunk(text)) {
    try {
      await ctx.reply(part, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      // A malformed-entity error means the escaping failed; retry as plain text
      // so the operator still gets the report.
      const message = err instanceof Error ? err.message : String(err);
      if (/parse|entit/i.test(message)) {
        console.warn(`[telegram] command reply markdown rejected, retrying as plain text: ${message}`);
        await ctx.reply(part, { link_preview_options: { is_disabled: true } });
      } else {
        throw err;
      }
    }
  }
}

let started = false;

/* ------------------------------------------------------------------ */
/* Launch retries                                                      */
/* ------------------------------------------------------------------ */

/**
 * The backoff ladder, then a steady beat. `attempt` is 1-based and names the attempt
 * that JUST FAILED, so `launchBackoffMs(1)` is the wait before attempt 2.
 *
 * 5s / 15s / 30s / 60s forever. The tail is INDEFINITE on purpose and is the whole
 * point of this ladder: the failure it recovers from is an external poller holding the
 * same bot token, which nothing on this box can clear and which may clear at any time.
 * A retry budget that gave up would mean the kill-switch stays dead until someone
 * restarts the engine — and restarting a live engine to recover a kill-switch is the
 * intervention the kill-switch exists to avoid.
 */
export const TELEGRAM_LAUNCH_BACKOFF_MS: readonly number[] = [5_000, 15_000, 30_000];
export const TELEGRAM_LAUNCH_RETRY_STEADY_MS = 60_000;

export function launchBackoffMs(attempt: number): number {
  return TELEGRAM_LAUNCH_BACKOFF_MS[attempt - 1] ?? TELEGRAM_LAUNCH_RETRY_STEADY_MS;
}

export interface LaunchRetryHandle {
  /** Cancels any pending retry and prevents further attempts. Idempotent. */
  stop(): void;
  /** How many launch attempts have been made. Diagnostic; used by the tests. */
  attempts(): number;
}

/**
 * Calls `launch` and keeps calling it, on the ladder above, until one sticks.
 *
 * WHY THIS EXISTS. Every boot on 10 Sep 2026 logged `409: Conflict: terminated by other
 * getUpdates request` — an external poller holding the same token — and telegraf's
 * `launch()` REJECTS on that. With a single `.catch()` the command bot was then dead for
 * the entire life of the process: `/pause`, `/resume`, `/close_all` and `/status` all
 * unresponsive, i.e. the operator kill-switch, gone until the next restart. Nothing in
 * this repository caused the conflict and nothing here can clear it; what it can do is
 * keep asking, so the switch comes back on its own the moment the conflict does clear.
 *
 * SUCCESS IS NOT AWAITABLE, and the logging follows from that rather than from choice.
 * `launch()` resolves only when polling STOPS — it awaits the infinite update loop — so
 * a promise that has not settled IS the success case. Readiness is therefore logged
 * immediately after the call, exactly as before this loop existed, and a rejection that
 * arrives afterwards corrects it on the next line. Awaiting it in the boot path would
 * hang the orchestrator forever.
 *
 * The timer functions are injected so the tests can drive the ladder without waiting
 * real minutes for it; `env.ts` parses at import, so a test cannot reach this by
 * setting a variable. Same reason `readNewsBlackout` takes its clock and its path.
 */
export function launchWithBackoff(deps: {
  launch: () => Promise<unknown>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}): LaunchRetryHandle {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const log = deps.log ?? ((m: string) => console.log(m));
  const logError = deps.logError ?? ((m: string) => console.error(m));

  let stopped = false;
  let pending: unknown = null;
  let attempt = 0;

  const attemptLaunch = (): void => {
    if (stopped) return;
    attempt += 1;
    const n = attempt;

    /*
     * The rejection handler is attached BEFORE readiness is logged, so a `launch` that
     * rejects synchronously-ish cannot escape it. `started` is cleared on the way past
     * because `stopTelegramCommands` reads it, and a bot that failed to launch must not
     * be reported as one that is polling.
     */
    void deps.launch().catch((err) => {
      started = false;
      if (stopped) return;
      logError(`[telegram] bot launch failed (attempt ${n}): ${err}`);

      const wait = launchBackoffMs(n);
      logError(`[telegram] retrying the command bot launch in ${Math.round(wait / 1000)}s`);
      pending = setTimer(() => {
        pending = null;
        attemptLaunch();
      }, wait);
    });

    log(`[telegram] command bot started (long-polling, attempt ${n})`);
  };

  attemptLaunch();

  return {
    stop(): void {
      stopped = true;
      if (pending !== null) {
        clearTimer(pending);
        pending = null;
      }
    },
    attempts: () => attempt,
  };
}

let launchHandle: LaunchRetryHandle | null = null;

/**
 * Registers the command handlers and starts long-polling. Only the orchestrator
 * (npm run dev / dist/index.js) calls this — the pause flag is engine state, so
 * running the bot from the API-only process would control nothing.
 */
export function startTelegramCommands(): void {
  const bot = getTelegramBot();
  if (!bot || started) return;
  started = true;

  if (!hasTelegram) {
    console.warn("[telegram] commands skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured");
    return;
  }
  if (env.TELEGRAM_ALLOWED_USER_IDS.length === 0) {
    console.warn(
      "[telegram] TELEGRAM_ALLOWED_USER_IDS is empty — control commands will be denied to everyone (fail closed)",
    );
  }

  bot.command("status", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "status");
    try {
      await replyMarkdown(ctx, buildStatusText());
    } catch (err) {
      console.error("[telegram] /status failed:", err);
      await ctx.reply("❌ /status failed — see engine logs.").catch(() => undefined);
    }
  });

  bot.command("close_all", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "close_all");
    try {
      const activeCount = countActivePositions();
      if (activeCount === 0) {
        await replyMarkdown(ctx, "✅ **No active positions** — nothing to close.");
        return;
      }
      await ctx.reply(`⚠️ Force-closing ${activeCount} active position(s)…`);
      const result = await forceCloseAllPositions();
      const lines = [
        "✅ *Force close complete*",
        "",
        `Closed: ${s(result.closed)}/${s(result.requested)}`,
        `Total net PnL: ${s(fmtUsd(result.totalNetPnlUsd))}`,
      ];
      if (result.stalePriced.length > 0) {
        lines.push(`⚠️ Closed at *stale* price (live data unavailable): ${s(result.stalePriced.join(", "))}`);
      }
      if (result.failed.length > 0) {
        lines.push(`❌ Could not close: ${s(result.failed.map((f) => f.pairName).join(", "))}`);
      }
      await replyMarkdown(ctx, lines.join("\n"));
    } catch (err) {
      console.error("[telegram] /close_all failed:", err);
      await ctx
        .reply(`❌ /close_all failed: ${err instanceof Error ? err.message : String(err)}`)
        .catch(() => undefined);
    }
  });

  bot.command("pause", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "pause");
    setEnginePaused(true);
    console.log("[telegram] engine PAUSED via /pause");
    await replyMarkdown(
      ctx,
      "⏸️ **Engine paused.**\nScanning for new positions is stopped. Open positions are still monitored and can still close normally.\nUse /resume to restart scanning.",
    );
  });

  /*
   * Realises fees WITHOUT closing. Operator-only and deliberately not on any schedule:
   * `closeLivePosition` claims atomically through `shouldClaimAndClose`, so claiming
   * on a timer would pay a second set of gas for fees the close collects anyway — the
   * churn the friction gates exist to prevent. The one case where it earns its gas is
   * a position held through a long in-range stretch, and that is a judgement call.
   */
  bot.command("claim", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "claim");

    if (!isLiveExecutionActive()) {
      await replyMarkdown(
        ctx,
        "⚠️ **Not live.** There are no on-chain fees to claim — this engine is paper trading.",
      );
      return;
    }

    const live = getActivePositions().filter(
      (p) => p.execution_mode === "LIVE" && p.position_address,
    );
    if (live.length === 0) {
      await replyMarkdown(ctx, "No open live positions to claim from.");
      return;
    }

    for (const p of live) {
      try {
        const { signatures } = await claimLiveFees({
          poolAddress: p.pool_address,
          positionAddress: p.position_address as string,
        });
        await replyMarkdown(
          ctx,
          `✅ **Claimed ${p.pair_name}**\n${signatures.length} tx: ${signatures.join(", ")}`,
        );
      } catch (err) {
        // Reported per position: one failure must not hide the others' outcomes.
        await replyMarkdown(
          ctx,
          `❌ **Claim failed for ${p.pair_name}**\n${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });

  bot.command("resume", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "resume");
    setEnginePaused(false);
    console.log("[telegram] engine RESUMED via /resume");

    /*
     * /resume lifts the TELEGRAM hold and cannot lift the FILE one — they are separate
     * decisions made through separate channels. Replying "resumed" while the control
     * file still holds entries would be a claim the next cycle contradicts, leaving the
     * operator watching a "running" engine open nothing — the exact confusion this
     * file-control path exists to remove. Read live, so the answer is the one the next
     * cycle will act on, and only in live mode, where the cycle reads the file at all.
     */
    const heldByFile = isLiveExecutionActive() && readEngineControlFile().paused;

    await replyMarkdown(
      ctx,
      heldByFile
        ? "▶️ **Telegram pause lifted** — but new entries are STILL HELD by the " +
            "operator control file, which /resume cannot clear. Remove it on the host, " +
            "or set `paused: false` in it. Monitoring and exits are unaffected."
        : "▶️ **Engine resumed.**\nScanning for new positions is active again.",
    );
  });

  bot.command("trades", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "trades");
    try {
      await replyMarkdown(ctx, buildTradesText());
    } catch (err) {
      console.error("[telegram] /trades failed:", err);
      await ctx.reply("❌ /trades failed — see engine logs.").catch(() => undefined);
    }
  });

  bot.command("pnl", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "pnl");
    try {
      await replyMarkdown(ctx, buildPnlText());
    } catch (err) {
      console.error("[telegram] /pnl failed:", err);
      await ctx.reply("❌ /pnl failed — see engine logs.").catch(() => undefined);
    }
  });

  bot.command("position", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "position");
    const arg = String((ctx as any).payload ?? "").trim();
    if (!arg) {
      await replyMarkdown(ctx, "Usage: /position <position_id>\nGet the id from /status or /trades.");
      return;
    }
    try {
      await replyMarkdown(ctx, buildPositionDetailText(arg));
    } catch (err) {
      console.error("[telegram] /position failed:", err);
      await ctx.reply("❌ /position failed — see engine logs.").catch(() => undefined);
    }
  });

  bot.command("research", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "research");
    try {
      await replyMarkdown(ctx, buildResearchText());
    } catch (err) {
      console.error("[telegram] /research failed:", err);
      await ctx.reply("❌ /research failed — see engine logs.").catch(() => undefined);
    }
  });

  bot.command("help", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "help");
    await replyMarkdown(ctx, buildHelpText());
  });

  // A command handler error must never kill the whole bot: log it and keep
  // polling (without bot.catch(), Telegraf re-throws and polling stops).
  bot.catch((err) => {
    console.error("[telegram] command error:", err);
  });

  launchHandle = launchWithBackoff({ launch: () => bot.launch() });
}

export function stopTelegramCommands(): void {
  const bot = getTelegramBot();

  /*
   * The retry loop is stopped FIRST, and unconditionally.
   *
   * It can be pending while `started` is false and while the bot never launched at
   * all — that is the whole state this retry loop adds — so gating the cancel behind
   * either check is how a "stopped" engine keeps waking up every 60s to re-poll a
   * token it no longer owns.
   */
  if (launchHandle) {
    launchHandle.stop();
    launchHandle = null;
  }

  if (!bot || !started) return;
  started = false;
  // The bot may never have launched (every attempt rejected), and telegraf throws
  // when stopping one that was never polling. Stopping is best effort by nature:
  // there is nothing to recover from and nothing left to stop.
  try {
    bot.stop();
  } catch {
    // Already stopped, or never started. Either way we are where we wanted to be.
  }
  console.log("[telegram] command bot stopped");
}
