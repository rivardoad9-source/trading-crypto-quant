/**
 * The screener's cadence rule: a 5-minute TICK that only becomes a screener run on the
 * 30-minute base cadence — or every tick for a bounded stretch after a macro-news window
 * closes.
 *
 * WHY THIS IS PINNED. The 5-minute tick looks, in the cron expression, exactly like a
 * six-fold increase in DeepSeek spend, and the 30-minute clock was chosen precisely to
 * bound that bill. The tests below are what make the distinction checkable rather than
 * asserted in a comment: off-cadence ticks must not run, the fast stretch must be bounded
 * by the window that produced it, and paper mode must stay on the baseline cadence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../config/env.js";
import { CRON, DLMM_BASE_CADENCE_MIN, DLMM_POST_NEWS_FAST_MIN } from "../config/constants.js";
import {
  decideScreenerRun,
  minutesOfHourInZone,
  postNewsFastWindowAt,
  readPostNewsFastWindow,
} from "../services/screenerCadence.js";
import type { NewsBlackoutWindow } from "../services/newsBlackout.js";

function window(event: string, startIso: string, endIso: string): NewsBlackoutWindow {
  return { event, start: new Date(startIso), end: new Date(endIso), source: null };
}

/** The PPI window the engine actually carried on 10 Sep 2026: 18:30-20:15 WIB. */
const PPI = window("PPI", "2026-09-10T11:30:00Z", "2026-09-10T13:15:00Z");

describe("screener cadence — the tick is not the cadence", () => {
  it("asserts a 5-minute tick on a 30-minute base cadence", () => {
    assert.equal(CRON.DLMM_TICK, "*/5 * * * *");
    assert.equal(DLMM_BASE_CADENCE_MIN, 30);
  });

  it("keeps the fast stretch bounded, never open-ended", () => {
    assert.ok(DLMM_POST_NEWS_FAST_MIN > 0);
    assert.ok(
      DLMM_POST_NEWS_FAST_MIN <= 240,
      "a post-news fast window over 4h is a cadence change, not a reaction window",
    );
  });

  it("runs the screener on the 30-minute marks and nowhere else", () => {
    for (const minute of [0, 30]) {
      const d = decideScreenerRun({ now: new Date(), minutesOfHour: minute, live: true, fastWindow: null });
      assert.equal(d.run, true, `minute ${minute} should run`);
      assert.equal(d.fast, false);
    }

    for (const minute of [5, 10, 20, 25, 55]) {
      const d = decideScreenerRun({ now: new Date(), minutesOfHour: minute, live: true, fastWindow: null });
      assert.equal(d.run, false, `minute ${minute} should be a no-op tick`);
      assert.equal(d.fast, false);
    }
  });

  it("honours an overridden base cadence", () => {
    const at = (m: number) =>
      decideScreenerRun({ now: new Date(), minutesOfHour: m, live: true, fastWindow: null, baseCadenceMin: 15 });

    assert.equal(at(15).run, true);
    assert.equal(at(45).run, true);
    assert.equal(at(5).run, false);
  });
});

describe("screener cadence — the post-news fast window", () => {
  it("runs every tick once the window has closed, and says which event", () => {
    // 20:20 WIB: five minutes after the PPI window ended.
    const now = new Date("2026-09-10T13:20:00Z");
    const d = decideScreenerRun({ now, minutesOfHour: 20, live: true, fastWindow: PPI });

    assert.equal(d.run, true);
    assert.equal(d.fast, true);
    assert.match(d.reason, /PPI/);
    assert.match(d.reason, /5m ago/);
    /*
     * The wording is asserted because the first version interpolated the fast-window
     * LENGTH into both slots and read as "running every 90m for 90m" — the log an operator
     * reads to understand why the engine is ticking fast said the opposite.
     */
    assert.match(d.reason, /ticking every 5m instead of 30m/);
  });

  it("stays on the base cadence in paper mode even when the calendar says go fast", () => {
    const d = decideScreenerRun({
      now: new Date("2026-09-10T13:20:00Z"),
      minutesOfHour: 20,
      live: false,
      fastWindow: PPI,
    });

    assert.equal(d.run, false);
    assert.equal(d.fast, false);
    assert.match(d.reason, /paper mode/);

    // …and the base cadence still applies in paper mode.
    const base = decideScreenerRun({
      now: new Date("2026-09-10T13:20:00Z"),
      minutesOfHour: 30,
      live: false,
      fastWindow: PPI,
    });
    assert.equal(base.run, true);
  });

  it("returns the window that closed most recently, not an older one", () => {
    const older = window("CPI", "2026-09-09T11:30:00Z", "2026-09-09T13:15:00Z");
    const recent = window("PPI", "2026-09-10T11:30:00Z", "2026-09-10T13:15:00Z");
    const now = new Date("2026-09-10T13:20:00Z");

    assert.equal(postNewsFastWindowAt(now, [older, recent])?.event, "PPI");
  });

  it("starts at the instant the window closes and ends exactly at the horizon", () => {
    const end = PPI.end.getTime();

    // The instant the window closes is the first instant entries are allowed again, so
    // the fast cadence and the reopened entry gate begin together.
    assert.equal(postNewsFastWindowAt(new Date(end), [PPI])?.event, "PPI");

    // Inside the window (entries still held) is NOT a fast window.
    assert.equal(postNewsFastWindowAt(new Date(end - 60_000), [PPI]), null);

    assert.equal(postNewsFastWindowAt(new Date(end + DLMM_POST_NEWS_FAST_MIN * 60_000 - 1), [PPI])?.event, "PPI");
    assert.equal(postNewsFastWindowAt(new Date(end + DLMM_POST_NEWS_FAST_MIN * 60_000), [PPI]), null);
    assert.equal(postNewsFastWindowAt(new Date(end + 6 * 3_600_000), [PPI]), null);
  });
});

