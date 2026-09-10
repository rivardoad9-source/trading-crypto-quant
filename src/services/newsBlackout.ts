import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config/env.js";

/**
 * The macro-news entry blackout: no NEW positions are opened in the minutes around a
 * scheduled US data release (CPI, PPI, NFP, FOMC).
 *
 * WHAT THIS IS NOT. It is not a risk gate and it prices nothing. Every existing
 * guardrail — friction, anti-rug, volatility, cooldown, the width cap — is untouched
 * and still decides whether a pool is worth entering. This asks a different question,
 * and only about TIMING: is the next few minutes a bad moment to be putting capital
 * into a range at all. A release moves SOL several bins in seconds, which is the same
 * drift `ActiveBinRaceError` refuses an entry over, arriving on a clock instead of out
 * of the pool's own realized volatility.
 *
 * IT DOES NOT TOUCH OPEN POSITIONS. Monitoring, fee accrual, stop-losses and closes run
 * exactly as they do outside a window. Blocking an EXIT during a release is the
 * opposite of prudent — the stop-loss is most needed precisely then. This is a pause on
 * ENTRIES, nothing else.
 *
 * WHERE THE CALENDAR COMES FROM. This module reads a file and never fetches: the
 * windows are written by a Hermes cron from the NewsAgent BLS/FOMC forward calendar
 * (release −60min → +45min), plus any ad-hoc windows an operator added by hand. Keeping
 * the fetch out of the engine is what stops a dead calendar service from stalling a
 * trading cycle, and it is why every failure below is a warning rather than a throw.
 *
 * FAILS OPEN, LOUDLY. The same rule as `assessPoolCooldown` and deliberately the
 * opposite of `screenTokenSafety`: this gate protects RETURNS, while the capital itself
 * is protected by the gates that fail closed. A missing file, malformed JSON, an
 * unreadable timestamp or a calendar whose cron has stopped refreshing all mean "trade
 * normally" — never "stop trading" — and every one of them warns. A gate that silently
 * freezes an unattended engine because a third-party cron died is a self-inflicted
 * outage; a gate that silently does nothing is the "all bin arrays exist" line again.
 * One rule avoids both: never throw, always say what happened.
 *
 * INERT IN PAPER MODE, by the caller. The read sits behind `isLiveExecutionActive()` in
 * `runDlmmTradingCycle`, mirroring where the `LIVE_MAX_POSITION_BINS` filter sits, so a
 * dry run does not so much as stat the file and its cycle is byte-identical to what it
 * was before this existed. `newsBlackout.test.ts` asserts that placement.
 */

/** How stale a calendar may be before it is ignored entirely. */
export const NEWS_BLACKOUT_MAX_AGE_HOURS = 48;

/**
 * The longest single window that will be honoured.
 *
 * THE STALENESS RULE DOES NOT COVER THIS, and the gap is the dangerous one. 48h only
 * helps when the cron STOPS writing; a cron that keeps running while emitting one bad
 * row — a mistyped year, an end date that never arrives — refreshes `generated_at`
 * every cycle and so stays permanently fresh, and the engine stops opening positions
 * for good while every status line still reads healthy. That is the self-inflicted
 * outage this module's own header warns about, reached from the one direction the
 * freshness check cannot see.
 *
 * 6h against a feed whose windows are 105 minutes: wide enough for an FOMC day or a
 * hand-added session an operator genuinely wants, far short of anything open-ended.
 * A window over it is dropped and warned about, exactly like an unparseable one.
 */
export const NEWS_BLACKOUT_MAX_WINDOW_HOURS = 6;

export interface NewsBlackoutWindow {
  /** The release this window brackets, e.g. "CPI". */
  event: string;
  /** Inclusive start. */
  start: Date;
  /** EXCLUSIVE end — see `activeWindowAt`. */
  end: Date;
  /**
   * Which calendar produced it: the NewsAgent feed, or an operator's ad-hoc file.
   * Recorded because "why did the engine skip that entry" has a different answer and a
   * different fix depending on which, and null when the file does not say.
   */
  source: string | null;
}

