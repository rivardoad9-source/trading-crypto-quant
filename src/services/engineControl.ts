import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config/env.js";

/**
 * Engine control: the two INDEPENDENT ways new entries can be held.
 *
 * 1. Telegram `/pause` — in-memory, per process, cleared by `/resume` or a restart.
 * 2. A control FILE — written by an operator or by Hermes, read once per cycle.
 *
 * WHY THE FILE EXISTS. Until 10 Sep 2026 the kill-switch was Telegram-only and this
 * module was nineteen lines around `let paused`. That morning every engine boot logged
 * `409: Conflict: terminated by other getUpdates request` — an external poller holding
 * the bot token — so command INTAKE was dead for the whole life of the process while
 * alert delivery kept working. `/pause`, `/resume`, `/close_all` and `/status` were all
 * unresponsive, and because the pause flag lives in memory there was no way to hold
 * entries from outside the process at all. `pm2 stop` is not a substitute: it also
 * stops monitoring the OPEN positions, which is how a stop-loss stops being enforced
 * and how a mid-cycle swap gets stranded.
 *
 * THE TWO SOURCES ARE NEVER EXPRESSED IN TERMS OF EACH OTHER. `/resume` does not clear
 * a file pause and deleting the file does not un-pause a Telegram pause — they are
 * different operators making different decisions through different channels, and each
 * holds entries on its own. Both are reported, always, and separately: one flag
 * standing for two causes is how "why is nothing opening" becomes unanswerable from
 * the log.
 *
 * ENTRIES ONLY. A hold skips `seekNewEntry` and nothing else. Fee accrual, valuation,
 * stop-losses and closes run exactly as on any other cycle — blocking an EXIT is the
 * opposite of prudent, and a position the engine has stopped acting on is the 10 Sep
 * half-landed open all over again.
 *
 * FAILS CLOSED, and it is the one gate on this path that does. The other file-backed
 * and history-backed gates fail OPEN (`assessPoolCooldown`, `assessExecutionBreaker`)
 * because a third party's dead cron must never freeze an unattended engine. This is
 * different in
 * kind: it is not a feed, it is an INSTRUCTION, and it exists only because somebody
 * wrote it. A file that is present but unreadable means an operator asked for something
 * the engine cannot make out — and the conservative reading of an unreadable
 * instruction is the one that spends no money. An ABSENT file is not an unreadable
 * instruction, it is the normal state, and it holds nothing.
 */

/* ------------------------------------------------------------------ */
/* Telegram /pause — in-memory, unchanged                              */
/* ------------------------------------------------------------------ */

/**
 * Deliberately in-memory, not persisted: a process restart brings the engine back in
 * the RUNNING state, which is the safe default for an unattended scheduler. Pausing
 * over Telegram is a temporary operator intervention, not a config. An operator who
 * wants a hold that SURVIVES a restart writes the control file instead — that is the
 * difference between the two sources, and the reason both exist.
 */
let paused = false;

export function isEnginePaused(): boolean {
  return paused;
}

/** Returns the new state. */
export function setEnginePaused(value: boolean): boolean {
  paused = value;
  return paused;
}

/* ------------------------------------------------------------------ */
/* The control file                                                    */
/* ------------------------------------------------------------------ */

/** Resolved like `DATABASE_PATH`, so an absolute path also works. */
export function engineControlPath(): string {
  return resolve(process.cwd(), env.ENGINE_CONTROL_FILE);
}

export interface EngineControlFileReading {
  /** Whether the file is holding new entries. */
  paused: boolean;
  /** The operator's stated reason, or null when the file gave none. */
  reason: string | null;
  /**
   * Everything that went wrong, in operator-readable form. Returned rather than logged
   * so the caller decides: the trading cycle prints them once per cycle, while
   * `/api/overview` — which the dashboard polls once a minute per open tab — reads the
   * same file and stays silent rather than filling the log with one warning per poll.
   */
  warnings: string[];
  /** The absolute path read, so a warning can name the file an operator has to fix. */
  path: string;
}

/**
 * Strips what would let file content forge the report it appears in.
 *
 * `reason` comes from a file this repository does not write and reaches the Telegram
 * `/status` reply. `markdownV2()` uses `**...**` to mark the bold spans it must NOT
 * escape, so a reason containing `**` would open a bold span of its own inside an
 * otherwise-escaped message — the "can't parse entities" failure CLAUDE.md records,
 * arriving through data instead of through static text. Control characters go too: a
 * newline in a reason would forge a line in the status report.
 *
 * The engine's other operator-file reader carries the same rule at the same boundary.
 * Kept local rather than shared because the alternative is a dependency between two
 * unrelated readers, or a third module for four lines.
 */
function cleanReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\*/g, "")
    .trim();
  return cleaned === "" ? null : cleaned.slice(0, 200);
}

