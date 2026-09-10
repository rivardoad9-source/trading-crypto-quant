import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NEWS_BLACKOUT_MAX_AGE_HOURS,
  activeWindowAt,
  describeBlackoutWindow,
  formatZonedStamp,
  isCalendarStale,
  parseNewsBlackoutFile,
  readNewsBlackout,
  toBlackoutStatus,
  type NewsBlackoutCalendar,
} from "../services/newsBlackout.js";
import { env } from "../config/env.js";

/**
 * The macro-news entry blackout.
 *
 * Everything below is about ONE property in two directions: the gate must skip entries
 * during a scheduled release, and it must never be able to stop the engine trading for
 * any other reason. The second half is the one with teeth — a gate that reads a file
 * written by a cron this repository does not own can fail in ways no guardrail here can
 * fix, so every one of those paths is asserted to fail OPEN.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/**
 * Walks the relative-import graph from an entry file. Same shape as the walker in
 * `onchainExecutor.test.ts`: relative specifiers only, because a package import can
 * never be one of our modules, and `.js` on disk is `.ts`.
 */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const spec = m[1];
      if (!spec) continue;
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

/** A calendar built from ISO strings, the way the file carries them. */
function calendar(
  windows: Array<{ event: string; start: string; end: string; source?: string }>,
  generatedAt: string | null = "2026-09-10T12:00:00Z",
): NewsBlackoutCalendar {
  return {
    generatedAt: generatedAt === null ? null : new Date(generatedAt),
    windows: windows.map((w) => ({
      event: w.event,
      start: new Date(w.start),
      end: new Date(w.end),
      source: w.source ?? null,
    })),
  };
}

/* ------------------------------------------------------------------ */

describe("news blackout — window boundaries", () => {
  const cal = calendar([
    { event: "PPI", start: "2026-09-10T11:30:00Z", end: "2026-09-10T13:15:00Z" },
  ]);

  it("blacks out an instant inside the window", () => {
    const hit = activeWindowAt(cal, new Date("2026-09-10T12:00:00Z"));
    assert.equal(hit?.event, "PPI");
  });

  it("treats the START as INSIDE the window", () => {
    /*
     * The window is `release -60min`, so its first instant is already inside the run-up
     * the gate exists to avoid. An exclusive start would leave exactly the moment the
     * calendar names as the beginning of the danger unprotected.
     */
    const hit = activeWindowAt(cal, new Date("2026-09-10T11:30:00Z"));
    assert.equal(hit?.event, "PPI");
  });

  it("treats the END as OUTSIDE the window", () => {
    /*
     * END EXCLUSIVE. The instant a window ends is the first instant trading is allowed
     * again — which is what "until 20:15" means to the operator reading the log. It
     * also stops two adjacent windows sharing an instant from both matching.
     */
    assert.equal(activeWindowAt(cal, new Date("2026-09-10T13:15:00Z")), null);
  });

  it("does not black out one millisecond before the start, or after the end", () => {
    assert.equal(activeWindowAt(cal, new Date("2026-09-10T11:29:59.999Z")), null);
    assert.equal(activeWindowAt(cal, new Date("2026-09-10T13:15:00.001Z")), null);
  });

  it("returns null when no window contains the instant", () => {
    assert.equal(activeWindowAt(cal, new Date("2026-09-11T00:00:00Z")), null);
    assert.equal(activeWindowAt(calendar([]), new Date("2026-09-10T12:00:00Z")), null);
  });

  it("reports the EARLIEST-ending window when two overlap", () => {
    /*
     * The reported "until" is the soonest moment the engine could next open. Reporting
     * the later one would tell the operator the freeze is longer than it is, and the
     * shorter window ending is a real change of state the next cycle must see.
     */
    const overlapping = calendar([
      { event: "FOMC", start: "2026-09-10T17:00:00Z", end: "2026-09-10T20:00:00Z" },
      { event: "CPI", start: "2026-09-10T17:30:00Z", end: "2026-09-10T18:15:00Z" },
    ]);
    const hit = activeWindowAt(overlapping, new Date("2026-09-10T17:45:00Z"));
    assert.equal(hit?.event, "CPI");
  });
});

