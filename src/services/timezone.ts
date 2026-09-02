/**
 * Timezone conversion for stored timestamps.
 *
 * SQLite's `'localtime'` modifier resolves against the C runtime's timezone, and the C
 * runtime does not read IANA zone names on every platform. On Windows, with
 * `TZ=Asia/Jakarta` exported from `.env`, the CRT parses that as a POSIX `TZ` string
 * with no offset and lands on +1 hour instead of +7 — so the same database bucketed
 * days six hours apart depending on which machine ran the query:
 *
 *     closed_at (UTC)                  2026-09-02 19:45:22
 *     datetime(closed_at,'localtime')  2026-09-02 20:45:22   (Windows, wrong)
 *     datetime(closed_at,'localtime')  2026-09-03 02:45:22   (Linux, correct)
 *
 * `Intl` is IANA-aware everywhere Node runs, so the conversion happens here and SQL only
 * ever compares UTC instants. That also fixes the harder half of the problem: an offset
 * looked up once cannot be right across a DST transition, and these helpers resolve the
 * offset at each instant rather than assuming one for the whole history.
 *
 * Stored timestamps are `YYYY-MM-DD HH:MM:SS` with no zone marker and always mean UTC.
 */
import { env } from "../config/env.js";

/** SQLite's storage shape, so bound parameters compare lexicographically as they sort. */
export function toSqlUtc(instant: Date): string {
  return instant.toISOString().slice(0, 19).replace("T", " ");
}

/** Parses a stored `YYYY-MM-DD HH:MM:SS` (UTC, zone-less) into an instant. */
export function parseStoredUtc(value: string): Date | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const hasZone = raw.includes("T") || /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const date = new Date(hasZone ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Minutes east of UTC in `timeZone` at a given instant. DST-correct by construction. */
export function offsetMinutesAt(instant: Date, timeZone: string = env.TZ): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;

  // "GMT" alone means UTC; anything unparseable is treated as UTC rather than guessed at.
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (!match) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** `YYYY-MM-DD` for an instant, in `timeZone`. en-CA formats exactly that way. */
export function zonedDayKey(instant: Date, timeZone: string = env.TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Hour of day, `00`-`23`, for an instant in `timeZone`. */
export function zonedHour(instant: Date, timeZone: string = env.TZ): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(instant);
}

/**
 * The UTC instant at which a local calendar day begins.
 *
 * Resolved twice: the offset is first looked up at the day's UTC midnight, then again at
 * the candidate instant. On a DST boundary those differ, and the second lookup is the
 * one that belongs to the moment actually being named.
 */
export function zonedDayStartUtc(dayKey: string, timeZone: string = env.TZ): Date {
  const utcMidnight = new Date(`${dayKey}T00:00:00Z`);
  const firstGuess = new Date(utcMidnight.getTime() - offsetMinutesAt(utcMidnight, timeZone) * 60_000);
  const settled = offsetMinutesAt(firstGuess, timeZone);
  return new Date(utcMidnight.getTime() - settled * 60_000);
}

/** Exclusive upper bound: the UTC instant at which the day AFTER `dayKey` begins. */
export function zonedDayEndUtc(dayKey: string, timeZone: string = env.TZ): Date {
  const next = new Date(`${dayKey}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return zonedDayStartUtc(next.toISOString().slice(0, 10), timeZone);
}

/**
 * Steps a `YYYY-MM-DD` key by whole days.
 *
 * Pure calendar arithmetic on the key itself, so it never re-enters a timezone and
 * cannot drift: the key is anchored at UTC midnight only as a counting device.
 */
export function addDaysToDayKey(dayKey: string, delta: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Today's date in the configured zone. */
export const currentZonedDay = (timeZone: string = env.TZ): string =>
  zonedDayKey(new Date(), timeZone);
