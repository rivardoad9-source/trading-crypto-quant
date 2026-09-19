/**
 * The lock that keeps the 1-minute fast monitor from overlapping the base-cadence
 * screener. Fee accrual is measured from `last_checked_at`, so two overlapping passes
 * would book the same interval twice — these tests pin the exclusion, the FIFO order,
 * and the skip-don't-queue behaviour the fast monitor depends on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Mutex } from "../services/mutex.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Mutex.run", () => {
  it("serialises overlapping critical sections", async () => {
    const mutex = new Mutex();
    const events: string[] = [];

    const holder = async (name: string) => {
      events.push(`${name}:enter`);
      await tick(10);
      events.push(`${name}:exit`);
    };

    await Promise.all([
      mutex.run(() => holder("a")),
      mutex.run(() => holder("b")),
      mutex.run(() => holder("c")),
    ]);

    // No "enter" may appear between another holder's enter and exit.
    assert.deepEqual(events, [
      "a:enter",
      "a:exit",
      "b:enter",
      "b:exit",
      "c:enter",
      "c:exit",
    ]);
  });

  it("returns the critical section's value", async () => {
    const mutex = new Mutex();
    assert.equal(await mutex.run(async () => 42), 42);
  });

  it("releases the lock when the critical section throws", async () => {
    const mutex = new Mutex();

    await assert.rejects(
      mutex.run(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );

    // A thrown holder that failed to release would deadlock every later caller.
    assert.equal(mutex.busy, false);
    assert.equal(await mutex.run(async () => "recovered"), "recovered");
  });

  it("runs waiters in the order they arrived", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        mutex.run(async () => {
          await tick(1);
          order.push(n);
        }),
      ),
    );

    assert.deepEqual(order, [1, 2, 3, 4]);
  });
});

describe("Mutex.tryRun", () => {
  it("runs when the lock is free", async () => {
    const mutex = new Mutex();
    const outcome = await mutex.tryRun(async () => "ran");

    assert.equal(outcome.ran, true);
    assert.equal(outcome.ran && outcome.value, "ran");
  });

  it("gives up instead of queueing while another holder is inside", async () => {
    const mutex = new Mutex();
    let sideEffects = 0;

    const held = mutex.run(async () => {
      await tick(20);
    });

    const skipped = await mutex.tryRun(async () => {
      sideEffects++;
      return "should not happen";
    });

    assert.equal(skipped.ran, false);
    assert.equal(sideEffects, 0, "a skipped tick must not touch anything");

    await held;
  });

  it("gives up while a waiter is queued but not yet running", async () => {
    /*
     * The window this guards: a holder clears its flag one microtask before the next
     * waiter resumes. A tryRun landing there would silently queue behind the waiter
     * instead of skipping, which is how a slow screener would pile up fast ticks.
     */
    const mutex = new Mutex();

    const first = mutex.run(() => tick(10));
    const second = mutex.run(() => tick(10));

    const skipped = await mutex.tryRun(async () => "should not happen");
    assert.equal(skipped.ran, false);

    await Promise.all([first, second]);
    assert.equal(mutex.busy, false);
  });

  it("becomes available again once the holder is done", async () => {
    const mutex = new Mutex();

    await mutex.run(() => tick(1));
    const outcome = await mutex.tryRun(async () => "free again");

    assert.equal(outcome.ran, true);
  });
});