describe("news blackout — parsing the calendar file", () => {
  it("parses the NewsAgent shape: generated_at plus windows[].start_utc/end_utc", () => {
    const { calendar: cal, warnings } = parseNewsBlackoutFile(
      JSON.stringify({
        generated_at: "2026-09-10T10:00:00Z",
        windows: [
          {
            event: "CPI",
            start_utc: "2026-09-10T11:30:00Z",
            end_utc: "2026-09-10T13:15:00Z",
            source: "bls",
          },
        ],
      }),
    );

    assert.deepEqual(warnings, []);
    assert.equal(cal.windows.length, 1);
    assert.equal(cal.windows[0]?.event, "CPI");
    assert.equal(cal.windows[0]?.source, "bls");
    assert.equal(cal.windows[0]?.start.toISOString(), "2026-09-10T11:30:00.000Z");
    assert.equal(cal.generatedAt?.toISOString(), "2026-09-10T10:00:00.000Z");
  });

  it("respects ad-hoc windows from the manual source alongside feed windows", () => {
    /*
     * `~/.hermes/scripts/news_blackout_manual.json` is merged into the same file by the
     * cron, so a manual window arrives as an ordinary row that differs only in `source`.
     * It must be honoured identically — an operator adding a window by hand is the
     * escape hatch for a release the BLS feed does not carry.
     */
    const { calendar: cal, warnings } = parseNewsBlackoutFile(
      JSON.stringify({
        generated_at: "2026-09-10T10:00:00Z",
        windows: [
          { event: "NFP", start_utc: "2026-09-10T11:30:00Z", end_utc: "2026-09-10T13:15:00Z" },
          {
            event: "Powell testimony",
            start_utc: "2026-09-10T14:00:00Z",
            end_utc: "2026-09-10T15:45:00Z",
            source: "manual",
          },
        ],
      }),
    );

    assert.deepEqual(warnings, []);
    assert.equal(cal.windows.length, 2);

    const hit = activeWindowAt(cal, new Date("2026-09-10T14:30:00Z"));
    assert.equal(hit?.event, "Powell testimony");
    assert.equal(hit?.source, "manual");

    /*
     * An ad-hoc window is TAGGED in the log, because "is this window still meant to be
     * here" has a different answer for one a person added than for one the feed will
     * retire by itself. The tag goes AFTER the fixed wording, never inside it — that
     * prefix is a log contract.
     */
    const line = describeBlackoutWindow(hit!);
    assert.ok(
      line.startsWith(
        "[news] blackout: Powell testimony until " +
          formatZonedStamp(hit!.end) +
          " — skipping new entries (monitoring continues)",
      ),
      line,
    );
    assert.ok(line.endsWith(" [source: manual]"), line);

    // A feed window is NOT tagged: the norm stays exactly the specified line.
    const feed = activeWindowAt(cal, new Date("2026-09-10T12:00:00Z"))!;
    assert.equal(feed.event, "NFP");
    assert.ok(!describeBlackoutWindow(feed).includes("source:"), describeBlackoutWindow(feed));
  });

  it("drops only the broken window, keeping the sound ones", () => {
    /*
     * Guessing at an unreadable instant is how a gate enforces a period nobody
     * scheduled; discarding the whole file over one bad row is how a gate switches
     * itself off. Per-row rejection with a per-row warning is neither.
     */
    const { calendar: cal, warnings } = parseNewsBlackoutFile(
      JSON.stringify({
        generated_at: "2026-09-10T10:00:00Z",
        windows: [
          { event: "BROKEN", start_utc: "not a date", end_utc: "2026-09-10T13:15:00Z" },
          { event: "BACKWARDS", start_utc: "2026-09-10T14:00:00Z", end_utc: "2026-09-10T13:00:00Z" },
          { event: "GOOD", start_utc: "2026-09-10T11:30:00Z", end_utc: "2026-09-10T13:15:00Z" },
        ],
      }),
    );

    assert.equal(cal.windows.length, 1);
    assert.equal(cal.windows[0]?.event, "GOOD");
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => w.includes("BROKEN")));
    assert.ok(warnings.some((w) => w.includes("BACKWARDS")));
  });

  it("reads a zone-less timestamp as UTC, never as local time", () => {
    /*
     * The seven-hour defect `timezone.ts` exists for. On an Asia/Jakarta box a window
     * read as local time would be applied most of a working day away from the release
     * — and a 105-minute window missed by seven hours is a gate that never fires.
     */
    const { calendar: cal } = parseNewsBlackoutFile(
      JSON.stringify({
        generated_at: "2026-09-10T10:00:00Z",
        windows: [{ event: "CPI", start_utc: "2026-09-10 11:30:00", end_utc: "2026-09-10 13:15:00" }],
      }),
    );
    assert.equal(cal.windows[0]?.start.toISOString(), "2026-09-10T11:30:00.000Z");
  });

  it("accepts an offset other than Z without shifting it", () => {
    const { calendar: cal } = parseNewsBlackoutFile(
      JSON.stringify({
        windows: [{ event: "CPI", start_utc: "2026-09-10T08:30:00-03:00", end_utc: "2026-09-10T13:15:00Z" }],
      }),
    );
    assert.equal(cal.windows[0]?.start.toISOString(), "2026-09-10T11:30:00.000Z");
  });

  it("names a window that has no event field rather than dropping it", () => {
    const { calendar: cal } = parseNewsBlackoutFile(
      JSON.stringify({
        windows: [{ start_utc: "2026-09-10T11:30:00Z", end_utc: "2026-09-10T13:15:00Z" }],
      }),
    );
    assert.equal(cal.windows.length, 1);
    assert.equal(cal.windows[0]?.event, "scheduled release");
  });

  it("never throws on malformed input, and warns instead", () => {
    for (const raw of ["", "not json", "[]", "null", '"a string"', "{}", '{"windows":42}']) {
      const { calendar: cal, warnings } = parseNewsBlackoutFile(raw);
      assert.equal(activeWindowAt(cal, new Date()), null, `${raw} produced a window`);
      assert.ok(warnings.length > 0, `${raw} was rejected silently`);
    }
  });
});

