/**
 * The ONE reader for a timestamp as stored by SQLite.
 *
 * `CURRENT_TIMESTAMP` writes `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker, which
 * `new Date()` would read as LOCAL time — a 7-hour error on the default Asia/Jakarta box,
 * enough to let a 4-hour cooldown expire before it ever began. ISO strings (what the tests
 * and seeds write) pass through untouched.
 *
 * WHY THIS FILE EXISTS. The rule had three implementations: the canonical one in
 * `meteora.ts`, and narrower copies in `liveReport.ts` and `reconciliation.ts` that tested
 * only for `"T"`. A value carrying a zone marker with a SPACE separator —
 * `2026-09-16 10:00:00Z`, `2026-09-16 10:00:00+07:00` — parsed in the canonical reader and
 * returned null in both copies. Nothing writes that form today (756 stored values were
 * scanned on 16 Sep 2026 and none was in it), so this was latent; it mattered because of
 * where the copies lived. In `reconciliation.ts` a null is not a parse detail, it is the
 * difference between a row being compared against the chain and being excluded from BOTH
 * totals as unmeasured.
 *
 * It is its own module rather than living in `meteora.ts` because `liveReport.ts` must not
 * import that: `meteora.ts` pulls `config/env.ts`, which parses `.env` at import and can
 * `process.exit(1)`, and `liveReport.ts` is the READ-ONLY report an operator runs against
 * the live host while the engine is writing. This module imports nothing.
 *
 * `meteora.ts` re-exports `parseDbTimestamp`, so every existing caller is unchanged — the
 * same move `isLiveExecutionActive()` made into `liveConfig.ts`.
 */

/** A stored timestamp as a `Date`, or null when it is absent or unparseable. */
export function parseDbTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const raw = value.trim();
  if (raw === "") return null;

  const hasZone = raw.includes("T") || /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const normalised = hasZone ? raw : `${raw.replace(" ", "T")}Z`;

  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The same reading as epoch milliseconds, or null.
 *
 * Null keeps meaning UNMEASURED to every caller — `reconciliation.ts` excludes such a row
 * from both totals rather than counting it as zero, and that is the behaviour being
 * preserved, not merely the parse.
 */
export function parseDbTimestampMs(value: string | null | undefined): number | null {
  const date = parseDbTimestamp(value);
  return date === null ? null : date.getTime();
}
