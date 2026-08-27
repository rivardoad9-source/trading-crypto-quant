import type { Context } from "telegraf";
import { env, hasTelegram } from "../config/env.js";
import { getTelegramBot, sanitize, chunk } from "./telegram.js";
import { computeOverview } from "./overview.js";
import { isEnginePaused, setEnginePaused } from "./engineControl.js";
import { forceCloseAllPositions } from "../agents/dlmmTraderAgent.js";
import { countActivePositions, getActivePositions } from "../database/repositories.js";

/**
 * Interactive Telegram control commands for the FlowMetrix engine.
 *
 * Every command is restricted to the owner's Telegram user ID(s) via
 * TELEGRAM_ALLOWED_USER_IDS (comma-separated). The gate fails closed: an empty
 * or unset allowlist means nobody can run the commands.
 *
 * Commands:
 *   /status    — balance, PnL, risk metrics, engine state, active positions
 *   /close_all — emergency force-close of every active position (paper trading)
 *   /pause     — stop scanning for new positions (monitoring keeps running)
 *   /resume    — re-enable scanning
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

  bot.command("resume", async (ctx) => {
    if (!isCommandAuthorized(ctx.from?.id)) return deny(ctx, "resume");
    setEnginePaused(false);
    console.log("[telegram] engine RESUMED via /resume");
    await replyMarkdown(ctx, "▶️ **Engine resumed.**\nScanning for new positions is active again.");
  });

  // launch() resolves only when polling STOPS — it awaits the infinite update
  // loop — so log readiness immediately and keep the catch for boot failures
  // (getMe / deleteWebhook errors). The 409 conflict case is handled inside
  // telegraf's polling loop with retries; it surfaces here only on boot.
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