describe("news blackout — staleness fails OPEN", () => {
  const now = new Date("2026-09-10T12:00:00Z");

  it("ignores a calendar generated more than 48h ago", () => {
    /*
     * A refresh cron that has died must not be able to hold an unattended engine out
     * of the market on the strength of records nobody is maintaining. This is the one
     * direction in which old data is dangerous, and it is why the limit exists.
     */
    const stale = calendar(
      [{ event: "CPI", start: "2026-09-10T11:30:00Z", end: "2026-09-10T13:15:00Z" }],
      "2026-09-08T11:00:00Z",
    );
    assert.equal(isCalendarStale(stale, now), true);
  });

  it("keeps a calendar generated exactly at the limit", () => {
    const edge = calendar([], "2026-09-08T12:00:00Z");
    assert.equal(isCalendarStale(edge, now), false);
    assert.equal((now.getTime() - edge.generatedAt!.getTime()) / 3_600_000, NEWS_BLACKOUT_MAX_AGE_HOURS);
  });

  it("keeps a fresh calendar", () => {
    assert.equal(isCalendarStale(calendar([], "2026-09-10T11:00:00Z"), now), false);
  });

  it("does NOT treat a missing generated_at as stale", () => {
    /*
     * Deliberate, and the reasoning is asymmetric. The windows carry absolute instants
     * and none is longer than two hours, so honouring an unverifiable calendar can
     * delay an entry by minutes and can never freeze trading. Ignoring it would switch
     * the gate off entirely whenever the writer omitted one field — the loud-but-inert
     * failure this file's whole design is trying to avoid. The freshness is warned
     * about instead.
     */
    assert.equal(isCalendarStale(calendar([], null), now), false);
  });

  it("does not let a clock skew into the future read as stale", () => {
    assert.equal(isCalendarStale(calendar([], "2026-09-10T18:00:00Z"), now), false);
  });
});

