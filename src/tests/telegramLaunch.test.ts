import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TELEGRAM_LAUNCH_BACKOFF_MS,
  TELEGRAM_LAUNCH_RETRY_STEADY_MS,
  launchBackoffMs,
  launchWithBackoff,
} from "../services/telegramCommands.js";

/**
 * The command bot's launch retries.
 *
 * WHAT THIS PROTECTS. On 10 Sep 2026 every engine boot logged `409: Conflict:
 * terminated by other getUpdates request` — an external poller holding the same bot
 * token. Telegraf's `launch()` REJECTS on that, and a single `.catch()` meant the
 * command bot was dead for the whole life of the process: `/pause`, `/resume`,
 * `/close_all` and `/status` all unresponsive. That is the operator kill-switch, and
 * losing it until the next restart is the opposite of what a kill-switch is for —
 * restarting a LIVE engine to recover one is precisely the intervention it exists to
 * avoid.
 *
 * The conflict is external and this repository can neither cause nor clear it. What it
 * can do is keep asking, indefinitely, so the switch returns on its own the moment the
 * conflict does. Every test below is about that loop being both persistent and
 * genuinely stoppable — a retry loop that cannot be stopped is a different bug of the
 * same size.
 */

/** Lets every pending microtask (the `.catch()` on a rejected launch) run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A launch harness with hand-driven timers.
 *
 * `outcomes` is consumed one per attempt. `"reject"` is a boot failure; `"poll"` is
 * SUCCESS, represented as a promise that never settles — which is what telegraf's
 * `launch()` actually does while it is polling, and the reason success cannot be
 * awaited anywhere in this design.
 */
function harness(outcomes: Array<"reject" | "poll">) {
  const delays: number[] = [];
  const fired: Array<() => void> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let cleared = 0;
  let calls = 0;

  const handle = launchWithBackoff({
    launch: () => {
      const outcome = outcomes[calls] ?? "poll";
      calls += 1;
      return outcome === "reject"
        ? Promise.reject(new Error(`409: Conflict (call ${calls})`))
        : new Promise<never>(() => {});
    },
    setTimer: (fn, ms) => {
      delays.push(ms);
      fired.push(fn);
      return delays.length;
    },
    clearTimer: () => {
      cleared += 1;
    },
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
  });

  return {
    handle,
    delays,
    logs,
    errors,
    calls: () => calls,
    cleared: () => cleared,
    /** Runs the retry the loop scheduled, as a real timer eventually would. */
    fire: (i: number) => fired[i]!(),
  };
}

describe("telegram launch — the backoff ladder", () => {
  it("is 5s, 15s, 30s and then a steady 60s FOREVER", () => {
    assert.deepEqual([...TELEGRAM_LAUNCH_BACKOFF_MS], [5_000, 15_000, 30_000]);

    assert.equal(launchBackoffMs(1), 5_000);
    assert.equal(launchBackoffMs(2), 15_000);
    assert.equal(launchBackoffMs(3), 30_000);

    /*
     * The tail is the load-bearing half. A retry budget that gave up would leave the
     * kill-switch dead until someone restarted the engine, and the conflict it recovers
     * from may clear at any time — an hour in, or a day in.
     */
    assert.equal(launchBackoffMs(4), TELEGRAM_LAUNCH_RETRY_STEADY_MS);
    assert.equal(launchBackoffMs(50), TELEGRAM_LAUNCH_RETRY_STEADY_MS);
    assert.equal(launchBackoffMs(10_000), TELEGRAM_LAUNCH_RETRY_STEADY_MS);
  });
});

