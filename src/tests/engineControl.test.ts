import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeEntriesHeld,
  entriesAreHeld,
  fileHoldSkipReason,
  isEnginePaused,
  readEngineControlFile,
  setEnginePaused,
  type EngineControlStatus,
} from "../services/engineControl.js";

/**
 * The file-based kill-switch.
 *
 * WHAT IT IS FOR. On 10 Sep 2026 every engine boot was refused by Telegram with
 * `409: Conflict: terminated by other getUpdates request` — an external poller holding
 * the bot token — so command INTAKE was dead for the life of the process. `/pause`,
 * `/resume`, `/close_all` and `/status` were all unresponsive, and the pause flag lives
 * in memory, so there was NO way to hold new entries from outside the process. `pm2
 * stop` is not a substitute: it also stops monitoring the open positions, which is how
 * a stop-loss stops being enforced.
 *
 * TWO PROPERTIES CARRY EVERYTHING BELOW. The file must be able to hold entries, and it
 * must never be able to hold anything else — no exit, no fee accrual, no close, and
 * nothing at all in paper mode.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "engine-control-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes a control file and reads it back through the real reader. */
function readFile(contents: string) {
  return withTempDir((dir) => {
    const file = join(dir, "engine_control.json");
    writeFileSync(file, contents, "utf8");
    return readEngineControlFile(file);
  });
}

const status = (over: Partial<EngineControlStatus> = {}): EngineControlStatus => ({
  pausedByTelegram: false,
  pausedByFile: false,
  fileReason: null,
  ...over,
});

describe("engine control file — the happy paths", () => {
  it("an ABSENT file is not a pause, and is not even a warning", () => {
    /*
     * No control file is the normal state of a box nobody has intervened on. Warning
     * about it every cycle would train the operator to ignore the one line that
     * matters, and pausing on it would mean a fresh deploy never trades.
     */
    const reading = withTempDir((dir) => readEngineControlFile(join(dir, "absent.json")));

    assert.equal(reading.paused, false);
    assert.equal(reading.reason, null);
    assert.deepEqual(reading.warnings, []);
  });

  it("holds entries on paused: true, and carries the operator's reason", () => {
    const reading = readFile(
      JSON.stringify({
        paused: true,
        reason: "operator: news window",
        updated_at: "2026-09-10T11:00:00Z",
      }),
    );

    assert.equal(reading.paused, true);
    assert.equal(reading.reason, "operator: news window");
    assert.deepEqual(reading.warnings, []);
  });

  it("releases entries on paused: false, silently", () => {
    const reading = readFile(JSON.stringify({ paused: false, reason: "left in place" }));

    assert.equal(reading.paused, false);
    assert.deepEqual(reading.warnings, []);
    /*
     * A stale reason beside `paused: false` must not be reported: it would render in
     * /status as though something were holding entries when nothing is.
     */
    assert.equal(reading.reason, null);
  });

  it("accepts a quoted boolean, because that is how a hand-edit goes wrong", () => {
    /*
     * The direction matters more than the tolerance. Refusing `"paused": "false"` would
     * PAUSE an engine whose operator had just written it to RESUME — a typo turning
     * into an outage in the one direction nobody is watching for.
     */
    assert.equal(readFile('{"paused":"false"}').paused, false);
    assert.equal(readFile('{"paused":"TRUE"}').paused, true);
    assert.equal(readFile('{"paused":" true "}').paused, true);
  });
});