/**
 * Reads `paused` out of an already-parsed object.
 *
 * Booleans are the documented form. The strings `"true"` and `"false"` are accepted
 * because this file is hand-edited under time pressure and quoting a boolean is the
 * commonest way to get JSON slightly wrong; refusing them would PAUSE an engine whose
 * operator had just written `"paused": "false"` to resume it. Anything else — a
 * number, a missing field, a typo — is not a readable instruction and pauses.
 */
function readPausedFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
}

/**
 * Parses the control file's contents. Never throws.
 *
 * A readable `paused: false` is honoured even when the REST of the object is nonsense,
 * because the one field that carries the instruction was legible. The opposite rule —
 * discarding a whole file over an unrelated bad field — is how a gate switches itself
 * off, or on, for a reason nobody asked for.
 */
export function parseEngineControlFile(raw: string): {
  paused: boolean;
  reason: string | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const held = (warning: string) => {
    warnings.push(warning);
    return { paused: true, reason: null, warnings };
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return held(
      `control file is not valid JSON (${(err as Error).message}); ` +
        `HOLDING new entries until it is readable or removed`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return held("control file is not a JSON object; HOLDING new entries");
  }

  const root = parsed as Record<string, unknown>;
  const flag = readPausedFlag(root.paused);

  if (flag === null) {
    return held(
      `control file has no readable "paused" boolean (got ${JSON.stringify(root.paused)}); ` +
        `HOLDING new entries`,
    );
  }

  return { paused: flag, reason: flag ? cleanReason(root.reason) : null, warnings };
}

/**
 * Reads the control file and reports whether it is holding new entries.
 *
 * NEVER THROWS, on any path.
 *
 * NOT CACHED, for the same reason the calendar reader is not: this reads a few hundred
 * bytes off local disk, and a cache would let the trading cycle and `/api/overview`
 * disagree about whether entries are held. An operator who writes the file expects the
 * NEXT cycle to see it, which is the whole point of a kill-switch that does not need a
 * restart.
 *
 * `file` is a parameter rather than a read of global state because `env.ts` parses once
 * at import, so a test cannot reach this function by setting a variable — the same
 * reason the calendar reader takes its path and its clock.
 */
export function readEngineControlFile(
  file: string = engineControlPath(),
): EngineControlFileReading {
  const path = file;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    /*
     * ABSENT IS NOT PAUSED, and it is not a warning either. No control file is the
     * normal state of a box nobody has intervened on, and warning about it every cycle
     * would train the operator to ignore the one line that matters.
     *
     * Any OTHER read error is a file that exists and cannot be read — permissions, a
     * truncated write, a disk fault. That is an instruction we cannot make out, so it
     * holds.
     */
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { paused: false, reason: null, warnings: [], path };
    }
    return {
      paused: true,
      reason: null,
      warnings: [
        `control file ${path} exists but is unreadable (${(err as Error).message}); ` +
          `HOLDING new entries — monitoring, fees and closes are unaffected`,
      ],
      path,
    };
  }

  const { paused: filePaused, reason, warnings } = parseEngineControlFile(raw);
  return {
    paused: filePaused,
    reason,
    warnings: warnings.map((w) => `${w} (${path})`),
    path,
  };
}

/* ------------------------------------------------------------------ */
/* The combined answer                                                 */
/* ------------------------------------------------------------------ */

/**
 * The shape `/api/overview` and the shared Telegram `/status` payload publish.
 *
 * Both sources are always present, so a reader can tell WHICH one to clear. Reporting
 * only "paused: true" would leave an operator using `/resume` against a file pause it
 * cannot lift.
 */
export interface EngineControlStatus {
  pausedByTelegram: boolean;
  pausedByFile: boolean;
  fileReason: string | null;
}

/** Whether either source is holding new entries. */
export function entriesAreHeld(status: EngineControlStatus): boolean {
  return status.pausedByTelegram || status.pausedByFile;
}

/**
 * One line naming every source that is holding entries, or null when none is.
 *
 * Printed only when something IS held: a cycle that opens nothing for ordinary reasons
 * is already fully described by the funnel row, and a per-cycle "nothing is holding
 * entries" line is the noise that hides the real one.
 */
export function describeEntriesHeld(status: EngineControlStatus): string | null {
  if (!entriesAreHeld(status)) return null;

  const file = status.pausedByFile
    ? `file (${status.fileReason ?? "no reason given"})`
    : "file: running";
  const telegram = status.pausedByTelegram ? "telegram /pause" : "telegram: running";

  return `[control] entries held: ${file}; ${telegram}`;
}

/**
 * The file's skip clause for `scan_funnel_cycles.skip_reason`.
 *
 * A SEPARATE clause, appended beside the `/pause` one rather than replacing it — the
 * `/pause` wording is already written to that column and an operator reads it there.
 */
export function fileHoldSkipReason(status: EngineControlStatus): string | null {
  if (!status.pausedByFile) return null;
  return (
    `engine paused via the operator control file` +
    (status.fileReason ? ` (${status.fileReason})` : "") +
    ` — new entries skipped, monitoring continues`
  );
}