describe("screener cadence — zone handling", () => {
  it("reads the minute of the hour in the engine's zone, not the server's", () => {
    // 12:30 UTC = 19:30 WIB (minute 30) but 18:00 in Asia/Kolkata (+5:30, minute 0).
    const instant = new Date("2026-09-10T12:30:00Z");
    assert.equal(minutesOfHourInZone(instant, "Asia/Jakarta"), 30);
    assert.equal(minutesOfHourInZone(instant, "Asia/Kolkata"), 0);
  });

  it("defaults to env.TZ", () => {
    const instant = new Date("2026-09-10T12:30:00Z");
    assert.equal(minutesOfHourInZone(instant), minutesOfHourInZone(instant, env.TZ));
  });
});

describe("screener cadence — reading the calendar", () => {
  /**
   * A calendar written, read and removed inside one test body. Deliberately not a
   * module-level fixture: `it()` only REGISTERS a test, so a directory cleaned up in a
   * surrounding `finally` would be gone before anything reads it.
   */
  function withCalendar(body: string, check: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "fm-cadence-"));
    try {
      const path = join(dir, "calendar.json");
      writeFileSync(path, body);
      check(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const calendarWith = (windows: unknown[], generatedAt = new Date().toISOString()): string =>
    JSON.stringify({ generated_at: generatedAt, windows });

  it("finds a window that closed minutes ago", () => {
    if (!env.NEWS_BLACKOUT_ENABLED) {
      // With the gate switched off the cadence module must not invent a fast window.
      withCalendar(calendarWith([]), (path) => {
        assert.equal(readPostNewsFastWindow(new Date(), path), null);
      });
      return;
    }

    const now = new Date();
    const end = new Date(now.getTime() - 10 * 60_000);
    const start = new Date(end.getTime() - 105 * 60_000);

    withCalendar(
      calendarWith([{ event: "PPI", start_utc: start.toISOString(), end_utc: end.toISOString() }]),
      (path) => {
        assert.equal(readPostNewsFastWindow(now, path)?.event, "PPI");
      },
    );
  });

  it("never throws on a missing, empty or malformed calendar", () => {
    const missing = join(tmpdir(), `fm-cadence-missing-${Date.now()}.json`);
    assert.equal(readPostNewsFastWindow(new Date(), missing), null);

    for (const body of ["{ not json", "", JSON.stringify(["nope"])]) {
      withCalendar(body, (path) => {
        assert.equal(readPostNewsFastWindow(new Date(), path), null);
      });
    }
  });

  it("ignores a window from a calendar the refresh cron stopped maintaining", () => {
    const now = new Date();
    const end = new Date(now.getTime() - 10 * 60_000);
    const start = new Date(end.getTime() - 3_600_000);

    withCalendar(
      calendarWith(
        [{ event: "PPI", start_utc: start.toISOString(), end_utc: end.toISOString() }],
        new Date(now.getTime() - 72 * 3_600_000).toISOString(),
      ),
      (path) => {
        assert.equal(readPostNewsFastWindow(now, path), null);
      },
    );
  });
});