describe("engine control file — fails CLOSED, loudly", () => {
  /*
   * The one gate on this path that fails closed, and deliberately so. A calendar or a
   * price feed failing open is right — a third party's dead cron must not freeze an
   * unattended engine. This file is not a feed, it is an INSTRUCTION, and it exists
   * only because a person wrote it. An instruction we cannot make out is read the way
   * that spends no money.
   */

  it("holds entries on malformed JSON, and says so", () => {
    const reading = readFile("{ this is not json");

    assert.equal(reading.paused, true);
    assert.equal(reading.warnings.length, 1);
    assert.match(reading.warnings[0]!, /not valid JSON/);
    assert.match(reading.warnings[0]!, /HOLDING new entries/);
  });

  it("holds entries when the file is not an object", () => {
    for (const raw of ["[]", '"paused"', "42", "null"]) {
      const reading = readFile(raw);
      assert.equal(reading.paused, true, `${raw} must hold entries`);
      assert.equal(reading.warnings.length, 1, raw);
    }
  });

  it("holds entries when `paused` is missing or unreadable", () => {
    for (const raw of ['{"reason":"no flag"}', '{"paused":1}', '{"paused":"yes"}', "{}"]) {
      const reading = readFile(raw);
      assert.equal(reading.paused, true, `${raw} must hold entries`);
      assert.match(reading.warnings[0]!, /no readable "paused" boolean/, raw);
    }
  });

  it("holds entries when the file exists but cannot be read", () => {
    /*
     * Distinct from ENOENT on purpose: a file that is THERE and unreadable —
     * permissions, a truncated write, a disk fault — is an instruction we cannot make
     * out, while an absent one is no instruction at all.
     */
    const reading = withTempDir((dir) => {
      // A directory at the path: `readFileSync` fails with EISDIR, not ENOENT, on every
      // platform, which makes this the portable way to produce a non-ENOENT read error.
      return readEngineControlFile(dir);
    });

    assert.equal(reading.paused, true);
    assert.equal(reading.warnings.length, 1);
    assert.match(reading.warnings[0]!, /HOLDING new entries/);
  });

  it("warns EVERY read, never just the first", () => {
    /*
     * There is no cache and no once-only flag: the cycle prints these every cycle, so a
     * broken control file stays visible until somebody fixes it. A warning that fires
     * once is a warning nobody sees at 3am.
     */
    withTempDir((dir) => {
      const file = join(dir, "engine_control.json");
      writeFileSync(file, "{ broken", "utf8");
      for (let i = 0; i < 3; i += 1) {
        const reading = readEngineControlFile(file);
        assert.equal(reading.paused, true);
        assert.equal(reading.warnings.length, 1, `read ${i + 1} must warn`);
      }
    });
  });

  it("names the file in every warning, so the operator knows what to fix", () => {
    withTempDir((dir) => {
      const file = join(dir, "engine_control.json");
      writeFileSync(file, "{ broken", "utf8");
      const reading = readEngineControlFile(file);
      assert.ok(reading.warnings[0]!.includes(file), reading.warnings[0]);
      assert.equal(reading.path, file);
    });
  });

  it("a readable `paused: false` survives an unparseable REST of the object", () => {
    /*
     * The field that carries the instruction was legible; discarding the whole file
     * over an unrelated bad field is how a gate switches itself ON for a reason nobody
     * asked for. (A file that does not PARSE at all is different — there is no legible
     * field then, and the case above holds entries.)
     */
    const reading = readFile(
      JSON.stringify({
        paused: false,
        updated_at: "not-a-date",
        nonsense: { deeply: [1, 2] },
      }),
    );

    assert.equal(reading.paused, false);
    assert.deepEqual(reading.warnings, []);
  });
});

describe("engine control file — the reason is untrusted data", () => {
  it("strips the markdown bold marker, which would break /status", () => {
    /*
     * `reason` comes from a file this repository does not write and is rendered into a
     * MarkdownV2 reply. `markdownV2()` uses `**...**` to mark the spans it must NOT
     * escape, so a `**` arriving through data opens a bold span of its own and Telegram
     * rejects the whole message with "can't parse entities" — the operator loses
     * /status at exactly the moment they are using it to find out why nothing is
     * opening.
     */
    const reading = readFile(JSON.stringify({ paused: true, reason: "oper**ator**: halt" }));
    assert.ok(!reading.reason!.includes("*"), reading.reason!);
  });

  it("strips control characters, which would forge a line in the report", () => {
    const reading = readFile(
      JSON.stringify({ paused: true, reason: "halt\nActive positions: 99" }),
    );
    assert.ok(!/[\n\r]/.test(reading.reason!), JSON.stringify(reading.reason));
  });

  it("bounds the length, so one field cannot flood the report", () => {
    const reading = readFile(JSON.stringify({ paused: true, reason: "x".repeat(5_000) }));
    assert.ok(reading.reason!.length <= 200, String(reading.reason!.length));
  });

  it("a non-string or empty reason is null, never the empty string", () => {
    assert.equal(readFile(JSON.stringify({ paused: true, reason: 42 })).reason, null);
    assert.equal(readFile(JSON.stringify({ paused: true, reason: "   " })).reason, null);
    assert.equal(readFile(JSON.stringify({ paused: true })).reason, null);
  });
});

