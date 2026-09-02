import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { MAX_CANDIDATE_POOLS, POSITION_STATUS, type PositionStatus } from "../config/constants.js";
import {
  assessBreakeven,
  defaultCooldownThresholds,
  defaultThresholds,
  estimateFeeYieldUsd,
  fetchLivePools,
  fetchPoolByAddress,
  fetchPoolsByAddresses,
  filterPoolsOnCooldown,
  hoursSince,
  isOutOfRange,
  parseDbTimestamp,
  riskMintOf,
  screenPools,
  valuePosition,
  type BreakevenAssessment,
  type CooldownBlockKind,
  type DlmmPool,
  type ScreenedPool,
} from "../services/meteora.js";
import {
  fetchPoolPriceChanges,
  fetchRealizedVolatilityPctPerHour,
  fetchSolPriceUsd,
} from "../services/marketData.js";
import {
  DeepSeekTruncatedError,
  isDeepSeekAvailable,
  structuredCompletion,
} from "../services/deepseek.js";
import { positionMutex } from "../services/mutex.js";
import {
  getPriorityFeeEstimateSafe,
  screenTokenSafety,
  type PriorityFeeEstimate,
  type SafetyVerdict,
  type TokenSafetyReport,
} from "../services/solana.js";
import { sendError, sendPositionClosed, sendPositionOpened } from "../services/telegram.js";
import { isEnginePaused } from "../services/engineControl.js";
import {
  closePosition,
  countActivePositions,
  getActivePositions,
  getPoolExitHistory,
  getPoolExitRecord,
  getRecentFailurePostMortems,
  getPositionById,
  hasActivePositionForPool,
  insertPosition,
  updatePositionMetrics,
} from "../database/repositories.js";
import { reflectOnPosition, runPostMortemSweep } from "./postMortemAgent.js";
import type { SimulatedPositionRow } from "../database/types.js";

/* ------------------------------------------------------------------ */
/* LLM decision contract                                               */
/* ------------------------------------------------------------------ */

export const DLMMPoolDecisionSchema = z.object({
  selectedPool: z.string().describe("Alamat pool address yang dipilih atau 'NONE'"),
  pairName: z.string(),
  action: z.enum(["ENTER", "SKIP"]),
  strategy: z.enum(["SPOT", "BID_ASK", "CURVE"]),
  binRangeDownsideCoverPct: z.number().min(0).max(100),
  binRangeUpsideCoverPct: z.number().min(0).max(100),
  confidenceScore: z.number().min(0).max(100),
  thesis: z.string().max(400),
});

export type DLMMPoolDecision = z.infer<typeof DLMMPoolDecisionSchema>;

const STRATEGY_SYSTEM_PROMPT = `You are a Solana Meteora DLMM liquidity strategist running a
ZERO-CAPITAL PAPER TRADING simulation. No real funds are ever deployed.

You receive up to three pre-screened candidate pools with hard quantitative metrics.
Select AT MOST ONE pool to provide liquidity to, or decline entirely.

Decision rules:
- Choose ENTER only when fee generation plausibly outweighs impermanent-loss risk
  over a holding period of hours, not weeks.
- Choose SKIP (and set selectedPool to "NONE") when every candidate looks like a
  transient fee spike on collapsing TVL, or when volume is not organic.
- Bin range: binRangeDownsideCoverPct and binRangeUpsideCoverPct are percentages of
  the CURRENT PRICE that your range should cover below and above spot. A DLMM
  position earns fees ONLY while price stays inside the range, so a tight range
  earns more per unit of liquidity but goes inactive sooner. Typical values are 2-15.
- strategy: SPOT for balanced two-sided liquidity, BID_ASK for volatile pairs where
  you want depth at the edges, CURVE for tight mean-reverting pairs.

Adaptive range sizing — bounded improvisation:
- The user message may contain a RECENT LOSSES block: your own last losing positions,
  each with the range you chose, how it closed, and the post-mortem written afterwards.
  Treat it as evidence about this market regime, not as a rule.
- If those losses are dominated by price leaving the range — out-of-range closes, wicks,
  false breakouts, or post-mortems describing choppy or whipsawing conditions — then
  WIDEN binRangeDownsideCoverPct and binRangeUpsideCoverPct beyond your first instinct.
  A range that survives the noise keeps earning; a range that gets wicked out pays gas
  and exit slippage for nothing and the pool is then benched by a cooldown.
- If instead the losses came from sustained one-directional moves, a wider range would
  only have lost more slowly. Prefer SKIP over widening in that case.
- Widening is not free: the same liquidity spread over a wider range earns less per unit
  of price movement. Say in your thesis why the width you chose is worth it.
- NEVER propose a value below the floors quoted in the user message. The engine clamps
  anything lower, so a smaller number is not a tighter range — it is just your reasoning
  being overridden.
- With no RECENT LOSSES block there is no evidence of a regime. Size the range on the
  candidate's own metrics and do not invent a loss history to justify a width.
- confidenceScore reflects conviction, 0-100.
- thesis: at most 400 characters, factual, referencing the metrics you were given.

Respond with ONLY a JSON object. Every key below is REQUIRED, including on a SKIP:

{
  "selectedPool": string  // a pool_address from the candidate list, or "NONE"
  "pairName":     string  // the pair name of the selected pool, or "NONE"
  "action":       "ENTER" | "SKIP"
  "strategy":     "SPOT" | "BID_ASK" | "CURVE"
  "binRangeDownsideCoverPct": number  // 0-100
  "binRangeUpsideCoverPct":   number  // 0-100
  "confidenceScore":          number  // 0-100
  "thesis":       string  // HARD LIMIT 400 characters, one to three sentences, concise
}`;

/**
 * Condenses recent losing closes into prompt lines.
 *
 * The realised range is reconstructed from the stored prices rather than from the
 * model's original request, so the block reports the range the position ACTUALLY had
 * after `computeBinRange` applied its floors — showing the asked-for width would teach
 * the model from a range that never existed.
 *
 * A pure function over rows so it is testable without a database.
 */
export function summariseLossHistory(rows: SimulatedPositionRow[]): string[] {
  const lines: string[] = [];

  for (const row of rows) {
    const entry = row.entry_price;
    const range =
      entry > 0 && row.lower_bin_price > 0 && row.upper_bin_price > 0
        ? `-${(((entry - row.lower_bin_price) / entry) * 100).toFixed(1)}%/` +
          `+${(((row.upper_bin_price - entry) / entry) * 100).toFixed(1)}%`
        : "unknown";

    const pnl = typeof row.realized_pnl_pct === "number" ? `${row.realized_pnl_pct.toFixed(2)}%` : "unknown";
    const held = hoursBetween(row.opened_at, parseDbTimestamp(row.closed_at) ?? new Date());

    lines.push(
      `- ${row.pair_name}: closed ${row.status} at ${pnl} after ${held.toFixed(1)}h ` +
        `with range ${range}.`,
      `  reason: ${row.close_reason ?? "unknown"}`,
      `  lesson: ${(row.post_mortem ?? "").trim()}`,
    );
  }

  return lines;
}