export interface NewsBlackoutCalendar {
  /**
   * When the cron last wrote the file. null means the file did not say, which is NOT
   * treated as stale — see `isCalendarStale`.
   */
  generatedAt: Date | null;
  windows: NewsBlackoutWindow[];
}

export interface NewsBlackoutReading {
  /** The window `now` falls inside, or null. Null always means "trade normally". */
  active: NewsBlackoutWindow | null;
  /**
   * Everything that went wrong, in operator-readable form. Returned rather than logged
   * so the caller decides: the trading cycle prints them once per cycle, while
   * `/api/overview` — which the dashboard polls once a minute per open tab — reads the
   * same file and stays silent rather than filling the log with one warning per poll.
   */
  warnings: string[];
  /** Whether the gate is switched on at all (`NEWS_BLACKOUT_ENABLED`). */
  enabled: boolean;
  /** The absolute path read, so a warning can name the file an operator has to fix. */
  path: string;
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

/**
 * `Thu 10 Sep 2026 20:15 WIB` — the operator's own wall clock, not UTC.
 *
 * The whole point of the line is that someone compares it against the clock on their
 * wall and decides whether to wait, so it renders in `env.TZ`. The abbreviation is
 * asked of `Intl` rather than hard-coded: `id-ID` is consulted first because it is the
 * locale that names the engine's default zone `WIB`, where `en-US` answers the far less
 * recognisable `GMT+7`, and for every other zone the two agree (`EDT`, `UTC`, `GMT+1`).
 * A zone `Intl` cannot abbreviate degrades to its GMT offset, never to a wrong label.
 */
export function formatZonedStamp(instant: Date, timeZone: string = env.TZ): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    // `hourCycle: "h23"` rather than `hour12: false`. They are not synonyms: en-US
    // defaults to an h12 cycle, and `hour12: false` has rendered midnight as "24:00"
    // on some ICU builds. Naming the cycle removes the ambiguity at the source instead
    // of patching the output afterwards, and no clock shows 24:00. (`hour12` would
    // take precedence over this if both were passed, so only this is passed.)
    hourCycle: "h23",
  }).formatToParts(instant);

  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";

  const zone =
    new Intl.DateTimeFormat("id-ID", { timeZone, timeZoneName: "short" })
      .formatToParts(instant)
      .find((p) => p.type === "timeZoneName")?.value ?? "";

  const stamp =
    `${pick("weekday")} ${pick("day")} ${pick("month")} ${pick("year")} ` +
    `${pick("hour")}:${pick("minute")}`;

  return zone ? `${stamp} ${zone}` : stamp;
}

/**
 * A hand-added window rather than one from the BLS/FOMC feed.
 *
 * Worth naming in the log because the two have different answers to "should this still
 * be here": a feed window expires with the release, an ad-hoc one expires when whoever
 * added it says so. Feed windows are the norm and are not tagged.
 */
const AD_HOC_SOURCE = /manual|ad[\s_-]?hoc|operator/i;

/**
 * The one line the cycle logs when a window is in force.
 *
 * The wording up to and including "(monitoring continues)" is FIXED — it is the string
 * the operator's tooling greps for, so an ad-hoc window's tag goes after it rather than
 * inside it. Changing the prefix to add a field is how a log contract quietly breaks.
 */
export function describeBlackoutWindow(
  window: NewsBlackoutWindow,
  timeZone: string = env.TZ,
): string {
  const tag =
    window.source && AD_HOC_SOURCE.test(window.source) ? ` [source: ${window.source}]` : "";

  return (
    `[news] blackout: ${window.event} until ${formatZonedStamp(window.end, timeZone)} — ` +
    `skipping new entries (monitoring continues)${tag}`
  );
}

