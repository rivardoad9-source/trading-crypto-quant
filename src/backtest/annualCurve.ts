/**
 * Daily equity curve construction for the annual backtest.
 *
 * Pure functions over a finished trade list, so they are unit-testable without a
 * network, a database, or a simulation run.
 *
 * The curve is REALISED-ONLY: equity steps on a trade's exit, never on open floating
 * PnL. That mirrors `computeMaxDrawdown` in `src/services/metrics.ts`, which the
 * dashboard and every existing report already use, and it keeps the curve
 * reproducible from the trade log alone. The cost is that a day with no close reads
 * 0.00%, which deflates daily volatility and therefore flatters any daily-sampled
 * ratio (Sharpe, Sortino). `activeDays` is reported so that distortion is visible
 * rather than hidden.
 */

/** One calendar day of the realised equity curve. UTC dates throughout. */
export interface DailyPoint {
  /** YYYY-MM-DD, UTC. */
  date: string;
  /** Realised equity at the END of this day. */
  equityUsd: number;
  /** Simple return against the previous day's closing equity. */
  dailyReturn: number;
  /** Realised PnL booked on this day. */
  realizedPnlUsd: number;
  /** How many positions closed on this day. */
  closes: number;
}

/** A trade, reduced to what the curve needs. */
export interface CurveTrade {
  exitTime: string;
  netPnlUsd: number;
}

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const DAY_MS = 86_400_000;

/**
 * Expands a trade list into one row per calendar day between `windowStart` and
 * `windowEnd` inclusive.
 *
 * Every day in the window is emitted, including days with no activity — a returns
 * series with holes would make monthly aggregation and drawdown-duration counts
 * silently wrong.
 */
export function buildDailyCurve(
  trades: CurveTrade[],
  startingEquityUsd: number,
  windowStartMs: number,
  windowEndMs: number,
): DailyPoint[] {
  const booked = new Map<string, { pnl: number; closes: number }>();

  for (const trade of trades) {
    const ms = Date.parse(trade.exitTime);
    if (!Number.isFinite(ms)) continue;
    const key = dayKey(ms);
    const row = booked.get(key) ?? { pnl: 0, closes: 0 };
    row.pnl += trade.netPnlUsd;
    row.closes += 1;
    booked.set(key, row);
  }

  const out: DailyPoint[] = [];
  let equity = startingEquityUsd;

  // Iterate on UTC midnights so a DST-shifting local clock cannot drop or duplicate a
  // day. Stored timestamps in this project are UTC; see the CLAUDE.md note on
  // parseDbTimestamp for what happens when that is assumed rather than enforced.
  const start = Date.UTC(
    new Date(windowStartMs).getUTCFullYear(),
    new Date(windowStartMs).getUTCMonth(),
    new Date(windowStartMs).getUTCDate(),
  );
  const end = Date.UTC(
    new Date(windowEndMs).getUTCFullYear(),
    new Date(windowEndMs).getUTCMonth(),
    new Date(windowEndMs).getUTCDate(),
  );

  for (let t = start; t <= end; t += DAY_MS) {
    const key = dayKey(t);
    const row = booked.get(key) ?? { pnl: 0, closes: 0 };
    const previousEquity = equity;
    equity += row.pnl;

    out.push({
      date: key,
      equityUsd: equity,
      // A wiped-out account has no meaningful percentage return; report 0 rather than
      // a division by zero that would surface as NaN or Infinity in the tear sheet.
      dailyReturn: previousEquity > 0 ? row.pnl / previousEquity : 0,
      realizedPnlUsd: row.pnl,
      closes: row.closes,
    });
  }

  return out;
}

/** Days on which at least one position closed. */
export const activeDays = (curve: DailyPoint[]): number =>
  curve.filter((d) => d.closes > 0).length;

/** RFC 4180-ish CSV, with the header row Python expects. */
export function curveToCsv(curve: DailyPoint[]): string {
  const lines = ["date,equity_usd,daily_return,realized_pnl_usd,closes"];
  for (const d of curve) {
    lines.push(
      [
        d.date,
        d.equityUsd.toFixed(6),
        d.dailyReturn.toFixed(10),
        d.realizedPnlUsd.toFixed(6),
        String(d.closes),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
