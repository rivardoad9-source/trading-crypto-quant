/**
 * When the heavy screener cycle is allowed to run.
 *
 * THE PROBLEM. `CRON.DLMM_TICK` fires every 5 minutes, but the screener is expensive: every
 * run that reaches it spends a deepseek-reasoner call plus the 600-pool scan. So the tick
 * is not the cadence — the cadence is a decision, and this module makes it in one place so
 * the rule can be unit-tested instead of being inferred from a cron expression.
 *
 * THE RULE, in full:
 *
 *   - Base cadence: a tick runs the screener only when its minute-of-hour is a multiple of
 *     `DLMM_BASE_CADENCE_MIN` (20), i.e. three times an hour — minutes 0, 20 and 40.
 *     Off-cadence ticks return here, before touching the network, the database or
 *     DeepSeek. Cost and behaviour outside a fast window are exactly what the 20-minute
 *     clock cost.
 *   - Fast window: after a macro-news blackout window CLOSES, for
 *     `DLMM_POST_NEWS_FAST_MIN` minutes, every tick runs the screener. Never DURING the
 *     window: entries are held there by `newsBlackout`, so running the screener more often
 *     could only burn tokens.
 *   - Live only. In paper mode there is no money to catch a re-pricing with, so the fast
 *     window is ignored and the cadence is byte-identical to the baseline. Same reasoning
 *     that keeps the news gate and the width filter behind `isLiveExecutionActive()`.
 *
 * WHY A WINDOW AND NOT JUST A FASTER CLOCK. See `DLMM_POST_NEWS_FAST_MIN`: the two hours
 * after a release are where a re-priced SOL and rewritten ranges actually pay, and there
 * are only a few events a week, so a bounded fast cadence costs reaction minutes while an
 * always-fast one would cost a permanent multiple of the engine's token bill.
 *
 * FAILS SAFE. Anything that goes wrong while reading the calendar (missing file, bad JSON,
 * stale calendar) means "no fast window" — the engine simply keeps its 20-minute cadence.
 * The opposite failure, inventing a fast window out of a broken file, would spend money on
 * tokens to react to an event that may not exist.
 */
import { readFileSync } from "node:fs";
import { env } from "../config/env.js";
import { CRON, DLMM_BASE_CADENCE_MIN, DLMM_POST_NEWS_FAST_MIN } from "../config/constants.js";
import {
  isCalendarStale,
  newsBlackoutPath,
  parseNewsBlackoutFile,
  type NewsBlackoutWindow,
} from "./newsBlackout.js";

/** What the tick callback needs to decide, with `now` already broken down. */
export interface ScreenerCadenceInput {
  /** The instant being decided about. Only used for the log line. */
  now: Date;
  /** Minute of the hour in the engine's zone (`env.TZ`), 0-59. */
  minutesOfHour: number;
  /** Whether live execution is armed. The fast window is live-only. */
  live: boolean;
  /** The blackout window that closed within the fast horizon, or null. */
  fastWindow: NewsBlackoutWindow | null;
  /** Overridable for tests; defaults to `DLMM_BASE_CADENCE_MIN`. */
  baseCadenceMin?: number;
}

export interface ScreenerCadenceDecision {
  /** Whether this tick should run the screener cycle. */
  run: boolean;
  /** True when it is running off the base cadence because of a post-news window. */
  fast: boolean;
  /** Operator-readable, and logged by the caller only when something interesting happened. */
  reason: string;
}

/**
 * Minute-of-hour in a named zone.
 *
 * The cron expression is evaluated in `env.TZ`, so "is this tick on a 20-minute mark" has to
 * be asked in that zone too. The box happens to run WIB today, but a cadence that silently
 * halves when the server's zone differs from `env.TZ` is exactly the class of bug
 * `timezone.ts` was written about, and it costs one `Intl` call to not have it.
 */
export function minutesOfHourInZone(now: Date, timeZone: string = env.TZ): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const value = Number(parts.find((p) => p.type === "minute")?.value);
  return Number.isFinite(value) ? value : now.getMinutes();
}