/**
 * One line for the boot log, so a disabled, mis-pathed or already-active gate is
 * visible at start-up rather than inferred from an absence of trades.
 */
export function describeNewsBlackout(): string {
  if (!env.NEWS_BLACKOUT_ENABLED) {
    return "[news] entry blackout: DISABLED (NEWS_BLACKOUT_ENABLED=false)";
  }

  const reading = readNewsBlackout();

  // The path is appended only when a warning has not already named it. Some do (a
  // missing file) and some do not (a stale calendar), and printing it twice is noise
  // in the one line an operator is meant to read closely.
  if (reading.warnings.length > 0) {
    const joined = reading.warnings.join("; ");
    const where = joined.includes(reading.path) ? "" : `; calendar: ${reading.path}`;
    return `[news] entry blackout: NOT ENFORCED — ${joined}${where}`;
  }

  const state = reading.active
    ? `IN FORCE — ${reading.active.event} until ${formatZonedStamp(reading.active.end)}`
    : "armed, no window in force";

  return `[news] entry blackout: ${state}; calendar: ${reading.path}`;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** Absolute path of the calendar, resolved the way `DATABASE_PATH` is. */
export function newsBlackoutPath(): string {
  return resolve(process.cwd(), env.NEWS_BLACKOUT_FILE);
}

/**
 * An ISO 8601 instant, or null.
 *
 * A bare `YYYY-MM-DD HH:MM:SS` is read as UTC, matching `parseStoredUtc` and this
 * project's rule that a zone-less timestamp always means UTC. Getting that wrong by
 * seven hours on an Asia/Jakarta box is the defect `timezone.ts` was written for, and a
 * 105-minute blackout window is exactly the interval such a slip would miss entirely.
 */
function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;

  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const date = new Date(hasZone ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The first non-empty string among the given keys, made safe to render.
 *
 * `event` and `source` come from a file this repository does not write, and they reach
 * the Telegram `/status` reply. `markdownV2()` uses `**...**` to mark the bold spans it
 * must NOT escape, so a label containing `**` would open a bold span of its own inside
 * an otherwise-escaped message — the "can't parse entities" failure CLAUDE.md records,
 * arriving through data instead of through static text. Asterisks are stripped here, at
 * the boundary, so every consumer (log line, `/status`, `/api/overview`) is covered by
 * one rule rather than each remembering its own.
 *
 * Control characters go too: a newline in an event name would forge a line in the
 * status report.
 */
function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value !== "string") continue;

    const cleaned = value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\*/g, "")
      .trim();

    if (cleaned !== "") return cleaned.slice(0, 80);
  }
  return null;
}

/**
 * Parses the calendar file's text. Pure, so every branch below is unit-testable without
 * a filesystem — including the ones that only ever happen when the writer changes.
 *
 * TOLERANT ABOUT NAMES, STRICT ABOUT TIMES. `event` may also arrive as `name`, `label`
 * or `title`, and an absent one degrades to a generic caption, because a window whose
 * times are sound should not be discarded over what it is called. A window whose start
 * or end will not parse is DROPPED, and warned about individually: guessing at an
 * instant is how a gate ends up enforcing a period nobody scheduled. A start at or
 * after its end is dropped for the same reason — that is not an empty window, it is a
 * broken record, and the next field to be wrong might be the one that matters.
 */
