import { env } from "../config/env.js";
import { chatCompletion, isDeepSeekAvailable } from "../services/deepseek.js";
import { getPositionsAwaitingPostMortem, setPostMortem } from "../database/repositories.js";
import type { SimulatedPositionRow } from "../database/types.js";

const SYSTEM_PROMPT = `You are a quantitative trading post-mortem analyst reviewing a closed
Meteora DLMM liquidity position from a zero-capital paper-trading simulation.

Write EXACTLY ONE sentence, at most 200 characters, stating the single most likely reason the
position ended where it did and the one lesson worth carrying forward.

Rules:
- One sentence. No preamble, no bullet points, no markdown, no quotation marks.
- Use only the figures supplied. Never invent a metric you were not given.
- Be specific and causal ("price exited the upper bin after 3h, so fees never offset IL"),
  not generic ("manage risk carefully").`;

function buildPrompt(row: SimulatedPositionRow): string {
  const n = (v: number | null | undefined, digits = 2): string =>
    v === null || v === undefined || !Number.isFinite(v) ? "unknown" : v.toFixed(digits);

  const heldHours =
    row.closed_at && row.opened_at
      ? (new Date(`${row.closed_at.replace(" ", "T")}Z`).getTime() -
          new Date(`${row.opened_at.replace(" ", "T")}Z`).getTime()) /
        3_600_000
      : Number.NaN;

  const priceMovePct =
    row.entry_price > 0 && row.exit_price !== null
      ? ((row.exit_price - row.entry_price) / row.entry_price) * 100
      : Number.NaN;

  return [
    `CLOSED POSITION`,
    `pair: ${row.pair_name}`,
    `strategy: ${row.strategy_type}`,
    `close_status: ${row.status}`,
    `close_reason: ${row.close_reason ?? "unknown"}`,
    `held_hours: ${n(heldHours, 1)}`,
    `entry_price: ${row.entry_price}`,
    `exit_price: ${row.exit_price ?? "unknown"}`,
    `price_move_pct: ${n(priceMovePct)}`,
    `bin_range: ${row.lower_bin_price} to ${row.upper_bin_price}`,
    `fees_earned_usd: ${n(row.unclaimed_fee_usd)}`,
    `impermanent_loss_usd: ${n(row.impermanent_loss_usd)}`,
    `net_realized_pnl_usd: ${n(row.realized_pnl_usd)}`,
    `net_realized_pnl_pct: ${n(row.realized_pnl_pct)}`,
    `estimated_gas_cost_usd: ${n(row.est_gas_cost_usd)}`,
    `pool_tvl_at_entry_usd: ${n(row.entry_tvl, 0)}`,
    `pool_24h_volume_at_entry_usd: ${n(row.entry_24h_volume, 0)}`,
    `model_confidence_at_entry: ${n(row.confidence_score, 0)}`,
    `original_entry_thesis: ${row.reasoning_log ?? "none"}`,
  ].join("\n");
}

/** Strips markdown/quoting artefacts and clamps to a single sentence. */
export function normalisePostMortem(raw: string): string {
  let text = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  text = text.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "");
  text = text.replace(/\s+/g, " ").trim();

  // Keep only the first sentence if the model produced more than one.
  const firstStop = text.search(/[.!?](\s|$)/);
  if (firstStop !== -1) text = text.slice(0, firstStop + 1);

  return text.length > 240 ? `${text.slice(0, 237).trimEnd()}…` : text;
}

/**
 * Generates and stores a one-sentence post-mortem for a single closed position.
 * Returns the stored text, or null when reflection is disabled, DeepSeek is not
 * configured, or the call failed. A failure leaves the row untouched so the next
 * cycle retries it rather than persisting an empty analysis.
 */
export async function reflectOnPosition(row: SimulatedPositionRow): Promise<string | null> {
  if (!env.POST_MORTEM_ENABLED) return null;
  if (!isDeepSeekAvailable()) return null;

  try {
    const raw = await chatCompletion({
      system: SYSTEM_PROMPT,
      user: buildPrompt(row),
      reasoning: false,
      temperature: 0.3,
      maxTokens: 160,
    });

    const text = normalisePostMortem(raw);
    if (!text) return null;

    setPostMortem(row.position_id, text);
    console.log(`[postmortem] ${row.pair_name}: ${text}`);
    return text;
  } catch (err) {
    console.warn(
      `[postmortem] failed for ${row.pair_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Sweeps closed positions that are still missing a post-mortem. Called at the end of
 * each trading cycle so a reflection that failed earlier gets another attempt.
 */
export async function runPostMortemSweep(limit = 5): Promise<number> {
  if (!env.POST_MORTEM_ENABLED || !isDeepSeekAvailable()) return 0;

  const pending = getPositionsAwaitingPostMortem(limit);
  let written = 0;

  for (const row of pending) {
    const text = await reflectOnPosition(row);
    if (text) written++;
  }

  return written;
}