describe("engine control — the two sources are independent", () => {
  it("/resume does not clear a file pause", () => {
    /*
     * The defect this prevents is an operator using the wrong lever: `/resume` lifts
     * the in-memory hold and cannot touch the file, so an engine reported simply as
     * "resumed" would keep opening nothing with no explanation.
     */
    const before = isEnginePaused();
    try {
      setEnginePaused(true);
      const filePaused = status({ pausedByTelegram: true, pausedByFile: true, fileReason: "halt" });
      assert.equal(entriesAreHeld(filePaused), true);

      setEnginePaused(false);
      const afterResume = status({
        pausedByTelegram: isEnginePaused(),
        pausedByFile: filePaused.pausedByFile,
        fileReason: filePaused.fileReason,
      });

      assert.equal(afterResume.pausedByTelegram, false, "/resume clears the Telegram hold");
      assert.equal(afterResume.pausedByFile, true, "/resume must NOT clear the file hold");
      assert.equal(entriesAreHeld(afterResume), true, "entries are still held");
    } finally {
      setEnginePaused(before);
    }
  });

  it("a file hold does not un-pause a Telegram pause either", () => {
    const both = status({ pausedByTelegram: true, pausedByFile: false });
    assert.equal(entriesAreHeld(both), true, "the Telegram hold stands on its own");
  });

  it("either source alone holds entries; neither holding means running", () => {
    assert.equal(entriesAreHeld(status()), false);
    assert.equal(entriesAreHeld(status({ pausedByTelegram: true })), true);
    assert.equal(entriesAreHeld(status({ pausedByFile: true })), true);
  });

  it("reports BOTH sources in one line, naming the one that holds", () => {
    assert.equal(
      describeEntriesHeld(status({ pausedByFile: true, fileReason: "operator: news window" })),
      "[control] entries held: file (operator: news window); telegram: running",
    );
    assert.equal(
      describeEntriesHeld(status({ pausedByTelegram: true })),
      "[control] entries held: file: running; telegram /pause",
    );
    assert.equal(
      describeEntriesHeld(status({ pausedByFile: true, pausedByTelegram: true })),
      "[control] entries held: file (no reason given); telegram /pause",
    );
  });

  it("prints nothing when nothing is holding entries", () => {
    /*
     * A per-cycle "nothing is holding entries" line is the noise that hides the real
     * one. An ordinary cycle is already fully described by the funnel row.
     */
    assert.equal(describeEntriesHeld(status()), null);
  });

  it("contributes a SEPARATE skip clause, never a replacement for /pause's", () => {
    /*
     * The `/pause` wording is already written to `scan_funnel_cycles.skip_reason` and
     * an operator reads it there, so the file's hold is appended beside it. One clause
     * standing for two causes is the funnel-ordering defect of 8 Sep, again.
     */
    assert.equal(fileHoldSkipReason(status()), null);

    const clause = fileHoldSkipReason(status({ pausedByFile: true, fileReason: "halt" }))!;
    assert.match(clause, /operator control file/);
    assert.match(clause, /halt/);
    assert.match(clause, /monitoring continues/);
    assert.ok(!clause.includes("/pause"), "must not restate the Telegram clause");
  });
});