export function parseNewsBlackoutFile(raw: string): {
  calendar: NewsBlackoutCalendar;
  warnings: string[];
  /**
   * Whether the file CARRIED a `generated_at`, regardless of whether it parsed.
   *
   * "the field is absent" and "the field is there and unreadable" are different faults
   * with different fixes, and both leave `generatedAt` null. Without this the reader
   * reported an unreadable timestamp as a missing one, contradicting the warning the
   * parser had already emitted about the same field.
   */
  sawGeneratedAtField: boolean;
} {
  const warnings: string[] = [];
  const empty: NewsBlackoutCalendar = { generatedAt: null, windows: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(`calendar is not valid JSON (${(err as Error).message})`);
    return { calendar: empty, warnings, sawGeneratedAtField: false };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push("calendar is not a JSON object");
    return { calendar: empty, warnings, sawGeneratedAtField: false };
  }

  const root = parsed as Record<string, unknown>;
  const rawGeneratedAt = root.generated_at ?? root.generatedAt;
  const sawGeneratedAtField = rawGeneratedAt !== undefined;
  const generatedAt = parseInstant(rawGeneratedAt);
  if (generatedAt === null && sawGeneratedAtField) {
    warnings.push("generated_at is present but unreadable; freshness cannot be checked");
  }

  const rows = root.windows;
  if (!Array.isArray(rows)) {
    warnings.push("calendar has no windows array");
    return { calendar: { generatedAt, windows: [] }, warnings, sawGeneratedAtField };
  }

  const windows: NewsBlackoutWindow[] = [];

  rows.forEach((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`window ${i} is not an object; ignored`);
      return;
    }

    const row = entry as Record<string, unknown>;
    const start = parseInstant(row.start_utc ?? row.startUtc);
    const end = parseInstant(row.end_utc ?? row.endUtc);
    const event = pickString(row, ["event", "name", "label", "title"]) ?? "scheduled release";

    if (start === null || end === null) {
      warnings.push(`window ${i} (${event}) has an unreadable start_utc/end_utc; ignored`);
      return;
    }
    if (start.getTime() >= end.getTime()) {
      warnings.push(`window ${i} (${event}) ends at or before it starts; ignored`);
      return;
    }

    const hours = (end.getTime() - start.getTime()) / 3_600_000;
    if (hours > NEWS_BLACKOUT_MAX_WINDOW_HOURS) {
      warnings.push(
        `window ${i} (${event}) spans ${hours.toFixed(1)}h, over the ` +
          `${NEWS_BLACKOUT_MAX_WINDOW_HOURS}h limit; ignored — a window this long is a ` +
          `bad row, and honouring it would hold entries indefinitely while the calendar ` +
          `kept reporting itself fresh`,
      );
      return;
    }

    windows.push({ event, start, end, source: pickString(row, ["source", "origin"]) });
  });

  return { calendar: { generatedAt, windows }, warnings, sawGeneratedAtField };
}

/**
 * Whether the calendar is too old to be believed.
 *
 * A cron that has stopped writing leaves a file whose FORWARD windows are missing, not
 * wrong — so the danger of an old calendar is under-blocking, which fails open by
 * itself. The 48h rule is for the other direction: a dead apparatus must not be able to
 * hold the engine out of the market on the strength of records nobody is maintaining.
 *
 * A calendar with NO `generated_at` is NOT stale. Its windows carry absolute instants
 * and each is under two hours long, so honouring them can delay an entry by minutes and
 * can never freeze trading — while ignoring them would silently switch the gate off
 * whenever the writer omitted one field. The unverifiable freshness is warned about
 * instead, every cycle, which is the loud half of failing open.
 */
export function isCalendarStale(
  calendar: NewsBlackoutCalendar,
  now: Date,
  maxAgeHours: number = NEWS_BLACKOUT_MAX_AGE_HOURS,
): boolean {
  if (calendar.generatedAt === null) return false;
  const ageHours = (now.getTime() - calendar.generatedAt.getTime()) / 3_600_000;
  return ageHours > maxAgeHours;
}

/**
 * The window containing `now`, or null.
 *
 * START INCLUSIVE, END EXCLUSIVE. Adjacent windows from the same feed share an instant
 * (13:15 ends one and begins the next), so a closed upper bound would place that
 * millisecond inside both — and, more importantly, the instant a window ENDS is the
 * first instant trading is allowed again. Half-open is the only reading under which
 * "until 20:15" means what an operator reads it to mean.
 *
 * The EARLIEST-ending match wins where windows overlap, so the reported "until" is the
 * soonest moment the engine could next open, never a later one that would read as a
 * longer freeze than is actually in force.
 */