describe("news blackout — the read never throws and never blocks on a fault", () => {
  /**
   * Runs the real `readNewsBlackout` against a real temp file.
   *
   * The path is passed in rather than set through `NEWS_BLACKOUT_FILE`, because
   * `env.ts` parses once at import: a test that set the variable would be asserting
   * against the default path and passing for the wrong reason.
   */
  function readWith(contents: string | null, now: Date) {
    const dir = mkdtempSync(join(tmpdir(), "flowmetrix-news-"));
    const file = join(dir, "news_blackout.json");
    if (contents !== null) writeFileSync(file, contents, "utf8");

    try {
      return readNewsBlackout(now, file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const now = new Date("2026-09-10T12:00:00Z");

  it("a MISSING file does not black out, and says so", () => {
    const { active, warnings } = readWith(null, now);
    assert.equal(active, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /not found/);
    assert.match(warnings[0]!, /NOT being blacked out/);
  });

  it("an UNPARSEABLE file does not black out, and says so", () => {
    const { active, warnings } = readWith("{ this is not json", now);
    assert.equal(active, null);
    assert.ok(warnings.some((w) => /not valid JSON/.test(w)));
  });

  it("a STALE calendar does not black out, even inside one of its windows", () => {
    const { active, warnings } = readWith(
      JSON.stringify({
        generated_at: "2026-09-05T12:00:00Z",
        windows: [{ event: "CPI", start_utc: "2026-09-10T11:30:00Z", end_utc: "2026-09-10T13:15:00Z" }],
      }),
      now,
    );
    assert.equal(active, null, "a stale calendar must not be able to freeze trading");
    assert.ok(warnings.some((w) => /over the 48h limit/.test(w)));
    assert.ok(warnings.some((w) => /IGNORED/.test(w)));
  });

  it("a FRESH calendar blacks out inside its window, and warns about nothing", () => {
    const { active, warnings } = readWith(
      JSON.stringify({
        generated_at: "2026-09-10T06:00:00Z",
        windows: [{ event: "PPI", start_utc: "2026-09-10T11:30:00Z", end_utc: "2026-09-10T13:15:00Z" }],
      }),
      now,
    );
    assert.equal(active?.event, "PPI");
    assert.deepEqual(warnings, []);
  });

  it("honours an undated calendar's windows but warns that freshness is unverifiable", () => {
    const { active, warnings } = readWith(
      JSON.stringify({
        windows: [{ event: "NFP", start_utc: "2026-09-10T11:30:00Z", end_utc: "2026-09-10T13:15:00Z" }],
      }),
      now,
    );
    assert.equal(active?.event, "NFP");
    assert.ok(warnings.some((w) => /no generated_at/.test(w)));
  });

  it("a directory where the file should be is a warning, not a crash", () => {
    /*
     * The non-ENOENT branch. `readFileSync` on a directory throws EISDIR, and the rule
     * is that NOTHING about this gate may propagate — a misconfigured path must cost a
     * log line, never a trading cycle.
     */
    const dir = mkdtempSync(join(tmpdir(), "flowmetrix-news-"));
    try {
      const { active, warnings } = readNewsBlackout(now, dir);
      assert.equal(active, null);
      assert.ok(warnings.some((w) => /unreadable/.test(w)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is switched off entirely by NEWS_BLACKOUT_ENABLED=false", () => {
    /*
     * Asserted through the parsed schema rather than by flipping the variable, since
     * `env.ts` parses once at import. The default is ON, and the read short-circuits
     * before touching the disk when it is not.
     */
    assert.equal(env.NEWS_BLACKOUT_ENABLED, true);
    const source = readFileSync(join(SRC, "services/newsBlackout.ts"), "utf8");
    assert.ok(
      source.indexOf("if (!env.NEWS_BLACKOUT_ENABLED)") < source.indexOf("readFileSync(path"),
      "a disabled gate must not read the file at all",
    );
  });
});

describe("news blackout — the operator-facing line", () => {
  it("renders the release, the wall-clock end and the zone", () => {
    /*
     * The exact line Hermes asked for. It is read against a clock on a wall, so it
     * renders in `env.TZ` (Asia/Jakarta by default, hence WIB) rather than UTC, and
     * names the event so the operator can decide whether waiting is worth it.
     */
    const line = describeBlackoutWindow(
      {
        event: "PPI",
        start: new Date("2026-09-10T11:30:00Z"),
        end: new Date("2026-09-10T13:15:00Z"),
        source: null,
      },
      // Passed explicitly, the way `timezone.test.ts` does: a literal assertion that
      // depended on the host's TZ would pass here and fail on the deploy box.
      "Asia/Jakarta",
    );

    assert.equal(
      line,
      "[news] blackout: PPI until Thu 10 Sep 2026 20:15 WIB — " +
        "skipping new entries (monitoring continues)",
    );
  });

  it("renders midnight as 00:00, never 24:00", () => {
    /*
     * `hour12: false` renders midnight as "24" on some ICU builds because en-US
     * defaults to an h12 cycle; `hourCycle: "h23"` is what pins it. A window ending at
     * "24:00 Fri" would be read as the END of Friday when it is the START.
     */
    assert.equal(formatZonedStamp(new Date("2026-09-11T00:00:00Z"), "UTC"), "Fri 11 Sep 2026 00:00 UTC");
    assert.equal(
      formatZonedStamp(new Date("2026-09-10T17:00:00Z"), "Asia/Jakarta"),
      "Fri 11 Sep 2026 00:00 WIB",
    );
  });

  it("tracks a DST transition rather than assuming one offset", () => {
    /*
     * The engine's own zone has no DST, so this is asserted in one that does — the
     * same reason `timezone.test.ts` tests outside Asia/Jakarta. An offset resolved
     * once and reused would render one of these two an hour out and label it wrongly.
     */
    assert.equal(
      formatZonedStamp(new Date("2026-03-08T06:59:00Z"), "America/New_York"),
      "Sun 08 Mar 2026 01:59 EST",
    );
    assert.equal(
      formatZonedStamp(new Date("2026-03-08T07:00:00Z"), "America/New_York"),
      "Sun 08 Mar 2026 03:00 EDT",
    );
  });

  it("renders the same instant in whatever zone is configured", () => {
    assert.equal(
      formatZonedStamp(new Date("2026-09-10T13:15:00Z"), "UTC"),
      "Thu 10 Sep 2026 13:15 UTC",
    );
    assert.equal(
      formatZonedStamp(new Date("2026-09-10T13:15:00Z"), "America/New_York"),
      "Thu 10 Sep 2026 09:15 EDT",
    );
  });

  it("defaults to the engine's own timezone, whatever the host's is", () => {
    /*
     * Asserted as an identity rather than against a literal, so it holds on any box.
     * The engine's zone is a setting; the HOST's zone must never leak into a figure an
     * operator reads, which is the whole reason `timezone.ts` exists.
     */
    const at = new Date("2026-09-10T13:15:00Z");
    assert.equal(formatZonedStamp(at), formatZonedStamp(at, env.TZ));
  });

  it("publishes {event, untilWib} or null, and nothing else", () => {
    assert.equal(toBlackoutStatus(null), null);
    assert.deepEqual(
      toBlackoutStatus(
        {
          event: "FOMC",
          start: new Date("2026-09-10T17:00:00Z"),
          end: new Date("2026-09-10T18:45:00Z"),
          source: "bls",
        },
        "Asia/Jakarta",
      ),
      // Crosses midnight into the 11th in WIB: the field is a WALL CLOCK, so the date
      // has to move with it or "until 01:45" reads as thirteen hours earlier.
      { event: "FOMC", untilWib: "Fri 11 Sep 2026 01:45 WIB" },
    );

    // The source is deliberately NOT published: the payload is what holds entries
    // back and for how long, not which feed said so.
    assert.deepEqual(
      Object.keys(
        toBlackoutStatus(
          {
            event: "CPI",
            start: new Date("2026-09-10T11:30:00Z"),
            end: new Date("2026-09-10T13:15:00Z"),
            source: "manual",
          },
          "UTC",
        )!,
      ),
      ["event", "untilWib"],
    );
  });
});

describe("news blackout — placement and blast radius", () => {
  const agent = readFileSync(join(SRC, "agents/dlmmTraderAgent.ts"), "utf8");

  it("is read inside isLiveExecutionActive(), so PAPER mode is byte-identical", () => {
    /*
     * The property Hermes asked to be asserted, and the same inert-default discipline
     * `defaultBacktestConfig()`, `liveConfig.ts` and the execution breaker follow. In
     * a dry run the calendar is never even opened, so a paper cycle behaves exactly as
     * it did before this gate existed and every cached sweep result stays comparable.
     */
    assert.match(
      agent,
      /const blackout = isLiveExecutionActive\(\) \? readNewsBlackout\(\) : null;/,
      "the blackout read must be guarded by isLiveExecutionActive()",
    );
  });

  it("gates ENTRIES only — the monitor stage runs before it and is untouched", () => {
    /*
     * A blackout must never stop an EXIT. The stop-loss is most needed precisely during
     * a release, and a position the engine has stopped watching is the failure mode of
     * the 10 Sep half-landed open. The monitor call therefore has to sit ABOVE the skip
     * decision in the cycle, where no blackout branch can reach it.
     */
    const monitor = agent.indexOf("await positionMutex.run(monitorOpenPositions)");
    const decision = agent.indexOf("const blackout = isLiveExecutionActive()");
    const seek = agent.indexOf("await seekNewEntry();");

    assert.ok(monitor > 0 && decision > monitor, "monitoring must run before the blackout check");
    assert.ok(seek > decision, "the blackout check must precede seekNewEntry");
    assert.ok(
      !/skipMonitor|monitorOpenPositions/.test(
        agent.slice(decision, agent.indexOf("const postMortemsBackfilled")),
      ),
      "the blackout branch must not touch the monitor stage",
    );
  });

  it("is independent of /pause: neither is expressed in terms of the other", () => {
    /*
     * Two independent reasons for the same silence. `/resume` must not shorten a
     * blackout, and a window ending must not un-pause a paused engine — so both
     * reasons are collected and BOTH are reported when both apply. The /pause wording
     * is unchanged character for character, because it is what already appears in
     * `scan_funnel_cycles.skip_reason`.
     */
    assert.match(agent, /const paused = isEnginePaused\(\);/);
    assert.match(agent, /skipReasons\.join\("; "\)/);
    assert.ok(
      agent.includes('skipReasons.push("engine paused via Telegram /pause — scanning disabled")'),
      "the /pause skip reason must keep its exact existing wording",
    );

    // engineControl itself must stay ignorant of the blackout: one concept, one owner.
    const control = readFileSync(join(SRC, "services/engineControl.ts"), "utf8");
    assert.ok(
      !/news|blackout/i.test(control),
      "pause/resume semantics must not be entangled with the news gate",
    );
  });

  it("touches no risk gate: the screener cannot see it", () => {
    /*
     * This is a TIMING gate, not a risk gate. `meteora.ts` holds the screening and
     * position maths shared with paper mode and the backtest; a live-only, clock-driven
     * rule leaking in there would silently rewrite every dry run and every cached sweep
     * — the same rule that keeps `LIVE_MAX_POSITION_BINS` out of that file.
     */
    for (const file of ["services/meteora.ts", "services/liveConfig.ts", "config/liveConfig.ts"]) {
      let text: string;
      try {
        text = readFileSync(join(SRC, file), "utf8");
      } catch {
        continue;
      }
      assert.ok(
        !/newsBlackout|NEWS_BLACKOUT/.test(text),
        `${file} must not read the news blackout`,
      );
    }
  });

  it("is not a V1.1 guardrail and must not be counted as one", () => {
    const baseline = readFileSync(join(SRC, "tests/v11Baseline.test.ts"), "utf8");
    assert.ok(
      !baseline.includes("NEWS_BLACKOUT"),
      "the news blackout must not be pinned as part of the V1.1 baseline",
    );
  });

  it("keeps the signer out of the API-only process", () => {
    /*
     * `overview.ts` has to ask whether live execution is active — a status payload must
     * not advertise a gate the engine is not enforcing. It asks `config/liveConfig.ts`,
     * NOT the live-execution bridge: `api/server.ts` imports `overview.ts` and runs as
     * its own process under `npm run api`, so importing the bridge for one boolean
     * would have pulled `onchainExecutor.ts` into the import graph of the
     * network-facing process. There is still exactly ONE definition of the predicate —
     * `liveExecution.ts` re-exports this one.
     *
     * WALKED, not grepped. `onchainExecutor.test.ts` proves the signer is reachable
     * from `src/index.ts` through the bridge and nothing else; that says nothing about
     * the OTHER entrypoint, which is the one exposed to a network. This is that
     * missing half, and it is the assertion that would have failed had `overview.ts`
     * imported the bridge.
     */
    const graph = importGraph(join(SRC, "api", "server.ts"));

    assert.ok(graph.size > 10, "the import walker found almost nothing; it is broken");
    assert.ok(
      graph.has(join(SRC, "services", "overview.ts")),
      "sanity: the walker should reach the overview payload",
    );
    assert.ok(
      !graph.has(join(SRC, "services", "onchainExecutor.ts")),
      "the API-only process can reach the SIGNER. A status field must never cost that.",
    );
    assert.ok(
      !graph.has(join(SRC, "services", "liveExecution.ts")),
      "the API-only process reaches the live-execution bridge; it needs neither",
    );

    // And exactly one definition of the predicate, so the two callers cannot diverge.
    const bridge = readFileSync(join(SRC, "services/liveExecution.ts"), "utf8");
    assert.ok(
      bridge.includes("export { isLiveExecutionActive }"),
      "the bridge must re-export the predicate rather than declare a second copy",
    );
    assert.equal(
      (bridge.match(/function isLiveExecutionActive/g) ?? []).length,
      0,
      "two copies of the arming predicate means two answers to 'are we live'",
    );
  });
});
