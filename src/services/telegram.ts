import { Telegraf } from "telegraf";
import { env, hasTelegram } from "../config/env.js";

/**
 * Telegram is optional. With no token/chat id configured every dispatch becomes a
 * no-op log line, so the agents run identically on a bare local machine.
 */
const bot = hasTelegram ? new Telegraf(env.TELEGRAM_BOT_TOKEN as string) : null;
const chatId = env.TELEGRAM_CHAT_ID;

/** Escapes the characters Telegram's legacy Markdown parser treats as syntax. */
export function sanitize(text: string): string {
  // Backslash built via fromCharCode so this file never needs a literal \\ escape.
  const esc = String.fromCharCode(92);
  const specials = "_*[]()~`>#+=|{}.!-" + esc;
  let out = "";
  for (const ch of text) {
    out += specials.includes(ch) ? esc + ch : ch;
  }
  return out;
}

/** Telegram rejects messages over 4096 characters. */
export function chunk(text: string, size = 3800): string[] {
  if (text.length <= size) return [text];

  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size);
    const at = cut > size * 0.5 ? cut : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/** The shared Telegraf instance, or null when Telegram is not configured. */
export function getTelegramBot(): Telegraf | null {
  return bot;
}

export function isTelegramEnabled(): boolean {
  return bot !== null;
}

/**
 * Sends a message. Never throws: a Telegram outage must not abort a trading or
 * research cycle. Returns true when the message was actually delivered.
 */
export async function sendMessage(text: string, useMarkdown = true): Promise<boolean> {
  if (!bot || !chatId) {
    console.log(`[telegram] disabled, would send:\n${text.slice(0, 400)}`);
    return false;
  }

  try {
    for (const part of chunk(text)) {
      await bot.telegram.sendMessage(chatId, part, {
        parse_mode: useMarkdown ? "MarkdownV2" : undefined,
        link_preview_options: { is_disabled: true },
      });
    }
    return true;
  } catch (err) {
    // A malformed-entity error means the escaping failed; retry as plain text so
    // the alert still reaches the operator.
    const message = err instanceof Error ? err.message : String(err);
    if (useMarkdown && /parse|entit/i.test(message)) {
      console.warn(`[telegram] markdown rejected, retrying as plain text: ${message}`);
      return sendMessage(text, false);
    }
    console.warn(`[telegram] send failed: ${message}`);
    return false;
  }
}

/** Sends pre-formatted Markdown produced by the LLM, escaped for MarkdownV2. */
export async function sendDailyResearch(reportDate: string, markdown: string): Promise<void> {
  const header = sanitize(`📊 FlowMetrix Daily Macro — ${reportDate}`);
  await sendMessage(`*${header}*\n\n${sanitize(markdown)}`);
}

export interface TradeAlertPayload {
  pairName: string;
  poolAddress: string;
  strategy: string;
  entryPrice: number;
  lowerBinPrice: number;
  upperBinPrice: number;
  confidence: number;
  thesis: string;
  virtualSol: number;
}

const fmt = (n: number, digits = 6): string =>
  Number.isFinite(n) ? n.toFixed(digits).replace(/\.?0+$/, "") : "n/a";

const usd = (n: number): string =>
  `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

export async function sendPositionOpened(p: TradeAlertPayload): Promise<void> {
  const body = [
    `🟢 PAPER POSITION OPENED (DRY-RUN)`,
    ``,
    `Pair: ${p.pairName}`,
    `Strategy: ${p.strategy}`,
    `Size: ${p.virtualSol} SOL (virtual)`,
    `Entry: ${fmt(p.entryPrice)}`,
    `Range: ${fmt(p.lowerBinPrice)} — ${fmt(p.upperBinPrice)}`,
    `Confidence: ${p.confidence}/100`,
    ``,
    `Thesis: ${p.thesis}`,
    ``,
    `Pool: ${p.poolAddress}`,
  ].join("\n");

  await sendMessage(sanitize(body));
}

export interface CloseAlertPayload {
  pairName: string;
  status: string;
  reason: string;
  entryPrice: number;
  exitPrice: number;
  feeUsd: number;
  ilUsd: number;
  netPnlUsd: number;
  netPnlPct: number;
  heldHours: number;
}

export async function sendPositionClosed(p: CloseAlertPayload): Promise<void> {
  const icon = p.netPnlUsd >= 0 ? "✅" : "🔻";
  const body = [
    `${icon} PAPER POSITION CLOSED — ${p.status}`,
    ``,
    `Pair: ${p.pairName}`,
    `Reason: ${p.reason}`,
    `Held: ${p.heldHours.toFixed(1)}h`,
    `Entry → Exit: ${fmt(p.entryPrice)} → ${fmt(p.exitPrice)}`,
    ``,
    `Fees earned: ${usd(p.feeUsd)}`,
    `Impermanent loss: ${usd(p.ilUsd)}`,
    `Net PnL: ${usd(p.netPnlUsd)} (${p.netPnlPct.toFixed(2)}%)`,
  ].join("\n");

  await sendMessage(sanitize(body));
}

export async function sendError(context: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sendMessage(sanitize(`⚠️ FlowMetrix error in ${context}\n\n${message.slice(0, 500)}`));
}

/** Telegraf keeps no long-lived handles in send-only mode; provided for symmetry. */
export function stopTelegram(): void {
  /* no polling loop is started, nothing to tear down */
}