export function activeWindowAt(
  calendar: NewsBlackoutCalendar,
  now: Date,
): NewsBlackoutWindow | null {
  const t = now.getTime();
  let best: NewsBlackoutWindow | null = null;

  for (const w of calendar.windows) {
    if (t < w.start.getTime() || t >= w.end.getTime()) continue;
    if (best === null || w.end.getTime() < best.end.getTime()) best = w;
  }

  return best;
}

/* ------------------------------------------------------------------ */
/* The read                                                            */
/* ------------------------------------------------------------------ */

/**
 * Reads the calendar and reports whether entries are blacked out right now.
 *
 * NEVER THROWS, on any path. A missing file is the normal state on a box with no Hermes
 * cron and is reported as one warning, not an error.
 *
 * NOT CACHED, unlike `readRpcHealth` and `readWalletBalance`. Those cache because their
 * source is a rate-limited third party that the very widget reporting on it would
 * otherwise generate load against. This reads a few kilobytes off local disk, where a
 * cache would buy nothing and would let the trading cycle and `/api/overview` disagree
 * about whether a window is in force. A blackout can begin and end between two
 * 30-minute cycles, so the answer has to be current at the moment it is asked.
 *
 * `now` and `file` are parameters rather than reads of global state for the same reason
 * `parseLiveConfig` takes its environment: it is what lets the failure paths below be
 * exercised against a real filesystem, and `env.ts` parses once at import, so a test
 * cannot reach this function by setting a variable.
 */
export function readNewsBlackout(
  now: Date = new Date(),
  file: string = newsBlackoutPath(),
): NewsBlackoutReading {
  const path = file;

  if (!env.NEWS_BLACKOUT_ENABLED) {
    return { active: null, warnings: [], enabled: false, path };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const reason =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "not found"
        : `unreadable (${(err as Error).message})`;

    return {
      active: null,
      warnings: [`calendar ${path} is ${reason}; entries are NOT being blacked out`],
      enabled: true,
      path,
    };
  }

  const { calendar, warnings, sawGeneratedAtField } = parseNewsBlackoutFile(raw);

  if (isCalendarStale(calendar, now)) {
    const ageHours = (now.getTime() - (calendar.generatedAt?.getTime() ?? 0)) / 3_600_000;
    warnings.push(
      `calendar was generated ${ageHours.toFixed(1)}h ago, over the ` +
        `${NEWS_BLACKOUT_MAX_AGE_HOURS}h limit; IGNORED so a dead refresh cron cannot ` +
        `freeze trading — check the Hermes news job`,
    );
    return { active: null, warnings, enabled: true, path };
  }

  // Only when the field was genuinely ABSENT. When it was present and unreadable the
  // parser has already said so, and saying "has no generated_at" on top of that is a
  // second, contradictory claim about the same field.
  if (calendar.generatedAt === null && !sawGeneratedAtField) {
    warnings.push(
      "calendar has no generated_at; its windows are still honoured (they carry " +
        "absolute times, and none may exceed " +
        `${NEWS_BLACKOUT_MAX_WINDOW_HOURS}h) but its freshness cannot be verified`,
    );
  }

  return { active: activeWindowAt(calendar, now), warnings, enabled: true, path };
}

/**
 * The shape `/api/overview` and the shared Telegram `/status` payload publish.
 *
 * Null means "no blackout is holding entries back", which in PAPER mode is always the
 * answer — the gate is inert there by construction, and reporting a window it is not
 * enforcing would be a claim about behaviour that is not happening.
 */
export interface NewsBlackoutStatus {
  event: string;
  untilWib: string;
}

export function toBlackoutStatus(
  window: NewsBlackoutWindow | null,
  timeZone: string = env.TZ,
): NewsBlackoutStatus | null {
  if (window === null) return null;
  return { event: window.event, untilWib: formatZonedStamp(window.end, timeZone) };
}
