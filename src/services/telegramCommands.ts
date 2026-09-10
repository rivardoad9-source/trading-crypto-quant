import type { Context } from "telegraf";
import { env, hasTelegram } from "../config/env.js";
import { getTelegramBot, sanitize, chunk } from "./telegram.js";
import { computeOverview } from "./overview.js";
import { isEnginePaused, setEnginePaused } from "./engineControl.js";
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
    `🎛 Engine: ${isEnginePaused() ? "⏸ **PAUSED** (scanning off)" : "▶️ **RUNNING**"}`,
  ];

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
    await replyMarkdown(ctx, "▶️ **Engine resumed.**\nScanning for new positions is active again.");
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

  // launch() resolves only when polling STOPS — it awaits the infinite update
  // loop — so log readiness immediately and keep the catch for boot failures
  // (getMe / deleteWebhook errors). The 409 conflict case is handled inside
  // telegraf's polling loop with retries; it surfaces here only on boot.
  // A command handler error must never kill the whole bot: log it and keep
  // polling (without bot.catch(), Telegraf re-throws and polling stops).
  bot.catch((err) => {
    console.error("[telegram] command error:", err);
  });
  bot.launch().catch((err) => {
    started = false;
    console.error("[telegram] bot launch failed:", err);
  });
  console.log("[telegram] command bot started (long-polling)");
}

export function stopTelegramCommands(): void {
  const bot = getTelegramBot();
  if (!bot || !started) return;
  started = false;
  bot.stop();
  console.log("[telegram] command bot stopped");
}