describe("telegram launch — retrying until it sticks", () => {
  it("rejects twice, then starts, waiting 5s and 15s in between", async () => {
    const h = harness(["reject", "reject", "poll"]);

    // Attempt 1 was made synchronously; its rejection arrives as a microtask.
    assert.equal(h.calls(), 1);
    await flush();
    assert.deepEqual(h.delays, [5_000]);

    h.fire(0);
    assert.equal(h.calls(), 2);
    await flush();
    assert.deepEqual(h.delays, [5_000, 15_000]);

    h.fire(1);
    assert.equal(h.calls(), 3);
    await flush();

    /*
     * The third launch is still pending, which IS the success state. Nothing further
     * may be scheduled: a loop that kept retrying behind a healthy poller would fight
     * its own bot for the token — the very conflict it is recovering from.
     */
    assert.deepEqual(h.delays, [5_000, 15_000], "no retry may be scheduled after success");
    assert.equal(h.handle.attempts(), 3);
  });

  it("names the attempt in both the failure and the success line", async () => {
    const h = harness(["reject", "reject", "poll"]);
    await flush();
    h.fire(0);
    await flush();
    h.fire(1);
    await flush();

    assert.ok(
      h.errors.some((m) => m.startsWith("[telegram] bot launch failed (attempt 1):")),
      h.errors.join(" | "),
    );
    assert.ok(
      h.errors.some((m) => m.startsWith("[telegram] bot launch failed (attempt 2):")),
      h.errors.join(" | "),
    );
    assert.ok(
      h.logs.includes("[telegram] command bot started (long-polling, attempt 3)"),
      h.logs.join(" | "),
    );
  });

  it("logs readiness immediately and never awaits launch()", async () => {
    /*
     * `launch()` resolves only when polling STOPS, so awaiting it in the boot path
     * would hang the orchestrator forever. The proof is that a launch which never
     * settles still produces its readiness line before this assertion runs — no flush,
     * no await in between.
     */
    const h = harness(["poll"]);
    assert.deepEqual(h.logs, ["[telegram] command bot started (long-polling, attempt 1)"]);
    assert.equal(h.delays.length, 0);
  });

  it("keeps retrying past the ladder, on the steady beat", async () => {
    const h = harness(["reject", "reject", "reject", "reject", "reject"]);

    await flush();
    for (let i = 0; i < 4; i += 1) {
      h.fire(i);
      await flush();
    }

    assert.deepEqual(h.delays, [
      5_000,
      15_000,
      30_000,
      TELEGRAM_LAUNCH_RETRY_STEADY_MS,
      TELEGRAM_LAUNCH_RETRY_STEADY_MS,
    ]);
  });
});

describe("telegram launch — stopping", () => {
  it("cancels the pending retry and makes no further attempt", async () => {
    const h = harness(["reject", "reject", "reject"]);

    await flush();
    assert.deepEqual(h.delays, [5_000]);

    h.handle.stop();
    assert.equal(h.cleared(), 1, "the pending timer must be cleared");

    /*
     * Firing it anyway is the assertion that matters. `clearTimeout` loses a race with
     * a timer that has already been handed to the event loop, so the loop must ALSO
     * refuse to act once stopped — otherwise a stopped engine wakes up every 60s to
     * re-poll a token it no longer owns.
     */
    h.fire(0);
    assert.equal(h.calls(), 1, "no attempt may follow stop()");
    assert.equal(h.handle.attempts(), 1);
    assert.deepEqual(h.delays, [5_000], "no retry may be scheduled after stop()");
  });

  it("schedules nothing when stopped while a launch is still in flight", async () => {
    const h = harness(["reject", "reject"]);

    // Stop BEFORE the rejection is delivered: the catch still runs, and must be inert.
    h.handle.stop();
    await flush();

    assert.deepEqual(h.delays, [], "a rejection arriving after stop() must schedule nothing");
    assert.equal(h.calls(), 1);
  });

  it("is idempotent, so a double stop cannot throw", async () => {
    const h = harness(["reject", "reject"]);
    await flush();

    h.handle.stop();
    assert.doesNotThrow(() => h.handle.stop());
    // Only the one pending timer existed to clear; the second stop finds nothing.
    assert.equal(h.cleared(), 1);
  });
});