export function buildCandidatePrompt(
  candidates: ScreenedPool[],
  solPriceUsd: number,
  priorityFee: PriorityFeeEstimate | null,
  lossHistory: SimulatedPositionRow[] = [],
): string {
  const lines: string[] = [
    `SOL/USD: $${solPriceUsd.toFixed(2)}`,
    `Position size per entry: ${env.VIRTUAL_SOL_PER_POSITION} SOL (virtual, $${(
      env.VIRTUAL_SOL_PER_POSITION * solPriceUsd
    ).toFixed(2)})`,
  ];

  if (priorityFee) {
    const roundTripUsd = priorityFee.totalUsd === null ? null : priorityFee.totalUsd * 2;
    lines.push(
      `Estimated Solana transaction cost: ${priorityFee.totalSol.toFixed(6)} SOL per tx` +
        (roundTripUsd === null ? "" : ` (~$${roundTripUsd.toFixed(4)} round trip)`) +
        `, from the p${priorityFee.percentile} priority fee across ${priorityFee.samples} recent slots.`,
      `Reject any pool whose plausible fee income cannot clear that round-trip cost.`,
    );
  } else {
    lines.push(`Estimated Solana transaction cost: UNAVAILABLE (do not assume it is zero).`);
  }

  /*
   * Range floors are quoted so the model can reason inside the constraint instead of
   * proposing a width the engine will silently widen anyway.
   */
  lines.push(
    "",
    `Bin range floors enforced by the engine: downside >= ${env.MIN_DOWNSIDE_COVER_PCT}%, ` +
      `upside >= ${env.MIN_UPSIDE_COVER_PCT}%. Anything smaller is clamped up to these.`,
  );

  const lossLines = summariseLossHistory(lossHistory);
  if (lossLines.length > 0) {
    lines.push(
      "",
      `RECENT LOSSES (your last ${lossHistory.length} losing closes, newest first):`,
      ...lossLines,
    );
  } else {
    lines.push(
      "",
      "RECENT LOSSES: UNAVAILABLE — no losing close carries a post-mortem yet. Do not " +
        "assume a market regime you have no evidence for.",
    );
  }

  lines.push("", "All candidates below already passed an anti-rug screen.", "", "CANDIDATE POOLS:");

  candidates.forEach((c, i) => {
    lines.push(
      "",
      `[${i + 1}] ${c.pairName}`,
      `  pool_address: ${c.address}`,
      `  current_price: ${c.currentPrice}`,
      `  tvl_usd: ${c.tvlUsd.toFixed(0)}`,
      `  volume_24h_usd: ${c.volume24hUsd.toFixed(0)}`,
      `  volume_1h_usd: ${c.volume1hUsd.toFixed(0)}`,
      `  fees_24h_usd: ${c.fees24hUsd.toFixed(2)}`,
      `  fee_tvl_ratio_24h: ${(c.feeTvlRatio24h * 100).toFixed(3)}% of TVL per 24h`,
      `  implied_apr: ${c.estimatedAprPct.toFixed(0)}%`,
      `  bin_step: ${c.binStep}`,
      `  base_fee_pct: ${c.baseFeePct}`,
      `  pool_age_hours: ${Number.isFinite(c.ageHours) ? c.ageHours.toFixed(1) : "unknown"}`,
      `  both_tokens_verified: ${c.bothTokensVerified}`,
    );
  });

  lines.push(
    "",
    "Select at most one pool. selectedPool must be one of the pool_address values above, or \"NONE\".",
  );

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Stage 0: anti-rug screen                                            */
/* ------------------------------------------------------------------ */

export interface SafetyScreenedPool {
  pool: ScreenedPool;
  safety: TokenSafetyReport | null;
  /** Filled in by the friction gate once position size is known. */
  breakeven?: BreakevenAssessment;
  /** Filled in by the volatility gates. */
  priceChange24hPct?: number;
  priceChange1hPct?: number;
  realizedVolPctPerHour?: number;
}

export interface SafetyScreenSummary {
  passed: SafetyScreenedPool[];
  rejected: Array<{ pairName: string; verdict: string; reasons: string[] }>;
}

/**
 * Filters candidates on rug risk before any of them reach the LLM, so the model is
 * never asked to reason about a pool that already failed a hard safety rule.
 *
 * UNKNOWN (a check that could not run) is resolved by ANTIRUG_ON_ERROR, which
 * defaults to "reject". The public Solana RPC blocks getTokenLargestAccounts, so on
 * the default endpoint every candidate resolves to UNKNOWN — that is the filter
 * working, not a bug. Point SOLANA_RPC_URL at a provider that serves the method.
 */
/**
 * The safety gate, isolated so it can be tested directly.
 *
 * FAIL is never accepted. UNKNOWN — a check that could not be executed — is accepted
 * only under an explicit "allow" policy; the default rejects it.
 */
export function acceptsSafetyVerdict(
  verdict: SafetyVerdict,
  onError: "reject" | "allow",
): boolean {
  if (verdict === "PASS") return true;
  if (verdict === "FAIL") return false;
  return onError === "allow";
}

export async function applyAntiRugScreen(
  candidates: ScreenedPool[],
): Promise<SafetyScreenSummary> {
  const summary: SafetyScreenSummary = { passed: [], rejected: [] };

  if (!env.ANTIRUG_ENABLED) {
    summary.passed = candidates.map((pool) => ({ pool, safety: null }));
    return summary;
  }

  for (const pool of candidates) {
    const mint = riskMintOf(pool);

    // Both legs are established quote assets; there is no rug surface to screen.
    if (mint === null) {
      summary.passed.push({
        pool,
        safety: {
          mint: "n/a",
          verdict: "PASS",
          reasons: ["both legs are recognised quote assets"],
          top10Pct: null,
          mintAuthorityRevoked: null,
          freezeAuthorityRevoked: null,
          checkedAt: new Date().toISOString(),
        },
      });
      continue;
    }

    let safety: TokenSafetyReport;
    try {
      safety = await screenTokenSafety(mint);
    } catch (err) {
      safety = {
        mint,
        verdict: "UNKNOWN",
        reasons: [`safety screen threw: ${err instanceof Error ? err.message : String(err)}`],
        top10Pct: null,
        mintAuthorityRevoked: null,
        freezeAuthorityRevoked: null,
        checkedAt: new Date().toISOString(),
      };
    }

    if (acceptsSafetyVerdict(safety.verdict, env.ANTIRUG_ON_ERROR)) {
      summary.passed.push({ pool, safety });
    } else {
      summary.rejected.push({
        pairName: pool.pairName,
        verdict: safety.verdict,
        reasons: safety.reasons,
      });
    }
  }

  return summary;
}

/* ------------------------------------------------------------------ */
/* Position sizing helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * USD notional of a position, fixed at entry.
 *
 * Fee accrual is quoted against this entry notional rather than a live mark-to-market
 * value so that fee income and impermanent loss stay independent terms: IL is already
 * measured separately by valuePosition(). Re-marking the notional would double-count
 * the price move.
 */
export function positionNotionalUsd(row: Pick<SimulatedPositionRow, "virtual_sol_amount" | "entry_sol_price_usd">): number {
  const solPrice = row.entry_sol_price_usd ?? 0;
  return row.virtual_sol_amount * solPrice;
}

/**
 * Builds the bin range, enforcing a floor on how tight the LLM may go.
 *
 * A narrow range exits sooner, and every exit costs gas plus forced-exit slippage.
 * The unbiased 30-day backtest closed 62% of trades on out-of-range while gas and
 * slippage ($74.80) exceeded all fee income ($55.25), so the floor is a direct
 * anti-churn measure rather than a style preference.
 */
export function computeBinRange(
  currentPrice: number,
  downsidePct: number,
  upsidePct: number,
  floors: { minDownsidePct: number; minUpsidePct: number } = {
    minDownsidePct: env.MIN_DOWNSIDE_COVER_PCT,
    minUpsidePct: env.MIN_UPSIDE_COVER_PCT,
  },
): { lower: number; upper: number; downsidePct: number; upsidePct: number; widened: boolean } {
  const effectiveDownside = Math.min(Math.max(downsidePct, floors.minDownsidePct), 99);
  const effectiveUpside = Math.max(upsidePct, floors.minUpsidePct);

  return {
    lower: currentPrice * (1 - effectiveDownside / 100),
    upper: currentPrice * (1 + effectiveUpside / 100),
    downsidePct: effectiveDownside,
    upsidePct: effectiveUpside,
    widened: effectiveDownside > downsidePct || effectiveUpside > upsidePct,
  };
}

/**
 * SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker.
 * Parsing lives in meteora.ts so the cooldown gate and the position monitor cannot
 * drift apart on how they read a stored timestamp.
 */
const hoursBetween = (fromIso: string | null, to: Date): number => hoursSince(fromIso, to);

/* ------------------------------------------------------------------ */
/* Exit rules                                                          */
/* ------------------------------------------------------------------ */

export interface ExitDecision {
  shouldClose: boolean;
  status: PositionStatus;
  reason: string;
}

export function evaluateExit(params: {
  netPnlPct: number;
  inRange: boolean;
  ageHours: number;
}): ExitDecision {
  const { netPnlPct, inRange, ageHours } = params;

  if (!inRange) {
    return {
      shouldClose: true,
      status: POSITION_STATUS.CLOSED_OUT_OF_RANGE,
      reason: "Price left the bin range; position stopped earning fees.",
    };
  }
  if (netPnlPct >= env.TAKE_PROFIT_PCT) {
    return {
      shouldClose: true,
      status: POSITION_STATUS.CLOSED_PROFIT,
      reason: `Take-profit hit (${netPnlPct.toFixed(2)}% >= ${env.TAKE_PROFIT_PCT}%).`,
    };
  }
  if (netPnlPct <= env.STOP_LOSS_PCT) {
    return {
      shouldClose: true,
      status: POSITION_STATUS.CLOSED_LOSS,
      reason: `Stop-loss hit (${netPnlPct.toFixed(2)}% <= ${env.STOP_LOSS_PCT}%).`,
    };
  }
  if (ageHours >= env.MAX_POSITION_AGE_HOURS) {
    return {
      shouldClose: true,
      status: POSITION_STATUS.CLOSED_TIMEOUT,
      reason: `Max age reached (${ageHours.toFixed(1)}h >= ${env.MAX_POSITION_AGE_HOURS}h).`,
    };
  }

  return { shouldClose: false, status: POSITION_STATUS.ACTIVE, reason: "" };
}

/* ------------------------------------------------------------------ */
/* Stage: monitor open positions                                       */
/* ------------------------------------------------------------------ */

export interface MonitorSummary {
  checked: number;
  closed: number;
  stale: number;
  /** Post-mortems written during this pass. */
  reflected: number;
}

/**
 * A close that still needs its notification and post-mortem.
 *
 * These are deliberately NOT done inside the pass: `sendPositionClosed` is a Telegram
 * round trip and `reflectOnPosition` is a DeepSeek call with a timeout measured in
 * minutes. Awaiting either while holding `positionMutex` would block the 60-second
 * monitor for the duration — silently voiding the exit-timing guarantee that is the
 * whole reason the fast monitor exists — for up to two minutes after every close.
 */
interface DeferredCloseWork {
  positionId: string;
  notify: Parameters<typeof sendPositionClosed>[0];
}

/**
 * Valuates a position at a given price: accrues this interval's fees on top of
 * the stored running total, then applies the LP value change. Shared by the
 * monitor's exit rules and the Telegram emergency /close_all so both always use
 * the same maths.
 */
function valuateAtPrice(
  row: SimulatedPositionRow,
  currentPrice: number,
  feeTvlRatio24h: number,
  now = new Date(),
): {
  netPnlUsd: number;
  netPnlPct: number;
  totalFeeUsd: number;
  ageHours: number;
  /** Divergence vs holding at this price. Diagnostic only, never part of PnL. */
  divergenceVsHoldUsd: number;
} {
  const notionalUsd = positionNotionalUsd(row);
  /*
   * Capped on purpose. After downtime this gap is however long the engine was off, and
   * crediting all of it would book fees for a period nothing observed, justified by one
   * instantaneous in-range check. Unobserved time is not evidence of earning.
   */
  const observedGapHours = hoursBetween(row.last_checked_at ?? row.opened_at, now);
  const intervalHours = Math.min(observedGapHours, env.MAX_FEE_ACCRUAL_GAP_HOURS);

  if (observedGapHours > env.MAX_FEE_ACCRUAL_GAP_HOURS) {
    console.warn(
      `[dlmm] ${row.pair_name}: ${observedGapHours.toFixed(1)}h since the last check — ` +
        `accruing fees for ${intervalHours}h only (engine was not watching the rest)`,
    );
  }
  const wasInRange = !isOutOfRange(currentPrice, row.lower_bin_price, row.upper_bin_price);

  // Accrue this interval's fees on top of the running total already stored.
  const accruedThisTick = estimateFeeYieldUsd(notionalUsd, feeTvlRatio24h, intervalHours, wasInRange);
  const totalFeeUsd = (row.unclaimed_fee_usd ?? 0) + accruedThisTick;

  const valuation = valuePosition({
    positionValueUsd: notionalUsd,
    entryPrice: row.entry_price,
    currentPrice,
    lowerBinPrice: row.lower_bin_price,
    upperBinPrice: row.upper_bin_price,
    accruedFeeUsd: totalFeeUsd,
  });

  return {
    netPnlUsd: valuation.netPnlUsd,
    netPnlPct: valuation.netPnlPct,
    totalFeeUsd,
    ageHours: hoursBetween(row.opened_at, now),
    divergenceVsHoldUsd: valuation.divergenceVsHoldUsd,
  };
}

/**
 * Consecutive ticks each position has gone without a usable price.
 *
 * Exists purely to keep the log readable at a 60-second cadence: an unreachable pool
 * would otherwise write the same warning 1440 times a day. Pruned to the live position
 * set on every pass, so it cannot grow — a stale entry for a position that closed weeks
 * ago is exactly the kind of slow leak a long-running VPS process dies of.
 */
const staleStreaks = new Map<string, number>();

/** Log the first stale tick, then hourly, then once on recovery. Nothing in between. */
function reportStale(positionId: string, pairName: string, poolAddress: string): void {
  const streak = (staleStreaks.get(positionId) ?? 0) + 1;
  staleStreaks.set(positionId, streak);

  if (streak === 1 || streak % 60 === 0) {
    console.warn(
      `[dlmm] no live data for ${pairName} (${poolAddress}) — ` +
        `${streak} consecutive tick${streak === 1 ? "" : "s"} skipped`,
    );
  }
}

function reportRecovered(positionId: string, pairName: string): void {
  const streak = staleStreaks.get(positionId);
  if (streak !== undefined && streak > 0) {
    console.log(`[dlmm] live data recovered for ${pairName} after ${streak} skipped tick(s)`);
  }
  staleStreaks.set(positionId, 0);
}

/**
 * One valuation pass over every open position.
 *
 * Prices are fetched for the whole set up front rather than per position inside the
 * loop: at MAX_CONCURRENT_POSITIONS = 3 that turns three serial round trips into one,
 * which is what makes a 60-second cadence affordable. It also means every position in
 * a pass is marked against prices read at the same instant, so two positions on the
 * same pool cannot disagree about the price within one tick.
 *
 * Callers must hold `positionMutex`.
 */
async function monitorOpenPositions(): Promise<{
  summary: MonitorSummary;
  deferred: DeferredCloseWork[];
}> {
  const positions = getActivePositions();
  const summary: MonitorSummary = { checked: 0, closed: 0, stale: 0, reflected: 0 };
  const deferred: DeferredCloseWork[] = [];
  if (positions.length === 0) return { summary, deferred };

  const pools = await fetchPoolsByAddresses(positions.map((p) => p.pool_address));
  const now = new Date();

  // Drop streak entries for positions that are no longer open, so the map stays bounded
  // by MAX_CONCURRENT_POSITIONS rather than by uptime.
  const live = new Set(positions.map((p) => p.position_id));
  for (const id of staleStreaks.keys()) {
    if (!live.has(id)) staleStreaks.delete(id);
  }

  for (const row of positions) {
    summary.checked++;

    const pool = pools.get(row.pool_address);
    if (!pool || !(pool.currentPrice > 0)) {
      // Leave the position untouched rather than marking it against a stale price.
      summary.stale++;
      reportStale(row.position_id, row.pair_name, row.pool_address);
      continue;
    }

    reportRecovered(row.position_id, row.pair_name);

    const totals = valuateAtPrice(row, pool.currentPrice, pool.feeTvlRatio24h, now);
    const exit = evaluateExit({
      netPnlPct: totals.netPnlPct,
      inRange: !isOutOfRange(pool.currentPrice, row.lower_bin_price, row.upper_bin_price),
      ageHours: totals.ageHours,
    });

    if (!exit.shouldClose) {
      updatePositionMetrics({
        positionId: row.position_id,
        currentPrice: pool.currentPrice,
        unclaimedFeeUsd: totals.totalFeeUsd,
        impermanentLossUsd: totals.divergenceVsHoldUsd,
        positionValueChangeUsd: totals.netPnlUsd - totals.totalFeeUsd,
        floatingPnlUsd: totals.netPnlUsd,
      });
      continue;
    }

    closePosition({
      positionId: row.position_id,
      status: exit.status,
      exitPrice: pool.currentPrice,
      realizedPnlUsd: totals.netPnlUsd,
      realizedPnlPct: totals.netPnlPct,
      unclaimedFeeUsd: totals.totalFeeUsd,
      impermanentLossUsd: totals.divergenceVsHoldUsd,
      positionValueChangeUsd: totals.netPnlUsd - totals.totalFeeUsd,
      closeReason: exit.reason,
    });
    summary.closed++;

    console.log(
      `[dlmm] closed ${row.pair_name} — ${exit.status} — ` +
        `net $${totals.netPnlUsd.toFixed(2)} (${totals.netPnlPct.toFixed(2)}%)`,
    );

    /*
     * Surface the circuit breaker at the moment it trips rather than only when the
     * screener later refuses the pool. Read back from the database so the run counts
     * the close that was just persisted.
     */
    const cooldown = defaultCooldownThresholds();
    if (cooldown.lockoutConsecutiveFailures > 0 && cooldown.lockoutHours > 0) {
      const exits = getPoolExitRecord(row.pool_address);
      if (exits.consecutiveFailures >= cooldown.lockoutConsecutiveFailures) {
        console.warn(
          `[cooldown] ${row.pair_name} locked out for ${cooldown.lockoutHours}h — ` +
            `${exits.consecutiveFailures} consecutive failed exits`,
        );
      }
    }

    // Queued, not awaited — see DeferredCloseWork. Both are network calls and the
    // position lock is still held here.
    deferred.push({
      positionId: row.position_id,
      notify: {
        pairName: row.pair_name,
        status: exit.status,
        reason: exit.reason,
        entryPrice: row.entry_price,
        exitPrice: pool.currentPrice,
        feeUsd: totals.totalFeeUsd,
        ilUsd: totals.netPnlUsd - totals.totalFeeUsd,
        netPnlUsd: totals.netPnlUsd,
        netPnlPct: totals.netPnlPct,
        heldHours: totals.ageHours,
      },
    });
  }

  return { summary, deferred };
}

/**
 * Runs the notification and post-mortem for closes from a finished pass.
 *
 * Must be called with `positionMutex` RELEASED. Failures are logged and swallowed: the
 * position is already closed and persisted, so a Telegram outage or a DeepSeek timeout
 * must not surface as a monitoring failure. `runPostMortemSweep` retries any reflection
 * that does not land here.
 */
async function settleClosedPositions(deferred: DeferredCloseWork[]): Promise<number> {
  let reflected = 0;

  for (const item of deferred) {
    try {
      await sendPositionClosed(item.notify);
    } catch (err) {
      console.error("[dlmm] close notification failed:", err);
    }

    try {
      // Re-read so the analysis sees the persisted close values, not pre-close state.
      const closedRow = getPositionById(item.positionId);
      if (closedRow) {
        const text = await reflectOnPosition(closedRow);
        if (text) reflected++;
      }
    } catch (err) {
      console.error("[dlmm] post-mortem failed (the sweep will retry):", err);
    }
  }

  return reflected;
}

export interface FastMonitorResult extends MonitorSummary {
  /** False when the tick gave up because a screener or /close_all held the lock. */
  ran: boolean;
}

/**
 * The 1-minute position monitor.
 *
 * Exists because exit thresholds were being blown straight through. On a 10-minute
 * cadence the 27-trade dry run fired its stop-loss at a median -9.79% and a worst
 * -13.84% against a -8% threshold: price crossed the level and kept going while the
 * engine was between ticks. Nothing was wrong with `evaluateExit`; it simply was not
 * asked often enough. Checking every 60 seconds bounds that overshoot to whatever the
 * pool moves in a minute.
 *
 * It carries no screening, no LLM call and no macro data — only the positions already
 * open, so it stays cheap enough to run every minute while the heavy 600-pool scan and
 * its rate-limited upstreams stay on the 30-minute screener clock.
 *
 * A tick that cannot take the lock returns `ran: false` and does nothing. That is not
 * a missed check: the holder is the screener's own monitor pass or /close_all, both of
 * which value the same positions against fresher prices than this tick would have.
 */
export async function runFastPositionMonitor(): Promise<FastMonitorResult> {
  const idle: FastMonitorResult = { ran: false, checked: 0, closed: 0, stale: 0, reflected: 0 };

  // Cheap pre-check: no open positions means no reason to take the lock at all.
  if (countActivePositions() === 0) return idle;

  const outcome = await positionMutex.tryRun(async () => {
    try {
      return await monitorOpenPositions();
    } catch (err) {
      // A fast tick must never take the process down; the next one is 60s away.
      console.error("[fast-monitor] pass failed:", err);
      return null;
    }
  });

  if (!outcome.ran || outcome.value === null) return idle;

  const { summary, deferred } = outcome.value;

  // Outside the lock by design: these are network calls, and the next tick is 60s away.
  summary.reflected = await settleClosedPositions(deferred);

  /*
   * Only a close is worth a line. This runs 1440 times a day: logging every tick, or
   * every tick with a stale position, is how a VPS log file becomes unreadable. The
   * staleness itself is already reported by reportStale, throttled to once an hour.
   */
  if (summary.closed > 0) {
    console.log(
      `[fast-monitor] checked ${summary.checked}, closed ${summary.closed}, stale ${summary.stale}`,
    );
  }
  return { ran: true, ...summary };
}

/* ------------------------------------------------------------------ */
/* Stage: emergency manual close (Telegram /close_all)                 */
/* ------------------------------------------------------------------ */

export interface ManualCloseResult {
  requested: number;
  closed: number;
  /** Positions that could not be closed at all (no live data AND no stored price). */
  failed: Array<{ pairName: string; positionId: string; reason: string }>;
  /**
   * Positions valued at their last stored price because live pool data was
   * unavailable. The price is a real measurement, just older — flagged so nobody
   * mistakes it for a live mark.
   */
  stalePriced: string[];
  totalNetPnlUsd: number;
}

export type ManualClosePoolSource = (
  poolAddress: string,
) => Promise<Pick<DlmmPool, "currentPrice" | "feeTvlRatio24h"> | null>;

/**
 * Emergency-close every active position (paper trading — no real funds).
 *
 * Values each position at the live pool price when available; falls back to the
 * last stored price (flagged) when the pool cannot be fetched. Only positions
 * with neither are left open and reported as failed.
 *
 * `fetchPool` and `reflect` are injectable so tests can run this without
 * network or DeepSeek access.
 */
export async function forceCloseAllPositions(options: {
  reason?: string;
  fetchPool?: ManualClosePoolSource;
  reflect?: (row: SimulatedPositionRow) => Promise<string | null>;
} = {}): Promise<ManualCloseResult> {
  /*
   * Queued on the position lock rather than skipped: an operator asking for a flat book
   * must not lose the race to a monitor tick that happened to start first. Waiting also
   * guarantees the active list read below is not one a concurrent pass is mid-way
   * through closing.
   */
  return positionMutex.run(() => closeAllPositionsLocked(options));
}

async function closeAllPositionsLocked(options: {
  reason?: string;
  fetchPool?: ManualClosePoolSource;
  reflect?: (row: SimulatedPositionRow) => Promise<string | null>;
}): Promise<ManualCloseResult> {
  const reason = options.reason ?? "Emergency manual close via Telegram /close_all";
  const fetchPool = options.fetchPool ?? fetchPoolByAddress;
  const reflect = options.reflect ?? reflectOnPosition;

  const active = getActivePositions();
  const result: ManualCloseResult = {
    requested: active.length,
    closed: 0,
    failed: [],
    stalePriced: [],
    totalNetPnlUsd: 0,
  };

  for (const row of active) {
    const pool = await fetchPool(row.pool_address);

    if (pool && pool.currentPrice > 0) {
      const totals = valuateAtPrice(row, pool.currentPrice, pool.feeTvlRatio24h);
      closePosition({
        positionId: row.position_id,
        status: POSITION_STATUS.CLOSED_MANUAL,
        exitPrice: pool.currentPrice,
        realizedPnlUsd: totals.netPnlUsd,
        realizedPnlPct: totals.netPnlPct,
        unclaimedFeeUsd: totals.totalFeeUsd,
        impermanentLossUsd: totals.divergenceVsHoldUsd,
        positionValueChangeUsd: totals.netPnlUsd - totals.totalFeeUsd,
        closeReason: reason,
      });
      result.closed++;
      result.totalNetPnlUsd += totals.netPnlUsd;

      console.log(
        `[dlmm] manual close ${row.pair_name} @ ${pool.currentPrice} — ` +
          `net $${totals.netPnlUsd.toFixed(2)} (${totals.netPnlPct.toFixed(2)}%)`,
      );

      await sendPositionClosed({
        pairName: row.pair_name,
        status: POSITION_STATUS.CLOSED_MANUAL,
        reason,
        entryPrice: row.entry_price,
        exitPrice: pool.currentPrice,
        feeUsd: totals.totalFeeUsd,
        ilUsd: totals.netPnlUsd - totals.totalFeeUsd,
        netPnlUsd: totals.netPnlUsd,
        netPnlPct: totals.netPnlPct,
        heldHours: totals.ageHours,
      });

      // Same reflection behaviour as a normal close; failures are retried later
      // by the post-mortem sweep, so one bad reflection must not abort the loop.
      const closedRow = getPositionById(row.position_id);
      if (closedRow) {
        try {
          await reflect(closedRow);
        } catch (err) {
          console.warn(
            `[dlmm] manual-close reflection failed for ${row.pair_name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      continue;
    }

    // Emergency fallback: close at the last stored price rather than leave the
    // position hanging. No new fees are accrued (feeTvlRatio24h = 0); the stored
    // unclaimed total is already in unclaimed_fee_usd.
    if (row.current_price !== null && row.current_price > 0) {
      const totals = valuateAtPrice(row, row.current_price, 0);
      closePosition({
        positionId: row.position_id,
        status: POSITION_STATUS.CLOSED_MANUAL,
        exitPrice: row.current_price,
        realizedPnlUsd: totals.netPnlUsd,
        realizedPnlPct: totals.netPnlPct,
        unclaimedFeeUsd: totals.totalFeeUsd,
        impermanentLossUsd: totals.divergenceVsHoldUsd,
        positionValueChangeUsd: totals.netPnlUsd - totals.totalFeeUsd,
        closeReason: `${reason} (stale price: live pool data unavailable)`,
      });
      result.closed++;
      result.stalePriced.push(row.pair_name);
      result.totalNetPnlUsd += totals.netPnlUsd;

      console.warn(
        `[dlmm] manual close ${row.pair_name} at STALE price ${row.current_price} ` +
          `(live data unavailable); net $${totals.netPnlUsd.toFixed(2)}`,
      );

      await sendPositionClosed({
        pairName: row.pair_name,
        status: POSITION_STATUS.CLOSED_MANUAL,
        reason: `${reason} (stale price — live pool data unavailable)`,
        entryPrice: row.entry_price,
        exitPrice: row.current_price,
        feeUsd: totals.totalFeeUsd,
        ilUsd: totals.netPnlUsd - totals.totalFeeUsd,
        netPnlUsd: totals.netPnlUsd,
        netPnlPct: totals.netPnlPct,
        heldHours: totals.ageHours,
      });
      continue;
    }

    result.failed.push({
      pairName: row.pair_name,
      positionId: row.position_id,
      reason: "no live pool data and no stored price",
    });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Stage: screen + decide + open                                       */
/* ------------------------------------------------------------------ */

export interface EntrySummary {
  scanned: number;
  candidates: number;
  /** Candidates remaining after the anti-rug screen. */
  safeCandidates: number;
  /** Candidates dropped because the pool is still serving a cooldown or a lockout. */
  cooldownRejected: Array<{
    pairName: string;
    poolAddress: string;
    kind: CooldownBlockKind;
    hoursRemaining: number;
    reason: string;
  }>;
  rugRejected: Array<{ pairName: string; verdict: string; reasons: string[] }>;
  /** Candidates dropped for having already pumped, or for an unknown 24h change. */
  volatilityRejected: Array<{
    pairName: string;
    priceChange24hPct: number | null;
    reason: string;
  }>;
  /** Candidates dropped because fees could not cover the cost of trading them. */
  breakevenRejected: Array<{
    pairName: string;
    coverageRatio: number;
    expectedFee24hUsd: number;
    roundTripCostUsd: number;
  }>;
  priorityFee: PriorityFeeEstimate | null;
  decision: DLMMPoolDecision | null;
  opened: boolean;
  skipReason?: string;
}

async function seekNewEntry(): Promise<EntrySummary> {
  const summary: EntrySummary = {
    scanned: 0,
    candidates: 0,
    safeCandidates: 0,
    cooldownRejected: [],
    rugRejected: [],
    volatilityRejected: [],
    breakevenRejected: [],
    priorityFee: null,
    decision: null,
    opened: false,
  };

  const activeCount = countActivePositions();
  if (activeCount >= env.MAX_CONCURRENT_POSITIONS) {
    summary.skipReason = `at capacity (${activeCount}/${env.MAX_CONCURRENT_POSITIONS} positions)`;
    return summary;
  }

  const pools = await fetchLivePools({ pageSize: 200, pages: 3 });
  const screened = screenPools(pools, defaultThresholds());
  summary.scanned = screened.scanned;

  // Never stack a second simulated position on a pool already held.
  const held = screened.candidates.filter((c) => !hasActivePositionForPool(c.address));

  /*
   * Anti-churn gate. Live paper trading re-opened CYBERLEEK-SOL within minutes of
   * closing it out of range, paying gas and forced-exit slippage on every lap: the
   * screener ranks on live metrics alone and so keeps re-electing the pool that just
   * failed. Two rules give it a memory — a 4h bench after any close, and a 24h
   * lockout after two consecutive losing or out-of-range exits.
   *
   * Placed before the anti-rug, volatility and breakeven gates because it is the only
   * one answered from local state: skipping a pool here saves several RPC and HTTP
   * round trips per candidate.
   */
  const cooldownFilter = filterPoolsOnCooldown(held, getPoolExitHistory());

  summary.cooldownRejected = cooldownFilter.blocked.map(({ pool, verdict }) => ({
    pairName: pool.pairName,
    poolAddress: pool.address,
    kind: verdict.kind ?? "cooldown",
    hoursRemaining: verdict.hoursRemaining,
    reason: verdict.reason,
  }));

  for (const r of summary.cooldownRejected) {
    console.warn(`[cooldown] skipped ${r.pairName} (${r.kind}): ${r.reason}`);
  }

  const fresh = cooldownFilter.allowed;
  summary.candidates = fresh.length;

  if (fresh.length === 0) {
    summary.skipReason =
      summary.cooldownRejected.length > 0 && held.length === summary.cooldownRejected.length
        ? `every candidate is on cooldown or locked out (${summary.cooldownRejected.length} pools)`
        : "no pool passed the quantitative filters";
    return summary;
  }

  // Screen a slightly wider slice than the LLM will see, so rejections still leave
  // enough survivors to fill the candidate list.
  const safetyScreen = await applyAntiRugScreen(fresh.slice(0, MAX_CANDIDATE_POOLS * 2));
  summary.rugRejected = safetyScreen.rejected;
  summary.safeCandidates = safetyScreen.passed.length;

  for (const r of safetyScreen.rejected) {
    console.warn(`[antirug] rejected ${r.pairName} (${r.verdict}): ${r.reasons.join("; ")}`);
  }

  if (safetyScreen.passed.length === 0) {
    summary.skipReason =
      safetyScreen.rejected.length > 0
        ? `all ${safetyScreen.rejected.length} candidates failed the anti-rug screen`
        : "no pool passed the anti-rug screen";
    return summary;
  }

  const top = safetyScreen.passed.slice(0, MAX_CANDIDATE_POOLS);

  if (!isDeepSeekAvailable()) {
    summary.skipReason = "DEEPSEEK_API_KEY not configured; entry decisions are disabled";
    return summary;
  }

  const solPriceUsd = await fetchSolPriceUsd();
  if (solPriceUsd === null) {
    // Without SOL/USD the position notional would be fabricated.
    summary.skipReason = "SOL/USD price unavailable; refusing to size a position";
    return summary;
  }

  const priorityFee = await getPriorityFeeEstimateSafe({
    solPriceUsd,
    lockedAccounts: top.map((t) => t.pool.address),
  });
  summary.priorityFee = priorityFee;

  /*
   * Volatility gate. A token that has already run hard is the worst moment to provide
   * liquidity: the retrace converts the position into the dumped asset. Rejected
   * BEFORE the LLM sees the candidate, so the model cannot talk itself into the top
   * of a pump.
   *
   * An unknown 24h change is rejected by default (VOLATILITY_ON_UNKNOWN), for the same
   * reason the anti-rug screen fails closed: treating "not measured" as "fine" is how
   * a filter turns into false confidence.
   */
  const priceChanges = await fetchPoolPriceChanges(top.map((t) => t.pool.address));
  const calm: typeof top = [];

  for (const entry of top) {
    const change = priceChanges.get(entry.pool.address);

    if (!change || change.h24 === null || change.h1 === null) {
      summary.volatilityRejected.push({
        pairName: entry.pool.pairName,
        priceChange24hPct: change?.h24 ?? null,
        reason: "1h/24h price change unavailable",
      });
      console.warn(`[volatility] rejected ${entry.pool.pairName}: price change unavailable`);
      continue;
    }

    entry.priceChange24hPct = change.h24;
    entry.priceChange1hPct = change.h1;

    // 1h surge: 6.8x lift in the big-loss rate above +10%.
    if (change.h1 > env.MAX_PRICE_SURGE_1H_PCT) {
      summary.volatilityRejected.push({
        pairName: entry.pool.pairName,
        priceChange24hPct: change.h24,
        reason: `1h surge +${change.h1.toFixed(1)}% (limit ${env.MAX_PRICE_SURGE_1H_PCT}%)`,
      });
      console.warn(
        `[volatility] rejected ${entry.pool.pairName}: 1h +${change.h1.toFixed(1)}%`,
      );
      continue;
    }

    // 24h pump: 6.9x lift above +150%.
    if (change.h24 > env.MAX_PRICE_CHANGE_24H_PCT) {
      summary.volatilityRejected.push({
        pairName: entry.pool.pairName,
        priceChange24hPct: change.h24,
        reason: `pumped ${change.h24.toFixed(1)}% in 24h (limit ${env.MAX_PRICE_CHANGE_24H_PCT}%)`,
      });
      console.warn(
        `[volatility] rejected ${entry.pool.pairName}: 24h +${change.h24.toFixed(1)}%`,
      );
      continue;
    }

    /*
     * Realized volatility: 5.8x lift above 10%/h, and the >=20%/h bucket averaged
     * -5.99% net with a 59% big-loss rate. One extra request per shortlisted pool,
     * which is why this runs last — after the cheap gates have already thinned the set.
     */
    const rvol = await fetchRealizedVolatilityPctPerHour(entry.pool.address);

    if (rvol === null) {
      summary.volatilityRejected.push({
        pairName: entry.pool.pairName,
        priceChange24hPct: change.h24,
        reason: "realized volatility unavailable",
      });
      console.warn(`[volatility] rejected ${entry.pool.pairName}: realized vol unavailable`);
      continue;
    }

    entry.realizedVolPctPerHour = rvol;

    if (rvol > env.MAX_REALIZED_VOL_PCT_PER_HOUR) {
      summary.volatilityRejected.push({
        pairName: entry.pool.pairName,
        priceChange24hPct: change.h24,
        reason: `realized vol ${rvol.toFixed(1)}%/h (limit ${env.MAX_REALIZED_VOL_PCT_PER_HOUR}%/h)`,
      });
      console.warn(
        `[volatility] rejected ${entry.pool.pairName}: rvol ${rvol.toFixed(1)}%/h`,
      );
      continue;
    }

    calm.push(entry);
  }

  if (calm.length === 0) {
    summary.skipReason = `all candidates failed the volatility gates (${summary.volatilityRejected.length} rejected)`;
    return summary;
  }

  top.length = 0;
  top.push(...calm);

  /*
   * Friction gate. Drop any candidate whose plausible 24h fee income cannot clear
   * MIN_FEE_COST_COVERAGE times the round-trip cost of trading it.
   *
   * When the gas estimate is unavailable, fall back to a conservative assumption
   * rather than treating the trip as free — assuming zero cost is what let the
   * strategy churn itself into a loss in the first place.
   */
  const notionalUsd = env.VIRTUAL_SOL_PER_POSITION * solPriceUsd;
  const gasRoundTripUsd =
    priorityFee?.totalUsd !== null && priorityFee?.totalUsd !== undefined
      ? priorityFee.totalUsd * 2
      : 0.0035 * 2 * solPriceUsd;

  const affordable: typeof top = [];
  for (const entry of top) {
    const breakeven = assessBreakeven({
      notionalUsd,
      feeTvlRatio24h: entry.pool.feeTvlRatio24h,
      gasCostRoundTripUsd: gasRoundTripUsd,
      slippagePct: env.FORCED_EXIT_SLIPPAGE_PCT,
      minCoverageRatio: env.MIN_FEE_COST_COVERAGE,
    });

    entry.breakeven = breakeven;

    if (breakeven.passes) {
      affordable.push(entry);
    } else {
      summary.breakevenRejected.push({
        pairName: entry.pool.pairName,
        coverageRatio: breakeven.coverageRatio,
        expectedFee24hUsd: breakeven.expectedFee24hUsd,
        roundTripCostUsd: breakeven.roundTripCostUsd,
      });
      console.warn(
        `[friction] rejected ${entry.pool.pairName}: 24h fee $${breakeven.expectedFee24hUsd.toFixed(4)} ` +
          `covers round-trip cost $${breakeven.roundTripCostUsd.toFixed(4)} only ` +
          `${breakeven.coverageRatio.toFixed(2)}x (need ${env.MIN_FEE_COST_COVERAGE}x)`,
      );
    }
  }

  if (affordable.length === 0) {
    summary.skipReason =
      `no candidate clears the breakeven gate ` +
      `(${env.MIN_FEE_COST_COVERAGE}x round-trip cost over 24h of fees)`;
    return summary;
  }

  top.length = 0;
  top.push(...affordable);

  /*
   * A reasoner that burns its whole budget on chain-of-thought and returns nothing is
   * an expected outcome, not a fault: there is no decision to act on, and no amount of
   * retrying inside one tick produces one. Skip the cycle and let the next screener
   * tick try again — open positions are unaffected, the fast monitor still marks and
   * exits them on its own clock. Only the truncation is swallowed; any other DeepSeek
   * failure still propagates, because it means something is genuinely wrong.
   */
  let decision: DLMMPoolDecision;
  try {
    decision = await structuredCompletion({
      system: STRATEGY_SYSTEM_PROMPT,
      user: buildCandidatePrompt(
        top.map((t) => t.pool),
        solPriceUsd,
        priorityFee,
        /*
         * In-context learning: the last few losing closes, so the model sizes this range
         * against how its recent ranges actually behaved instead of judging every
         * candidate from a blank slate.
         */
        getRecentFailurePostMortems(env.LOSS_CONTEXT_TRADES),
      ),
      schema: DLMMPoolDecisionSchema,
      reasoning: true,
    });
  } catch (err) {
    if (!(err instanceof DeepSeekTruncatedError)) throw err;
    summary.skipReason = "DeepSeek CoT truncated, skipping cycle";
    console.warn(`[dlmm] DeepSeek CoT truncated, skipping cycle: ${err.message}`);
    return summary;
  }
  summary.decision = decision;

  if (decision.action !== "ENTER" || decision.selectedPool === "NONE") {
    summary.skipReason = `model declined: ${decision.thesis}`;
    return summary;
  }

  const chosenEntry = top.find((c) => c.pool.address === decision.selectedPool);
  const chosen = chosenEntry?.pool;
  if (!chosen) {
    summary.skipReason = `model returned an unknown pool address (${decision.selectedPool})`;
    console.warn(`[dlmm] ${summary.skipReason}`);
    return summary;
  }

  const range = computeBinRange(
    chosen.currentPrice,
    decision.binRangeDownsideCoverPct,
    decision.binRangeUpsideCoverPct,
  );
  const { lower, upper } = range;

  if (range.widened) {
    console.log(
      `[friction] widened bin range to -${range.downsidePct}%/+${range.upsidePct}% ` +
        `(model asked for -${decision.binRangeDownsideCoverPct}%/+${decision.binRangeUpsideCoverPct}%) ` +
        `to cut churn`,
    );
  }

  if (!(lower > 0) || !(upper > lower)) {
    summary.skipReason = `invalid bin range computed (${lower} .. ${upper})`;
    console.warn(`[dlmm] ${summary.skipReason}`);
    return summary;
  }

  const positionId = randomUUID();
  const roundTripGasUsd =
    priorityFee && priorityFee.totalUsd !== null ? priorityFee.totalUsd * 2 : null;

  /*
   * The one write this function makes, taken under the shared lock so the invariant
   * stays simple and auditable: every mutation of simulated_positions happens with
   * positionMutex held. The capacity re-check inside is not redundant — minutes of LLM
   * and RPC latency separate the check at the top of this function from this write.
   */
  const openedUnderLock = await positionMutex.run(async () => {
    const live = countActivePositions();
    if (live >= env.MAX_CONCURRENT_POSITIONS) {
      return false;
    }

    insertPosition({
      positionId,
      poolAddress: chosen.address,
      pairName: chosen.pairName,
      strategyType: decision.strategy,
      entryPrice: chosen.currentPrice,
      lowerBinPrice: lower,
      upperBinPrice: upper,
      virtualSolAmount: env.VIRTUAL_SOL_PER_POSITION,
      entryTvl: chosen.tvlUsd,
      entry24hVolume: chosen.volume24hUsd,
      confidenceScore: decision.confidenceScore,
      reasoningLog: decision.thesis,
      entrySolPriceUsd: solPriceUsd,
      top10HolderPct: chosenEntry?.safety?.top10Pct ?? null,
      mintAuthorityRevoked: chosenEntry?.safety?.mintAuthorityRevoked ?? null,
      freezeAuthorityRevoked: chosenEntry?.safety?.freezeAuthorityRevoked ?? null,
      safetyVerdict: chosenEntry?.safety?.verdict ?? "SKIPPED",
      // A round trip is two transactions: open the position, then close it. Stays null
      // when the estimate is unavailable — recording 0 would assert the trip was free.
      estGasCostUsd: roundTripGasUsd,
      estPriorityMicroLamports: priorityFee?.microLamportsPerCu ?? null,
      breakevenCoverageRatio: chosenEntry?.breakeven?.coverageRatio ?? null,
      expectedFee24hUsd: chosenEntry?.breakeven?.expectedFee24hUsd ?? null,
    });
    return true;
  });

  if (!openedUnderLock) {
    summary.skipReason = `filled to capacity (${env.MAX_CONCURRENT_POSITIONS}) while deciding`;
    console.warn(`[dlmm] ${summary.skipReason}`);
    return summary;
  }

  summary.opened = true;

  console.log(
    `[dlmm] opened ${chosen.pairName} @ ${chosen.currentPrice} ` +
      `range [${lower.toPrecision(6)}, ${upper.toPrecision(6)}] ` +
      `conf=${decision.confidenceScore}`,
  );

  await sendPositionOpened({
    pairName: chosen.pairName,
    poolAddress: chosen.address,
    strategy: decision.strategy,
    entryPrice: chosen.currentPrice,
    lowerBinPrice: lower,
    upperBinPrice: upper,
    confidence: decision.confidenceScore,
    thesis: decision.thesis,
    virtualSol: env.VIRTUAL_SOL_PER_POSITION,
  });

  return summary;
}

/* ------------------------------------------------------------------ */
/* Cycle entrypoint                                                    */
/* ------------------------------------------------------------------ */

export interface CycleResult {
  monitor: MonitorSummary;
  entry: EntrySummary;
  /** Post-mortems backfilled for closed positions that were missing one. */
  postMortemsBackfilled: number;
}

export interface CycleOptions {
  /**
   * Skip the monitor stage and only look for a new entry.
   *
   * Set by the screener's scheduler, because the 1-minute fast monitor owns position
   * marking there and a second pass 30 minutes apart adds nothing. Left false for
   * `npm run dlmm:once`, the smoke test and any manual trigger, where "one cycle" is
   * expected to mean screen AND monitor.
   */
  skipMonitor?: boolean;
}

/**
 * One full paper-trading cycle: mark open positions, then look for a new entry.
 * Runs every 30 minutes via cron; also exported for manual triggering.
 */
export async function runDlmmTradingCycle(
  options: CycleOptions = {},
): Promise<CycleResult | null> {
  // Belt-and-braces: env.ts already refuses to boot unless DRY_RUN is true.
  if (!env.DRY_RUN) {
    throw new Error("[dlmm] refusing to run: DRY_RUN is false and live execution is unimplemented.");
  }

  console.log("[dlmm] cycle start");

  try {
    /*
     * Under the shared lock, and queued rather than skipped: unlike a fast tick, this
     * pass is the only monitoring a manual `dlmm:once` run will ever get.
     */
    let monitor: MonitorSummary = { checked: 0, closed: 0, stale: 0, reflected: 0 };
    if (!options.skipMonitor) {
      const pass = await positionMutex.run(monitorOpenPositions);
      monitor = pass.summary;
      // Same rule as the fast monitor: notify and reflect with the lock released.
      monitor.reflected = await settleClosedPositions(pass.deferred);
    }

    // /pause stops scanning for new entries but keeps monitoring open positions,
    // so existing ones still accrue, exit and reflect normally.
    const entry = isEnginePaused()
      ? {
          scanned: 0,
          candidates: 0,
          safeCandidates: 0,
          cooldownRejected: [],
          rugRejected: [],
          volatilityRejected: [],
          breakevenRejected: [],
          priorityFee: null,
          decision: null,
          opened: false,
          skipReason: "engine paused via Telegram /pause — scanning disabled",
        }
      : await seekNewEntry();

    // Retry any reflection that failed on an earlier cycle.
    const postMortemsBackfilled = await runPostMortemSweep();

    console.log(
      `[dlmm] cycle done — checked ${monitor.checked}, closed ${monitor.closed}, ` +
        `stale ${monitor.stale}, candidates ${entry.candidates}, ` +
        `cooldown-rejected ${entry.cooldownRejected.length}, ` +
        `safe ${entry.safeCandidates}, rug-rejected ${entry.rugRejected.length}, ` +
        `vol-rejected ${entry.volatilityRejected.length}, ` +
        `cost-rejected ${entry.breakevenRejected.length}, ` +
        `opened ${entry.opened ? "yes" : `no (${entry.skipReason ?? "n/a"})`}`,
    );

    return { monitor, entry, postMortemsBackfilled };
  } catch (err) {
    console.error("[dlmm] cycle failed:", err);
    await sendError("runDlmmTradingCycle", err);
    return null;
  }
}