/**
 * The most recent blackout window that closed within the fast horizon, or null.
 *
 * Half-open like `activeWindowAt`: a window becomes "recently closed" at its END instant,
 * which is also the first instant entries are allowed again — so the fast cadence and the
 * reopened entry gate start on the same millisecond. The LATEST close wins when several
 * overlap, because the freshest release is the one whose reaction is still being priced.
 */
export function postNewsFastWindowAt(
  now: Date,
  windows: readonly NewsBlackoutWindow[],
  fastMinutes: number = DLMM_POST_NEWS_FAST_MIN,
): NewsBlackoutWindow | null {
  const t = now.getTime();
  const horizonMs = fastMinutes * 60_000;

  let best: NewsBlackoutWindow | null = null;
  for (const w of windows) {
    const end = w.end.getTime();
    if (t < end || t >= end + horizonMs) continue;
    if (best === null || end > best.end.getTime()) best = w;
  }
  return best;
}

/**
 * Reads the calendar and answers `postNewsFastWindowAt`. Never throws.
 *
 * Takes its clock and its path as parameters for the same reason `readNewsBlackout` does:
 * it is what lets the failure paths be exercised against a real filesystem, and `env.ts`
 * parses once at import so a test cannot reach this by setting a variable.
 */
export function readPostNewsFastWindow(
  now: Date = new Date(),
  file: string = newsBlackoutPath(),
  fastMinutes: number = DLMM_POST_NEWS_FAST_MIN,
): NewsBlackoutWindow | null {
  if (!env.NEWS_BLACKOUT_ENABLED) return null;

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const { calendar } = parseNewsBlackoutFile(raw);
  if (isCalendarStale(calendar, now)) return null;

  return postNewsFastWindowAt(now, calendar.windows, fastMinutes);
}

/** `42m` / `2h 05m` — short enough for a log line that repeats. */
function describeAge(since: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The tick interval `CRON.DLMM_TICK` implies (a 5-minute tick -> 5), or null when it
 * cannot be read.
 *
 * Interpolating the real value keeps the log line honest if the tick ever changes — the
 * first version of this line printed the fast-window LENGTH in both slots, which read as
 * "running every 90m for 90m", i.e. exactly the opposite of what happens.
 */
export function tickIntervalMinutes(expression: string = CRON.DLMM_TICK): number | null {
  const match = /^\*\/(\d+)\s/.exec(expression.trim());
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The decision itself. Pure: no clock, no filesystem, no env reads.
 *
 * `live` is why the fast window is passed in as a value rather than read here — in paper
 * mode the caller passes null and the cadence falls back to the baseline, which is the
 * behaviour a dry run is supposed to have (its cycle must stay byte-identical).
 */
export function decideScreenerRun(input: ScreenerCadenceInput): ScreenerCadenceDecision {
  const base = input.baseCadenceMin ?? DLMM_BASE_CADENCE_MIN;
  const fastWindow = input.live ? input.fastWindow : null;

  if (fastWindow !== null) {
    const age = describeAge(fastWindow.end, input.now);
    const tick = tickIntervalMinutes();
    const cadence = tick === null ? "every tick" : `every ${tick}m`;
    return {
      run: true,
      fast: true,
      reason:
        `[dlmm] post-news fast cadence: ${fastWindow.event} closed ${age} ago — ` +
        `ticking ${cadence} instead of ${base}m, for ${DLMM_POST_NEWS_FAST_MIN}m after the window`,
    };
  }

  if (input.minutesOfHour % base === 0) {
    return { run: true, fast: false, reason: `[dlmm] base cadence (${base}m)` };
  }

  /*
   * Silent by design: this is the common case (10 of every 12 ticks), and the caller does
   * not log it. A paper-mode fast window is called out in the reason string because it is
   * the one case where the calendar says "go fast" and the engine deliberately does not.
   */
  const paperNote =
    !input.live && input.fastWindow !== null
      ? " (post-news window present, but paper mode keeps the base cadence)"
      : "";

  return {
    run: false,
    fast: false,
    reason: `[dlmm] tick skipped: not a ${base}m mark${paperNote}`,
  };
}