describe("engine control — placement and blast radius", () => {
  const agent = readFileSync(join(SRC, "agents/dlmmTraderAgent.ts"), "utf8");

  it("is read inside isLiveExecutionActive(), so PAPER mode is byte-identical", () => {
    /*
     * A dry run must not so much as stat the file: a live-only control leaking into
     * paper mode would silently change every dry run and every cached sweep result —
     * the same discipline `defaultBacktestConfig()` and `liveConfig.ts` follow.
     */
    assert.match(
      agent,
      /const control = isLiveExecutionActive\(\) \? readEngineControlFile\(\) : null;/,
      "the control-file read must be guarded by isLiveExecutionActive()",
    );
  });

  it("gates ENTRIES only — the monitor stage runs before it and is untouched", () => {
    /*
     * Blocking an EXIT while entries are held is the opposite of prudent: the
     * stop-loss is what stops being enforced, and a position the engine has stopped
     * acting on is the 10 Sep half-landed open all over again.
     */
    const monitor = agent.indexOf("await positionMutex.run(monitorOpenPositions)");
    const decision = agent.indexOf("const control = isLiveExecutionActive()");

    assert.ok(monitor > 0, "the monitor call must exist");
    assert.ok(decision > monitor, "monitoring must run before the control-file check");
  });

  it("holds entries by adding a skip reason, not by short-circuiting the cycle", () => {
    // The hold must flow through the same `skipReasons` list every other hold uses, so
    // it lands in `scan_funnel_cycles.skip_reason` and is reconcilable afterwards.
    assert.match(agent, /const fileHold = fileHoldSkipReason\(controlStatus\);/);
    assert.match(agent, /if \(fileHold\) skipReasons\.push\(fileHold\);/);
  });

  it("keeps the /pause skip reason character for character", () => {
    assert.ok(
      agent.includes('skipReasons.push("engine paused via Telegram /pause — scanning disabled")'),
      "the /pause skip reason must keep its exact existing wording",
    );
  });

  it("touches no risk gate: the screener cannot see it", () => {
    /*
     * This is an operator switch, not a risk rule. `meteora.ts` holds the screening and
     * position maths shared with paper mode and the backtest; a live-only control
     * leaking in there would rewrite every dry run and every cached sweep — the same
     * rule that keeps `LIVE_MAX_POSITION_BINS` out of that file.
     */
    for (const file of ["services/meteora.ts", "config/liveConfig.ts"]) {
      const text = readFileSync(join(SRC, file), "utf8");
      assert.ok(
        !/engineControl|ENGINE_CONTROL/.test(text),
        `${file} must not read the engine control file`,
      );
    }
  });

  it("keeps the signer out of the API-only process", () => {
    /*
     * `overview.ts` publishes the control state and is imported by `api/server.ts`,
     * which `npm run api` runs as a process of its own. Reaching the bridge for it
     * would pull `onchainExecutor.ts` into that process's import graph — the reason
     * `isLiveExecutionActive` lives in `config/liveConfig.ts` in the first place.
     */
    const overview = readFileSync(join(SRC, "services/overview.ts"), "utf8");
    assert.ok(
      !/from\s*["'][^"']*liveExecution/.test(overview),
      "overview.ts must not import the live-execution bridge",
    );
    assert.match(overview, /from "\.\.\/config\/liveConfig\.js"/);
  });

  it("publishes both sources, and the file half only when live", () => {
    const overview = readFileSync(join(SRC, "services/overview.ts"), "utf8");
    /*
     * Publishing a hold the engine is not applying is the "advertised bound,
     * unenforced" defect CLAUDE.md records three times — pointing the other way.
     */
    assert.match(
      overview,
      /const controlFile = isLiveExecutionActive\(\) \? readEngineControlFile\(\) : null;/,
    );
    assert.match(overview, /pausedByTelegram: isEnginePaused\(\)/);
    assert.match(overview, /pausedByFile: controlFile\?\.paused \?\? false/);
  });

  it("reads the file ONCE per overview, so the two fields cannot straddle a write", () => {
    const overview = readFileSync(join(SRC, "services/overview.ts"), "utf8");
    assert.equal(
      (overview.match(/readEngineControlFile\(\)/g) ?? []).length,
      1,
      "two reads could report a paused file with no reason, or a reason with no pause",
    );
  });
});
